"""Offline, role-agnostic extraction experiment. No production writes or domain lexicon.
Candidates use generic Jieba POS + observed contiguous phrases and PMI.
Semantic embeddings run locally; remote access downloads public model weights only.
"""
import os
os.environ.setdefault('OMP_NUM_THREADS', '4')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '4')
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
import json, re, math, time, hashlib, unicodedata, argparse
from pathlib import Path
from collections import Counter, defaultdict
import numpy as np
import jieba.posseg as posseg
from scipy import sparse
from sklearn.feature_extraction.text import TfidfTransformer
from sklearn.decomposition import NMF
from sklearn.cluster import KMeans
from threadpoolctl import threadpool_limits

OUT=Path(__file__).resolve().parent.parent/'ui_data/insights/comparisons/agent-unsupervised-20261010'
CLEAN='--clean' in __import__('sys').argv
STRICT='--strict' in __import__('sys').argv
STOP=set('岗位 职位 工作 职责 任职 要求 优先 熟悉 掌握 了解 精通 熟练 具备 能力 经验 学历 专业 本科 硕士 博士 以上 以下 至少 公司 团队 福利 待遇 薪资 薪酬 五险 一金 沟通 协作 合作 责任心 学习 努力 热爱 热情 负责 参与 协助 完成 进行 以及 包括 等等 相关 其他 良好 扎实 较强 一定 丰富 独立 定期 日常 持续 不断 高效 有效 提升 推动 能够 可以 需要 我们 你们 企业 业务 技术 工具 项目 系统 平台 方案 产品 应用 开发 设计 实现 使用 通过 根据 基于 结合 为了 具有 例如 如 等 及 与 和 或 的 中 上 下 将 有 对 并 在 一 二 三 四 五'.split())
EN_STOP=set('and or of the a an to in on for with as is are be have has from by etc experience familiar preferred knowledge ability skills skill strong good responsible requirements qualification qualifications job work team company bachelor master years year degree understand understanding using use development develop design implement include including such that this our your you we proficiency proficient'.split())
SOFT=set('工作 技术 工具 业务 项目 系统 平台 方案 产品 应用 开发 设计 数据 模型 实现 使用 管理 服务 需求'.split())
def normalized(s):return unicodedata.normalize('NFKC',str(s)).lower()
def compact(s):return re.sub(r'\s+','',normalized(s))
def isenglish(s):return bool(re.fullmatch(r'[a-z][a-z0-9+#_.-]*',s))
def stop(s):return s in STOP or s in EN_STOP or s.isdigit()
def valid_single(t,flag):
    return not stop(t) and ((isenglish(t) and len(t)>=2) or (2<=len(t)<=10 and (flag.startswith('n') or flag in ('vn','an'))))
def segments(text):
    # Split at punctuation; never join terms across clauses or after removing stop words.
    for clause in re.split(r'[，,。；;：:\n\r!?！？、()（）\[\]【】/|<>]',normalized(text)):
        if not clause.strip():continue
        if STRICT:
            seq=[];cursor=0
            # Keep technical English punctuation, e.g. Node.js, C++, scikit-learn.
            for m in re.finditer(r'[a-z][a-z0-9]*(?:[.+#_-][a-z0-9+#_-]*)*',clause):
                seq.extend((t.word,t.flag) for t in posseg.cut(clause[cursor:m.start()],HMM=True) if not t.word.isspace())
                seq.append((m.group(),'eng'));cursor=m.end()
            seq.extend((t.word,t.flag) for t in posseg.cut(clause[cursor:],HMM=True) if not t.word.isspace())
            yield seq
        else:yield [(t.word,t.flag) for t in posseg.cut(clause,HMM=True) if not t.word.isspace()]
def phrases(seq):
    result=[]
    for i,(t,flag) in enumerate(seq):
        if valid_single(t,flag):result.append((t,i,1))
        for n in (2,3):
            group=seq[i:i+n]
            if len(group)!=n or any((stop(w) and not (STRICT and w in SOFT)) or not re.search(r'[a-z\u4e00-\u9fff]',w) for w,_ in group):continue
            words=[w for w,_ in group]
            if all(isenglish(w) for w in words):phrase=' '.join(words)
            elif all(re.fullmatch(r'[\u4e00-\u9fff]+',w) for w in words):
                # Noun-bearing phrases; generic POS filtering, not role-specific keywords.
                if not any(f.startswith('n') for _,f in group):continue
                if STRICT and ((len(words[0])<2 and group[0][1] not in ('a','m')) or group[0][1] in ('p','u','c','d','v') or group[-1][1] in ('p','u','c','d','a','b')):continue
                phrase=''.join(words)
            else:continue
            if 3<=len(phrase)<=28 and (isenglish(words[0]) or len(phrase)<=12):result.append((phrase,i,n))
    return result
