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

class InsufficientClassSamples(ValueError):
    def __init__(self, message, counts=None):
        super().__init__(message)
        self.counts = counts

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
        raise InsufficientClassSamples('有效正负标签不足60条，保留标注结果，不训练或替换现有筛选器')
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
    grouping_vectorizer = TfidfVectorizer(analyzer='char', ngram_range=(5,5), max_features=40000)
    grouping_corpus = data.get('grouping_samples', rows)
    if data.get('fixed_splits') is not None and data.get('grouping_samples'):
        corpus_by_id = {r['id']: r for r in grouping_corpus}
        if any(corpus_by_id.get(r['id'], {}).get('body') != r['body'] for r in rows):
            raise ValueError('固定去重语料缺少样本或正文不一致')
    grouping_vectorizer.fit([r['body'] for r in grouping_corpus])
    grouping = grouping_vectorizer.transform([r['body'] for r in rows])
    similarity = cosine_similarity(grouping)
    for i, j in zip(*np.where(np.triu(similarity >= .9, 1))):
        union(int(i), int(j))
    group_keys = {}
    for i, r in enumerate(rows):
        group_keys.setdefault(find(i), []).append(digest(r['body']))
    # Fixed split before seeing labels, never retry splits to improve the score.
    assignments = {g: ('train' if h < 6 else 'validation' if h < 8 else 'test')
                   for g, bodies in group_keys.items() for h in [int(min(bodies)[:8],16) % 10]}
    fixed = data.get('fixed_splits')
    if fixed is not None:
        if not isinstance(fixed, dict) or len({r['id'] for r in rows}) != size:
            raise ValueError('固定分组格式错误或样本ID重复')
        splits = [fixed.get(r['id']) for r in rows]
        if any(s not in ['train', 'validation', 'test', 'excluded'] for s in splits):
            raise ValueError('固定分组缺失或无效；禁止自动重新划分')
        grouped_splits = {}
        for i, split in enumerate(splits):
            grouped_splits.setdefault(find(i), set()).add(split)
        if any(len(s) != 1 for s in grouped_splits.values()):
            conflicts = [[dict(id=rows[i]['id'], split=splits[i]) for i in range(size) if find(i) == group]
                         for group, labels in grouped_splits.items() if len(labels) != 1]
            raise ValueError('固定分组存在公司或近重复泄漏；停止训练，不自动重分测试集：'+json.dumps(conflicts))
    else:
        splits = [assignments[find(i)] for i in range(size)]
    sets = {s: [i for i in range(size) if splits[i] == s] for s in ['train','validation','test']}
    y = lambda ids: [int(rows[i]['label'] == 'include') for i in ids]
    counts = {s: {'n':len(ids), 'positive':sum(y(ids)), 'negative':len(ids)-sum(y(ids))} for s,ids in sets.items()}
    if min(counts['train']['positive'], counts['train']['negative']) < 10 or min(counts['validation']['positive'], counts['validation']['negative']) < 3:
        raise InsufficientClassSamples('按公司与近重复隔离后正负样本不足；标签已保留，请补充不同公司、不同职责的样本，不重新抽取测试集以美化指标。', counts)
    # Predeclared, bounded search. Vocabulary sees TRAIN only; choices and the
    # threshold see VALIDATION only. Test labels never enter model selection.
    contracts = ['duties-v1']
    if all(r.get('training_text_v2') for r in rows):
        contracts.append('scoped-jd-v2')
    best = None
    candidates = []
    for contract in contracts:
        texts = [r['training_text_v2'] if contract == 'scoped-jd-v2' else r['text'] for r in rows]
        vectorizer = TfidfVectorizer(analyzer='char', ngram_range=(2,4), sublinear_tf=True, min_df=2, max_features=30000)
        vectorizer.fit([texts[i] for i in sets['train']])
        x = vectorizer.transform(texts)
        for c in [.25, 1, 4, 16]:
            for class_weight in [None, 'balanced']:
                head = LogisticRegression(C=c, class_weight=class_weight, max_iter=1500, random_state=42).fit(x[sets['train']], y(sets['train']))
                val_scores = head.predict_proba(x[sets['validation']])[:,1]
                for threshold in [.3,.35,.4,.45,.5,.55,.6,.65,.7,.75,.8]:
                    m = metrics(y(sets['validation']), [int(s >= threshold) for s in val_scores])
                    pr, rc = m['precision'] or 0, m['recall'] or 0
                    rank = (int(pr >= .85 and rc >= .65), m['f1'] or 0, pr, rc, -abs(threshold-.5), -c)
                    choice = dict(input_preprocessing=contract, C=c, class_weight=class_weight, threshold=threshold, validation=m)
                    candidates.append(choice)
                    if best is None or rank > best[0]:
                        best = (rank, choice, vectorizer, head, x)
    _, selected, vectorizer, head, x = best
    threshold, validation = selected['threshold'], selected['validation']
    # Freeze selection before the single held-out test evaluation.
    out = Path(output_dir)
    (out/'selection.json').write_text(json.dumps(dict(**selected, counts=counts, candidates=candidates, protocol='train-only vocabulary; validation-only bounded grid; fixed company/near-duplicate split; test evaluated after selection'), ensure_ascii=False), encoding='utf8')
    scores = head.predict_proba(x)[:,1]
    test = metrics(y(sets['test']), [int(scores[i] >= threshold) for i in sets['test']])
    eligible = (test['n'] >= 40 and min(test['positive'],test['negative']) >= 10 and
                (test['precision'] or 0) >= .85 and (test['recall'] or 0) >= .65 and
                (validation['precision'] or 0) >= .85 and (validation['recall'] or 0) >= .65)
    version = 'insight-qwen-tfidf-lr-'+data['id']
    model = dict(version=version, family=data['role'], algorithm='char-2-4gram TF-IDF + LogisticRegression', threshold=threshold, input_preprocessing=selected['input_preprocessing'],
                 tfidf=dict(vocabulary={k:int(v) for k,v in vectorizer.vocabulary_.items()}, idf=vectorizer.idf_.tolist(), ngram_range=[2,4], sublinear_tf=True),
                 head=dict(classes=head.classes_.tolist(), coef=head.coef_[0].tolist(), intercept=float(head.intercept_[0])),
                 input_contract=selected['input_preprocessing']+'; original JD only; AI category labels as supervision; no training-only AI tags; body80–9000; no search-query/company-id/contact features',
                 provenance=dict(annotation='Qwen3.7-Flash pseudo-labels, not human gold', train_rows=len(sets['train']), validation=validation, test=test,
                                 counts=counts, annotation_schema=data.get('annotationSchema'), corpus_sha256=hashlib.sha256(Path(input_path).read_bytes()).hexdigest(),
                                 sampling=data.get('sampling'),
                                 selection=selected, scope='dataset and role scoped experimental candidate', grouping='company + exact and cosine>=0.90 near-duplicate body isolation'))
    (out/'model.json').write_text(json.dumps(model,ensure_ascii=False), encoding='utf8')
    predictions = [dict(id=r['id'], split=splits[i], group=find(i), label=r['label'], score=float(scores[i]), prediction='include' if scores[i]>=threshold else 'exclude') for i,r in enumerate(rows)]
    report = dict(eligible=eligible, counts=counts, validation=validation, test=test, threshold=threshold, selection=selected, seconds=time.perf_counter()-started,
                  metrics_basis='held-out Qwen pseudo-label agreement; not independent real-world accuracy', human_metrics=None, annotationSchema=data.get('annotationSchema'),
                  sampling=data.get('sampling'),
                  fixed_splits=fixed is not None, excluded_rows=sum(s == 'excluded' for s in splits),
                  predictions=predictions, version=version)
    (out/'evaluation.json').write_text(json.dumps(report,ensure_ascii=False), encoding='utf8')
    print(json.dumps(dict(eligible=eligible,counts=counts,test=test),ensure_ascii=False),flush=True)

if __name__ == '__main__':
    try:
        train(sys.argv[1], sys.argv[2])
    except InsufficientClassSamples as error:
        report = dict(ready=False, message=str(error), counts=error.counts,
                      basis='fixed company and near-duplicate groups; no split retries')
        (Path(sys.argv[2])/'training-readiness.json').write_text(json.dumps(report, ensure_ascii=False), encoding='utf8')
        print(json.dumps(report, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)
    except Exception as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False),file=sys.stderr)
        sys.exit(1)
