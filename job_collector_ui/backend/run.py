import argparse
import asyncio
import multiprocessing
import os
import socket
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from job_collector_ui.backend.app import create_app
from job_collector_ui.backend.config import Settings


async def run():
    import uvicorn
    settings = Settings.environment()
    server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if os.name == "nt":
        server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        server_socket.bind(("127.0.0.1", settings.port))
        server_socket.listen(128)
        server_socket.setblocking(False)
    except OSError:
        server_socket.close()
        raise RuntimeError(f"端口{settings.port}已占用，未启动第二个后台")
    app = create_app(settings)
    config = uvicorn.Config(app, host="127.0.0.1", port=settings.port, access_log=False, proxy_headers=False, workers=1)
    try:
        await uvicorn.Server(config).serve(sockets=[server_socket])
    finally:
        server_socket.close()


if __name__ == "__main__":
    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("JOB_UI_PORT", "8788")))
    args = parser.parse_args()
    os.environ["JOB_UI_PORT"] = str(args.port)
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    asyncio.run(run())