def extract(docs):
    started=time.perf_counter();freq=Counter();tf=[];tokens=[];parts={};boundary=defaultdict(lambda:[Counter(),Counter()]);examples={}
    tokenfreq=Counter();total=0
    for d in docs:
        counts=Counter();doc_tokens=[]
        for section in d['sections']:
            for seq in segments(section['quote']):
                # Preserve exact adjacency, including stopwords; graph matching
                # must not manufacture phrases across removed words.
                doc_tokens.append([w for w,f in seq])
                tokenfreq.update(w for w,_ in seq);total+=len(seq)
                for term,i,n in phrases(seq):
                    counts[term]+=1
                    parts.setdefault(term,tuple(w for w,_ in seq[i:i+n]))
                    boundary[term][0][seq[i-1][0] if i else '^']+=1
                    boundary[term][1][seq[i+n][0] if i+n<len(seq) else '$']+=1
                    examples.setdefault(term,{'row_no':d['row_no'],'title':d['title'],'location':section['location'],'quote':section['quote']})
        freq.update(counts.keys());tf.append(counts);tokens.append(doc_tokens)
    minimum=max(5,math.ceil(len(docs)*.005))
    def cohesion(term):
        ws=parts[term];c=sum(x[term] for x in tf)
        return min(math.log2((c*max(1,total))/max(1,tokenfreq[ws[i]]*tokenfreq[ws[i+1]])) for i in range(len(ws)-1)) if len(ws)>1 else None
    candidates=[]
    for term,df in freq.items():
        if df<minimum:continue
        # Generic phrase-first ablation, no target-role whitelist:
        # retain >=3 Chinese characters; English singles stay for tool names.
        if CLEAN and (term=='ai' or (re.fullmatch(r'[\u4e00-\u9fff]+',term) and len(term)<3)):continue
        pmi=cohesion(term)
        if pmi is not None and pmi<2:continue
        candidates.append({'name':term,'df':df,'pmi':pmi,'parts':parts[term],'evidence':examples[term]})
    # C-value-style nesting suppression: a fragment mostly used inside a longer
    # observed phrase is represented by that phrase. No dictionary-based aliases.
    keep=[]
    for c in candidates:
        longer=[o for o in candidates if len(o['parts'])>len(c['parts']) and compact(c['name']) in compact(o['name']) and o['df']>=c['df']*.75]
        if not longer:keep.append(c)
    keep.sort(key=lambda c:-(c['df']/len(docs))*(math.log((len(docs)+1)/(c['df']+1))+1))
    keep=keep[:1800];vocab=[c['name'] for c in keep];idx={s:i for i,s in enumerate(vocab)}
    rr=[];cc=[];vv=[]
    for row,counts in enumerate(tf):
        for t,c in counts.items():
            if t in idx:rr.append(row);cc.append(idx[t]);vv.append(c)
    X=sparse.csr_matrix((vv,(rr,cc)),shape=(len(docs),len(vocab)),dtype=float)
    print(json.dumps({'stage':'candidates','docs':len(docs),'candidates':len(vocab),'minimum_df':minimum,'elapsed_s':round(time.perf_counter()-started,2)},ensure_ascii=False),flush=True)
    return keep,X,tokens,minimum
def rank(a):
    order=np.argsort(-np.asarray(a),kind='stable');result=np.empty(len(a));result[order]=np.arange(len(a));return result
