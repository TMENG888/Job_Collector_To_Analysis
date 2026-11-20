import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import numpy as np

from resume_vector_cache import ENCODING_CONTRACT, materialize_vectors


TEST_ROOT = Path('E:/Codex/temp/20261118-incremental-vectors')
TEST_ROOT.mkdir(parents=True, exist_ok=True)
MODEL = {'repo': 'fixture/local-encoder', 'revision': 'v1', 'files_sha256': 'fixture-files-v1'}


def expected(text):
    return np.frombuffer(hashlib.sha256(text.encode()).digest(), dtype=np.uint8)[:4].astype(np.float32)


class VectorCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=TEST_ROOT)
        self.root = Path(self.temp.name)
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def encode(self, texts):
        self.calls.extend(texts)
        return np.array([expected(text) for text in texts])

    def run_cache(self, chunks, **kwargs):
        return materialize_vectors(self.root, chunks, MODEL, self.encode, dimension=4, batch_size=2, legacy_model=MODEL, **kwargs)

    def assertAligned(self, actual, chunks):
        np.testing.assert_array_equal(actual, np.array([expected(text) for text in chunks]))

    def legacy(self, chunks, *, partial=None):
        identity = {k: MODEL[k] for k in ('repo', 'revision')}
        fingerprint = hashlib.sha256(json.dumps([identity, chunks], ensure_ascii=False).encode()).hexdigest()
        folder = self.root / fingerprint
        folder.mkdir()
        matrix = np.array([expected(text) for text in chunks])
        if partial is None:
            np.save(folder / 'embeddings.npy', matrix)
            meta = {'fingerprint': fingerprint, 'model': identity, 'shape': [len(chunks), 4]}
            name = 'embedding-cache.json'
        else:
            matrix[partial:] = np.nan
            np.save(folder / 'embeddings.partial.npy', matrix)
            meta = {'fingerprint': fingerprint, 'done': partial, 'total': len(chunks)}
            name = 'embedding-progress.json'
        (folder / name).write_text(json.dumps(meta), encoding='utf-8')
        return folder

    def test_initial_encoding_then_new_resume_queries_reuse_all_job_vectors(self):
        chunks = ['岗位A\nPython开发', '岗位B\nSQL分析', '岗位A\nPython开发']
        vectors, first = self.run_cache(chunks)
        self.assertEqual(self.calls, chunks[:2])
        self.assertEqual(first['encoded_chunks'], 2)
        self.assertEqual(first['duplicate_chunks'], 1)
        self.assertAligned(vectors, chunks)
        self.calls.clear()
        # Resume queries have their own encoder call; they never affect JD keys.
        for query in ('Python开发', '增加Docker及Redis项目经验'):
            query_vector = expected(query)
            vectors, cached = self.run_cache(chunks)
            self.assertEqual((vectors @ query_vector).shape, (3,))
            self.assertEqual(cached['encoded_chunks'], 0)
            self.assertEqual(cached['reused_chunks'], 2)
        self.assertEqual(self.calls, [])

    def test_added_modified_deleted_reordered_jobs_preserve_alignment(self):
        self.run_cache(['A\nunchanged-window', 'A\nold-window', 'B\nbody'])
        self.calls.clear()
        chunks = ['B\nbody', 'A\nnew-window', 'A\nunchanged-window', 'C\nnew-job']
        actual, stats = self.run_cache(chunks)
        self.assertEqual(self.calls, ['A\nnew-window', 'C\nnew-job'])
        self.assertEqual(stats['reused_chunks'], 2)
        self.assertAligned(actual, chunks)
        self.calls.clear()
        actual, stats = self.run_cache(['C\nnew-job', 'B\nbody', 'B\nbody'])
        self.assertEqual(self.calls, [])
        self.assertAligned(actual, ['C\nnew-job', 'B\nbody', 'B\nbody'])

    def test_model_files_revision_and_preprocessing_invalidate_only_their_namespace(self):
        self.run_cache(['A'])
        for model in ({**MODEL, 'revision': 'v2'}, {**MODEL, 'files_sha256': 'fixture-files-v2'}):
            _, stats = materialize_vectors(self.root, ['A'], model, self.encode, dimension=4)
            self.assertEqual(stats['encoded_chunks'], 1)
        _, stats = self.run_cache(['A'], contract={**ENCODING_CONTRACT, 'overlap_tokens': 20})
        self.assertEqual(stats['encoded_chunks'], 1)
        _, stats = self.run_cache(['A'])
        self.assertEqual(stats['encoded_chunks'], 0)

    def test_committed_batch_survives_process_failure(self):
        count = 0

        def interrupted(texts):
            nonlocal count
            count += 1
            if count == 2:
                raise RuntimeError('fixture interrupted')
            return self.encode(texts)

        chunks = ['A', 'B', 'C', 'D', 'E']
        with self.assertRaisesRegex(RuntimeError, 'interrupted'):
            materialize_vectors(self.root, chunks, MODEL, interrupted, dimension=4, batch_size=2)
        self.calls.clear()
        actual, stats = self.run_cache(chunks)
        self.assertEqual(self.calls, ['C', 'D', 'E'])
        self.assertEqual(stats['reused_chunks'], 2)
        self.assertAligned(actual, chunks)

    def test_complete_legacy_cache_is_imported_without_reencoding(self):
        chunks = ['A', 'B', 'A']
        folder = self.legacy(chunks)
        actual, stats = self.run_cache(chunks)
        self.assertEqual(self.calls, [])
        self.assertEqual(stats['imported_chunks'], 2)
        self.assertAligned(actual, chunks)
        self.assertTrue((folder / 'embeddings.npy').exists())

    def test_legacy_partial_imports_only_durable_prefix(self):
        chunks = ['A', 'B', 'C', 'D']
        self.legacy(chunks, partial=2)
        actual, stats = self.run_cache(chunks)
        self.assertEqual(self.calls, ['C', 'D'])
        self.assertEqual(stats['imported_chunks'], 2)
        self.assertAligned(actual, chunks)

    def test_legacy_wrong_metadata_or_text_order_never_imported(self):
        chunks = ['A', 'B']
        folder = self.legacy(chunks)
        meta = folder / 'embedding-cache.json'
        value = json.loads(meta.read_text())
        value['fingerprint'] = 'fixture-wrong-fingerprint'
        meta.write_text(json.dumps(value))
        _, stats = self.run_cache(chunks)
        self.assertEqual(stats['imported_chunks'], 0)
        self.assertEqual(self.calls, chunks)
        _, stats = self.run_cache(['B', 'A', 'C'])
        self.assertEqual(stats['imported_chunks'], 0)
        self.assertEqual(stats['encoded_chunks'], 1)

    def test_preprocessing_change_cannot_import_old_matrix(self):
        self.legacy(['A'])
        _, stats = self.run_cache(['A'], contract={**ENCODING_CONTRACT, 'max_seq_length': 256})
        self.assertEqual(stats['imported_chunks'], 0)
        self.assertEqual(self.calls, ['A'])

    def test_changed_model_files_cannot_import_legacy_with_same_model_id(self):
        self.legacy(['A'])
        _, stats = materialize_vectors(self.root, ['A'], {**MODEL, 'files_sha256': 'changed'}, self.encode,
                                      dimension=4, legacy_model=MODEL)
        self.assertEqual(stats['imported_chunks'], 0)
        self.assertEqual(self.calls, ['A'])

    def test_corrupt_vector_is_recomputed_without_discarding_good_rows(self):
        self.run_cache(['A', 'B', 'C'])
        db = sqlite3.connect(self.root / 'chunk-vectors-v1.sqlite3')
        with db:
            db.execute('UPDATE vectors SET vector=? WHERE text_hash=?', (b'bad', hashlib.sha256(b'B').hexdigest()))
            bad = np.full(4, np.nan, dtype='<f4').tobytes()
            db.execute('UPDATE vectors SET vector=?, checksum=? WHERE text_hash=?', (bad, hashlib.sha256(bad).hexdigest(), hashlib.sha256(b'C').hexdigest()))
        db.close()
        self.calls.clear()
        actual, stats = self.run_cache(['C', 'B', 'A'])
        self.assertEqual(self.calls, ['C', 'B'])
        self.assertEqual(stats['reused_chunks'], 1)
        self.assertAligned(actual, ['C', 'B', 'A'])

    def test_invalid_encoder_output_is_not_saved(self):
        for output in (np.zeros((1, 3)), np.full((1, 4), np.nan)):
            with self.assertRaisesRegex(ValueError, 'invalid vectors'):
                materialize_vectors(self.root, ['A'], MODEL, lambda _: output, dimension=4)
        _, stats = self.run_cache(['A'])
        self.assertEqual(stats['encoded_chunks'], 1)

    def test_empty_pool_and_progress_counts(self):
        vectors, stats = self.run_cache([])
        self.assertEqual(vectors.shape, (0, 4))
        self.assertEqual(stats['encoded_chunks'], 0)
        self.run_cache(['A', 'B'])
        events = []
        self.run_cache(['A', 'B', 'C', 'D', 'E', 'C'], on_progress=lambda stage, **data: events.append((stage, data)))
        self.assertEqual(events[0][1]['total'], 3)
        self.assertEqual(events[0][1]['reused_chunks'], 2)
        self.assertEqual(events[-1][1]['done'], 3)


if __name__ == '__main__':
    unittest.main()
