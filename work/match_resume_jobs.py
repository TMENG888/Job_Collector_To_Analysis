import os,sys
for k,v in {'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','TOKENIZERS_PARALLELISM':'false','OMP_NUM_THREADS':'4','MKL_NUM_THREADS':'4','PYTHONDONTWRITEBYTECODE':'1'}.items():os.environ[k]=v
import json,time,hashlib,re,math,threading,gc
from pathlib import Path
from collections import Counter
import numpy as np,psutil,jieba,ctypes
ROOT=Path(sys.argv[1]).resolve()
PROJECT=Path(__file__).resolve().parent.parent
CONFIG=json.loads((ROOT/'config.json').read_text(encoding='utf-8'))
CACHE_ROOT=Path(CONFIG['cacheDir']).resolve()
if CACHE_ROOT.parent!=ROOT.parent.parent:raise ValueError('cache directory outside matching runtime')
START=time.perf_counter()
stats={'peakRss':0,'minAvailableRam':2**63};done=threading.Event()
pressure_count=0
def monitor():
 global pressure_count
 while not done.wait(.5):
  rss=psutil.Process().memory_info().rss;available=psutil.virtual_memory().available
  stats['peakRss']=max(stats['peakRss'],rss);stats['minAvailableRam']=min(stats['minAvailableRam'],available)
  pressure_count=pressure_count+1 if available<256*1024**2 else 0
  if pressure_count>=6:
   (ROOT/'memory-stop.json').write_text(json.dumps(stats));os._exit(78)
threading.Thread(target=monitor,daemon=True).start()
def log(stage,**kw):print(json.dumps({'stage':stage,'seconds':round(time.perf_counter()-START,1),**kw},ensure_ascii=False),flush=True)
def save(name,x):(ROOT/name).write_text(json.dumps(x,ensure_ascii=False,indent=2),encoding='utf-8')
def read(name):return json.loads((ROOT/name).read_text(encoding='utf-8'))
def verify(directory):
 m=json.loads((directory/'local-manifest.json').read_text(encoding='utf-8'))
 for name,expected in m['files'].items():
  assert hashlib.sha256((directory/name).read_bytes()).hexdigest()==expected['sha256'],name
 return {k:m[k] for k in ['repo','revision']}
jobs=read('jobs.json');profile=read('profile.json')
# Exact title/company/body duplicates are collapsed, while city variants remain separate.
seen={};unique=[];aliases={}
for i,j in enumerate(jobs):
 identity=(j['company'],j['job_name'],j['city'],re.sub(r'\s+','',j['description']))
 if identity in seen:aliases.setdefault(str(seen[identity]),[]).append(j['key']);continue
 seen[identity]=i;unique.append(i)
docs=[jobs[i]['job_name']+'\n'+jobs[i]['description'] for i in unique]
queries=profile['query_facets'];lex_queries=[queries[0]+' '+queries[1],queries[2],queries[3]]
def tokens(s):
 return [x for x in re.findall(r'[a-z][a-z0-9_+#.\-]*|[\u4e00-\u9fff]+|\d+(?:\.\d+)?', ' '.join(jieba.cut(s.lower()))) if len(x)>1 or x in ['c','r']]
tick=time.perf_counter();terms=[Counter(tokens(s)) for s in docs];n=len(terms);df=Counter()
for c in terms:df.update(c.keys())
lengths=np.array([sum(c.values()) for c in terms]);average=float(lengths.mean());scores=[]
for query in lex_queries:
 score=np.zeros(n)
 for t in set(tokens(query)):
  f=np.array([c[t] for c in terms]);idf=math.log(1+(n-df[t]+.5)/(df[t]+.5))
  score+=idf*f*2.5/(f+1.5*(.25+.75*lengths/average))
 scores.append(score)
