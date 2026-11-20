"""Durable, content-addressed JD vectors shared by all matching sessions.

Resume/query data never enters the cache key. Each committed encoding batch is
a checkpoint, independent of the order or membership of a classifier snapshot.
"""
import hashlib
import json
import sqlite3
from pathlib import Path

import numpy as np


ENCODING_CONTRACT = {
    'version': 1,
    'text': 'title-newline-full-body-token-windows-v1',
    'window_tokens': 350,
    'overlap_tokens': 40,
    'max_seq_length': 512,
    'prompt': '',
    'normalize_embeddings': True,
    'dtype': 'float32',
}

# The old matrix metadata did not record file hashes. Import only the verified
# model shipped with that implementation, never a new model under the same ID.
LEGACY_BGE_MODEL = {
    'repo': 'BAAI/bge-small-zh-v1.5',
    'revision': '7999e1d3359715c523056ef9478215996d62a620',
    'files_sha256': '5af5fe0a6c78a8370d62640b8de96f339eb5f8770bf0109a9962d594e6b169d8',
}


def _digest(value):
    return hashlib.sha256(value).hexdigest()


def cache_namespace(model, dimension, contract):
    descriptor = {'model': model, 'dimension': dimension, 'encoding': contract}
    text = json.dumps(descriptor, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return _digest(text.encode('utf-8')), text


def _legacy_rows(root, chunks, model, dimension):
    """Only use the old matrix whose fingerprint proves this exact text order.

    Older matrices without their original input text cannot be mapped safely to
    a changed pool, so they are left untouched. Partial files are read only up to
    their flushed checkpoint; this also preserves old interrupted work.
    """
    identity = {k: model[k] for k in ('repo', 'revision')}
    fingerprint = _digest(json.dumps([identity, chunks], ensure_ascii=False).encode('utf-8'))
    folder = root / fingerprint
    candidates = [
        (folder / 'embedding-cache.json', folder / 'embeddings.npy', False),
        (folder / 'embedding-progress.json', folder / 'embeddings.partial.npy', True),
    ]
    for meta_path, array_path, partial in candidates:
        if not meta_path.is_file() or not array_path.is_file():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding='utf-8'))
            if meta.get('fingerprint') != fingerprint:
                continue
            count = meta.get('done') if partial else len(chunks)
            if type(count) is not int or not 0 <= count <= len(chunks):
                continue
            if partial and meta.get('total') != len(chunks):
                continue
            if not partial and (meta.get('model') != identity or meta.get('shape') != [len(chunks), dimension]):
                continue
            matrix = np.load(array_path, mmap_mode='r', allow_pickle=False)
            if matrix.shape != (len(chunks), dimension) or matrix.dtype != np.dtype('float32'):
                continue
            return matrix, count
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return None, 0


def materialize_vectors(cache_root, chunks, model, encode, *, dimension=512,
                        batch_size=4, contract=None, on_progress=None,
                        legacy_model=LEGACY_BGE_MODEL):
    """Return vectors in input order, encoding only missing/corrupt text hashes.

    `encode` receives only new text, never the complete pool. Model file hashes
    must be supplied in `model` by the caller after local manifest verification.
    """
    if dimension <= 0 or batch_size <= 0:
        raise ValueError('invalid vector cache dimensions or batch size')
    contract = dict(ENCODING_CONTRACT if contract is None else contract)
    namespace, descriptor = cache_namespace(model, dimension, contract)
    root = Path(cache_root)
    root.mkdir(parents=True, exist_ok=True)
    database = root / 'chunk-vectors-v1.sqlite3'
    keys = [_digest(text.encode('utf-8')) for text in chunks]
    first = {}
    for index, key in enumerate(keys):
        first.setdefault(key, index)
    unique_keys = list(first)
    positions = {key: index for index, key in enumerate(unique_keys)}
    vectors = np.empty((len(unique_keys), dimension), dtype=np.float32)
    found = set()
    emit = on_progress or (lambda stage, **data: None)
    connection = sqlite3.connect(database, timeout=30)
    try:
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('PRAGMA synchronous=FULL')
        connection.execute('PRAGMA busy_timeout=30000')
        connection.executescript('''
            CREATE TABLE IF NOT EXISTS namespaces (
                namespace TEXT PRIMARY KEY, descriptor TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS vectors (
                namespace TEXT NOT NULL, text_hash TEXT NOT NULL,
                vector BLOB NOT NULL, checksum TEXT NOT NULL,
                PRIMARY KEY (namespace, text_hash)
            ) WITHOUT ROWID;
        ''')
        with connection:
            connection.execute('INSERT OR IGNORE INTO namespaces VALUES (?, ?)', (namespace, descriptor))
        for start in range(0, len(unique_keys), 500):
            part = unique_keys[start:start + 500]
            marks = ','.join('?' for _ in part)
            rows = connection.execute(
                f'SELECT text_hash, vector, checksum FROM vectors WHERE namespace=? AND text_hash IN ({marks})',
                [namespace, *part],
            )
            for key, blob, checksum in rows:
                if len(blob) != dimension * 4 or _digest(blob) != checksum:
                    continue
                value = np.frombuffer(blob, dtype='<f4')
                if not np.isfinite(value).all():
                    continue
                vectors[positions[key]] = value
                found.add(key)
        cached = len(found)

        def commit(values):
            records = []
            for key, value in values:
                blob = np.asarray(value, dtype='<f4').tobytes()
                records.append((namespace, key, blob, _digest(blob)))
            with connection:
                connection.executemany('INSERT OR REPLACE INTO vectors VALUES (?, ?, ?, ?)', records)
            for key, value in values:
                vectors[positions[key]] = value
                found.add(key)

        imported = 0
        if len(found) < len(unique_keys) and contract == ENCODING_CONTRACT and model == legacy_model:
            legacy, count = _legacy_rows(root, chunks, model, dimension)
            if legacy is not None:
                pending = []
                for key in unique_keys:
                    index = first[key]
                    if key in found or index >= count or not np.isfinite(legacy[index]).all():
                        continue
                    pending.append((key, legacy[index]))
                    if len(pending) >= 256:
                        commit(pending)
                        imported += len(pending)
                        pending = []
                if pending:
                    commit(pending)
                    imported += len(pending)
                del legacy
        missing = [key for key in unique_keys if key not in found]
        metrics = {
            'namespace': namespace, 'chunks': len(chunks), 'unique_chunks': len(unique_keys),
            'duplicate_chunks': len(chunks) - len(unique_keys),
            'cached_chunks': cached, 'imported_chunks': imported,
            'reused_chunks': len(found), 'encoded_chunks': 0,
            'pending_chunks': len(missing),
        }
        emit('embedding_started' if missing else 'embedding_cache_reused',
             done=0, total=len(missing), **metrics)
        for start in range(0, len(missing), batch_size):
            part = missing[start:start + batch_size]
            batch = np.asarray(encode([chunks[first[key]] for key in part]), dtype=np.float32)
            if batch.shape != (len(part), dimension) or not np.isfinite(batch).all():
                raise ValueError('encoder returned invalid vectors; batch was not checkpointed')
            commit(list(zip(part, batch)))
            metrics['encoded_chunks'] += len(part)
            emit('embedding_progress', done=metrics['encoded_chunks'], total=len(missing), **metrics)
        # Owners/bounds are rebuilt by the caller for this pool, never reused
        # from another snapshot. This gather preserves exact input alignment.
        order = np.fromiter((positions[key] for key in keys), dtype=np.intp, count=len(keys))
        return vectors[order], metrics
    finally:
        connection.close()
