"""Offline experimental binary role admission. Safe JSON artifact, no network/DB/pickle."""
import json
import sys
from pathlib import Path
from evaluate_role_screening_trial import ROOT, prepare, sha
from predict_codex_role_classifier import restore_vectorizer

OUT=ROOT/'ui_data/insights/comparisons/bayes-classifier-20261016'

def nb_scores(x,head):
    import numpy as np
    from scipy.special import logsumexp
    joint=np.asarray(x@np.asarray(head['feature_log_prob']).T)
    if head['kind']=='multinomial_nb':joint+=np.asarray(head['class_log_prior'])
    elif head['kind']!='complement_nb':raise ValueError('Unknown NB kind')
    if head['classes']!=[0,1]:raise ValueError('Binary classes [0,1] required')
    return np.exp(joint[:,1]-logsumexp(joint,axis=1))

def predict(docs,artifact_dir=OUT,method=None):
    if not isinstance(docs,list):raise ValueError('Provide JSON array')
    if len(docs)>256:raise ValueError('At most256 records per call')
    for d in docs:
        if not isinstance(d,dict) or not isinstance(d.get('title'),str) or not isinstance(d.get('body'),str):
            raise ValueError('title/body strings required')
        if len(d['body'])>9000:raise ValueError('JD exceeds evaluated9000char limit')
    artifact_dir=Path(artifact_dir)
    artifact=json.loads((artifact_dir/'classifier.json').read_text(encoding='utf-8'))
    seal=json.loads((artifact_dir/'selection-before-test.json').read_text(encoding='utf-8'))
    if sha(artifact_dir/'classifier.json')!=seal['classifier_sha256']:raise ValueError('Artifact checksum mismatch')
    method=method or artifact['winner']
    if method not in artifact['heads']:raise ValueError('Unknown NB method')
    if not docs:return []
    x=restore_vectorizer(artifact['tfidf']).transform([prepare(d)[0] for d in docs])
    scores=nb_scores(x,artifact['heads'][method]);threshold=artifact['selections'][method]['threshold']
    return [{'id':d.get('id'),'target':'数据分析','method':method,'score':float(s),'threshold':threshold,
             'accepted':bool(s>=threshold),'status':'offline_experimental_only',
             'warning':'Codex labels, not independent human gold; score not calibrated confidence; other role families not evaluated'}
            for d,s in zip(docs,scores)]

if __name__=='__main__':
    sys.stdin.reconfigure(encoding='utf-8');sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(predict(json.load(sys.stdin)),ensure_ascii=False))
