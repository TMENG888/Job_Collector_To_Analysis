import json
import unittest
import unicodedata
from collections import Counter
from train_codex_role_classifier import OUT,ROOT,choose,metric,sha,rank

class CodexClassifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.corpus=json.loads((OUT/'corpus.json').read_text(encoding='utf-8'))
        cls.fresh=json.loads((OUT/'fresh-reference-labels.json').read_text(encoding='utf-8'))
        inherited=json.loads((OUT/'inherited-labels.json').read_text(encoding='utf-8'))
        cls.labels={r['id']:r for r in cls.fresh['records']+inherited['records']}

    def test_reference_seals_and_quotes(self):
        self.assertEqual(self.fresh['corpus_sha256'],sha(OUT/'corpus.json'))
        self.assertEqual(len(self.labels),480)
        for d in self.corpus['docs']:
            r=self.labels[d['id']];self.assertIn(r['quote'],d['body']);self.assertEqual(r['content_hash'],d['content_hash'])

    def test_fresh_tests_never_reuse_old_evaluation(self):
        docs=self.corpus['docs']
        test=[d for d in docs if d['split'].startswith('test')]
        self.assertEqual(len(test),120)
        self.assertTrue(all(d['origin']=='new_blind_review' and d['id'].startswith('N') for d in test))
        self.assertEqual(Counter(d['split'] for d in test),{'test_random':80,'test_challenge':40})
        self.assertEqual(len({d['company_group'] for d in docs}),480)

    def test_near_duplicate_isolation(self):
        def norm(s):return ''.join(c for c in unicodedata.normalize('NFKC',s).lower() if not c.isspace() and not c.isdigit() and unicodedata.category(c)[0] not in 'PS')
        docs=self.corpus['docs'];texts=[norm(d['body']) for d in docs]
        grams=[{s[i:i+5] for i in range(len(s)-4)} for s in texts]
        for i in range(len(docs)):
            for j in range(i):
                if min(len(texts[i]),len(texts[j]))/max(len(texts[i]),len(texts[j]))<.75:continue
                self.assertLess(len(grams[i]&grams[j])/len(grams[i]|grams[j]),.8,(docs[i]['id'],docs[j]['id']))

    def test_production_untouched(self):
        for p,h in self.corpus['manifest']['protected_hashes'].items():self.assertEqual(sha(ROOT/p),h,p)

    def test_validation_threshold_selection(self):
        chosen=choose([1,1,0,0],{1:[.9,.8,.3,.1]})
        self.assertTrue(chosen['meets_target']);self.assertEqual(chosen['validation']['f1'],1)

    def test_no_predictions_undefined_precision(self):
        m=metric([1,0],[0,0]);self.assertIsNone(m['precision']);self.assertEqual(m['recall'],0)

    @unittest.skipUnless((OUT/'results.json').exists(),'training running')
    def test_results_recomputed_and_selection_locked(self):
        r=json.loads((OUT/'results.json').read_text(encoding='utf-8'))
        pred=json.loads((OUT/'predictions.json').read_text(encoding='utf-8'))
        seal=json.loads((OUT/'selection-before-test.json').read_text(encoding='utf-8'))
        self.assertEqual(len(pred),480*6)
        self.assertEqual(r['protocol']['code_sha256'],sha(ROOT/'work/train_codex_role_classifier.py'))
        self.assertEqual(r['protocol']['labels_sha256'],sha(OUT/'fresh-reference-labels.json'))
        self.assertEqual(seal['classifier_sha256'],sha(OUT/'classifier.json'))
        self.assertEqual(r['winner'],max(seal['selections'],key=lambda n:rank(seal['selections'][n]['validation'])))
        for name,splits in r['metrics'].items():
            for split,expected in splits.items():
                rows=[p for p in pred if p['model']==name and p['split']==split]
                known=[p for p in rows if p['label']!='uncertain']
                actual=metric([int(p['label']=='core') for p in known],[int(p['accepted']) for p in known])
                for k,v in actual.items():self.assertEqual(expected[k],v,(name,split,k))
                self.assertEqual(expected['uncertain_total'],len(rows)-len(known))
                for p in rows:self.assertEqual(p['accepted'],p['score']>=p['threshold'])
        self.assertTrue(all(r['production_unchanged'].values()))

    @unittest.skipUnless((OUT/'results.json').exists(),'training running')
    def test_safe_serialization_predictions_roundtrip(self):
        from predict_codex_role_classifier import predict
        pred=json.loads((OUT/'predictions.json').read_text(encoding='utf-8'))
        # Verify new-process loader on frozen and finetuned encoders as well as no-pickle lexical head.
        sample=[d for d in self.corpus['docs'] if d['split']=='test_random'][:4]
        for method in ['char_tfidf_lr','bge_frozen_lr','setfit_bge_lr','ensemble_equal']:
            actual=predict(sample,method=method)
            expected={p['id']:p for p in pred if p['model']==method}
            for d,p in zip(sample,actual):
                self.assertEqual(p['accepted'],expected[d['id']]['accepted'])
                self.assertAlmostEqual(p['score'],expected[d['id']]['score'],places=5)
        self.assertEqual(predict([]),[])
        with self.assertRaises(ValueError):predict([{'title':'a','body':'a'*9001}])

    @unittest.skipUnless((OUT/'results.json').exists(),'training running')
    def test_cli_process_json_roundtrip(self):
        import subprocess
        import sys
        sample=[d for d in self.corpus['docs'] if d['id']=='N081']
        proc=subprocess.run([sys.executable,str(ROOT/'work/predict_codex_role_classifier.py')],
            input=json.dumps(sample,ensure_ascii=False),encoding='utf-8',capture_output=True,check=True,cwd=ROOT)
        rows=json.loads(proc.stdout)
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['id'],'N081')
        self.assertIn('not calibrated',rows[0]['warning'])
        self.assertEqual(rows[0]['target'],'数据分析')

    @unittest.skipUnless((OUT/'results.json').exists(),'training running')
    def test_export_recovery_preserves_original_training(self):
        r=json.loads((OUT/'results.json').read_text(encoding='utf-8'))
        recovery=r['export_recovery']
        self.assertTrue(recovery['validation_matches_original_logged_run'])
        self.assertTrue(recovery['original_weights_identical'])
        self.assertEqual(recovery['wrapper_sha256'],sha(ROOT/'work/resume_codex_classifier_export.py'))
        self.assertEqual(recovery['original_train_code_sha256'],r['protocol']['code_sha256'])
        self.assertEqual(recovery['trained_weight_hashes']['model.safetensors'],sha(OUT/'trained-encoder/model.safetensors'))

if __name__=='__main__':unittest.main(verbosity=2)
