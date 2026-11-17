import os
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    root: Path
    data: Path
    runtime: Path
    port: int = 8788
    node: str = "node"
    worker_url: str = ""
    token: str = ""
    manage_worker: bool = True

    @classmethod
    def environment(cls):
        root = Path(__file__).resolve().parents[2]
        runtime = Path(os.environ.get("JOB_API_RUNTIME", "E:/Codex/work/job-fastapi/runtime"))
        if not runtime.anchor or not Path(runtime.anchor).exists():
            raise RuntimeError("FastAPI运行盘不可用，未改用C盘")
        return cls(root, Path(os.environ.get("JOB_UI_DATA_DIR", root / "ui_data")).resolve(),
                   runtime.resolve(), int(os.environ.get("JOB_UI_PORT", "8788")),
                   os.environ.get("JOB_UI_NODE") or shutil.which("node") or "node")

    @property
    def public_url(self):
        return f"http://127.0.0.1:{self.port}"

    @property
    def public_dir(self):
        return self.root / "job_collector_ui" / "public"

    @property
    def training_python(self):
        return self.root / "work" / "role_screening_env" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
