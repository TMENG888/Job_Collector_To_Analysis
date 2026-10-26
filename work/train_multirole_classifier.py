"""Offline CPU-only TF-IDF/LR; JSON artifacts, no pickle/network/paid API."""
import os
os.environ['OMP_NUM_THREADS']='2'
os.environ['OPENBLAS_NUM_THREADS']='2'
import json,hashlib,re,time,sys
from pathlib import Path
from collections import Counter
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import precision_recall_fscore_support,confusion_matrix
from sklearn.metrics.pairwise import cosine_similarity

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'ui_data/insights/comparisons/multirole-lr-20261016'
sha=lambda b:hashlib.sha256(b).hexdigest()
def save(file,obj):
    content=json.dumps(obj,ensure_ascii=False,indent=2,default=lambda x:x.item() if hasattr(x,'item') else str(x))
    if file.exists() and '--resume-serialization' in sys.argv:
        try:
            assert json.loads(file.read_text(encoding='utf8'))==json.loads(content),'Cannot change frozen artifact: '+str(file)
            return
        except json.JSONDecodeError:
            file.rename(file.with_suffix('.incomplete.json'))
    with file.open('x',encoding='utf8') as f:f.write(content)
def metrics(y,p):
    tp=sum(a==1 and b==1 for a,b in zip(y,p));fp=sum(a==0 and b==1 for a,b in zip(y,p))
    fn=sum(a==1 and b==0 for a,b in zip(y,p));tn=sum(a==0 and b==0 for a,b in zip(y,p))
    pr=tp/(tp+fp) if tp+fp else 0;rc=tp/(tp+fn) if tp+fn else 0
    return dict(n=len(y),positive=tp+fn,negative=tn+fp,tp=tp,fp=fp,fn=fn,tn=tn,precision=pr,recall=rc,f05=1.25*pr*rc/(.25*pr+rc) if pr+rc else 0)
