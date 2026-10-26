"""Source-evidence supervised occupational admission pilot. Offline, no production writes."""
import os
for k,v in {'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','HF_HUB_DISABLE_TELEMETRY':'1','TOKENIZERS_PARALLELISM':'false','OMP_NUM_THREADS':'2','MKL_NUM_THREADS':'2','DO_NOT_TRACK':'1','WANDB_DISABLED':'true'}.items():
    os.environ[k]=v
import json
import subprocess
import time
from collections import Counter
from pathlib import Path
from evaluate_role_screening_trial import ROOT, MODEL, prepare, metric, sha

OUT=ROOT/'ui_data/insights/comparisons/codex-classifier-20261016'
PROTOCOL={
 'target':'数据分析', 'labels':'core positive; adjacent/exclude/store_ops/data_engineering/other negative; uncertain excluded from fitting and binary metrics',
 'annotation':'Codex source evidence, not independent human gold. No synthetic JD or title-as-gold labels.',
 'development':'previous300 reviewed JDs reallocated as development only; plus new60 directed training; previous tests are NOT tests anymore',
 'new_test':'new80 company-capped random + new40 directed challenge; companies and near-JDs isolated against all development data; report separately',
 'input':'same generic prepare() as first pilot: title60 + duty head/middle/tail420 chars; max512tokens; no new target exclusion rules',
 'seed':42,'threads':2,'batch_size':4,'max_seq_length':512,
 'tfidf':{'analyzer':'char','ngram_range':[2,4],'min_df':2,'max_features':30000,'sublinear_tf':True},
 'Cs':[.1,1,10],'thresholds':[round(.2+.05*i,2) for i in range(16)],
 'selection':'validation only; prefer precision>=.95 and recall>=.7 then maximize recall, precision; else F0.5 then recall; model winner locked before new test metrics',
 'setfit':{'steps':160,'iterations':4,'learning_rate':2e-5,'epochs':1},
 'ensemble':'fixed equal mean of validation-selected char and SetFit scores; threshold on validation only; not an ablation',
 'probabilities':'discriminative scores are NOT calibrated confidence or causal estimates',
 'scope_limit':'one target role family only; not role-definition/JD general model; novel families require separate evaluation',
}

def save(name,data):
    path=OUT/name
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')

def rank(m):
    meets=(m['precision'] or 0)>=.95 and (m['recall'] or 0)>=.7
    return (int(meets), m['recall'] if meets else m['f05'],m['precision'] or 0,m['recall'] or 0)

def choose(y,by_c):
    choices=[]
    for c,scores in by_c.items():
        for t in PROTOCOL['thresholds']:
            m=metric(y,[int(s>=t) for s in scores])
            choices.append((rank(m)+(-c,-abs(t-.5)),{'C':c,'threshold':t,'validation':m,'meets_target':rank(m)[0]==1}))
    return max(choices,key=lambda v:v[0])[1]

def head_json(head):
    return {'classes':head.classes_.tolist(),'coef':head.coef_[0].tolist(),'intercept':float(head.intercept_[0])}