def textrank(candidates,X,tokens):
    idx={c['name']:i for i,c in enumerate(candidates)};edges=Counter()
    for doc in tokens:
        for seq in doc:
            positions=[]
            for i,t in enumerate(seq):
                if t in idx:positions.append((i,idx[t]))
                for n in (2,3):
                    if i+n<=len(seq):
                        for term in (''.join(seq[i:i+n]),' '.join(seq[i:i+n])):
                            if term in idx:positions.append((i,idx[term]))
            for a,(pa,ia) in enumerate(positions):
                for pb,ib in positions[a+1:]:
                    if pb-pa>5:break
                    if ia!=ib:edges[(ia,ib)]+=1;edges[(ib,ia)]+=1
    if edges:
        ij=list(edges);G=sparse.csr_matrix((list(edges.values()),([a for a,b in ij],[b for a,b in ij])),shape=(len(idx),len(idx)),dtype=float)
        degree=np.asarray(G.sum(axis=1)).ravel();P=sparse.diags(1/np.maximum(degree,1))@G
        v=np.ones(len(idx))/len(idx)
        for _ in range(80):
            nxt=.15/len(idx)+.85*(P.T@v+v[degree==0].sum()/len(idx))
            if np.abs(nxt-v).sum()<1e-8:break
            v=nxt
    else:v=np.ones(len(idx))/len(idx)
    return v*np.sqrt(np.asarray((X>0).sum(axis=0)).ravel()/X.shape[0])
def nmf_score(T,k=12):
    k=min(k,min(T.shape)-1);model=NMF(n_components=k,init='nndsvda',random_state=20261010,max_iter=2000,tol=1e-4)
    W=model.fit_transform(T);H=model.components_;H=H/np.maximum(H.max(axis=1,keepdims=True),1e-9)
    importance=W.sum(axis=0);importance/=max(importance.sum(),1e-9)
    scores=(H*np.sqrt(importance)[:,None]).max(axis=0)
    # Round-robin topic representatives, then global topic relevance.
    chosen=[];seen=set();orders=[np.argsort(-h) for h in H]
    for p in range(20):
        for topic in np.argsort(-importance):
            j=int(orders[topic][p])
            if j not in seen:seen.add(j);chosen.append(j)
    chosen+= [int(j) for j in np.argsort(-scores) if int(j) not in seen]
    return scores,np.argmax(H,axis=0),chosen,{'topics':k,'iterations':model.n_iter_,'converged':model.n_iter_<2000,'max_iter':2000,'reconstruction_error':float(model.reconstruction_err_),'topic_mass':importance.tolist()}
def select(order,candidates,limit=100,sim=None,threshold=.88):
    selected=[]
    for j in order:
        j=int(j);c=candidates[j]
        if any((compact(c['name']) in compact(candidates[k]['name']) or compact(candidates[k]['name']) in compact(c['name'])) and min(c['df'],candidates[k]['df'])/max(c['df'],candidates[k]['df'])>=.7 for k in selected):continue
        if sim is not None and selected and np.max(sim[j,selected])>=threshold:continue
        selected.append(j)
        if len(selected)>=limit:break
    return selected
def semantic(candidates,tfscore,out):
    from fastembed import TextEmbedding
    model_name='BAAI/bge-small-zh-v1.5'
    supported=TextEmbedding.list_supported_models()
    if not any(m['model']==model_name for m in supported):
        model_name='intfloat/multilingual-e5-small'
    texts=[c['name'] for c in candidates]
    fingerprint=hashlib.sha256(json.dumps([model_name,texts],ensure_ascii=False).encode()).hexdigest()
    cache=out/'phrase-embeddings.npz'
    if cache.exists():
        cached=np.load(cache)
        if str(cached['fingerprint'])==fingerprint:E=cached['vectors'];return E,model_name,True
    print(json.dumps({'stage':'load_local_embedding','model':model_name,'candidates':len(texts)}),flush=True)
    model=TextEmbedding(model_name=model_name,cache_dir=str(OUT/'model-cache'),threads=4)
    if 'e5' in model_name:texts=['passage: '+t for t in texts]
    E=np.array(list(model.embed(texts,batch_size=64)),dtype=np.float32)
    E/=np.maximum(np.linalg.norm(E,axis=1,keepdims=True),1e-9)
    np.savez_compressed(cache,vectors=E,fingerprint=fingerprint)
    return E,model_name,False
