"""Train a scoped candidate on API pseudo-labels; no network or production registry writes."""
import os
os.environ['OMP_NUM_THREADS'] = '2'
os.environ['OPENBLAS_NUM_THREADS'] = '2'
import sys, json, re, hashlib, time
from pathlib import Path
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics.pairwise import cosine_similarity

def digest(value):
    return hashlib.sha256(value.encode('utf8')).hexdigest()

def metrics(y, p):
    tp = sum(a == 1 and b == 1 for a, b in zip(y, p))
    tn = sum(a == 0 and b == 0 for a, b in zip(y, p))
    fp = sum(a == 0 and b == 1 for a, b in zip(y, p))
    fn = sum(a == 1 and b == 0 for a, b in zip(y, p))
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    return dict(n=len(y), positive=tp+fn, negative=tn+fp, tp=tp, tn=tn, fp=fp, fn=fn,
                accuracy=(tp+tn)/len(y) if len(y) else None, precision=precision, recall=recall,
                f1=2*tp/(2*tp+fp+fn) if 2*tp+fp+fn else None)

def train(input_path, output_dir):
    started = time.perf_counter()
    data = json.loads(Path(input_path).read_text(encoding='utf8'))
    rows = [r for r in data['samples'] if r['label'] in ['include', 'exclude']]
    if len(rows) < 60:
        raise ValueError('有效正负标签不足60条，保留标注结果，不训练或替换现有筛选器')
    size = len(rows)
    parent = list(range(size))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    def union(i, j):
        i, j = find(i), find(j)
        if i != j:
            parent[max(i,j)] = min(i,j)
    seen = {}
    for i, r in enumerate(rows):
        for key in [('company', r.get('company', '')), ('body', re.sub(r'\s+', '', r['body']).lower())]:
            if not key[1]:
                continue
            if key in seen:
                union(i, seen[key])
            else:
                seen[key] = i
    # This representation is for grouping only, never the classifier vocabulary.
    grouping = TfidfVectorizer(analyzer='char', ngram_range=(5,5), max_features=40000).fit_transform([r['body'] for r in rows])
    similarity = cosine_similarity(grouping)
    for i, j in zip(*np.where(np.triu(similarity >= .9, 1))):
        union(int(i), int(j))
    group_keys = {}
    for i, r in enumerate(rows):
        group_keys.setdefault(find(i), []).append(digest(r['body']))
    # Fixed split before seeing labels, never retry splits to improve the score.
    assignments = {g: ('train' if h < 6 else 'validation' if h < 8 else 'test')
                   for g, bodies in group_keys.items() for h in [int(min(bodies)[:8],16) % 10]}
    splits = [assignments[find(i)] for i in range(size)]
    sets = {s: [i for i in range(size) if splits[i] == s] for s in ['train','validation','test']}
    y = lambda ids: [int(rows[i]['label'] == 'include') for i in ids]
    counts = {s: {'n':len(ids), 'positive':sum(y(ids)), 'negative':len(ids)-sum(y(ids))} for s,ids in sets.items()}
    if min(counts['train']['positive'], counts['train']['negative']) < 10 or min(counts['validation']['positive'], counts['validation']['negative']) < 3:
        raise ValueError('按公司与近重复隔离后正负样本不足；请补充样本，不重新抽取测试集以美化指标。分层数量：'+json.dumps(counts))
    vectorizer = TfidfVectorizer(analyzer='char', ngram_range=(2,4), sublinear_tf=True, min_df=2, max_features=30000)
    vectorizer.fit([rows[i]['text'] for i in sets['train']])
    x = vectorizer.transform([r['text'] for r in rows])
    head = LogisticRegression(C=1, class_weight='balanced', max_iter=1500, random_state=42).fit(x[sets['train']], y(sets['train']))
    val_scores = head.predict_proba(x[sets['validation']])[:,1]
    choices = []
    for threshold in [.4,.45,.5,.55,.6,.65,.7,.75,.8]:
        m = metrics(y(sets['validation']), [int(s >= threshold) for s in val_scores])
        pr, rc = m['precision'] or 0, m['recall'] or 0
        choices.append(((int(pr >= .85), rc if pr >= .85 else (m['f1'] or 0), pr, -abs(threshold-.55)), threshold, m))
    _, threshold, validation = max(choices, key=lambda item:item[0])
    # Freeze selection before the single held-out test evaluation.
    out = Path(output_dir)
    (out/'selection.json').write_text(json.dumps(dict(threshold=threshold, C=1, counts=counts, validation=validation), ensure_ascii=False), encoding='utf8')
    scores = head.predict_proba(x)[:,1]
    test = metrics(y(sets['test']), [int(scores[i] >= threshold) for i in sets['test']])
    eligible = (test['n'] >= 40 and min(test['positive'],test['negative']) >= 10 and
                (test['precision'] or 0) >= .85 and (test['recall'] or 0) >= .65 and
                (validation['precision'] or 0) >= .85 and (validation['recall'] or 0) >= .65)
    version = 'insight-qwen-tfidf-lr-'+data['id']
    model = dict(version=version, family=data['role'], algorithm='char-2-4gram TF-IDF + LogisticRegression', threshold=threshold,
                 tfidf=dict(vocabulary={k:int(v) for k,v in vectorizer.vocabulary_.items()}, idf=vectorizer.idf_.tolist(), ngram_range=[2,4], sublinear_tf=True),
                 head=dict(classes=head.classes_.tolist(), coef=head.coef_[0].tolist(), intercept=float(head.intercept_[0])),
                 input_contract='prepareClassifierInput v1; title60 + duties head/mid/tail420; body80–9000; no query/salary/contact features',
                 provenance=dict(annotation='Qwen3.7-Flash pseudo-labels, not human gold', train_rows=len(sets['train']), validation=validation, test=test,
                                 counts=counts, corpus_sha256=hashlib.sha256(Path(input_path).read_bytes()).hexdigest(),
                                 scope='dataset and role scoped experimental candidate', grouping='company + exact and cosine>=0.90 near-duplicate body isolation'))
    (out/'model.json').write_text(json.dumps(model,ensure_ascii=False), encoding='utf8')
    predictions = [dict(id=r['id'], split=splits[i], group=find(i), label=r['label'], score=float(scores[i]), prediction='include' if scores[i]>=threshold else 'exclude') for i,r in enumerate(rows)]
    report = dict(eligible=eligible, counts=counts, validation=validation, test=test, threshold=threshold, seconds=time.perf_counter()-started,
                  metrics_basis='held-out Qwen pseudo-label agreement; not independent real-world accuracy', human_metrics=None,
                  predictions=predictions, version=version)
    (out/'evaluation.json').write_text(json.dumps(report,ensure_ascii=False), encoding='utf8')
    print(json.dumps(dict(eligible=eligible,counts=counts,test=test),ensure_ascii=False),flush=True)

if __name__ == '__main__':
    try:
        train(sys.argv[1], sys.argv[2])
    except Exception as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False),file=sys.stderr)
        sys.exit(1)
