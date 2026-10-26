import os
for key, value in {'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1', 'TOKENIZERS_PARALLELISM': 'false', 'OMP_NUM_THREADS': '4', 'MKL_NUM_THREADS': '4', 'DO_NOT_TRACK': '1', 'PYTHONDONTWRITEBYTECODE': '1'}.items():
    os.environ[key] = value
import sys, json, hashlib, sqlite3, time
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MODEL = Path(os.environ.get('JOB_SEMANTIC_ENCODER_DIR', ROOT / 'work/role_screening_models/bge-small-zh-v1.5'))
RUNTIME = Path(os.environ.get('JOB_SEMANTIC_ROLE_DIR', 'E:/Codex/work/job-semantic-role-runtime'))
INPUT_VERSION = 'section-balanced-head-tail-max256-v1'
model = None
anchor_cache = {}

def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def read(path):
    return json.loads(path.read_text(encoding='utf-8'))

def input_key(row):
    data = [row.get(k, '') for k in ['title', 'duties', 'requirements', 'unsectioned']]
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()

def encoder():
    global model
    if model is None:
        import torch
        from sentence_transformers import SentenceTransformer
        manifest = read(MODEL / 'local-manifest.json')
        for name, spec in manifest['files'].items():
            if sha(MODEL / name) != spec['sha256']:
                raise RuntimeError('Local encoder checksum mismatch')
        torch.set_num_threads(4)
        model = SentenceTransformer(str(MODEL), device='cpu', local_files_only=True, trust_remote_code=False)
        model.max_seq_length = 256
    return model

def packed(row):
    tokenizer = encoder().tokenizer
    def trim(text, budget):
        offsets = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True, truncation=False)['offset_mapping']
        if len(offsets) <= budget:
            return text
        head = int(budget * .65)
        tail = budget - head - 2
        return text[:offsets[head - 1][1]] + ' … ' + text[offsets[-tail][0]:]
    title = trim(row['title'], 30)
    duties = row.get('duties') or row.get('unsectioned', '')
    requirements = row.get('requirements', '')
    db, qb = (120, 80) if duties and requirements else ((200, 0) if duties else (0, 200))
    value = '标题：' + title + '\n职责：' + trim(duties, db)
    if requirements:
        value += '\n要求：' + trim(requirements, qb)
    if len(tokenizer(value, add_special_tokens=True, truncation=False)['input_ids']) > 256:
        raise RuntimeError('Packed input exceeds frozen256 token limit')
    return value

def seed(db, namespace):
    source = Path(os.environ.get('JOB_SEMANTIC_SEED_DIR', 'E:/Codex/work/20261023-semantic-role-prototypes'))
    complete = source / 'embedding-complete.json'
    if db.execute("SELECT value FROM metadata WHERE key='seed'").fetchone() or not complete.exists():
        return
    spec = read(complete)
    if sha(source / 'embeddings.npy') != spec['embeddings_sha256']:
        raise RuntimeError('Seed vectors checksum mismatch')
    manifest = read(source / 'input-manifest.json')
    if manifest['model_manifest_sha256'] != sha(MODEL / 'local-manifest.json'):
        raise RuntimeError('Seed encoder differs from runtime')
    corpus = read(source / 'corpus.json')['rows']
    indices = read(source / 'input-indices.json')
    vectors = np.load(source / 'embeddings.npy', mmap_mode='r', allow_pickle=False)
    if vectors.shape != (manifest['unique_inputs'], 512) or len(corpus) != len(indices):
        raise RuntimeError('Seed vector dimensions mismatch')
    seen = set()
    batch = []
    for row, index in zip(corpus, indices):
        if index < 0:
            continue
        key = input_key(row)
        if key in seen:
            continue
        seen.add(key)
        vector = np.asarray(vectors[index], dtype=np.float32)
        if not np.isfinite(vector).all() or abs(float(np.linalg.norm(vector)) - 1) > 1e-4:
            raise RuntimeError('Invalid seed vector')
        batch.append((namespace + ':' + key, vector.tobytes()))
        if len(batch) >= 2000:
            db.executemany('INSERT OR IGNORE INTO embeddings VALUES(?,?)', batch)
            db.commit()
            batch.clear()
    db.executemany('INSERT OR IGNORE INTO embeddings VALUES(?,?)', batch)
    db.execute('INSERT INTO metadata VALUES(?,?)', ('seed', spec['embeddings_sha256']))
    db.commit()

def classify(db, namespace, request):
    references = request['references']
    reference_id = request['referenceHash']
    if reference_id not in anchor_cache:
        rows = references['targets'] + references['other']
        values = [packed(row) for row in rows]
        anchor_cache.clear()
        anchor_cache[reference_id] = encoder().encode(values, batch_size=32, normalize_embeddings=True, show_progress_bar=False, convert_to_numpy=True)
    anchors = anchor_cache[reference_id]
    rows = request['rows']
    if len(rows) > 2000:
        raise RuntimeError('Batch too large')
    vectors = np.zeros((len(rows), 512), dtype=np.float32)
    missing = []
    for i, row in enumerate(rows):
        if input_key(row) != row['key']:
            raise RuntimeError('Input hash mismatch')
        cached = db.execute('SELECT vector FROM embeddings WHERE key=?', (namespace + ':' + row['key'],)).fetchone()
        if cached:
            vector = np.frombuffer(cached[0], dtype=np.float32)
            if vector.shape != (512,) or not np.isfinite(vector).all() or abs(float(np.linalg.norm(vector)) - 1) > 1e-4:
                raise RuntimeError('Invalid cached vector')
            vectors[i] = vector
        else:
            missing.append(i)
    if missing:
        values = [packed(rows[i]) for i in missing]
        encoded = encoder().encode(values, batch_size=32, normalize_embeddings=True, show_progress_bar=False, convert_to_numpy=True)
        vectors[missing] = encoded
        db.executemany('INSERT OR REPLACE INTO embeddings VALUES(?,?)', [(namespace + ':' + rows[i]['key'], np.asarray(encoded[j], dtype=np.float32).tobytes()) for j, i in enumerate(missing)])
        db.commit()
    scores = vectors @ anchors.T
    if not np.isfinite(scores).all():
        raise RuntimeError('Non-finite similarity')
    return {'rows': [{'key': row['key'], 'scores': scores[i].astype(float).tolist()} for i, row in enumerate(rows)], 'cacheHits': len(rows) - len(missing), 'encoded': len(missing), 'referenceHash': reference_id}

def main():
    RUNTIME.mkdir(parents=True, exist_ok=True)
    namespace = INPUT_VERSION + ':' + sha(MODEL / 'local-manifest.json')
    db = sqlite3.connect(RUNTIME / 'vectors.sqlite', timeout=60)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE IF NOT EXISTS embeddings(key TEXT PRIMARY KEY, vector BLOB NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
    seed(db, namespace)
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            if request.get('action') != 'classify':
                raise RuntimeError('Unsupported action')
            result = classify(db, namespace, request)
            print(json.dumps({'id': request['id'], 'result': result}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({'id': request.get('id') if request else None, 'error': str(error)[:400]}, ensure_ascii=False), flush=True)
    db.close()

if __name__ == '__main__':
    main()
