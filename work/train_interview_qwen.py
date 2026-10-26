import os
os.environ['OMP_NUM_THREADS']='2'
os.environ['OPENBLAS_NUM_THREADS']='2'
import sys,json,re,hashlib,math
from pathlib import Path
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.linear_model import LogisticRegression

def read(file):
    return json.loads(Path(file).read_text(encoding='utf8'))
def save(file,value):
    Path(file).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf8')
def norm(value):
    return re.sub(r'\s+','',value).lower()
def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()
def grouping(rows):
    parent=list(range(len(rows)))
    duplicate_parent=list(range(len(rows)))
    def find(i):
        while parent[i]!=i:
            parent[i]=parent[parent[i]]
            i=parent[i]
        return i
    def duplicate_find(i):
        while duplicate_parent[i]!=i:
            duplicate_parent[i]=duplicate_parent[duplicate_parent[i]]
            i=duplicate_parent[i]
        return i
    def union(i,j,duplicate=False):
        a,b=find(i),find(j)
        parent[max(a,b)]=min(a,b)
        if duplicate:
            a,b=duplicate_find(i),duplicate_find(j)
            duplicate_parent[max(a,b)]=min(a,b)
    seen={}
    companies=[('字节',r'字节|TikTok'),('百度','百度'),('蚂蚁','蚂蚁'),('阿里','阿里|淘天|高德'),('京东','京东'),('美团','美团'),('小红书','小红书'),('小米','小米'),('腾讯','腾讯'),('网易','网易'),('芒果','芒果'),('数字马力','数字马力'),('联想','联想|联宝')]
    for i,r in enumerate(rows):
        company=next((name for name,pattern in companies if re.search(pattern,r['title'],re.I)),'')
        r['company_group']=company
        keys=[('url',r['url']),('body',norm(r['body'])),('company',company)]
        qs=sorted(set(re.sub(r'[\W_]','',re.sub(r'^\d+[.、)）]','',line.strip())).lower() for line in r['body'].splitlines() if re.match(r'^\s*\d+[.、)）]',line) and len(line.strip())>=6))
        if len(qs)>=5: keys.append(('questions','|'.join(qs)))
        for key in keys:
            if not key[1]: continue
            if key in seen: union(i,seen[key],key[0]!='company')
            else: seen[key]=i
    if len(rows)>1:
        x=TfidfVectorizer(analyzer='char',ngram_range=(5,5),max_features=40000).fit_transform([norm(r['body']) for r in rows])
        similarity=cosine_similarity(x)
        for i,j in zip(*np.where(np.triu(similarity>=.88,1))): union(int(i),int(j),True)
    groups={}
    for i,r in enumerate(rows): groups.setdefault(find(i),[]).append(i)
    for ids in groups.values():
        key=min(sha(norm(rows[i]['body'])) for i in ids)
        has_reference=any(rows[i].get('reference') for i in ids)
        for i in ids: rows[i].update(group=key,duplicate_group=str(duplicate_find(i)),split='reference' if has_reference else 'unassigned')
    return rows

def prepare(directory):
    folder=Path(directory)
    corpus=read(folder/'corpus.json')
    reference=read(folder/'reference-grouping.json')
    allrows=grouping([dict(r,reference=False) for r in corpus['rows']]+[dict(r,reference=True) for r in reference['rows']])
    pool=[r for r in allrows if not r['reference'] and r['split']!='reference']
    unique={}
    for r in sorted(pool,key=lambda r:r['id']): unique.setdefault(r['duplicate_group'],r)
    candidates=sorted(unique.values(),key=lambda r:sha(r['id']))[:corpus['sampleCount']]
    groups={}
    for r in candidates: groups.setdefault(r['group'],[]).append(r)
    validation_count=0
    target=len(candidates)*.3
    for key,group in sorted(groups.items(),key=lambda item:(-len(item[1]),item[0])):
        use_validation=abs(validation_count+len(group)-target)<abs(validation_count-target)
        for r in group: r['split']='validation' if use_validation else 'train'
        if use_validation: validation_count+=len(group)
    reference_unique={}
    for r in allrows:
        if r['reference']: reference_unique.setdefault(r['duplicate_group'],r['id'])
    save(folder/'prepared.json',dict(samples=candidates,reference_ids=list(reference_unique.values()),corpus=len(corpus['rows']),reference_excluded=sum(not r['reference'] and r['split']=='reference' for r in allrows),available=len(unique),sampled=len(candidates),groups=len(groups),split_policy='label-blind group-size balancing, validation target 30%, frozen before Qwen requests',split_counts={s:sum(r['split']==s for r in candidates) for s in ['train','validation']}))

def wilson(k,n):
    if not n: return 0
    z=1.959963984540054
    p=k/n
    return (p+z*z/(2*n)-z*math.sqrt(p*(1-p)/n+z*z/(4*n*n)))/(1+z*z/n)
def metrics(gold,pred):
    tp=sum(int(a==1 and b==1) for a,b in zip(gold,pred))
    tn=sum(int(a==0 and b==0) for a,b in zip(gold,pred))
    fp=sum(int(a==0 and b==1) for a,b in zip(gold,pred))
    fn=sum(int(a==1 and b==0) for a,b in zip(gold,pred))
    return dict(n=len(gold),positive=tp+fn,negative=tn+fp,tp=tp,tn=tn,fp=fp,fn=fn,accuracy=(tp+tn)/len(gold) if len(gold) else None,precision=tp/(tp+fp) if tp+fp else None,recall=tp/(tp+fn) if tp+fn else None,f1=2*tp/(2*tp+fp+fn) if 2*tp+fp+fn else None,precision_lower95=wilson(tp,tp+fp),recall_lower95=wilson(tp,tp+fn))

