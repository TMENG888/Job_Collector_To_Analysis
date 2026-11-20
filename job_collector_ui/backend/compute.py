import asyncio
import json
import os
import re
from pathlib import Path
from .processes import creation_options, terminate


def within(value, parent):
    candidate, base = Path(value).resolve(), Path(parent).resolve()
    if candidate == base or not candidate.is_relative_to(base):
        raise ValueError("计算路径不在任务目录中")
    return candidate


def knowledge_path(data):
    config = data / "knowledge-storage.json"
    if config.exists():
        value = json.loads(config.read_text(encoding="utf-8"))["database"]
        if not Path(value).is_absolute() or not Path(value).is_file():
            raise ValueError("已配置的知识库不可用，不创建替代空库")
        return Path(value)
    return data / "knowledge" / "岗位知识库.sqlite"


class ComputeSupervisor:
    def __init__(self, settings, ledger, owner):
        self.settings, self.ledger, self.owner = settings, ledger, owner
        self.semaphore = asyncio.Semaphore(1)
        self.analysis_semaphore = asyncio.Semaphore(1)
        self.tasks, self.processes = {}, {}

    def command(self, body):
        s = self.settings
        classifier = Path(os.environ.get("JOB_INSIGHT_CLASSIFIER_DIR", "E:/Codex/work/20261018-insight-qwen-classifier/runtime" if s.data == s.root / "ui_data" else s.data / "insight_classification"))
        interviews = Path(os.environ.get("JOB_INTERVIEW_CLASSIFIER_DIR", "E:/Codex/work/nowcoder-interview-classifier/runtime"))
        clusters = Path(os.environ.get("JOB_ROLE_DISCOVERY_DIR", "E:/Codex/work/20261028-job-role-discovery/runtime"))
        if body.kind == "resume_matching":
            matching = Path(os.environ.get("JOB_RESUME_MATCHING_DIR", "E:/Codex/work/job-resume-matching"))
            folder = within(body.folder or "", matching / "runs")
            if folder.parent != (matching / "runs").resolve() or not re.fullmatch(r"[a-f0-9-]{36}", folder.name):
                raise ValueError("简历匹配计算目录无效")
            return [str(s.training_python), "-B", "-u", str(s.root / "work/match_resume_jobs.py"), str(folder)], str(folder)
        if body.kind == "classifier":
            folder = within(body.folder or "", classifier)
            if not re.fullmatch(r"[a-f0-9-]{36}", folder.name) or folder.parent != classifier.resolve():
                raise ValueError("分类器计算路径无效")
            return [str(s.training_python), "-B", str(s.root / "work/train_insight_classifier.py"), str(folder / "samples.json"), str(folder)], str(folder)
        if body.kind.startswith("interview_"):
            folder = within(body.folder or "", interviews)
            if not re.fullmatch(r"[a-f0-9-]{36}", folder.name) or folder.parent != interviews.resolve():
                raise ValueError("面经计算路径无效")
            return [str(s.training_python), "-B", str(s.root / "work/train_interview_qwen.py"), body.kind.split("_", 1)[1], str(folder)], str(folder)
        if body.kind == "cluster":
            output = within(body.outputFile or "", clusters)
            if output.parent != clusters.resolve() or not re.fullmatch(r"[a-f0-9-]{36}\.json", output.name):
                raise ValueError("聚类输出路径无效")
            return [str(s.training_python), "-B", str(s.root / "work/discover_job_clusters.py"), str(knowledge_path(s.data)), str(output)], str(output)
        input_file, output = Path(body.inputFile or "").resolve(), Path(body.outputFile or "").resolve()
        if input_file != s.data / "insights/config.json" or output != s.data / "insights/岗位市场洞察.json":
            raise ValueError("岗位分析路径无效")
        return [s.node, str(s.root / "work/analyze_job_market_sample.mjs"), str(input_file), str(output)], str(output)

    async def submit(self, body):
        command, resource = self.command(body)
        if not Path(command[0]).is_file() and command[0] != "node":
            raise ValueError("计算运行环境不可用")
        job, created = await asyncio.to_thread(self.ledger.create_job, body.requestId, body.kind, resource)
        if created:
            task = asyncio.create_task(self.execute(job["id"], command, body.kind))
            self.tasks[job["id"]] = task
            task.add_done_callback(lambda _: self.tasks.pop(job["id"], None))
        return job

    async def execute(self, task_id, command, kind):
        process = None
        drains = None
        try:
            async with (self.analysis_semaphore if kind == "analysis" else self.semaphore):
                if self.ledger.job(task_id)["state"] != "queued":
                    return
                self.ledger.update_job(task_id, "running")
                temp = self.settings.runtime / "temp" / task_id
                temp.mkdir(parents=True, exist_ok=True)
                env = {**os.environ, "TEMP": str(temp), "TMP": str(temp), "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1", "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "2"}
                process = await asyncio.create_subprocess_exec(*command, cwd=self.settings.root, env=env,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, **creation_options())
                self.processes[task_id] = process
                self.owner.attach(process.pid)

                async def drain(stream, name):
                    tail = b""
                    with open(temp.parent.parent / (task_id + '.' + name + '.log'), 'ab', buffering=0) as output:
                        while chunk := await stream.read(8192):
                            output.write(chunk)
                            tail = (tail + chunk)[-16000:]
                    return tail

                drains = asyncio.gather(drain(process.stdout, 'stdout'), drain(process.stderr, 'stderr'))
                stdout, stderr = await asyncio.wait_for(drains, 900 if kind == "cluster" else 3600)
                code = await process.wait()
                error = re.sub(r"sk-[\w.-]+", "[密钥隐藏]", stderr.decode("utf-8", "replace"))[-1800:]
                self.ledger.update_job(task_id, "completed" if code == 0 else "failed", code, error if code else "")
        except asyncio.CancelledError:
            await terminate(process)
            self.ledger.update_job(task_id, "cancelled", -1, "计算已停止，原输入和结果保留")
        except Exception as error:
            await terminate(process)
            self.ledger.update_job(task_id, "failed", -1, type(error).__name__ + "：计算未完成，原输入保留")
        finally:
            if drains is not None:
                drains.cancel()
                await asyncio.gather(drains, return_exceptions=True)
            self.processes.pop(task_id, None)

    def logs(self, task_id, stdout_offset, stderr_offset):
        import base64
        result = {"more": False}
        for name, offset in (("stdout", stdout_offset), ("stderr", stderr_offset)):
            filename = self.settings.runtime / (task_id + '.' + name + '.log')
            content = b''
            try:
                with open(filename, 'rb') as source:
                    source.seek(max(0, offset))
                    content = source.read(65536)
                    result["more"] = result["more"] or bool(source.read(1))
            except FileNotFoundError:
                pass
            result[name] = base64.b64encode(content).decode('ascii')
            result[name + 'Offset'] = offset + len(content)
        return result

    async def cancel(self, task_id):
        task = self.tasks.get(task_id)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if self.ledger.job(task_id)["state"] in ("queued", "running"):
                self.ledger.update_job(task_id, "cancelled", -1, "计算已停止，原输入和结果保留")
        return self.ledger.job(task_id)

    async def close(self):
        await asyncio.gather(*(self.cancel(task_id) for task_id in list(self.tasks)))
