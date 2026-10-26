import json
import unittest
import unicodedata
import numpy as np
from evaluate_crossencoder_role_trial import ROOT, OUT, OLD, MODEL, CATEGORIES, choose_gate, gated
from evaluate_role_screening_trial import metric, sha

class CrossEncoderTrialTests(unittest.TestCase):
    def test_competitor_blocks_core_even_with_positive_core_score(self):
        self.assertEqual(gated(np.array([[3.,4.,0.],[3.,0.,1.]]),{'min_score':0,'min_margin':1}).tolist(),[0,1])
    def test_margin_and_absolute_score_both_needed(self):
        self.assertEqual(gated(np.array([[-3.,-8.,-9.],[3.,2.9,0.],[3.,0.,1.]]),{'min_score':0,'min_margin':1}).tolist(),[0,0,1])
    def test_validation_selection(self):
        gate=choose_gate([1,0],np.array([[4.,0.,1.],[2.,3.,0.]]))
        self.assertTrue(gate['meets_target'])
        self.assertEqual(gate['validation']['precision'],1)
        self.assertEqual(gate['validation']['recall'],1)
    def test_fresh_seal_and_company_isolation(self):
        old=json.loads((OLD/'corpus.json').read_text(encoding='utf-8'))
        fresh=json.loads((OUT/'fresh-corpus.json').read_text(encoding='utf-8'))
        ref=json.loads((OUT/'fresh-reference-labels.json').read_text(encoding='utf-8'))
        self.assertEqual(ref['corpus_sha256'],sha(OUT/'fresh-corpus.json'))
        self.assertEqual(fresh['manifest']['old_corpus_sha256'],sha(OLD/'corpus.json'))
        docs=old['docs']+fresh['docs']
        self.assertEqual(len(docs),300);self.assertEqual(len({d['company_group'] for d in docs}),300)
        rr={r['id']:r for r in ref['records']}
        for d in fresh['docs']:
            self.assertIn(rr[d['id']]['quote'],d['body'])
            self.assertEqual(rr[d['id']]['content_hash'],d['content_hash'])
        for p,h in old['manifest']['protected_hashes'].items():self.assertEqual(sha(ROOT/p),h)
    def test_fresh_near_duplicate_isolation(self):
        old=json.loads((OLD/'corpus.json').read_text(encoding='utf-8'))['docs']
        fresh=json.loads((OUT/'fresh-corpus.json').read_text(encoding='utf-8'))['docs']
        def norm(s):return ''.join(c for c in unicodedata.normalize('NFKC',s).lower() if not c.isspace() and not c.isdigit() and unicodedata.category(c)[0] not in 'PS')
        docs=old+fresh;texts=[norm(d['body']) for d in docs]
        grams=[{s[i:i+5] for i in range(len(s)-4)} for s in texts]
        for i in range(200,300):
            for j in range(i):
                if min(len(texts[i]),len(texts[j]))/max(len(texts[i]),len(texts[j]))<.75:continue
                self.assertLess(len(grams[i]&grams[j])/len(grams[i]|grams[j]),.8,(docs[i]['id'],docs[j]['id']))
    def test_pinned_model_assets(self):
        manifest=json.loads((MODEL/'local-manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['revision'],'1427fd652930e4ba29e8149678df786c240d8825')
        for p,m in manifest['files'].items():self.assertEqual(sha(MODEL/p),m['sha256'])
    @unittest.skipUnless((OUT/'results.json').exists(),'inference not finished')
    def test_sealed_predictions_and_metrics(self):
        r=json.loads((OUT/'results.json').read_text(encoding='utf-8'))
        pred=json.loads((OUT/'predictions.json').read_text(encoding='utf-8'))
        scores=json.loads((OUT/'crossencoder-scores.json').read_text(encoding='utf-8'))
        self.assertEqual(len(pred),1800);self.assertEqual(len(scores),300)
        self.assertEqual(r['protocol']['code_sha256'],sha(ROOT/'work/evaluate_crossencoder_role_trial.py'))
        self.assertEqual(r['protocol']['fresh_labels_sha256'],sha(OUT/'fresh-reference-labels.json'))
        self.assertEqual(r['protocol']['old_labels_sha256'],sha(OLD/'reference-labels.json'))
        for name,splits in r['metrics'].items():
            for split,expected in splits.items():
                rows=[p for p in pred if p['model']==name and p['split']==split]
                known=[p for p in rows if p['label']!='uncertain']
                observed=metric([int(p['label']=='core') for p in known],[int(p['accepted']) for p in known])
                for k,v in observed.items():self.assertEqual(v,expected[k],(name,split,k))
                self.assertEqual(len(rows)-len(known),expected['uncertain_total'])
        raw=np.array([[s['scores'][c] for c in CATEGORIES] for s in scores])
        accept=gated(raw,r['gate']).tolist()
        for s,a in zip(scores,accept):
            self.assertEqual(s['nearest_description'],max(s['scores'],key=s['scores'].get))
            self.assertEqual(s['core_admitted'],bool(a))
            self.assertIn(s['final_decision'],['core','not_core_or_review'])
        for m in r['prior_models_reproducibility'].values():
            self.assertTrue(m['all_old_decisions_same']);self.assertLess(m['max_score_difference_old200'],1e-5)
        self.assertTrue(all(r['production_unchanged'].values()))

if __name__=='__main__':unittest.main(verbosity=2)