bm25=np.max(scores,axis=0);bm_order=np.argsort(-bm25,kind='stable')
save('bm25.json',{'seconds':time.perf_counter()-tick,'k1':1.5,'b':.75,'unique':n,'queries':lex_queries,'top':[{'key':jobs[unique[int(i)]]['key'],'score':float(bm25[i])} for i in bm_order[:250]]})
log('bm25_done',unique=n,duplicates=len(jobs)-n)
del terms,scores,docs,seen;gc.collect()
import torch
from sentence_transformers import SentenceTransformer,CrossEncoder
torch.set_num_threads(4);torch.set_num_interop_threads(1)
emb_dir=PROJECT/'work/role_screening_models/bge-small-zh-v1.5';embedding_manifest=verify(emb_dir)
tick=time.perf_counter();encoder=SentenceTransformer(str(emb_dir),device='cpu',local_files_only=True,trust_remote_code=False)
encoder.max_seq_length=512;encoder.eval();embedding_load=time.perf_counter()-tick
def windows(text,tokenizer,limit,overlap):
 enc=tokenizer(text,add_special_tokens=False,truncation=False,return_offsets_mapping=True)
 offsets=enc['offset_mapping'];out=[];start=0
 if not offsets:return [(0,len(text))]
 while start<len(offsets):
  end=min(start+limit,len(offsets));a=0 if start==0 else offsets[start][0];b=len(text) if end==len(offsets) else offsets[end-1][1]
  out.append((a,b))
  if end==len(offsets):break
  start=end-overlap
 assert out[0][0]==0 and out[-1][1]==len(text)
 assert all(out[k+1][0]<=out[k][1] for k in range(len(out)-1))
 return out
chunks=[];owners=[];bounds=[]
for local,j in enumerate([jobs[i] for i in unique]):
 # Token offsets cover every character of full JD. No head-only truncation.
 for a,b in windows(j['description'],encoder.tokenizer,350,40):
  title=j['job_name'];chunk=title+'\n'+j['description'][a:b]
  if len(encoder.tokenizer(chunk,add_special_tokens=True)['input_ids'])>512:raise ValueError('embedding title too long')
  chunks.append(chunk);owners.append(local);bounds.append([a,b])
fingerprint=hashlib.sha256(json.dumps([embedding_manifest,chunks],ensure_ascii=False).encode()).hexdigest()
cache_dir=CACHE_ROOT/fingerprint;cache_dir.mkdir(parents=True,exist_ok=True)
cache=cache_dir/'embeddings.npy';meta=cache_dir/'embedding-cache.json';tick=time.perf_counter()
if cache.exists() and meta.exists() and json.loads(meta.read_text(encoding='utf-8'))['fingerprint']==fingerprint:
 vectors=np.load(cache,allow_pickle=False);log('embedding_cache_reused',chunks=len(chunks))
else:
 # A memmap is a durable per-batch checkpoint; only a finished index is promoted.
 partial=cache_dir/'embeddings.partial.npy';progress=cache_dir/'embedding-progress.json'
 progress_data=json.loads(progress.read_text(encoding='utf-8')) if progress.exists() else {}
 valid=partial.exists() and progress_data.get('fingerprint')==fingerprint
 offset=progress_data['done'] if valid else 0
 matrix=np.lib.format.open_memmap(partial,mode='r+' if valid else 'w+',dtype='float32',shape=(len(chunks),512))
 log('embedding_started',chunks=len(chunks),resuming=offset)
 last=time.perf_counter()
 for a in range(offset,len(chunks),4):
  b=min(a+4,len(chunks));matrix[a:b]=encoder.encode(chunks[a:b],batch_size=4,prompt='',normalize_embeddings=True,show_progress_bar=False,convert_to_numpy=True)
  matrix.flush();progress.write_text(json.dumps({'fingerprint':fingerprint,'done':b,'total':len(chunks)}),encoding='utf-8')
  if time.perf_counter()-last>20:log('embedding_progress',done=b,total=len(chunks));last=time.perf_counter()
 assert np.isfinite(matrix).all();del matrix;partial.replace(cache)
 meta.write_text(json.dumps({'fingerprint':fingerprint,'shape':[len(chunks),512],'owners':owners,'bounds':bounds,'model':embedding_manifest}),encoding='utf-8');vectors=np.load(cache,allow_pickle=False)
embedding_seconds=time.perf_counter()-tick
q=encoder.encode(queries,batch_size=4,prompt='为这个句子生成表示以用于检索相关文章：',normalize_embeddings=True,show_progress_bar=False,convert_to_numpy=True)
chunk_scores=np.max(vectors@q.T,axis=1);dense=np.full(n,-2,dtype=np.float64);np.maximum.at(dense,np.array(owners),chunk_scores)
vector_order=np.argsort(-dense,kind='stable');del encoder,vectors;gc.collect()
# Equal-weight reciprocal-rank fusion, fixed before seeing results.
rrf=np.zeros(n)
for order in [bm_order[:250],vector_order[:250]]:
 for rank,i in enumerate(order,1):rrf[i]+=1/(60+rank)
