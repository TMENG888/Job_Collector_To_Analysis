"""Experimental local classifier: JSON array of {id,title,body} on stdin; JSON on stdout.
No pickle loading, network, database access, or production-admission integration.
"""
import sys
import json
from pathlib import Path
from train_codex_role_classifier import OUT, MODEL, ROOT, prepare, sha

def linear_scores(x,head):
    import numpy as np
    z=np.asarray(x@np.asarray(head['coef'])).reshape(-1)+head['intercept']
    return 1/(1+np.exp(-np.clip(z,-500,500)))

def restore_vectorizer(spec):
    import numpy as np
    from sklearn.feature_extraction.text import TfidfVectorizer
    v=TfidfVectorizer(analyzer='char',ngram_range=tuple(spec['ngram_range']),vocabulary=spec['vocabulary'],sublinear_tf=spec['sublinear_tf'])
    v.idf_=np.asarray(spec['idf'])
    return v

def predict(docs,artifact_dir=OUT,method=None):
    import numpy as np
    artifact_dir=Path(artifact_dir)
    artifact=json.loads((artifact_dir/'classifier.json').read_text(encoding='utf-8'))
    seal=json.loads((artifact_dir/'selection-before-test.json').read_text(encoding='utf-8'))
    assert sha(artifact_dir/'classifier.json')==seal['classifier_sha256'],'Artifact checksum mismatch'
    method=method or artifact['winner']
    assert method in ['char_tfidf_lr','bge_frozen_lr','setfit_bge_lr','ensemble_equal']
    if not docs:return []
    if len(docs)>256:raise ValueError('At most256 records per bounded inference call')
    for d in docs:
        if not isinstance(d.get('title'),str) or not isinstance(d.get('body'),str):raise ValueError('title/body strings required')
        if len(d['body'])>9000:raise ValueError('JD exceeds evaluated9000char limit')
    texts=[prepare(d)[0] for d in docs];scores={}
    if method in ['char_tfidf_lr','ensemble_equal']:
        scores['char_tfidf_lr']=linear_scores(restore_vectorizer(artifact['tfidf']).transform(texts),artifact['heads']['char_tfidf_lr'])
    if method in ['bge_frozen_lr','setfit_bge_lr','ensemble_equal']:
        import torch
        import psutil
        from sentence_transformers import SentenceTransformer
        if psutil.virtual_memory().available<2*1024**3:raise RuntimeError('Insufficient memory for encoder')
        torch.set_num_threads(2)
        model_dir=MODEL if method=='bge_frozen_lr' else artifact_dir/'trained-encoder'
        if method=='bge_frozen_lr':
            manifest=json.loads((MODEL/'local-manifest.json').read_text(encoding='utf-8'))
            for p,m in manifest['files'].items():assert sha(MODEL/p)==m['sha256']
        else:
            for p,h in artifact['encoder_files'].items():assert sha(model_dir/p)==h
        encoder=SentenceTransformer(str(model_dir),device='cpu',local_files_only=True,trust_remote_code=False);encoder.max_seq_length=512
        x=encoder.encode(texts,batch_size=4,normalize_embeddings=True,show_progress_bar=False,convert_to_numpy=True)
        name='bge_frozen_lr' if method=='bge_frozen_lr' else 'setfit_bge_lr'
        scores[name]=linear_scores(x,artifact['heads'][name])
    values=(scores['char_tfidf_lr']+scores['setfit_bge_lr'])/2 if method=='ensemble_equal' else scores[method]
    threshold=artifact['selections'][method]['threshold']
    return [{'id':d.get('id'), 'target':'数据分析', 'method':method,'score':float(s),'threshold':threshold,
             'accepted':bool(s>=threshold),'status':'experimental_candidate' if s>=threshold else 'not_admitted_not_proof_unrelated',
             'warning':'Codex-label trained; not calibrated confidence; independent human review pending; not applicable to other role families'} for d,s in zip(docs,values)]

def main():
    sys.stdin.reconfigure(encoding='utf-8');sys.stdout.reconfigure(encoding='utf-8')
    docs=json.load(sys.stdin)
    if not isinstance(docs,list):raise ValueError('Provide JSON array')
    print(json.dumps(predict(docs),ensure_ascii=False))

if __name__=='__main__':main()