def semantic_score(E,tfscore,seed=20261010):
    # Unsupervised theme clustering; frequency relevance prevents off-domain
    # synonyms from being preferred solely for proximity to the vector centroid.
    model=KMeans(n_clusters=min(24,len(E)),random_state=seed,n_init=10)
    model.fit(E,sample_weight=np.maximum(tfscore,1e-9));labels=model.labels_
    centroid=np.average(E,axis=0,weights=np.maximum(tfscore,1e-9));centroid/=max(np.linalg.norm(centroid),1e-9)
    scores=.65*(1-rank(E@centroid)/len(E))+.35*(1-rank(tfscore)/len(E))
    groups=[np.where(labels==k)[0][np.argsort(-scores[labels==k])] for k in range(model.n_clusters)]
    groups.sort(key=lambda g:-tfscore[g].sum());order=[]
    for n in range(max(map(len,groups))):
        for g in groups:
            if n<len(g):order.append(int(g[n]))
    return scores,labels,order
def matrix_for(docs,candidates):
    # Frozen train vocabulary applied to holdout, no holdout candidate learning.
    keys=[compact(c['name']) for c in candidates];rows=[];cols=[]
    for i,d in enumerate(docs):
        text=compact(d['text'])
        for j,key in enumerate(keys):
            # English word boundaries prevent matching e.g. SQL inside NoSQL.
            name=candidates[j]['name'];pat=r'(?<![a-z0-9])'+re.escape(normalized(name))+r'(?![a-z0-9])'
            has=bool(re.search(pat,normalized(d['text']))) if re.fullmatch(r'[a-z0-9 .+#_-]+',name) else key in text
            if has:rows.append(i);cols.append(j)
    return sparse.csr_matrix((np.ones(len(rows)),(rows,cols)),shape=(len(docs),len(keys)))
