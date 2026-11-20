import asyncio
import os
import secrets
from pathlib import Path
import httpx
from .processes import available_port, creation_options, terminate


class Worker:
    def __init__(self, settings, owner):
        self.settings, self.owner = settings, owner
        self.token = settings.token or secrets.token_urlsafe(36)
        self.url = settings.worker_url or f"http://127.0.0.1:{available_port()}"
        self.process = None
        self.logs = []
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(connect=5, read=180, write=30, pool=10), trust_env=False, follow_redirects=False)

    def headers(self):
        return {"x-job-worker-token": self.token}

    async def start(self):
        if not self.settings.manage_worker:
            return
        s = self.settings
        s.runtime.mkdir(parents=True, exist_ok=True)
        temp = Path(os.environ.get("TEMP") or os.environ.get("TMP") or s.runtime / "temp").resolve()
        temp.mkdir(parents=True, exist_ok=True)
        self.logs = [open(s.runtime / name, "ab", buffering=0) for name in ("worker.stdout.log", "worker.stderr.log")]
        env = {**os.environ, "TEMP": str(temp), "TMP": str(temp),
               "JOB_UI_DATA_DIR": str(s.data), "JOB_UI_PORT": self.url.rsplit(":", 1)[1],
               "JOB_UI_OPEN_BROWSER": "0", "JOB_UI_START_WORKER": "0", "JOB_WORKER_TOKEN": self.token,
               "JOB_PUBLIC_ORIGIN": s.public_url, "JOB_COMPUTE_BASE_URL": s.public_url,
               "JOB_COMPUTE_TOKEN": self.token, "PYTHONDONTWRITEBYTECODE": "1"}
        self.process = await asyncio.create_subprocess_exec(s.node, str(s.root / "job_collector_ui/server.mjs"),
            env=env, cwd=s.root, stdout=self.logs[0], stderr=self.logs[1], **creation_options())
        self.owner.attach(self.process.pid)
        for _ in range(160):
            if self.process.returncode is not None:
                raise RuntimeError("Node执行进程未启动；请查看worker.stderr.log，未启动第二个任务进程")
            try:
                response = await self.client.get(self.url + "/_worker/health", headers=self.headers(), timeout=1)
                if response.status_code == 200 and response.json().get("worker"):
                    return
            except (httpx.HTTPError, ValueError):
                pass
            await asyncio.sleep(.1)
        raise RuntimeError("Node执行进程启动超时")

    async def json(self, path):
        response = await self.client.get(self.url + path, headers=self.headers())
        response.raise_for_status()
        return response.json()

    async def close(self):
        if self.settings.manage_worker and self.process and self.process.returncode is None:
            try:
                await self.client.post(self.url + "/_worker/shutdown", headers=self.headers(), timeout=3)
                await asyncio.wait_for(self.process.wait(), 5)
            except (httpx.HTTPError, asyncio.TimeoutError):
                await terminate(self.process)
        await self.client.aclose()
        for handle in self.logs:
            handle.close()
