"""Offline synthetic regression tests; no network, credentials or production writes."""
import contextlib
import io
import json
import os
import random
import tempfile
import unittest
from pathlib import Path

from train_insight_classifier import train, InsufficientClassSamples


class FixedSplitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cache = Path(os.environ.get('JOB_TEST_WORK_DIR', 'E:/Codex/work/20261022-targeted-annotation'))
        if not cache.parent.exists():
            raise RuntimeError('E盘测试目录不可用，请明确设置 JOB_TEST_WORK_DIR')
        cache.mkdir(parents=True, exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix='fixed-split-regression-', dir=cache)
        cls.folder = Path(cls.temp.name)
        samples, splits = [], {}
        for i in range(210):
            rng = random.Random(i)
            noise = ''.join(chr(rng.randrange(0x4e00, 0x7000)) for _ in range(120))
            positive = i % 2 == 0
            body = ('负责业务指标分析和数据分析报告。熟悉SQL数据分析。' if positive else
                    '负责软件开发维护和接口测试。熟悉Java后端开发。') + noise
            row = dict(id=str(i), company='synthetic-'+str(i), body=body,
                       text=body, training_text_v2=body+'任职要求：'+noise,
                       label='include' if positive else 'exclude')
            samples.append(row)
            splits[str(i)] = 'train' if i < 120 else 'validation' if i < 160 else 'test' if i < 200 else 'excluded'
        cls.fixture = dict(id='synthetic-test', role='数据分析', samples=samples,
                           fixed_splits=splits,
                           grouping_samples=[dict(id=r['id'], body=r['body']) for r in samples])

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def execute(self, name, mutate=lambda d: None):
        data = json.loads(json.dumps(self.fixture))
        mutate(data)
        directory = self.folder / name
        directory.mkdir()
        source = directory / 'samples.json'
        source.write_text(json.dumps(data), encoding='utf8')
        with contextlib.redirect_stdout(io.StringIO()):
            train(str(source), str(directory))
        return json.loads((directory / 'model.json').read_text(encoding='utf8'))

    def test_holdout_labels_cannot_change_weights_or_selection(self):
        original = self.execute('baseline')
        def flip(data):
            for row in data['samples']:
                if data['fixed_splits'][row['id']] in ['test', 'excluded']:
                    row['label'] = 'exclude' if row['label'] == 'include' else 'include'
        flipped = self.execute('flipped', flip)
        for key in ['tfidf', 'head', 'threshold', 'input_preprocessing']:
            self.assertEqual(original[key], flipped[key])
        self.assertEqual(original['provenance']['selection'], flipped['provenance']['selection'])

    def test_missing_assignment_fails(self):
        with self.assertRaisesRegex(ValueError, '固定分组缺失'):
            self.execute('missing', lambda d: d['fixed_splits'].pop('0'))

    def test_cross_company_leak_fails(self):
        def leak(data):
            data['samples'][0]['company'] = data['samples'][160]['company']
        with self.assertRaisesRegex(ValueError, '近重复泄漏'):
            self.execute('leak', leak)

    def test_grouping_body_mismatch_fails(self):
        with self.assertRaisesRegex(ValueError, '固定去重语料'):
            self.execute('tamper', lambda d: d['grouping_samples'][0].update(body='tampered'))

    def test_sampling_hints_are_not_features_or_threshold_inputs(self):
        original = self.execute('without-hints')
        def hint(data):
            data['sampling'] = dict(version='schema-stratified-v1', metricsBasis='enriched, not population accuracy')
            for row in data['samples']:
                row['sampling'] = dict(stratum='target_candidate', title=['sampling-only-canary'])
        hinted = self.execute('with-hints', hint)
        for key in ['tfidf', 'head', 'threshold', 'input_preprocessing']:
            self.assertEqual(original[key], hinted[key])
        self.assertEqual(hinted['provenance']['sampling']['version'], 'schema-stratified-v1')

    def test_split_shortage_keeps_group_counts(self):
        def shortage(data):
            for row in data['samples']:
                row['label'] = 'exclude'
        with self.assertRaises(InsufficientClassSamples) as failure:
            self.execute('shortage', shortage)
        self.assertEqual(failure.exception.counts['train']['positive'], 0)
        self.assertIn('标签已保留', str(failure.exception))


if __name__ == '__main__':
    unittest.main()
