import os
os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')
import sys
import json
import sqlite3
import re
import random
import heapq
from collections import Counter
from pathlib import Path
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.cluster import MiniBatchKMeans
from threadpoolctl import threadpool_limits


def records(db):
    query = 'SELECT j.job_key,j.raw FROM jobs j WHERE EXISTS (SELECT 1 FROM memberships m JOIN tasks t ON t.task_id=m.task_id WHERE m.job_key=j.job_key AND t.archived=0) ORDER BY j.job_key'
    for key, raw in db.execute(query):
        row = json.loads(raw)
        title = str(row.get('job_name') or row.get('岗位名称') or '').strip()
        if not title:
            continue
        body = str(row.get('job_description') or row.get('岗位描述') or '')
        body = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?<!\d)1[3-9]\d{9}(?!\d)', '[已脱敏]', body)
        text = (title + ' ') * 4 + body[:900]
        yield {'id': key, 'title': title[:100], 'body': body[:700], 'company': str(row.get('company_name') or ''), 'text': text}


def batches(db, size=512):
    batch = []
    for row in records(db):
        batch.append(row)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def discover(database, output, requested=0):
    rng = random.Random(20261028)
    db = sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True)
    db.execute('PRAGMA busy_timeout=2000')
    db.execute('BEGIN')
    anchors = []
    total = 0
    for row in records(db):
        total += 1
        if len(anchors) < 16000:
            anchors.append(row['text'])
        else:
            at = rng.randrange(total)
            if at < len(anchors):
                anchors[at] = row['text']
    if total < 120:
        raise ValueError('至少需要120条有岗位名称的记录才能进行岗位分布探索')
    revision = db.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()
    k = requested or min(40, max(8, round((total / 120) ** .5)))
    k = min(k, max(2, total // 15))
    print(json.dumps({'phase': 'vectorizing', 'total': total, 'clusters': k}), flush=True)
    vectorizer = TfidfVectorizer(analyzer='char', ngram_range=(2, 3), max_features=24000, min_df=2, max_df=.85, sublinear_tf=True, dtype=np.float32)
    with threadpool_limits(limits=2):
        matrix = vectorizer.fit_transform(anchors)
        model = MiniBatchKMeans(n_clusters=k, random_state=20261028, n_init=3, batch_size=512, max_iter=60, reassignment_ratio=.01)
        model.fit(matrix)
        del matrix, anchors
        scanned = 0
        for batch in batches(db):
            model.partial_fit(vectorizer.transform([r['text'] for r in batch]))
            scanned += len(batch)
            if scanned % 10240 < 512:
                print(json.dumps({'phase': 'clustering', 'completed': scanned, 'total': total}), flush=True)
        counts = Counter()
        nearest = [[] for _ in range(k)]
        boundary = [[] for _ in range(k)]
        scanned = 0
        for batch in batches(db):
            x = vectorizer.transform([r['text'] for r in batch])
            distances = model.transform(x)
            labels = distances.argmin(axis=1)
            for row, label, scores in zip(batch, labels, distances):
                label = int(label)
                distance = float(scores[label])
                counts[label] += 1
                brief = {key: row[key] for key in ['id', 'title', 'body', 'company']}
                item = (-distance, row['id'], brief)
                heapq.heappush(nearest[label], item)
                if len(nearest[label]) > 24:
                    heapq.heappop(nearest[label])
                heapq.heappush(boundary[label], (distance, row['id'], brief))
                if len(boundary[label]) > 3:
                    heapq.heappop(boundary[label])
            scanned += len(batch)
        features = vectorizer.get_feature_names_out()
        clusters = []
        for label, count in counts.most_common():
            representatives = []
            companies = set()
            for _, _, row in sorted(nearest[label], reverse=True):
                company = row['company'] or row['id']
                if company not in companies:
                    representatives.append(row)
                    companies.add(company)
                if len(representatives) == 5:
                    break
            clusters.append({'id': str(label), 'count': count, 'share': count / total, 'terms': [str(features[i]) for i in model.cluster_centers_[label].argsort()[-12:][::-1]], 'representatives': representatives, 'boundary': [r[2] for r in sorted(boundary[label], reverse=True)[:2]]})
    result = {'algorithm': '标题加权字符TF-IDF＋MiniBatchKMeans', 'representation': 'char-2-3-TFIDF-24000', 'fitVocabularySample': min(total, 16000), 'total': total, 'assigned': sum(counts.values()), 'sourceRevision': int(revision[0]) if revision else None, 'clusterCount': len(clusters), 'clusters': clusters, 'basis': '全部有效岗位记录参与增量聚类及分配；跨平台同职位未实体合并。簇占比不是已确认岗位类别占比。'}
    Path(output).write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    db.close()
    return result


if __name__ == '__main__':
    discover(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 0)
