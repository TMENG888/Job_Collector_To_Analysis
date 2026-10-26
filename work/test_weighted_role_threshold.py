"""Frozen offline score candidates. No review labels loaded; no production edits."""
import os
os.environ.setdefault('OMP_NUM_THREADS','4')
import json,re,math,time
from pathlib import Path
from collections import defaultdict
import numpy as np
from scipy import sparse
from sklearn.feature_extraction.text import TfidfTransformer
from threadpoolctl import threadpool_limits
import test_agent_unsupervised_wordcloud as base
from test_crossrole_cloud import GENERIC,FOCUSED
ROOT=Path(__file__).resolve().parent.parent/'ui_data/insights/comparisons/weighted-role-threshold-20261010'
base.STRICT=True;base.CLEAN=False
ACTION=re.compile('开发|研发|构建|搭建|建设|设计|实现|抓取|采集|爬取|清洗|解析|入库|部署|维护|编排|接入|集成|加工|治理|优化|调优|建模|调度|监控|保障|处理')
BONUS=re.compile('优先|加分|更佳|preferred|nice.to.have',re.I)
SOFT=re.compile('福利|五险|一金|学历|本科|硕士|博士|责任心|团队合作|沟通能力|学习能力|薪酬|薪资待遇|公司简介|公司介绍|我们是|致力于')
def present(name,text):
    if re.fullmatch(r'[a-z0-9+#_. -]+',name):return bool(re.search(r'(?<![a-z0-9])'+re.escape(name)+r'(?![a-z0-9])',base.normalized(text)))
    return base.compact(name) in base.compact(text)
def fast_matrix(docs,candidates):
    rows=[];cols=[]
    keys=[base.compact(c['name']) for c in candidates]
    patterns=[re.compile(r'(?<![a-z0-9])'+re.escape(base.normalized(c['name']))+r'(?![a-z0-9])') if re.fullmatch(r'[a-z0-9 .+#_-]+',c['name']) else None for c in candidates]
    for i,d in enumerate(docs):
        for j,(key,p) in enumerate(zip(keys,patterns)):
            if p.search(d['_normalized']) if p else key in d['_compact']:rows.append(i);cols.append(j)
    return sparse.csr_matrix((np.ones(len(rows)),(rows,cols)),shape=(len(docs),len(candidates)))
def run(role):
    data=json.loads((ROOT/(role+'-raw.json')).read_text(encoding='utf8'));docs=data['docs'];train=[d for d in docs if d['split']=='train'];seeds=[d for d in train if d['title_seed']]
    for d in docs:
        d['_normalized']=base.normalized(d['text']);d['_compact']=base.compact(d['text'])
        d['_sections']=[(s,base.normalized(s['quote']),base.compact(s['quote'])) for s in d['sections']]
    # Dedup entire bodies already done before splitting. No test/calibration corpus frequencies.
    cand,S,tokens,minimum=base.extract(seeds);B=fast_matrix(train,cand)
    seed_df=np.asarray((S>0).sum(axis=0)).ravel();bgdf=np.asarray(B.sum(axis=0)).ravel()
    lift=((seed_df+.5)/(len(seeds)+1))/((bgdf+.5)/(len(train)+1))
    T=TfidfTransformer(sublinear_tf=True).fit(B);ST=T.transform(S);tf=np.asarray(ST.mean(axis=0)).ravel();tr=base.textrank(cand,S,tokens)
    rrf=np.zeros(len(cand))
    for score in [tf,tr]:
        for rank,j in enumerate(np.argsort(-score)):rrf[j]+=1/(61+rank)
    variants=[]
    for algorithm,score in [('tfidf',tf),('textrank',tr),('fusion',rrf)]:
        weights=3*(score/max(score))*np.sqrt(np.clip(np.log2(np.maximum(lift,1))/3,0,1))
        # Standalone generic words receive only 0.10, not full technical weight.
        for i,c in enumerate(cand):
            if c['name'] in FOCUSED:weights[i]=min(weights[i],.10)
        order=[int(j) for j in np.argsort(-weights) if lift[j]>=1.2 and weights[j]>0]
        selected=base.select(order,cand,limit=100)
        terms=[{**cand[j],'weight':float(weights[j]),'lift':float(lift[j]),'background_df':int(bgdf[j]),'weak':bool(weights[j]<.5)} for j in selected]
        patterns={t['name']:re.compile(r'(?<![a-z0-9])'+re.escape(t['name'])+r'(?![a-z0-9])') if re.fullmatch(r'[a-z0-9+#_. -]+',t['name']) else None for t in terms}
        for policy in ['weighted','context']:
            predictions=[]
            for d in docs:
                hits=[]
                for t in terms:
                    p=patterns[t['name']];key=base.compact(t['name'])
                    if not (p.search(d['_normalized']) if p else key in d['_compact']):continue
                    quotes=[s for s,n,c in d['_sections'] if p.search(n) if p] if p else [s for s,n,c in d['_sections'] if key in c]
                    if not quotes:continue
                    best=1 if policy=='weighted' else 0;bestquote=quotes[0]
                    if policy=='context':
                        for s in quotes:
                            # Clause-level evidence, no target technical whitelist.
                            q=s['quote'];factor=0 if SOFT.search(q) else .2 if BONUS.search(q) else .5 if s['location']=='requirements' else 1 if s['location']=='duties' and ACTION.search(q) else .7 if ACTION.search(q) else .3
                            if factor>best:best=factor;bestquote=s
                    w=t['weight']*best
                    if w:hits.append({'term':t['name'],'weight':w,'base_weight':t['weight'],'weak':t['weak'],'location':bestquote['location'],'quote':bestquote['quote']})
                # Longer/shorter nested variants do not count as independent proof.
                hits.sort(key=lambda h:-h['weight']);ind=[]
                for h in hits:
                    if any(base.compact(h['term']) in base.compact(o['term']) or base.compact(o['term']) in base.compact(h['term']) for o in ind):continue
                    ind.append(h)
                ind=ind[:8];strong=sum(h['weight'] for h in ind if not h['weak']);weak=min(.3,sum(h['weight'] for h in ind if h['weak']))
                predictions.append({'row_no':d['row_no'],'score':round(strong+weak,6),'hits':ind,'weak_total':weak,'old_matched':d['old_matched'],'split':d['split']})
            variants.append({'id':algorithm+'-'+policy,'terms':terms,'predictions':predictions})
        print(json.dumps({'role':role,'algorithm':algorithm,'training_docs':len(train),'title_seeds':len(seeds),'top10':[(t['name'],round(t['weight'],2),round(t['lift'],1)) for t in terms[:10]]},ensure_ascii=False),flush=True)
    result={'manifest':data['manifest'],'training_seed_docs':len(seeds),'candidate_docs_minimum':minimum,'parameters':{'max_terms':100,'max_independent_hits':8,'max_term_weight':3,'weak_term_cutoff':.5,'weak_pool_cap':.3,'minimum_lift':1.2,'generic_single_max':.1,'weight_formula':'3*(algorithm_score/max_score)*sqrt(clip(log2(lift)/3,0,1)); standalone generic <=0.10','context_factors':{'duties_action':1,'unsectioned_action':.7,'requirements':.5,'bonus':.2,'no_action':.3,'promo':0}},'variants':variants}
    (ROOT/(role+'-scores.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
if __name__=='__main__':
    with threadpool_limits(limits=4):
        for role in ['agent','crawler','bigdata']:run(role)
