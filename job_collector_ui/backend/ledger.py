import hashlib
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


class Ledger:
    def __init__(self, filename):
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        self.filename = str(filename)
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS commands (
                    key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
                    status INTEGER, response BLOB, created REAL NOT NULL, updated REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
                    resource TEXT NOT NULL, state TEXT NOT NULL, code INTEGER,
                    error TEXT NOT NULL DEFAULT '', created REAL NOT NULL, updated REAL NOT NULL
                );
            """)

    def recover(self):
        with self.connection() as db:
            db.execute("UPDATE commands SET state='uncertain', updated=? WHERE state='pending'", (time.time(),))
            db.execute("UPDATE jobs SET state='interrupted', error='服务已退出；不自动重跑', updated=? WHERE state IN ('queued','running')", (time.time(),))

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.filename, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def claim(self, key, method, path, body):
        key = hashlib.sha256(key.encode()).hexdigest()
        fingerprint = hashlib.sha256(method.encode() + b"\0" + path.encode() + b"\0" + body).hexdigest()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM commands WHERE key=?", (key,)).fetchone()
            if existing:
                if existing["fingerprint"] != fingerprint:
                    raise ValueError("同一操作标识不能用于不同请求")
                return key, dict(existing)
            db.execute("INSERT INTO commands VALUES (?,?,'pending',NULL,NULL,?,?)", (key, fingerprint, time.time(), time.time()))
        return key, None

    def finish(self, key, status, body):
        with self.connection() as db:
            db.execute("UPDATE commands SET state='done', status=?, response=?, updated=? WHERE key=?", (status, body, time.time(), key))

    def uncertain(self, key):
        with self.connection() as db:
            db.execute("UPDATE commands SET state='uncertain', updated=? WHERE key=?", (time.time(), key))

    def create_job(self, request_id, kind, resource):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT * FROM jobs WHERE request_id=?", (request_id,)).fetchone()
            if existing:
                if existing["kind"] != kind or existing["resource"] != resource:
                    raise ValueError("计算任务标识与任务内容不一致")
                return dict(existing), False
            if db.execute("SELECT id FROM jobs WHERE resource=? AND state IN ('queued','running')", (resource,)).fetchone():
                raise ValueError("该计算资源已有任务运行中")
            task_id = str(uuid.uuid4())
            db.execute("INSERT INTO jobs VALUES (?,?,?,?,'queued',NULL,'',?,?)", (task_id, request_id, kind, resource, time.time(), time.time()))
            return dict(db.execute("SELECT * FROM jobs WHERE id=?", (task_id,)).fetchone()), True

    def job(self, task_id):
        with self.connection() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (task_id,)).fetchone()
            return dict(row) if row else None

    def update_job(self, task_id, state, code=None, error=""):
        with self.connection() as db:
            db.execute("UPDATE jobs SET state=?, code=?, error=?, updated=? WHERE id=?", (state, code, error[-1800:], time.time(), task_id))

    def jobs(self):
        with self.connection() as db:
            return [dict(row) for row in db.execute("SELECT id,kind,state,code,error,created,updated FROM jobs ORDER BY created DESC LIMIT 50")]