def main():
    if (OUT/'results.json').exists():raise RuntimeError('Results sealed; create new version and new test for further tuning')
    corpus=json.loads((OUT/'corpus.json').read_text(encoding='utf-8'))
    inherited=json.loads((OUT/'inherited-labels.json').read_text(encoding='utf-8'))
    fresh=json.loads((OUT/'fresh-reference-labels.json').read_text(encoding='utf-8'))
    assert fresh['corpus_sha256']==sha(OUT/'corpus.json')
    docs=corpus['docs'];labels={r['id']:r for r in inherited['records']+fresh['records']}
    assert len(docs)==480 and len(labels)==480 and len({d['company_group'] for d in docs})==480
    for d in docs:
        assert labels[d['id']]['quote'] in d['body']
        assert labels[d['id']]['content_hash']==d['content_hash']
    for p,h in corpus['manifest']['protected_hashes'].items():assert sha(ROOT/p)==h,p
    assets=json.loads((MODEL/'local-manifest.json').read_text(encoding='utf-8'))
    for p,m in assets['files'].items():assert sha(MODEL/p)==m['sha256']
    lock={'protocol':PROTOCOL,'code_sha256':sha(__file__),'input_code_sha256':sha(ROOT/'work/evaluate_role_screening_trial.py'),
        'corpus_sha256':sha(OUT/'corpus.json'),'labels_sha256':sha(OUT/'fresh-reference-labels.json'),
        'inherited_labels_sha256':sha(OUT/'inherited-labels.json'),'assets_sha256':sha(MODEL/'local-manifest.json')}
    if (OUT/'evaluation-protocol.json').exists():assert json.loads((OUT/'evaluation-protocol.json').read_text(encoding='utf-8'))==lock
    else:save('evaluation-protocol.json',lock)
    prepared=[prepare(d) for d in docs];texts=[p[0] for p in prepared]
    save('model-inputs.json',[{'id':d['id'],'text':p[0],'mode':p[1],'compressed':p[2]} for d,p in zip(docs,prepared)])
    train=[i for i,d in enumerate(docs) if d['split']=='train' and labels[d['id']]['label']!='uncertain']
    val=[i for i,d in enumerate(docs) if d['split']=='validation' and labels[d['id']]['label']!='uncertain']
    y=lambda indexes:[int(labels[docs[i]['id']]['label']=='core') for i in indexes]
    print(json.dumps({'training':Counter(y(train)),'validation':Counter(y(val)),'compressed':sum(p[2] for p in prepared)}),flush=True)
    import numpy as np
    import psutil
    import torch
    from sklearn.linear_model import LogisticRegression
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sentence_transformers import SentenceTransformer
    from transformers import set_seed
    torch.set_num_threads(2);torch.set_num_interop_threads(2);set_seed(42)
    if psutil.virtual_memory().available<3*1024**3:raise RuntimeError('Less than3GB memory; abort safely')
    started=time.perf_counter();timings={};scores={};selections={};export={'protocol':lock,'scope':'数据分析 only; experimental, not production','heads':{}}
    def fit_heads(name,x):
        fits={c:LogisticRegression(C=c,class_weight='balanced',max_iter=1500,random_state=42).fit(x[train],y(train)) for c in PROTOCOL['Cs']}
        selected=choose(y(val),{c:f.predict_proba(x[val])[:,1].tolist() for c,f in fits.items()})
        head=fits[selected['C']];scores[name]=head.predict_proba(x)[:,1].tolist();selections[name]=selected
        export['heads'][name]=head_json(head)
        print(name+' validation '+json.dumps(selected),flush=True)
    step=time.perf_counter()
    vectorizer=TfidfVectorizer(analyzer='char',ngram_range=(2,4),min_df=2,max_features=30000,sublinear_tf=True)
    vectorizer.fit([texts[i] for i in train]);xchar=vectorizer.transform(texts)
    fit_heads('char_tfidf_lr',xchar)
    export['tfidf']={'vocabulary':vectorizer.vocabulary_,'idf':vectorizer.idf_.tolist(),'ngram_range':[2,4],'sublinear_tf':True}
    timings['char_fit_and_all_inference_seconds']=time.perf_counter()-step
    step=time.perf_counter()
    encoder=SentenceTransformer(str(MODEL),device='cpu',local_files_only=True,trust_remote_code=False);encoder.max_seq_length=512
    lengths=encoder.tokenizer(texts,truncation=False,return_length=True)['length']
    save('tokenization-audit.json',{'over512':sum(n>512 for n in lengths),'max_tokens':max(lengths),'compressed':sum(p[2] for p in prepared)})
    x=encoder.encode(texts,batch_size=4,normalize_embeddings=True,show_progress_bar=False,convert_to_numpy=True)
    fit_heads('bge_frozen_lr',x);timings['bge_encode_fit_seconds']=time.perf_counter()-step
    print('Starting local SetFit160 steps; no network or production changes',flush=True)
    from datasets import Dataset
    from setfit import SetFitModel,Trainer,TrainingArguments
    step=time.perf_counter()
    model=SetFitModel(model_body=encoder,model_head=LogisticRegression(C=1,class_weight='balanced',max_iter=1500,random_state=42),normalize_embeddings=True)
    args=TrainingArguments(output_dir=str(OUT/'training-logs'),batch_size=4,num_epochs=1,max_steps=160,num_iterations=4,body_learning_rate=2e-5,
        max_length=512,seed=42,report_to='none',save_strategy='no',logging_steps=20,show_progress_bar=False)
    trainer=Trainer(model=model,args=args,train_dataset=Dataset.from_dict({'text':[texts[i] for i in train],'label':y(train)}))
    trainer.train()
    xs=encoder.encode(texts,batch_size=4,normalize_embeddings=True,show_progress_bar=False,convert_to_numpy=True)
    fit_heads('setfit_bge_lr',xs)
    encoder.save(str(OUT/'trained-encoder'),safe_serialization=True)
    timings['setfit_train_encode_fit_seconds']=time.perf_counter()-step
    scores['ensemble_equal']=[(a+b)/2 for a,b in zip(scores['char_tfidf_lr'],scores['setfit_bge_lr'])]
    selections['ensemble_equal']=choose(y(val),{1:[scores['ensemble_equal'][i] for i in val]})
    winner=max(selections,key=lambda name:rank(selections[name]['validation']))
    # Seal deployment candidate BEFORE computing new test metrics. No test-based choice.
    export.update(selections=selections,winner=winner,encoder_files={str(p.relative_to(OUT/'trained-encoder')):sha(p) for p in (OUT/'trained-encoder').rglob('*') if p.is_file()})
    save('classifier.json',export)
    save('selection-before-test.json',{'winner':winner,'selections':selections,'sealed_at':time.time(),'classifier_sha256':sha(OUT/'classifier.json')})
    scores['production_keywords']=[float(d['baseline']['matched']) for d in docs]
    # Input-cleaning control separates changes in preparation from classifier gains.
    node_code="import{matchUniversalRoleKeywords as m}from './work/universal-role-keywords.mjs';let s='';for await(const c of process.stdin)s+=c;let d=JSON.parse(s);console.log(JSON.stringify(d.rows.map(r=>Number(m({'岗位名称':r.title,'岗位描述':r.text},d.baseline).matched))));"
    control=subprocess.run(['node','--input-type=module','-e',node_code],input=json.dumps({'baseline':corpus['manifest']['baseline_keywords'],'rows':[{'title':d['title'],'text':t} for d,t in zip(docs,texts)]},ensure_ascii=False),capture_output=True,text=True,encoding='utf-8',cwd=ROOT,check=True)
    scores['keywords_prepared_control']=json.loads(control.stdout)
    for name in ['production_keywords','keywords_prepared_control']:
        selections[name]={'threshold':.5,'validation':metric(y(val),[int(scores[name][i]>=.5) for i in val])}
    metrics={};predictions=[]
    for name,values in scores.items():
        threshold=selections[name]['threshold'];accepted=[int(s>=threshold) for s in values];metrics[name]={}
        for split in ['train','validation','test_random','test_challenge']:
            known=[i for i,d in enumerate(docs) if d['split']==split and labels[d['id']]['label']!='uncertain']
            uncertain=[i for i,d in enumerate(docs) if d['split']==split and labels[d['id']]['label']=='uncertain']
            m=metric(y(known),[accepted[i] for i in known]);m.update(uncertain_total=len(uncertain),uncertain_accepted=sum(accepted[i] for i in uncertain))
            m['per_platform']={}
            for platform in sorted({docs[i]['platform'] for i in known}):
                sub=[i for i in known if docs[i]['platform']==platform];m['per_platform'][platform]=metric(y(sub),[accepted[i] for i in sub])
            metrics[name][split]=m
        for i,d in enumerate(docs):
            label=labels[d['id']]['label'];pred=accepted[i]
            predictions.append({'model':name,'id':d['id'],'split':d['split'],'label':label,'score':values[i],'threshold':threshold,'accepted':bool(pred),
                'result':'uncertain' if label=='uncertain' else 'TP' if pred and label=='core' else 'FP' if pred else 'FN' if label=='core' else 'TN'})
    unchanged={p:sha(ROOT/p)==h for p,h in corpus['manifest']['protected_hashes'].items()};assert all(unchanged.values())
    assert sha(OUT/'fresh-reference-labels.json')==lock['labels_sha256']
    timings['total_seconds']=time.perf_counter()-started
    save('predictions.json',predictions)
    result={'protocol':lock,'winner':winner,'selections':selections,'metrics':metrics,'timings':timings,
        'rss_mb':psutil.Process().memory_info().rss/1024**2,'production_unchanged':unchanged,
        'label_counts':{s:dict(Counter(labels[d['id']]['label'] for d in docs if d['split']==s)) for s in sorted({d['split'] for d in docs})}}
    save('results.json',result)
    print(json.dumps({'winner':winner,'timings':timings,'new_test':{n:{s:v for s,v in splits.items() if s.startswith('test')} for n,splits in metrics.items()}},ensure_ascii=False),flush=True)

if __name__=='__main__':main()