def main():
    started=time.perf_counter();data=json.loads((OUT/'corpus.json').read_text(encoding='utf8'));docs=data['docs'];train=[d for d in docs if d['split']=='train'];holdout=[d for d in docs if d['split']=='holdout']
    out=OUT/'strict-phrases' if STRICT else OUT/'phrase-first' if CLEAN else OUT
    out.mkdir(exist_ok=True)
    candidates,X,tokens,minimum=extract(train);T=TfidfTransformer(sublinear_tf=True).fit_transform(X)
    variants=[];rankings={};meta={}
    t=time.perf_counter();tfscore=np.asarray(T.mean(axis=0)).ravel();rankings['tfidf']=np.argsort(-tfscore);meta['tfidf']={'runtime_s':time.perf_counter()-t}
    t=time.perf_counter();trscore=textrank(candidates,X,tokens);rankings['textrank']=np.argsort(-trscore);meta['textrank']={'runtime_s':time.perf_counter()-t}
    t=time.perf_counter();nscore,topics,norder,ninfo=nmf_score(T);rankings['nmf']=norder;meta['nmf']={**ninfo,'runtime_s':time.perf_counter()-t}
    # Save non-semantic results before dependency/model errors, preserving progress.
    (out/'candidate-pool.json').write_text(json.dumps(candidates,ensure_ascii=False,indent=2),encoding='utf8')
    t=time.perf_counter();E,model_name,cached=semantic(candidates,tfscore,out);sim=E@E.T
    sscore,clusters,sorder=semantic_score(E,tfscore);rankings['semantic']=sorder;meta['semantic']={'model':model_name,'dimension':int(E.shape[1]),'cached':cached,'runtime_s':time.perf_counter()-t}
    rrf=np.zeros(len(candidates))
    for order in rankings.values():
        for position,j in enumerate(order):rrf[j]+=1/(60+position+1)
    rankings['fusion']=np.argsort(-rrf);meta['fusion']={'runtime_s':0,'method':'equal RRF k=60; semantic cosine suppression .88; no role dictionary'}
    scores={'tfidf':tfscore,'textrank':trscore,'nmf':nscore,'semantic':sscore,'fusion':rrf}
    selected={id:select(order,candidates,sim=sim if id in ('semantic','fusion') else None) for id,order in rankings.items()}
    hold=matrix_for(holdout,candidates);binary=(X>0).astype(float)
    names={'tfidf':'TF-IDF＋短语发现','textrank':'TextRank＋短语归并','nmf':'NMF主题分解','semantic':'语义向量＋聚类','fusion':'无监督融合'}
    for id,indices in selected.items():
        terms=[]
        for j in indices:terms.append({**candidates[j],'score':float(scores[id][j]),'seed_count':candidates[j]['df'],'used_for_filter':False,'topic_id':int(topics[j]),'semantic_cluster':int(clusters[j])})
        support=np.asarray(hold[:,indices].sum(axis=0)).ravel();coverage=float(np.mean(np.asarray(hold[:,indices].sum(axis=1)).ravel()>0))
        nested=sum(compact(a['name']) in compact(b['name']) or compact(b['name']) in compact(a['name']) for i,a in enumerate(terms) for b in terms[i+1:])
        probabilities=np.bincount(topics[indices],minlength=ninfo['topics'])/len(indices);entropy=-sum(p*math.log(p) for p in probabilities if p>0)/math.log(len(probabilities))
        variants.append({'id':id,'name':names[id],'terms':terms,'meta':meta[id],'metrics':{'words':len(terms),'holdout_doc_coverage':coverage,'holdout_word_support_ratio':float(np.mean(support>=2)),'holdout_word_support':support.tolist(),'nested_pairs':nested,'nmf_topic_coverage':int(len(set(topics[indices]))),'nmf_topic_entropy':entropy}})
        print(json.dumps({'stage':'ranked','id':id,'words':len(terms),'top20':[t['name'] for t in terms[:20]]},ensure_ascii=False),flush=True)
    # Rank robustness on three 80%-subsamples, with train candidate pool fixed.
    # This is conditional ranking stability, not full end-to-end vocabulary stability.
    stability=defaultdict(list);stability_iterations=[]
    for seed in (11,23,47):
        t=time.perf_counter();sample=np.sort(np.random.default_rng(seed).choice(len(train),int(len(train)*.8),replace=False));XX=X[sample];TT=TfidfTransformer(sublinear_tf=True).fit_transform(XX)
        ts=np.asarray(TT.mean(axis=0)).ravel();rs=textrank(candidates,XX,[tokens[i] for i in sample]);ns,nt,no,ni=nmf_score(TT);ss,sl,so=semantic_score(E,ts)
        stability_iterations.append(ni['iterations'])
        orders={'tfidf':np.argsort(-ts),'textrank':np.argsort(-rs),'nmf':no,'semantic':so};rr=np.zeros(len(candidates))
        for order in orders.values():
            for p,j in enumerate(order):rr[j]+=1/(60+p+1)
        orders['fusion']=np.argsort(-rr)
        for id,order in orders.items():
            a=set(selected[id][:50]);b=set(select(order,candidates,limit=50,sim=sim if id in ('semantic','fusion') else None));stability[id].append(len(a&b)/max(1,len(a|b)))
        print(json.dumps({'stage':'stability','seed':seed,'elapsed_s':round(time.perf_counter()-t,2)}),flush=True)
    for v in variants:v['metrics']['top50_stability_jaccard']=float(np.mean(stability[v['id']]));v['metrics']['stability_runs']=stability[v['id']]
    meta['nmf']['stability_iterations']=stability_iterations
    meta['nmf']['stability_converged']=all(n<2000 for n in stability_iterations)
    # Deterministic alphabetical blind list: no algorithm/rank visible in review file.
    union={t['name']:t for v in variants for t in v['terms']}
    for t in data['manifest']['baseline']:
        name=t.get('name',t.get('term'));d=next((d for d in docs if compact(name) in compact(d['text'])),None)
        if name not in union:union[name]={'name':name,'evidence':{'row_no':d['row_no'],'title':d['title'],'quote':next((s['quote'] for s in d['sections'] if compact(name) in compact(s['quote'])),d['text'])} if d else None}
    (out/'blind-review.json').write_text(json.dumps([{'name':n,'evidence':union[n]['evidence']} for n in sorted(union)],ensure_ascii=False,indent=2),encoding='utf8')
    result={'manifest':data['manifest'],'parameters':{'min_df':minimum,'max_candidates':1800,'limit':100,'phrase_pmi':2,'nmf_topics':12,'semantic_clusters':24,'similarity_threshold':.88,'rrf_k':60,'phrase_first':CLEAN,'strict_boundaries':STRICT,'no_role_specific_vocabulary':True,'embedding_training':'public pretrained semantic encoder, no target labels; not trained from scratch'},'candidates':len(candidates),'variants':variants,'total_runtime_s':time.perf_counter()-started}
    (out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'stage':'done','out':str(out),'runtime_s':round(result['total_runtime_s'],2),'blind_terms':len(union)},ensure_ascii=False),flush=True)
if __name__=='__main__':
    with threadpool_limits(limits=4):main()
