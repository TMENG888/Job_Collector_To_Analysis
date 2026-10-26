"""Checks for the isolated role-screening evaluation, not production tests."""
import hashlib
import json
import unittest
from pathlib import Path
from evaluate_role_screening_trial import OUT, ROOT, MODEL, choose, metric, prepare, sha

class TrialTests(unittest.TestCase):
    def test_metrics_confusion(self):
        m=metric([1,1,0,0],[1,0,1,0])
        self.assertEqual((m['tp'],m['fp'],m['fn'],m['tn']),(1,1,1,1))
        self.assertEqual(m['precision'],.5)
        self.assertEqual(m['recall'],.5)
        self.assertEqual(m['f1'],.5)
    def test_undefined_precision_not_fake_zero(self):
        m=metric([0,1],[0,0])
        self.assertIsNone(m['precision'])
        self.assertIsNone(m['precision_ci95'])
        self.assertEqual(m['recall'],0)
    def test_perfect_small_sample_not_certain(self):
        m=metric([1]*4,[1]*4)
        self.assertLess(m['precision_ci95'][0],.6)
        self.assertAlmostEqual(m['precision_ci95'][1],1)
    def test_section_requirements_before_duties(self):
        d={'title':'例子','body':'任职要求：熟悉Python SQL。岗位职责：'+('维护系统、记录故障。'*10)+'任职要求：本科。'}
        text,mode,compressed=prepare(d)
        self.assertEqual(mode,'duties_heading')
        self.assertNotIn('Python',text)
        self.assertNotIn('本科',text)
    def test_compaction_preserves_tail(self):
        text,_,compressed=prepare({'title':'例子','body':'工作内容：'+('头'*300)+('中'*300)+('尾'*300)})
        self.assertTrue(compressed)
        self.assertIn('头',text); self.assertIn('中',text); self.assertIn('尾',text)
        self.assertLess(len(text),500)
    def test_threshold_chosen_on_supplied_validation(self):
        c=choose([1,1,0,0],{1:[.9,.8,.4,.2]})
        self.assertTrue(c['meets_precision_recall_target'])
        self.assertEqual(c['validation']['precision'],1)
        self.assertEqual(c['validation']['recall'],1)
    def test_frozen_reference_integrity(self):
        corpus=json.loads((OUT/'corpus.json').read_text(encoding='utf-8'))
        ref=json.loads((OUT/'reference-labels.json').read_text(encoding='utf-8'))
        self.assertEqual(ref['corpus_sha256'],sha(OUT/'corpus.json'))
        self.assertEqual(len(corpus['docs']),200)
        self.assertEqual(len({d['company_group'] for d in corpus['docs']}),200)
        records={r['id']:r for r in ref['records']}
        for d in corpus['docs']:
            self.assertIn(records[d['id']]['quote'],d['body'])
            self.assertEqual(records[d['id']]['content_hash'],d['content_hash'])
        for p,expected in corpus['manifest']['protected_hashes'].items():
            self.assertEqual(sha(ROOT/p),expected,p)
    def test_public_model_asset_integrity(self):
        manifest=json.loads((MODEL/'local-manifest.json').read_text(encoding='utf-8'))
        for p,expected in manifest['files'].items():
            self.assertEqual(sha(MODEL/p),expected['sha256'],p)
    def test_cross_split_near_duplicate_guard(self):
        docs=json.loads((OUT/'corpus.json').read_text(encoding='utf-8'))['docs']
        import unicodedata
        def norm(text):
            text=unicodedata.normalize('NFKC',text).lower()
            return ''.join(c for c in text if not c.isspace() and not c.isdigit() and unicodedata.category(c)[0] not in 'PS')
        normalized=[norm(d['body']) for d in docs]
        grams=[{s[i:i+5] for i in range(len(s)-4)} for s in normalized]
        for i in range(len(docs)):
            for j in range(i):
                a,b=normalized[i],normalized[j]
                if min(len(a),len(b))/max(len(a),len(b))<.75: continue
                similarity=len(grams[i]&grams[j])/len(grams[i]|grams[j])
                self.assertLess(similarity,.8,(docs[i]['id'],docs[j]['id']))
    @unittest.skipUnless((OUT/'results.json').exists(),'training has not sealed results yet')
    def test_result_recomputation_and_seals(self):
        results=json.loads((OUT/'results.json').read_text(encoding='utf-8'))
        pred=json.loads((OUT/'predictions.json').read_text(encoding='utf-8'))
        self.assertEqual(len(pred),800)
        self.assertEqual(results['protocol']['labels_sha256'],sha(OUT/'reference-labels.json'))
        self.assertEqual(results['protocol']['code_sha256'],sha(ROOT/'work/evaluate_role_screening_trial.py'))
        for model, splits in results['scores'].items():
            for split,expected in splits.items():
                rows=[p for p in pred if p['model']==model and p['split']==split]
                known=[p for p in rows if p['label']!='uncertain']
                observed=metric([int(p['label']=='core') for p in known],[int(p['accepted']) for p in known])
                for key,value in observed.items(): self.assertEqual(value,expected[key],(model,split,key))
                self.assertEqual(len(rows),len(known)+expected['uncertain_total'])
                for p in rows: self.assertEqual(p['accepted'],p['score']>=p['threshold'])
        self.assertTrue(all(results['production_unchanged'].values()))

if __name__=='__main__': unittest.main(verbosity=2)
