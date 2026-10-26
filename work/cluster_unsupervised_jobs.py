"""Offline discovery only. No production DB imports, network or API labels."""
import os
for k,v in {'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','HF_HUB_DISABLE_TELEMETRY':'1','TOKENIZERS_PARALLELISM':'false','OMP_NUM_THREADS':'2','MKL_NUM_THREADS':'2','DO_NOT_TRACK':'1'}.items():os.environ[k]=v
import json,time,hashlib,sys
from pathlib import Path
from collections import Counter
import numpy as np
import torch
from sentence_transformers import SentenceTransformer
from sklearn.cluster import KMeans,HDBSCAN
from sklearn.decomposition import PCA
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import normalize

ROOT=Path(__file__).resolve().parents[1]
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(out,name,value):
    with (out/name).open('x',encoding='utf-8') as f:json.dump(value,f,ensure_ascii=False,indent=2)
def run(out):
    out=Path(out);corpus=json.loads((out/'corpus.json').read_text(encoding='utf-8'));docs=corpus['docs'];protocol=corpus['protocol']
    if (out/'clusters.json').exists():raise RuntimeError('Results sealed; do not overwrite')
    model_dir=ROOT/'work/role_screening_models/bge-small-zh-v1.5'
    manifest=json.loads((model_dir/'local-manifest.json').read_text(encoding='utf-8'))
    for name,spec in manifest['files'].items():
        if sha(model_dir/name)!=spec['sha256']:raise RuntimeError('Encoder integrity mismatch '+name)
    torch.set_num_threads(2);start=time.perf_counter();model=SentenceTransformer(str(model_dir),device='cpu',local_files_only=True);model.max_seq_length=512
    texts=[d['text'] for d in docs];lengths=[len(model.tokenizer(t,truncation=False)['input_ids']) for t in texts]
    if max(lengths)>512:raise RuntimeError('Input would silently truncate; revise versioned preparation before clustering')
    parts=[]
    for i in range(0,len(texts),250):
        parts.append(model.encode(texts[i:i+250],batch_size=8,normalize_embeddings=True,show_progress_bar=False))
        print(json.dumps({'stage':'embedding','done':min(i+250,len(texts)),'total':len(texts),'seconds':round(time.perf_counter()-start,1)}),flush=True)
    x=np.concatenate(parts).astype('float32');np.save(out/'embeddings.npy',x,allow_pickle=False);encoding_seconds=time.perf_counter()-start
    reduced=PCA(n_components=30,random_state=42).fit_transform(x)
    methods={};labels_by_method={}
    for name,estimator,data in [('kmeans',KMeans(n_clusters=24,n_init=10,random_state=42),x),('hdbscan',HDBSCAN(min_cluster_size=50,min_samples=10,cluster_selection_method='eom',n_jobs=2),reduced)]:
        stamp=time.perf_counter();labels=estimator.fit_predict(data);counts=Counter(int(v) for v in labels);valid=labels>=0
        metric=None
        if len(set(labels[valid]))>1 and sum(valid)>2:
            metric=float(silhouette_score(x[valid],labels[valid],metric='cosine',sample_size=min(1000,int(sum(valid))),random_state=42))
        methods[name]={'clusters':len([c for c in counts if c>=0]),'noise_rows':counts.get(-1,0),'coverage':float(np.mean(valid)),'sizes':dict(sorted(counts.items())),'cosine_silhouette_sample1000_excluding_noise':metric,'seconds':time.perf_counter()-stamp}
        labels_by_method[name]=labels
    h=methods['hdbscan'];chosen='hdbscan' if h['clusters']>=4 and h['coverage']>=.3 else 'kmeans'
    assignments=[];cards=[];audits=[];labels=labels_by_method[chosen]
    for cluster in sorted(set(int(v) for v in labels)):
        ids=np.flatnonzero(labels==cluster);centroid=normalize(np.mean(x[ids],axis=0).reshape(1,-1))[0];similarity=x[ids]@centroid
        ordered=[int(ids[i]) for i in np.argsort(-similarity,kind='stable')]
        if cluster<0:
            for i in ordered:assignments.append({'key':docs[i]['key'],'cluster':cluster,'status':'noise_unlabelled'})
            continue
        center=ordered[:2];boundary=[i for i in reversed(ordered) if i not in center][:2]
        random_ids=sorted((i for i in ordered if i not in center+boundary),key=lambda i:hashlib.sha256(('sample42:'+docs[i]['key']).encode()).hexdigest())
        reps=center+random_ids[:2]+boundary;audit_ids=random_ids[2:4]
        samples=[]
        for i in reps:
            d=docs[i];samples.append({'key':d['key'],'content_hash':d['content_hash'],'kind':'center' if i in center else 'boundary' if i in boundary else 'random','title':d['title'],'excerpt':d['excerpt']})
        cards.append({'cluster':cluster,'rows':len(ids),'samples':samples})
        for i in audit_ids:audits.append({'cluster':cluster,'key':docs[i]['key'],'content_hash':docs[i]['content_hash'],'title':docs[i]['title'],'excerpt':docs[i]['excerpt']})
        for i in ordered:assignments.append({'key':docs[i]['key'],'content_hash':docs[i]['content_hash'],'cluster':cluster,'centroid_similarity':float(x[i]@centroid),'status':'cluster_member_not_confirmed_label'})
    save(out,'clusters.json',{'chosen':chosen,'methods':methods,'cards':cards})
    save(out,'assignments.json',assignments);save(out,'heldout-audit.json',audits)
    save(out,'summary.json',{'source_rows':protocol['source_rows'],'sampled_rows':len(docs),'corpus_sha256':sha(out/'corpus.json'),'model_revision':manifest['revision'],'embedding_dimensions':int(x.shape[1]),'max_input_tokens':max(lengths),'embedding_seconds':encoding_seconds,'methods':methods,'chosen':chosen,'representative_rows':sum(len(c['samples']) for c in cards),'heldout_audit_rows':len(audits),'total_seconds':time.perf_counter()-start,'limitations':'Unsupervised discovery; silhouette is NOT occupational precision; same-Codex audit is NOT independent human gold. No production publication.'})
    print(json.dumps({'stage':'completed','chosen':chosen,'methods':methods,'seconds':time.perf_counter()-start}),flush=True)
if __name__=='__main__':run(sys.argv[1])