candidates=np.flatnonzero(rrf>0);candidates=sorted(candidates,key=lambda i:(-rrf[i],jobs[unique[i]]['key']))
save('retrieval.json',{'vector_model':embedding_manifest,'embedding_load_seconds':embedding_load,'embedding_seconds':embedding_seconds,'chunks':len(chunks),'unique':n,'candidates':len(candidates),'candidates_top250_per_channel':True,'rrf_k':60,'duplicates':aliases,'ranked':[{'key':jobs[unique[int(i)]]['key'],'index':unique[int(i)],'bm25':float(bm25[i]),'dense':float(dense[i]),'rrf':float(rrf[i])} for i in candidates]})
log('hybrid_done',candidates=len(candidates),chunks=len(chunks))
rerank_dir=PROJECT/'work/role_screening_models/mmarco-mMiniLMv2-L12-H384-v1';reranker_manifest=verify(rerank_dir)
tick=time.perf_counter();reranker=CrossEncoder(str(rerank_dir),device='cpu',max_length=512,local_files_only=True,trust_remote_code=False,default_activation_function=torch.nn.Identity());reranker.model.eval();reranker_load=time.perf_counter()-tick
query=profile.get('matching_query') or ('寻找'+CONFIG['role']+'岗位。候选人已展示的技术与职责：'+'、'.join(s['name'] for s in profile['skills'][:12]))
query_ids=reranker.tokenizer(query,add_special_tokens=False)['input_ids']
if len(query_ids)>180:
 query=reranker.tokenizer.decode(query_ids[:180],skip_special_tokens=True)
 query_ids=reranker.tokenizer(query,add_special_tokens=False)['input_ids']
qlen=len(query_ids)
pairs=[];pair_owners=[]
for ci,i in enumerate(candidates):
 j=jobs[unique[int(i)]]
 title_tokens=len(reranker.tokenizer(j['job_name'],add_special_tokens=False)['input_ids'])
 limit=512-qlen-title_tokens-8
 if limit<160:raise ValueError('job title exceeds reranking token budget')
 for a,b in windows(j['description'],reranker.tokenizer,limit,32):
  body=j['job_name']+'\n'+j['description'][a:b]
  assert len(reranker.tokenizer(query,body,add_special_tokens=True,truncation=False)['input_ids'])<=512
  pairs.append((query,body));pair_owners.append(ci)
tick=time.perf_counter();log('reranker_started',pairs=len(pairs),window_tokens=limit)
cross=np.full(len(candidates),-np.inf);last=time.perf_counter()
for a in range(0,len(pairs),2):
 values=reranker.predict(pairs[a:a+2],batch_size=2,show_progress_bar=False,convert_to_numpy=True)
 for k,value in enumerate(values):cross[pair_owners[a+k]]=max(cross[pair_owners[a+k]],float(value))
 if time.perf_counter()-last>20:log('reranker_progress',done=min(a+2,len(pairs)),total=len(pairs));last=time.perf_counter()
order=sorted(range(len(candidates)),key=lambda ci:(-cross[ci],-rrf[candidates[ci]],jobs[unique[int(candidates[ci])]]['key']))
assert np.isfinite(cross).all()
ranked=[]
for rank,ci in enumerate(order,1):
 i=int(candidates[ci]);j=jobs[unique[i]]
 ranked.append({**j,'rank':rank,'bm25_score':float(bm25[i]),'vector_similarity':float(dense[i]),'rrf_score':float(rrf[i]),'rerank_score':float(cross[ci]),'recall_rank':candidates.index(i)+1})
save('ranked.json',ranked)
save('performance.json',{'source_rows':len(jobs),'unique_rows':n,'chunks':len(chunks),'candidates':len(candidates),'rerank_pairs':len(pairs),'embedding_model':embedding_manifest,'reranker_model':reranker_manifest,'embedding_load_seconds':embedding_load,'embedding_seconds':embedding_seconds,'reranker_load_seconds':reranker_load,'rerank_seconds':time.perf_counter()-tick,'total_seconds':time.perf_counter()-START,'memory':stats,'filters_before_ranking':[],'full_body_policy':'all JD characters covered by overlapping token windows; max chunk reranker score; query is factual profile summary, not full resume','limits':'Top250 per retrieval channel is a recall cutoff. Classifier pool may have false positives and misses. Rerank logits are relevance scores, not success probabilities. No human matching labels.'})
log('finished',top=[{'title':j['job_name'],'company':j['company'],'score':round(j['rerank_score'],3)} for j in ranked[:10]])
done.set()
