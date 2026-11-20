import asyncio
import hmac
import json
import uuid
from contextlib import asynccontextmanager
from urllib.parse import urlsplit
import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.background import BackgroundTask
from .config import Settings
from .compute import ComputeSupervisor
from .ledger import Ledger
from .models import TrainingCreate, TrainingStart, RunIdentity, ResumeRun, ClassifierStart, InsightRun, ComputeRequest, SemanticStart, SchemaDraft, ClassifierDelete, DiscoveryName
from .processes import ProcessOwner
from .reports import ReportCache
from .worker import Worker
from .models import CollectionKeywords
from .models import MatchingStart, MatchingResume, MatchingAssess, MatchingMessage

HOP_HEADERS = {"host", "connection", "transfer-encoding", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade", "content-length"}
PROTECTED_COMMANDS = {"/api/resume-matching/message", "/api/resume-matching/assess", "/api/resume-matching/start", "/api/resume-matching/resume", "/api/collection/keywords", "/api/insights/training/create", "/api/insights/training/start", "/api/insights/training/resume", "/api/insights/classifier/start", "/api/insights/classifier/resume", "/api/insights/classifier/schema-draft", "/api/insights/run", "/api/insights/semantic/start", "/api/insights/semantic/resume", "/api/insights/discovery/scan", "/api/insights/discovery/name"}


def create_app(settings=None):
    settings = settings or Settings.environment()

    @asynccontextmanager
    async def lifespan(app):
        owner = ProcessOwner()
        worker = Worker(settings, owner)
        ledger = Ledger(settings.runtime / "operations.sqlite")
        reports = ReportCache(settings, owner)
        compute = ComputeSupervisor(settings, ledger, owner)
        app.state.worker, app.state.ledger = worker, ledger
        app.state.compute, app.state.reports = compute, reports
        try:
            await worker.start()
            ledger.recover()
            yield
        finally:
            await worker.close()
            await compute.close()
            reports.close()
            owner.close()

    app = FastAPI(title="岗位洞察系统 API", version="2.0.0", lifespan=lifespan,
                  description="FastAPI主入口、持久化计算调度；复用Node.js采集、会话和标注执行模块。")
    app.state.settings = settings

    @app.middleware("http")
    async def local_requests(request, call_next):
        try:
            host = urlsplit("http://" + request.headers.get("host", ""))
            allowed_host = host.hostname in ("127.0.0.1", "localhost") and host.port == settings.port
        except ValueError:
            allowed_host = False
        if not allowed_host:
            return JSONResponse({"error": "仅允许本机工作台地址访问"}, 403)
        origin = request.headers.get("origin")
        if origin and origin not in (settings.public_url, f"http://localhost:{settings.port}"):
            return JSONResponse({"error": "请求来源不属于当前工作台"}, 403)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            if request.headers.get("sec-fetch-site") == "cross-site":
                return JSONResponse({"error": "不接受跨站操作"}, 403)
            if request.url.path == "/api/browser" or request.url.path.startswith("/api/browser/"):
                return JSONResponse({"error": "求职浏览器功能已移除", "code": "FEATURE_REMOVED"}, 410)
            if request.url.path.startswith(("/api/", "/internal/")) and request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/json":
                return JSONResponse({"error": "请使用JSON请求"}, 415)
            chunks, size = [], 0
            async for chunk in request.stream():
                size += len(chunk)
                if size > 8 * 1024 * 1024:
                    return JSONResponse({"error": "请求体过大"}, 413)
                chunks.append(chunk)
            request._body = b"".join(chunks)
        try:
            response = await call_next(request)
        except httpx.HTTPError:
            return JSONResponse({"error": "后台执行进程连接未完成；未自动重发操作，请先核对任务状态", "code": "WORKER_UNAVAILABLE"}, 503)
        response.headers["x-backend-framework"] = "FastAPI"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        details = [{"field": ".".join(map(str, item["loc"][1:])), "message": item["msg"]} for item in error.errors()]
        return JSONResponse({"error": "请求参数校验失败", "code": "INVALID_REQUEST", "details": details}, 400)

    @app.exception_handler(ValueError)
    async def invalid_value(request, error):
        return JSONResponse({"error": str(error)[:500]}, 400)

    def internal(request):
        supplied = request.headers.get("x-job-compute-token", "")
        return bool(supplied) and hmac.compare_digest(supplied, app.state.worker.token)

    @app.get("/api/backend/health", tags=["服务状态"])
    async def health():
        state = await app.state.worker.json("/_worker/health")
        return {"status": "ready", "framework": "FastAPI", "version": "2.0.0", "worker": state,
                "compute": {"concurrency": 2, "lanes": {"training": 1, "analysis": 1}, "active": len(app.state.compute.tasks)},
                "native": ["report", "validation", "compute-queue", "command-deduplication"],
                "execution": "Node.js兼容执行进程；Python训练与聚类独立进程"}

    @app.get("/api/backend/jobs", tags=["服务状态"])
    async def jobs():
        return {"jobs": await asyncio.to_thread(app.state.ledger.jobs)}

    @app.post("/internal/compute", include_in_schema=False)
    async def compute_start(request: Request, body: ComputeRequest):
        if not internal(request):
            return JSONResponse({"error": "仅允许受控执行进程调度"}, 403)
        return JSONResponse({"job": await app.state.compute.submit(body)}, 202)

    @app.get("/internal/compute/{task_id}", include_in_schema=False)
    async def compute_status(request: Request, task_id: str, stdoutOffset: int = 0, stderrOffset: int = 0):
        if not internal(request):
            return JSONResponse({"error": "仅允许受控执行进程调度"}, 403)
        job = await asyncio.to_thread(app.state.ledger.job, task_id)
        output = await asyncio.to_thread(app.state.compute.logs, task_id, max(0, stdoutOffset), max(0, stderrOffset)) if job else None
        return JSONResponse({"job": job, "output": output} if job else {"error": "计算任务不存在"}, 200 if job else 404)

    @app.post("/internal/compute/{task_id}/cancel", include_in_schema=False)
    async def compute_cancel(request: Request, task_id: str):
        if not internal(request):
            return JSONResponse({"error": "仅允许受控执行进程调度"}, 403)
        return {"job": await app.state.compute.cancel(task_id)}

    @app.get("/api/insights", tags=["岗位分析"])
    async def insight_state(request: Request):
        state = await app.state.worker.json("/api/insights?summary=1")
        state["reportVersion"] = app.state.reports.version()
        if request.query_params.get("summary") == "1":
            return JSONResponse(state, headers={"cache-control": "no-store"})
        report = await app.state.reports.load()
        state["reportVersion"] = report["version"] if report else None
        head = json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode()[:-1]

        async def stream():
            yield head + b',"report":'
            yield report["raw"] if report else b"null"
            yield b"}"

        return StreamingResponse(stream(), media_type="application/json", headers={"cache-control": "no-store"})

    @app.get("/api/insights/report", tags=["岗位分析"])
    async def insight_report(request: Request):
        report = await app.state.reports.load(request.query_params.get('snapshotKey'))
        if not report:
            return JSONResponse({"error": "尚无岗位洞察报告"}, 404)
        etag = '"' + report["version"] + '"'
        headers = {"etag": etag, "cache-control": "no-cache", "vary": "Accept-Encoding"}
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=headers)
        compressed = "gzip" in request.headers.get("accept-encoding", "")
        if compressed:
            headers["content-encoding"] = "gzip"
        return Response(report["gzip"] if compressed else report["raw"], media_type="application/json", headers=headers)

    @app.get("/api/insights/logs", tags=["岗位分析"])
    async def insight_logs():
        def read_tail():
            try:
                with open(settings.data / "insights/analysis.log", "rb") as handle:
                    handle.seek(0, 2)
                    handle.seek(max(0, handle.tell() - 400000))
                    return handle.read().decode("utf-8", "replace")[-100000:]
            except FileNotFoundError:
                return ""
        return {"content": await asyncio.to_thread(read_tail)}

    async def dispatch(request, body=None):
        worker = app.state.worker
        path = request.url.path + ("?" + request.url.query if request.url.query else "")
        data = body if body is not None else await request.body()
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_HEADERS and not k.lower().startswith("x-job-") and k.lower() != "origin"}
        headers.update(worker.headers())
        if request.headers.get("origin"):
            headers["origin"] = worker.url
        command_key = None
        if request.method == "POST" and request.url.path in PROTECTED_COMMANDS:
            supplied_key = request.headers.get("idempotency-key") or str(uuid.uuid4())
            if len(supplied_key) > 160:
                raise ValueError("操作标识过长")
            command_key, prior = await asyncio.to_thread(app.state.ledger.claim, supplied_key, request.method, path, data)
            if prior:
                if prior["state"] == "done":
                    return Response(prior["response"], status_code=prior["status"], media_type="application/json", headers={"x-operation-replayed": "1"})
                return JSONResponse({"error": "此操作已提交或结果待核，未重复执行；请刷新任务状态", "code": "OPERATION_PENDING"}, 409)
        upstream = None
        try:
            upstream = await worker.client.send(worker.client.build_request(request.method, worker.url + path, content=data, headers=headers), stream=True)
            output_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP_HEADERS}
            if command_key:
                result = await upstream.aread()
                await upstream.aclose()
                output_headers.pop("content-encoding", None)
                await asyncio.to_thread(app.state.ledger.finish, command_key, upstream.status_code, result)
                return Response(result, status_code=upstream.status_code, headers=output_headers)
            return StreamingResponse(upstream.aiter_raw(), status_code=upstream.status_code, headers=output_headers,
                                     background=BackgroundTask(upstream.aclose))
        except BaseException:
            if upstream:
                await upstream.aclose()
            if command_key:
                await asyncio.to_thread(app.state.ledger.uncertain, command_key)
            raise

    def register(path, model, title, tag):
        async def endpoint(request, body):
            data = json.dumps(body.model_dump(exclude_none=True), ensure_ascii=False, separators=(",", ":")).encode()
            return await dispatch(request, data)
        endpoint.__annotations__ = {"request": Request, "body": model}
        endpoint.__name__ = path.replace("/", "_")
        app.post(path, summary=title, tags=[tag])(endpoint)

    for path, model, title in (
        ("/api/insights/training/create", TrainingCreate, "创建岗位训练任务"),
        ("/api/insights/training/start", TrainingStart, "启动岗位训练"),
        ("/api/insights/training/resume", ResumeRun, "继续原轮次剩余标注"),
        ("/api/insights/training/cancel", RunIdentity, "停止训练任务"),
        ("/api/insights/classifier/start", ClassifierStart, "启动分类器标注"),
        ("/api/insights/classifier/resume", ResumeRun, "恢复分类器断点"),
        ("/api/insights/classifier/schema-draft", SchemaDraft, "扩展检索词与标注规范"),
        ("/api/insights/semantic/start", SemanticStart, "增量提取技能与职责标签"),
        ("/api/insights/classifiers/delete", ClassifierDelete, "移除岗位分类器"),
        ("/api/insights/discovery/name", DiscoveryName, "识别岗位聚类方向"),
        ("/api/insights/run", InsightRun, "生成岗位分析报告"),
    ):
        register(path, model, title, "岗位分析与训练")

    register("/api/collection/keywords", CollectionKeywords, "DeepSeek生成5个扩展关键词", "采集任务")
    register("/api/resume-matching/start", MatchingStart, "解析简历并检索重排目标岗位", "简历匹配")
    register("/api/resume-matching/resume", MatchingResume, "从断点继续匹配", "简历匹配")
    register("/api/resume-matching/assess", MatchingAssess, "逐项核验本页岗位要求", "简历匹配")
    register("/api/resume-matching/message", MatchingMessage, "补充或修改会话人才画像并重新匹配", "简历匹配")

    def register_read(path, title, tag):
        async def endpoint(request: Request):
            return await dispatch(request)
        endpoint.__name__ = "read_" + path.replace("/", "_")
        app.get(path, summary=title, tags=[tag])(endpoint)

    for path, title, tag in (
        ("/api/state", "工作台状态", "采集任务"),
        ("/api/tasks", "采集任务列表", "采集任务"),
        ("/api/insights/classifiers", "分类器目录", "岗位分析与训练"),
        ("/api/insights/classifier", "当前分类器与标注进度", "岗位分析与训练"),
        ("/api/insights/classifier/schema", "岗位标注规范", "岗位分析与训练"),
        ("/api/insights/training", "训练记录与队列", "岗位分析与训练"),
        ("/api/insights/datasets", "岗位知识库目录", "岗位分析与训练"),
        ("/api/insights/semantic", "技能标签提取进度", "岗位分析与训练"),
        ("/api/insights/discovery", "岗位聚类发现进度", "岗位分析与训练"),
        ("/api/assistant/context", "助手知识库范围与配置", "求职助手"),
        ("/api/assistant/sessions", "助手会话目录", "求职助手"),
    ):
        register_read(path, title, tag)

    @app.post("/api/assistant/chat", summary="岗位咨询与采集对话，支持SSE事件流", tags=["求职助手"])
    async def assistant_chat(request: Request, body: dict):
        if not isinstance(body.get("message"), str) or not body["message"].strip():
            raise ValueError("请输入消息")
        return await dispatch(request)

    @app.api_route("/api/browser", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], include_in_schema=False)
    @app.api_route("/api/browser/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], include_in_schema=False)
    async def retired_browser(request: Request, path: str = ""):
        return JSONResponse({"error": "求职浏览器功能已移除", "code": "FEATURE_REMOVED"}, 410)

    @app.api_route("/api/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], include_in_schema=False)
    async def compatibility(request: Request, path: str):
        return await dispatch(request)

    @app.get("/_worker/{path:path}", include_in_schema=False)
    async def private_worker(path: str):
        return JSONResponse({"error": "接口不存在"}, 404)

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def static(path: str):
        if path.rstrip("/") in ("profile", "platforms", "labels"):
            return RedirectResponse("/tasks", status_code=302)
        if path.rstrip("/") == "browser" or path.startswith("browser/"):
            return RedirectResponse("/tasks", status_code=302)
        target = (settings.public_dir / ("index.html" if not path or path.rstrip("/") in ("tasks", "insights", "assistant", "matching", "quality", "sources") or path.startswith("tasks/") else path)).resolve()
        if not target.is_relative_to(settings.public_dir.resolve()) or not target.is_file():
            return JSONResponse({"error": "未找到"}, 404)
        return FileResponse(target, headers={"cache-control": "no-cache"})

    return app