def main():
    if (OUT/'results.json').exists() or ((OUT/'selection-before-test.json').exists() and '--resume-serialization' not in sys.argv):raise RuntimeError('Sealed trial; do not tune or rerun against this test')
    raw=(OUT/'training-corpus.json').read_bytes();data=json.loads(raw);rows=data['samples'];N=len(rows)
    # Unite company, identical bodies and near-JD copies BEFORE any split.
    parent=list(range(N))
    def find(i):
        while parent[i]!=i:parent[i]=parent[parent[i]];i=parent[i]
        return i
    def union(a,b):
        a,b=find(a),find(b)
        if a!=b:parent[max(a,b)]=min(a,b)
    seen={}
    for i,r in enumerate(rows):
        for key in [('company',r['company']),('body',re.sub(r'\s+','',r['body']).lower())]:
            if key in seen:union(i,seen[key])
            else:seen[key]=i
    grouping=TfidfVectorizer(analyzer='char',ngram_range=(5,5),max_features=50000).fit_transform([r['body'] for r in rows])
    similar=cosine_similarity(grouping)
    for i,j in zip(*np.where(np.triu(similar>=.90,1))):union(int(i),int(j))
    keys={}
    for i,r in enumerate(rows):keys.setdefault(find(i),[]).append(r['company']+'|'+sha(r['body'].encode()))
    # Fixed group hash split independent of labels/scores; no retry for better metrics.
    assignments={k:('train' if n<6 else 'validation' if n<8 else 'test') for k,v in keys.items() for n in [int(sha(min(v).encode())[:8],16)%10]}
    splits=[assignments[find(i)] for i in range(N)]
    save(OUT/'split.json',dict(corpus_sha256=sha(raw),near_jd_cosine=.90,rows=[dict(id=r['id'],group=find(i),split=splits[i]) for i,r in enumerate(rows)]))
    selections={};models={};scores={};families=data['families'];started=time.perf_counter()
    slugs={'嵌入式开发':'embedded','测试工程':'software-testing','新媒体运营':'new-media','销售工程师':'sales-engineer','智能体/大模型应用':'agent-app','爬虫/数据采集':'web-crawler','大数据开发':'big-data'}
    for family in families:
        # One body/family label per split; uncertain/conflicting labels are not negatives.
        indexed={};conflicts=set()
        for i,r in enumerate(rows):
            label=r['decisions'].get(family)
            if label not in ['include','exclude']:continue
            key=sha(re.sub(r'\s+','',r['body']).lower().encode())
            if key in indexed and rows[indexed[key]]['decisions'][family]!=label:conflicts.add(key)
            else:indexed.setdefault(key,i)
        known=[i for k,i in indexed.items() if k not in conflicts]
        sets={s:[i for i in known if splits[i]==s] for s in ['train','validation','test']}
        y=lambda ids:[int(rows[i]['decisions'][family]=='include') for i in ids]
        counts={s:dict(Counter(y(ids))) for s,ids in sets.items()}
        if min(counts['train'].get(k,0) for k in [0,1])<10 or min(counts['validation'].get(k,0) for k in [0,1])<3:
            selections[family]=dict(status='insufficient_labels',counts=counts,conflicting_bodies=len(conflicts));continue
        vectorizer=TfidfVectorizer(analyzer='char',ngram_range=(2,4),min_df=2,max_features=30000,sublinear_tf=True)
        vectorizer.fit([rows[i]['text'] for i in sets['train']]);x=vectorizer.transform([r['text'] for r in rows])
        choices=[]
        for c in [.1,1,10]:
            head=LogisticRegression(C=c,class_weight='balanced',max_iter=1500,random_state=42).fit(x[sets['train']],y(sets['train']))
            vals=head.predict_proba(x[sets['validation']])[:,1]
            for threshold in [.45,.5,.55,.6,.65,.7]:
                m=metrics(y(sets['validation']),[int(v>=threshold) for v in vals]);meets=m['precision']>=.9 and m['recall']>=.6
                choices.append(((int(meets),m['recall'] if meets else m['f05'],m['precision'],-c,-abs(threshold-.55)),head,c,threshold,m))
        _,head,c,threshold,m=max(choices,key=lambda t:t[0]);version=slugs[family]+'-tfidf-lr-v1'
        selections[family]=dict(C=c,threshold=threshold,validation=m,counts=counts,conflicting_bodies=len(conflicts),version=version)
        models[family]=dict(version=version,family=family,algorithm='char-2-4gram TF-IDF + LogisticRegression',threshold=threshold,
            tfidf=dict(vocabulary=vectorizer.vocabulary_,idf=vectorizer.idf_.tolist(),ngram_range=[2,4],sublinear_tf=True),
            head=dict(classes=head.classes_.tolist(),coef=head.coef_[0].tolist(),intercept=float(head.intercept_[0])),
            input_contract='title60 + original duty head/mid/tail420; Unicode char2–4; body80–9000; no query/salary/skills input',
            provenance=dict(annotation=data['annotation'],training_corpus_sha256=sha(raw),train_rows=len(sets['train']),validation=m,scope='family-specific model; not universal, uncalibrated scores',selection='validation-only C/threshold; held-out group test used solely as release gate'))
        scores[family]=dict(indices=sets,scores=head.predict_proba(x)[:,1].tolist())
    # Seal selections before looking at ANY test labels/metrics.
    save(OUT/'selection-before-test.json',selections)
    results={};manifest={};predictions=[]
    modeldir=ROOT/'work/models/role-screening';modeldir.mkdir(parents=True,exist_ok=True)
    for family,model in models.items():
        fit=scores[family];selection=selections[family];t=selection['threshold']
        y=[int(rows[i]['decisions'][family]=='include') for i in fit['indices']['test']]
        m=metrics(y,[int(fit['scores'][i]>=t) for i in fit['indices']['test']]);v=selection['validation']
        passed=v['precision']>=.8 and v['recall']>=.6 and m['precision']>=.8 and m['recall']>=.6 and m['tp']>=3 and m['negative']>=3
        result=dict(**selection,test=m,released=passed,limitations='Small directed source sample; Codex labels, not independent human gold; not population accuracy. Old audit labels reused as development, no claim of fresh independent validation.')
        results[family]=result;model['provenance']['test']=m
        for i,r in enumerate(rows):predictions.append(dict(id=r['id'],family=family,split=splits[i],label=r['decisions'].get(family),score=fit['scores'][i],accepted=fit['scores'][i]>=t))
        candidate=OUT/(model['version']+'.json');save(candidate,model)
        if passed:
            artifact=modeldir/candidate.name
            with artifact.open('xb') as f:f.write(candidate.read_bytes())
            manifest[family]=dict(file=artifact.name,sha256=sha(artifact.read_bytes()),version=model['version'],threshold=t)
    save(OUT/'predictions.json',predictions)
    save(OUT/'results.json',dict(corpus_sha256=sha(raw),families=results,not_fit={f:s for f,s in selections.items() if f not in models},seconds=time.perf_counter()-started))
    # Registry advertises only models that passed the fixed release gate.
    save(modeldir/'multirole-registry-v1.json',dict(version='multirole-tfidf-lr-v1',models=manifest))
    print(json.dumps(dict(results=results,not_fit={f:s for f,s in selections.items() if f not in models},released=list(manifest)),ensure_ascii=False),flush=True)
if __name__=='__main__':main()
