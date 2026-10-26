import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.svm import LinearSVC

VERSION='supervised-job-embedding-v1'

def normalized(vectors):
    x=np.asarray(vectors,dtype=np.float64)
    if x.ndim!=2 or not len(x) or not np.isfinite(x).all():raise ValueError('Expected nonempty finite embedding matrix')
    norms=np.linalg.norm(x,axis=1,keepdims=True)
    if np.any(norms<1e-12):raise ValueError('Zero embedding is not valid')
    return x/norms

def train(vectors,labels,classes,algorithm='lr',c=1.0,class_weight=None):
    x=normalized(vectors);y=np.asarray(labels,dtype=np.int8)
    if y.shape!=(len(x),len(classes)) or not np.isin(y,[0,1]).all():raise ValueError('Invalid multilabel training targets')
    if len(set(classes))!=len(classes) or algorithm not in ('lr','svm') or c<=0:raise ValueError('Invalid model specification')
    coefficients=[];intercepts=[]
    for column in y.T:
        if len(np.unique(column))!=2:raise ValueError('Every trained class needs positive and negative examples')
        model=LogisticRegression(C=c,class_weight=class_weight,solver='liblinear',max_iter=4000,random_state=20261023) if algorithm=='lr' else LinearSVC(C=c,class_weight=class_weight,dual=True,max_iter=12000,random_state=20261023)
        model.fit(x,column)
        if np.max(model.n_iter_)>=model.max_iter:raise RuntimeError('Classifier convergence not confirmed')
        coefficients.append(model.coef_[0]);intercepts.append(float(model.intercept_[0]))
    return {'coef':np.stack(coefficients),'intercept':np.array(intercepts),'classes':list(classes),'algorithm':algorithm,'c':c,'classWeight':class_weight}

def score(model,vectors):
    x=normalized(vectors)
    if x.shape[1]!=model['coef'].shape[1]:raise ValueError('Embedding dimension mismatch')
    margin=x@model['coef'].T+model['intercept']
    if model['algorithm']=='lr':return 1/(1+np.exp(-np.clip(margin,-700,700)))
    return margin

def decide(scores,threshold,mode='multilabel'):
    values=np.asarray(scores)
    if values.ndim!=2 or not np.isfinite(values).all():raise ValueError('Invalid score matrix')
    result=values>=threshold
    if mode=='top1':
        chosen=np.argmax(values,axis=1);result[:]=False
        for i,j in enumerate(chosen):result[i,j]=values[i,j]>=threshold
    elif mode!='multilabel':raise ValueError('Unknown decision mode')
    return result

def export(model,directory,threshold,mode,provenance):
    target=Path(directory);target.mkdir(parents=True,exist_ok=False)
    np.savez(target/'weights.npz',coef=model['coef'],intercept=model['intercept'])
    metadata={k:v for k,v in model.items() if k not in ('coef','intercept')}
    metadata.update({'version':VERSION,'dimensions':int(model['coef'].shape[1]),'threshold':float(threshold),'mode':mode,'normalization':'l2','weightsSha256':hashlib.sha256((target/'weights.npz').read_bytes()).hexdigest(),'provenance':provenance,'scoreMeaning':'uncalibrated binary probability' if model['algorithm']=='lr' else 'uncalibrated linear margin','deploymentStatus':'offline-candidate'})
    with (target/'model.json').open('x',encoding='utf-8') as f:json.dump(metadata,f,ensure_ascii=False,indent=2)
    return metadata

def load(directory,encoder_identity=None):
    target=Path(directory);meta=json.loads((target/'model.json').read_text(encoding='utf-8'))
    if meta['version']!=VERSION or hashlib.sha256((target/'weights.npz').read_bytes()).hexdigest()!=meta['weightsSha256']:raise ValueError('Invalid model or weights hash')
    if encoder_identity is not None and encoder_identity!=meta['provenance']['encoderIdentity']:raise ValueError('Embedding identity mismatch')
    with np.load(target/'weights.npz',allow_pickle=False) as weights:coef=weights['coef'].copy();intercept=weights['intercept'].copy()
    if coef.shape!=(len(meta['classes']),meta['dimensions']) or intercept.shape!=(len(meta['classes']),) or not np.isfinite(coef).all() or not np.isfinite(intercept).all():raise ValueError('Invalid stored coefficients')
    return {**meta,'coef':coef,'intercept':intercept}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['predict']);parser.add_argument('--model',required=True);parser.add_argument('--vectors',required=True);parser.add_argument('--encoder-identity',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
    model=load(args.model,args.encoder_identity);scores=score(model,np.load(args.vectors,allow_pickle=False));selected=decide(scores,model['threshold'],model['mode'])
    output={'version':VERSION,'classes':model['classes'],'scoreMeaning':model['scoreMeaning'],'rows':[{'labels':[c for c,v in zip(model['classes'],row) if v],'scores':values.tolist(),'status':'target' if row.any() else 'other-or-insufficient-evidence'} for row,values in zip(selected,scores)]}
    with Path(args.output).open('x',encoding='utf-8') as f:json.dump(output,f,ensure_ascii=False,indent=2)

if __name__=='__main__':main()
