"""Read-only experiment integrity and safe inference regression checks."""
import json
import subprocess
import sys
import unittest
import unicodedata
from collections import Counter
from evaluate_bayes_role_trial import OUT,OLD,ROOT,PROTOCOL,choose,rank,read,metric,prepare,sha

class BayesTrialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old=read(OLD/'corpus.json');cls.fresh=read(OUT/'fresh-corpus.json')
        cls.docs=cls.old['docs']+cls.fresh['docs']
        cls.labels={r['id']:r for r in read(OLD/'inherited-labels.json')['records']+
                    read(OLD/'fresh-reference-labels.json')['records']+read(OUT/'fresh-reference-labels.json')['records']}
        cls.artifact=read(OUT/'classifier.json');cls.seal=read(OUT/'selection-before-test.json')
        cls.results=read(OUT/'results.json');cls.pred=read(OUT/'predictions.json')

    def test_protocol_and_inputs_sealed(self):
        lock=read(OUT/'evaluation-protocol.json')
        self.assertEqual(lock['protocol'],PROTOCOL)
        self.assertEqual(lock['code_sha256'],sha(ROOT/'work/evaluate_bayes_role_trial.py'))
        self.assertEqual(lock['input_code_sha256'],sha(ROOT/'work/evaluate_role_screening_trial.py'))
        self.assertEqual(lock['predictor_sha256'],sha(ROOT/'work/predict_bayes_role_classifier.py'))
        self.assertEqual(lock['fresh_corpus_sha256'],sha(OUT/'fresh-corpus.json'))
        self.assertEqual(lock['fresh_labels_sha256'],sha(OUT/'fresh-reference-labels.json'))
        for p,h in lock['prior_hashes'].items():self.assertEqual(sha(OLD/p),h,p)
        self.assertEqual(self.seal['classifier_sha256'],sha(OUT/'classifier.json'))
        self.assertEqual(self.results['protocol'],lock)
        self.assertEqual(self.artifact['protocol'],lock)
        self.assertLess(self.seal['sealed_at'],self.results['completed_at'])

    def test_training_splits_unchanged_no_new_test_fitting(self):
        for split,key,count in [('train','training_ids',286),('validation','validation_ids',57)]:
            expected=[d['id'] for d in self.old['docs'] if d['split']==split and self.labels[d['id']]['label']!='uncertain']
            self.assertEqual(expected,self.seal[key]);self.assertEqual(len(expected),count)
            self.assertTrue(all(not id.startswith('B') for id in expected))
        self.assertEqual(self.results['training_counts'],{'0':206,'1':80})
        self.assertEqual(self.results['validation_counts'],{'0':44,'1':13})
        self.assertEqual(Counter(d['split'] for d in self.fresh['docs']),{'fresh_random':80,'fresh_challenge':40})
        self.assertEqual(len({d['key'] for d in self.docs}),600)
        self.assertEqual(len({d['company_group'] for d in self.docs}),600)

    def test_exact_reference_quotes_and_hashes(self):
        ref=read(OUT/'fresh-reference-labels.json')
        self.assertEqual(ref['corpus_sha256'],sha(OUT/'fresh-corpus.json'))
        self.assertEqual(len(self.labels),600)
        for d in self.docs:
            label=self.labels[d['id']]
            self.assertIn(label['quote'],d['body'],d['id'])
            self.assertEqual(label['content_hash'],d['content_hash'])
        self.assertEqual(len([r for r in ref['records'] if r['label']=='uncertain']),8)

    def test_near_jd_isolation_new_against_all_prior_and_other_new(self):
        def norm(s):return ''.join(c for c in unicodedata.normalize('NFKC',s).lower() if not c.isspace() and not c.isdigit() and unicodedata.category(c)[0] not in 'PS')
        texts=[norm(d['body']) for d in self.docs];grams=[{s[i:i+5] for i in range(len(s)-4)} for s in texts]
        for i in range(480,600):
            for j in range(i):
                if min(len(texts[i]),len(texts[j]))/max(len(texts[i]),len(texts[j]))<.75:continue
                self.assertLess(len(grams[i]&grams[j])/len(grams[i]|grams[j]),.8,(self.docs[i]['id'],self.docs[j]['id']))

    def test_vectorizer_fitted_on_original_training_only(self):
        import numpy as np
        from sklearn.feature_extraction.text import TfidfVectorizer
        prior=read(OLD/'classifier.json')
        self.assertEqual(self.artifact['tfidf'],prior['tfidf'])
        rows=[d for d in self.old['docs'] if d['id'] in self.seal['training_ids']]
        vectorizer=TfidfVectorizer(analyzer='char',ngram_range=(2,4),min_df=2,max_features=30000,sublinear_tf=True).fit([prepare(d)[0] for d in rows])
        self.assertEqual(vectorizer.vocabulary_,prior['tfidf']['vocabulary'])
        np.testing.assert_allclose(vectorizer.idf_,prior['tfidf']['idf'],rtol=0,atol=0)

    def test_grid_selection_on_validation_only(self):
        grid=read(OUT/'validation-grid.json')
        docs={d['id']:d for d in self.docs};y=[int(self.labels[id]['label']=='core') for id in self.seal['validation_ids']]
        for kind,entries in grid.items():
            self.assertEqual(len(entries),6)
            actual=choose(y,[(row['config'],row['scores']) for row in entries])
            self.assertEqual(actual,self.seal['selections'][kind])
        self.assertEqual(self.results['winner'],max(self.seal['selections'],key=lambda n:rank(self.seal['selections'][n]['validation'])))
        # undefined precision cannot beat a perfect separation at an interior threshold
        self.assertEqual(choose([1,0],[({'alpha':1,'fit_prior':False},[.9,.1])])['validation']['f1'],1)
        self.assertIsNone(metric([1,0],[0,0])['precision'])

    def test_sklearn_to_json_all_predictions_roundtrip(self):
        import numpy as np
        from sklearn.naive_bayes import MultinomialNB,ComplementNB
        from predict_codex_role_classifier import restore_vectorizer
        from predict_bayes_role_classifier import predict
        train_ids=set(self.seal['training_ids']);train=[d for d in self.docs if d['id'] in train_ids]
        v=restore_vectorizer(self.artifact['tfidf']);xt=v.transform([prepare(d)[0] for d in train]);x=v.transform([prepare(d)[0] for d in self.docs])
        for kind,cls in [('multinomial_nb',MultinomialNB),('complement_nb',ComplementNB)]:
            model=cls(**self.seal['selections'][kind]['config']).fit(xt,[int(self.labels[d['id']]['label']=='core') for d in train])
            expected=model.predict_proba(x)[:,1]
            actual=[]
            for start in range(0,600,200):actual.extend(predict(self.docs[start:start+200],method=kind))
            np.testing.assert_allclose([p['score'] for p in actual],expected,rtol=0,atol=1e-10)
            lookup={p['id']:p for p in self.pred if p['model']==kind}
            for p in actual:
                self.assertEqual(p['accepted'],lookup[p['id']]['accepted'])
                self.assertAlmostEqual(p['score'],lookup[p['id']]['score'],places=10)
        self.assertEqual(predict([]),[])
        for bad in [None,[{}],[{'title':'a','body':'a'*9001}],[{'title':'a','body':'b'}]*257]:
            with self.assertRaises(ValueError):predict(bad)

    def test_cnb_binary_equivalence(self):
        self.assertEqual(len(self.results['equivalence_max_abs_error']),3)
        for error in self.results['equivalence_max_abs_error'].values():self.assertLess(error,1e-10)
        a=[p['accepted'] for p in self.pred if p['model']=='multinomial_nb']
        b=[p['accepted'] for p in self.pred if p['model']=='complement_nb']
        self.assertEqual(a,b)

    def test_metrics_and_uncertain_separate(self):
        self.assertEqual(len(self.pred),600*4)
        for model,splits in self.results['metrics'].items():
            for split,m in splits.items():
                rows=[p for p in self.pred if p['model']==model and p['split']==split]
                known=[p for p in rows if p['label']!='uncertain'];unknown=[p for p in rows if p['label']=='uncertain']
                actual=metric([int(p['label']=='core') for p in known],[int(p['accepted']) for p in known])
                for k,v in actual.items():self.assertEqual(m[k],v,(model,split,k))
                self.assertEqual(m['uncertain_total'],len(unknown));self.assertEqual(m['uncertain_accepted'],sum(p['accepted'] for p in unknown))
                for p in rows:self.assertEqual(p['accepted'],p['score']>=p['threshold'])

    def test_previous_lr_baseline_reproduced(self):
        from predict_codex_role_classifier import restore_vectorizer,linear_scores
        old=read(OLD/'predictions.json');lookup={(p['model'],p['id']):p for p in self.pred}
        for p in old:
            if p['model']=='char_tfidf_lr':
                q=lookup[(p['model'],p['id'])];self.assertEqual(p['accepted'],q['accepted']);self.assertAlmostEqual(p['score'],q['score'],places=10)
        prior=read(OLD/'classifier.json');x=restore_vectorizer(prior['tfidf']).transform([prepare(d)[0] for d in self.fresh['docs']])
        for d,s in zip(self.fresh['docs'],linear_scores(x,prior['heads']['char_tfidf_lr'])):
            self.assertAlmostEqual(float(s),lookup[('char_tfidf_lr',d['id'])]['score'],places=10)

    def test_production_and_prior_untouched(self):
        for p,h in self.old['manifest']['protected_hashes'].items():self.assertEqual(sha(ROOT/p),h,p)
        self.assertTrue(all(self.results['production_unchanged'].values()))
        # Recheck frozen rule decisions against the current unchanged implementation, no database access.
        script="import{matchUniversalRoleKeywords as m}from './work/universal-role-keywords.mjs';let s='';for await(const c of process.stdin)s+=c;const d=JSON.parse(s);console.log(JSON.stringify(d.rows.map(r=>m({'岗位名称':r.title,'岗位描述':r.body},d.keywords).matched)));"
        proc=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps({'rows':self.fresh['docs'],'keywords':self.old['manifest']['baseline_keywords']},ensure_ascii=False),encoding='utf-8',capture_output=True,check=True,cwd=ROOT)
        self.assertEqual(json.loads(proc.stdout),[d['baseline']['matched'] for d in self.fresh['docs']])

    def test_predict_cli_new_process(self):
        proc=subprocess.run([sys.executable,str(ROOT/'work/predict_bayes_role_classifier.py')],input=json.dumps(self.fresh['docs'][:2],ensure_ascii=False),encoding='utf-8',capture_output=True,check=True,cwd=ROOT)
        rows=json.loads(proc.stdout);self.assertEqual([r['id'] for r in rows],['B001','B002'])
        self.assertTrue(all(r['status']=='offline_experimental_only' for r in rows))

if __name__=='__main__':unittest.main(verbosity=2)
