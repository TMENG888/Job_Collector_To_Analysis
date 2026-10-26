"""Invariant checks, not a claim of semantic classification accuracy."""
import unittest,json,hashlib
from pathlib import Path
import numpy as np
from run_bertopic_discovery import ROOT,SOURCE,EXPECTED_CORPUS,make_protocol,chinese_tokens,run

OUT=SOURCE.parent/'bertopic-codex-20261017-zh-v2'
def read(name):return json.loads((OUT/name).read_text(encoding='utf-8'))
def sha(file):return hashlib.sha256(Path(file).read_bytes()).hexdigest()

class ProtocolTests(unittest.TestCase):
    def test_primary_and_sensitivity_fixed_without_gold(self):
        p=make_protocol()
        self.assertEqual(p['primary']['umap']['random_state'],42)
        self.assertEqual(p['primary']['umap']['n_components'],5)
        self.assertEqual(p['primary']['hdbscan']['min_cluster_size'],50)
        self.assertEqual(len(p['sensitivity']),2)
        self.assertIn('not used to choose',p['selection'])
        self.assertIn('language=multilingual',p['representation'])

    def test_chinese_representation_has_tokens_not_whole_sentences(self):
        tokens=chinese_tokens('负责数据库维护以及网络故障排查，Python Linux。')
        self.assertGreater(len(tokens),3)
        self.assertNotIn('负责',tokens);self.assertIn('python',tokens)
        self.assertTrue(any('网络' in t for t in tokens))

    def test_existing_or_nonexperiment_target_is_refused(self):
        with self.assertRaises(ValueError):run(ROOT)
        with self.assertRaises(FileExistsError):run(SOURCE)

@unittest.skipUnless((OUT/'summary.json').exists(),'fit not finished')
class ResultTests(unittest.TestCase):
    def test_identical_sealed_source_and_vector_provenance(self):
        self.assertEqual(sha(OUT/'corpus.json'),EXPECTED_CORPUS)
        self.assertEqual(sha(SOURCE/'corpus.json'),EXPECTED_CORPUS)
        self.assertEqual(sha(SOURCE/'embeddings.npy'),read('protocol.json')['source_embeddings_sha256'])
        self.assertEqual(read('summary.json')['embedding_seconds_this_run'],0)

    def test_assignments_cover_all_sources_and_preserve_noise(self):
        docs=read('corpus.json')['docs'];rows=read('assignments.json');source={d['key']:d for d in docs}
        self.assertEqual(len(rows),5000);self.assertEqual(len({r['key'] for r in rows}),5000)
        for r in rows:self.assertEqual(r['content_hash'],source[r['key']]['content_hash'])
        metrics=read('summary.json')['methods']['primary50_seed42']
        self.assertEqual(sum(r['cluster']<0 for r in rows),metrics['noise_rows'])
        self.assertEqual(sum(r['cluster']>=0 for r in rows),5000-metrics['noise_rows'])
        self.assertTrue(all(r['status']=='noise_unlabelled' for r in rows if r['cluster']<0))

    def test_naming_and_heldout_are_disjoint_with_traceable_content(self):
        clusters=read('clusters.json')['cards'];audit=read('heldout-audit.json');assign={r['key']:r for r in read('assignments.json')}
        seen=set()
        for c in clusters:
            self.assertEqual(c['rows'],sum(r['cluster']==c['cluster'] for r in assign.values()))
            self.assertEqual(len(c['samples']),6)
            self.assertEqual([s['kind'] for s in c['samples']],['center','center','random','random','boundary','boundary'])
            for sample in c['samples']:
                self.assertNotIn(sample['key'],seen);seen.add(sample['key'])
                self.assertEqual(assign[sample['key']]['cluster'],c['cluster'])
                self.assertEqual(assign[sample['key']]['content_hash'],sample['content_hash'])
        self.assertEqual(len(audit),len(clusters)*2)
        for sample in audit:
            self.assertNotIn(sample['key'],seen);seen.add(sample['key'])
            self.assertEqual(assign[sample['key']]['cluster'],sample['cluster'])
            self.assertEqual(assign[sample['key']]['content_hash'],sample['content_hash'])
        for sample in read('noise-review.json'):self.assertEqual(assign[sample['key']]['cluster'],-1)

    def test_stability_not_presented_as_accuracy(self):
        s=read('summary.json');self.assertIsNone(s['precision']);self.assertIsNone(s['recall'])
        self.assertFalse(s['production_changed']);self.assertEqual(s['paid_api_calls'],0)
        self.assertEqual(s['common_diagnostic_silhouette']['same_rows'],s['methods']['primary50_seed42']['diagnostic_nonnoise_rows'])
        reduced=np.load(OUT/'umap_primary.npy',allow_pickle=False)
        self.assertEqual(reduced.shape,(5000,5));self.assertTrue(np.isfinite(reduced).all())
        self.assertEqual(set(s['methods']),{'primary50_seed42','fine25_seed42','primary50_seed43'})

    def test_chinese_fix_keeps_clusters_and_representatives_identical(self):
        preflight=SOURCE.parent/'bertopic-codex-20261017'
        previous=json.loads((preflight/'clusters.json').read_text(encoding='utf-8'))
        current=read('clusters.json')
        self.assertEqual([c['samples'] for c in previous['cards']],[c['samples'] for c in current['cards']])
        for name in read('summary.json')['methods']:
            self.assertEqual(read(name+'-assignments.json'),json.loads((preflight/(name+'-assignments.json')).read_text(encoding='utf-8')))
        self.assertTrue(any(any('\u4e00'<=ch<='\u9fff' for ch in word) for c in current['cards'] for word,weight in c['topic_words']))

if __name__=='__main__':unittest.main()