def train(directory):
    folder=Path(directory)
    if (folder/'evaluation.json').exists(): raise ValueError('本轮评测已封存，不覆盖测试结果')
    data=read(folder/'samples.json')
    prepared=read(folder/'prepared.json')
    assignments={r['id']:r for r in prepared['samples']}
    rows=[r for r in data['samples'] if r['label'] in ['include','exclude']]
    if len({r['id'] for r in data['samples']})!=len(data['samples']): raise ValueError('标注样本重复')
    if any(r['id'] not in assignments or r['text']!=assignments[r['id']]['text'] or r['split']!=assignments[r['id']]['split'] or r['body']!=assignments[r['id']]['body'] for r in rows): raise ValueError('训练数据不属于冻结Qwen抽样')
    sets={s:[i for i,r in enumerate(rows) if r['split']==s] for s in ['train','validation']}
    y=np.array([int(r['label']=='include') for r in rows])
    counts={s:dict(n=len(ids),positive=int(sum(y[ids])),negative=int(len(ids)-sum(y[ids]))) for s,ids in sets.items()}
    if min(counts['train']['positive'],counts['train']['negative'])<8 or min(counts['validation']['positive'],counts['validation']['negative'])<3: raise ValueError('隔离后正负样本不足，保留Qwen标签；不更换测试集或强行训练：'+json.dumps(counts))
    vectorizer=TfidfVectorizer(analyzer='char',ngram_range=(2,4),sublinear_tf=True,min_df=2,max_features=20000,lowercase=False)
    vectorizer.fit([rows[i]['text'] for i in sets['train']])
    x=vectorizer.transform([r['text'] for r in rows])
    best=None
    candidates=[]
    for c in [.25,1,4]:
        for weight in [None,'balanced']:
            model=LogisticRegression(C=c,class_weight=weight,max_iter=2000,random_state=42).fit(x[sets['train']],y[sets['train']])
            scores=model.predict_proba(x[sets['validation']])[:,1]
            for threshold in [.3,.4,.5,.6,.7]:
                m=metrics(y[sets['validation']],(scores>=threshold).astype(int))
                rank=(int((m['precision'] or 0)>=.9 and (m['recall'] or 0)>=.85),m['f1'] or 0,m['precision'] or 0,m['recall'] or 0,-abs(threshold-.5),-c)
                choice=dict(C=c,class_weight=weight,threshold=threshold,validation=m)
                candidates.append(choice)
                if best is None or rank>best[0]: best=(rank,choice,model)
    _,selection,model=best
    save(folder/'selection.json',dict(selected=selection,candidates=candidates,counts=counts,policy='Qwen training only; vocabulary TRAIN only; threshold Qwen VALIDATION only; Codex reference labels not loaded until selection frozen'))
    reference=read(folder/'reference-evaluation.json')
    unique={}
    for r in reference['rows']:
        if r['label'] in ['include','exclude'] and r['id'] in prepared['reference_ids']: unique.setdefault(norm(r['body']),r)
    tests=list(unique.values())
    xt=vectorizer.transform([r['text'] for r in tests]) if tests else None
    scores=model.predict_proba(xt)[:,1] if tests else []
    test=metrics([int(r['label']=='include') for r in tests],[int(s>=selection['threshold']) for s in scores])
    validation=selection['validation']
    gate=[]
    if test['n']<30: gate.append('独立参考测试不足30篇')
    if min(test['positive'],test['negative'])<10: gate.append('参考测试每类不足10篇')
    if min(validation['positive'],validation['negative'])<5: gate.append('验证集每类不足5篇')
    for name,m in [('验证',validation),('参考测试',test)]:
        if not ((m['precision'] or 0)>=.9 and (m['recall'] or 0)>=.85 and (m['f1'] or 0)>=.87): gate.append(name+'指标未通过')
    if min(test['precision_lower95'],test['recall_lower95'])<.7: gate.append('参考测试置信区间下界不足70%')
    version='nowcoder-qwen-lr-'+data['id']
    artifact=dict(version=version,family=data['role'],algorithm='char-2-4gram TF-IDF + LogisticRegression',input_preprocessing='interview-original-v1',threshold=selection['threshold'],hard_filter_eligible=not gate,tfidf=dict(vocabulary={k:int(v) for k,v in vectorizer.vocabulary_.items()},idf=vectorizer.idf_.tolist(),ngram_range=[2,4],sublinear_tf=True),head=dict(classes=model.classes_.tolist(),coef=model.coef_[0].tolist(),intercept=float(model.intercept_[0])),provenance=dict(annotation='Qwen3.7-Flash labels; no Codex review',training_source='qwen-only',reference_labels_used_for_training=False,reference_labels_used_for_selection=False,reference_version=reference['version'],reference_sha256=data['referenceSha256'],reference_basis=reference['basis'],validation=validation,test=test,counts=counts,selection=selection))
    report=dict(version=version,eligible=not gate,threshold=selection['threshold'],counts=counts,validation=validation,test=test,test_basis=reference['basis'],gate_reasons=gate,training_source='qwen-only',reference_labels_used_for_training=False,reference_labels_used_for_selection=False,predictions=[dict(id=r['id'],score=float(s),label=r['label'],prediction='include' if s>=selection['threshold'] else 'exclude') for r,s in zip(tests,scores)])
    save(folder/'model.json',artifact)
    save(folder/'evaluation.json',report)
    print(json.dumps(dict(eligible=not gate,counts=counts,test=test),ensure_ascii=False))

if __name__=='__main__':
    try:
        {'prepare':prepare,'train':train}[sys.argv[1]](sys.argv[2])
    except Exception as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
