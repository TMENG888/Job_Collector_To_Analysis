import asyncio
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
import httpx
from .app import create_app
from .config import Settings
from .compute import ComputeSupervisor
from .ledger import Ledger
from .models import ComputeRequest
from .processes import ProcessOwner
from .reports import build_report, province_name

ROOT = Path(__file__).resolve().parents[2]
TEMP = Path('E:/Codex/temp/20261111-fastapi-migration/tests')
TEMP.mkdir(parents=True, exist_ok=True)


class MockStream(httpx.AsyncByteStream):
    def __init__(self, content):
        self.content = content

    async def __aiter__(self):
        yield self.content


class APITest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = Path(tempfile.mkdtemp(dir=TEMP))
        self.settings = Settings(ROOT, self.folder / 'data', self.folder / 'runtime', 18789,
            worker_url='http://127.0.0.1:19999', token='test-worker-token', manage_worker=False)
        self.calls = []
        self.disconnect = False
        self.app = create_app(self.settings)
        self.life = self.app.router.lifespan_context(self.app)
        await self.life.__aenter__()
        await self.app.state.worker.client.aclose()

        async def upstream(request):
            self.calls.append(request)
            if self.disconnect:
                raise httpx.ConnectError('mock disconnected')
            if request.url.path == '/api/assistant/chat':
                return httpx.Response(200,stream=MockStream(b'event: phase\ndata: {"type":"phase"}\n\nevent: done\ndata: {"type":"done"}\n\n'),headers={'content-type':'text/event-stream','cache-control':'no-cache'})
            if request.url.path == '/api/insights':
                return httpx.Response(200,json={'status':'completed','role':'应用开发','reportVersion':'legacy'})
            return httpx.Response(202 if request.method=='POST' else 200,stream=MockStream(b'{"ok":true,"id":"saved-operation"}'),headers={'content-type':'application/json'})

        self.app.state.worker.client = httpx.AsyncClient(transport=httpx.MockTransport(upstream),trust_env=False)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(self.app),base_url='http://127.0.0.1:18789')

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.life.__aexit__(None,None,None)

    async def test_contract_rejects_invalid_budget_unknown_field_and_false_confirmation(self):
        for body in ({'id':'x','confirmed':True,'labelBudget':21},{'id':'x','confirmed':True,'sampleCount':4},
                     {'id':'x','confirmed':False},{'id':'x','confirmed':1},{'id':'x','confirmed':True,'ignored':1}):
            response = await self.client.post('/api/insights/training/start',json=body)
            self.assertEqual(response.status_code,400,response.text)
            self.assertTrue(all('input' not in item for item in response.json()['details']))
        self.assertEqual(self.calls,[])

    async def test_same_command_replays_ack_and_never_dispatches_twice(self):
        headers={'idempotency-key':'test-command-1'}
        body={'id':'x','confirmed':True}
        first=await self.client.post('/api/insights/training/resume',json=body,headers=headers)
        second=await self.client.post('/api/insights/training/resume',json=body,headers=headers)
        self.assertEqual(first.status_code,202)
        self.assertEqual(first.json(),second.json())
        self.assertEqual(second.headers['x-operation-replayed'],'1')
        self.assertEqual(len(self.calls),1)
        different=await self.client.post('/api/insights/training/resume',json={'id':'y','confirmed':True},headers=headers)
        self.assertEqual(different.status_code,400)
        self.assertEqual(len(self.calls),1)

    async def test_resume_matching_contract_and_idempotent_dispatch(self):
        body={'role':'研发','resume':'使用Python开发检索系统，负责接口实现与性能优化。'*4,'budget':.5,'shareConfirmed':True,'requestId':str(uuid.uuid4())}
        for patch_value in ({'budget':.51},{'shareConfirmed':False},{'shareConfirmed':1},{'unexpected':True}):
            reply=await self.client.post('/api/resume-matching/start',json={**body,**patch_value})
            self.assertEqual(reply.status_code,400,reply.text)
        self.assertEqual(self.calls,[])
        headers={'idempotency-key':body['requestId']}
        first=await self.client.post('/api/resume-matching/start',json=body,headers=headers)
        second=await self.client.post('/api/resume-matching/start',json=body,headers=headers)
        self.assertEqual(first.status_code,202,first.text)
        self.assertEqual(second.headers['x-operation-replayed'],'1')
        self.assertEqual(len(self.calls),1)
        page=await self.client.get('/matching')
        self.assertEqual(page.status_code,200)
        self.assertIn('matchingView',page.text)

    async def test_requirement_coverage_requires_confirmation_and_ten_job_limit(self):
        body={'id':str(uuid.uuid4()),'keys':['k1'],'shareConfirmed':True,'requestId':str(uuid.uuid4())}
        for patch_value in ({'keys':[]},{'keys':[str(i) for i in range(11)]},{'shareConfirmed':False},{'budget':2}):
            reply=await self.client.post('/api/resume-matching/assess',json={**body,**patch_value})
            self.assertEqual(reply.status_code,400,reply.text)
        self.assertEqual(self.calls,[])
        headers={'idempotency-key':body['requestId']}
        first=await self.client.post('/api/resume-matching/assess',json=body,headers=headers)
        replay=await self.client.post('/api/resume-matching/assess',json=body,headers=headers)
        self.assertEqual(first.status_code,202,first.text)
        self.assertEqual(replay.headers['x-operation-replayed'],'1')
        self.assertEqual(len(self.calls),1)

    async def test_classifier_annotation_count_is_fixed_for_both_entrypoints(self):
        for route, body in (
            ('/api/insights/training/start', {'id':'fixed-count', 'confirmed':True}),
            ('/api/insights/classifier/start', {'inputFile':'kb://task/fixed-count','role':'应用开发'}),
        ):
            before = len(self.calls)
            for count in (400, 600, '500', 500.0, True):
                response = await self.client.post(route, json={**body, 'sampleCount':count})
                self.assertEqual(response.status_code,400,response.text)
            self.assertEqual(len(self.calls),before)
            response = await self.client.post(route,json=body)
            self.assertEqual(response.status_code,202,response.text)
            self.assertEqual(json.loads(self.calls[-1].content)['sampleCount'],500)

    async def test_uncertain_dispatch_is_not_automatically_reissued(self):
        self.disconnect=True
        first=await self.client.post('/api/insights/training/resume',json={'id':'x','confirmed':True},headers={'idempotency-key':'uncertain'})
        self.assertEqual(first.status_code,503)
        self.disconnect=False
        again=await self.client.post('/api/insights/training/resume',json={'id':'x','confirmed':True},headers={'idempotency-key':'uncertain'})
        self.assertEqual(again.status_code,409)
        self.assertEqual(len(self.calls),1)

    async def test_public_origin_and_worker_token_are_separate(self):
        denied=await self.client.post('/api/insights/training/resume',json={'id':'x','confirmed':True},headers={'origin':'https://evil.example'})
        self.assertEqual(denied.status_code,403)
        denied=await self.client.get('/api/state',headers={'host':'evil.example:18789'})
        self.assertEqual(denied.status_code,403)
        response=await self.client.get('/api/state',headers={'origin':'http://127.0.0.1:18789','x-job-worker-token':'forged'})
        self.assertEqual(response.status_code,200)
        self.assertEqual(self.calls[-1].headers['origin'],'http://127.0.0.1:19999')
        self.assertEqual(self.calls[-1].headers['x-job-worker-token'],'test-worker-token')
        self.assertEqual((await self.client.get('/internal/compute/unknown')).status_code,403)
        self.assertEqual((await self.client.get('/_worker/health')).status_code,404)

    async def test_assistant_sse_and_plain_json_compatibility(self):
        response=await self.client.post('/api/assistant/chat',json={'message':'测试咨询'},headers={'accept':'text/event-stream'})
        self.assertEqual(response.status_code,200)
        self.assertIn('event: done',response.text)
        self.assertIn('text/event-stream',response.headers['content-type'])
        self.assertEqual(response.headers['x-backend-framework'],'FastAPI')
        self.assertEqual((await self.client.post('/api/assistant/chat',json={'message':''})).status_code,400)

    async def test_retired_browser_has_no_worker_side_effects(self):
        before=len(self.calls)
        for method in ('GET','POST','PUT','PATCH','DELETE','OPTIONS'):
            for path in ('/api/browser','/api/browser/status','/api/browser/recruiter/start'):
                response=await self.client.request(method,path,content=b'not-json')
                self.assertEqual(response.status_code,410)
                self.assertEqual(response.json()['code'],'FEATURE_REMOVED')
        self.assertEqual(len(self.calls),before)
        response=await self.client.get('/browser')
        self.assertEqual(response.status_code,302)
        self.assertEqual(response.headers['location'],'/tasks')

    async def test_collection_keywords_validation_and_request_deduplication(self):
        path='/api/collection/keywords'
        before=len(self.calls)
        for body in ({'role':''},{'role':'岗'},{'role':'Java开发','count':20},{'role':['Java']}):
            self.assertEqual((await self.client.post(path,json=body)).status_code,400)
        self.assertEqual(len(self.calls),before)
        headers={'Idempotency-Key':'collection-keywords-test'}
        first=await self.client.post(path,json={'role':'Java开发'},headers=headers)
        second=await self.client.post(path,json={'role':'Java开发'},headers=headers)
        self.assertEqual(first.status_code,202)
        self.assertEqual(second.status_code,202)
        self.assertEqual(second.headers['x-operation-replayed'],'1')
        self.assertEqual(len(self.calls),before+1)

    async def test_native_report_cache_etag_gzip_and_source_immutability(self):
        report_dir=self.settings.data/'insights';report_dir.mkdir(parents=True)
        filename=report_dir/'岗位市场洞察.json'
        source={'role':'应用开发','cohort_observations':[{'company_name':'公司甲','knowledge_key':'a','skills':['Python']}]}
        filename.write_text(json.dumps(source,ensure_ascii=False),encoding='utf-8')
        before=hashlib.sha256(filename.read_bytes()).hexdigest()
        response=await self.client.get('/api/insights/report')
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['company_ranking']['knownJobs'],1)
        unchanged=await self.client.get('/api/insights/report',headers={'if-none-match':response.headers['etag']})
        self.assertEqual(unchanged.status_code,304)
        full=await self.client.get('/api/insights')
        self.assertEqual(full.json()['report']['role'],'应用开发')
        self.assertEqual(hashlib.sha256(filename.read_bytes()).hexdigest(),before)
        self.assertEqual(len(self.calls),1)

    async def test_internal_compute_rejects_paths_outside_owned_run(self):
        response=await self.client.post('/internal/compute',json={'kind':'classifier','folder':'C:/Windows','requestId':'test'},headers={'x-job-compute-token':'test-worker-token'})
        self.assertEqual(response.status_code,400,response.text)
        self.assertEqual(self.app.state.ledger.jobs(),[])

    async def test_native_role_snapshots_are_independent_and_support_etag(self):
        database=self.settings.data/'knowledge/岗位知识库.sqlite'
        database.parent.mkdir(parents=True)
        with sqlite3.connect(database) as db:
            db.execute('CREATE TABLE insight_report_snapshots(snapshot_key TEXT PRIMARY KEY,report TEXT,report_hash TEXT)')
            for role,key in [('方向甲','a'*64),('方向乙','b'*64)]:
                raw=json.dumps({'role':role,'cohort_observations':[]},ensure_ascii=False)
                db.execute('INSERT INTO insight_report_snapshots VALUES(?,?,?)',(key,raw,hashlib.sha256(raw.encode()).hexdigest()))
        for role,key in [('方向甲','a'*64),('方向乙','b'*64),('方向甲','a'*64)]:
            response=await self.client.get('/api/insights/report',params={'snapshotKey':key})
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(response.json()['role'],role)
            cached=await self.client.get('/api/insights/report',params={'snapshotKey':key},headers={'if-none-match':response.headers['etag']})
            self.assertEqual(cached.status_code,304)
        self.assertEqual((await self.client.get('/api/insights/report?snapshotKey=invalid')).status_code,400)
        self.assertEqual((await self.client.get('/api/insights/report?snapshotKey='+'c'*64)).status_code,404)
        self.assertEqual(self.calls,[])

    async def test_native_snapshot_checksum_and_force_refresh_validation(self):
        database=self.settings.data/'knowledge/岗位知识库.sqlite';database.parent.mkdir(parents=True)
        with sqlite3.connect(database) as db:
            db.execute('CREATE TABLE insight_report_snapshots(snapshot_key TEXT PRIMARY KEY,report TEXT,report_hash TEXT)')
            db.execute('INSERT INTO insight_report_snapshots VALUES(?,?,?)',('d'*64,'{}','wrong'))
        response=await self.client.get('/api/insights/report?snapshotKey='+'d'*64)
        self.assertEqual(response.status_code,400,response.text)
        self.assertIn('校验失败',response.json()['error'])
        invalid=await self.client.post('/api/insights/run',json={'inputFile':'kb://all','role':'研发','forceRefresh':'true'})
        self.assertEqual(invalid.status_code,400)
        valid=await self.client.post('/api/insights/run',json={'inputFile':'kb://all','role':'研发','forceRefresh':True})
        self.assertEqual(valid.status_code,202,valid.text)
        self.assertTrue(json.loads(self.calls[-1].content)['forceRefresh'])

    async def test_swagger_lists_typed_training_and_streaming_routes(self):
        response=await self.client.get('/openapi.json')
        paths=response.json()['paths']
        self.assertIn('/api/insights/training/resume',paths)
        self.assertIn('/api/assistant/chat',paths)
        self.assertIn('/api/insights/report',paths)
        self.assertNotIn('/internal/compute',paths)
        self.assertEqual(len(self.calls),0)


class StorageTest(unittest.TestCase):
    def test_ledger_restart_preserves_unknown_commands_without_replay(self):
        folder=Path(tempfile.mkdtemp(dir=TEMP));filename=folder/'ledger.sqlite'
        first=Ledger(filename);key,prior=first.claim('test-request','POST','/paid',b'{}')
        self.assertIsNone(prior)
        job,_=first.create_job('compute-request','classifier','output');first.update_job(job['id'],'running')
        second=Ledger(filename);second.recover()
        _,prior=second.claim('test-request','POST','/paid',b'{}')
        self.assertEqual(prior['state'],'uncertain')
        self.assertEqual(second.job(job['id'])['state'],'interrupted')

    def test_report_enrichment_uses_exact_content_version(self):
        folder=Path(tempfile.mkdtemp(dir=TEMP));db=sqlite3.connect(folder/'jobs.sqlite')
        db.executescript('CREATE TABLE jobs(job_key TEXT,content_hash TEXT,raw TEXT);CREATE TABLE job_versions(job_key TEXT,content_hash TEXT,raw TEXT);')
        db.execute('INSERT INTO jobs VALUES (?,?,?)',('k','new',json.dumps({'company_name':'不应采用的新版本'})))
        db.execute('INSERT INTO job_versions VALUES (?,?,?)',('k','old',json.dumps({'company_name':'旧版本公司','province':'广东省'})))
        db.commit();db.close()
        report=folder/'report.json';report.write_text(json.dumps({'cohort_observations':[{'knowledge_key':'k','knowledge_hash':'old','city':'深圳'}]}),encoding='utf-8')
        raw,_=build_report(report,folder/'jobs.sqlite');result=json.loads(raw)
        self.assertEqual(result['cohort_observations'][0]['company_name'],'旧版本公司')
        self.assertEqual(result['cohort_observations'][0]['province'],'广东')
        self.assertEqual(province_name({'city':'广州/深圳'}),'广东')
        self.assertEqual(province_name({'city':'广州/北京'}),'多省份')


class ComputeTest(unittest.IsolatedAsyncioTestCase):
    async def test_subprocess_logs_are_retained_and_read_incrementally(self):
        import base64
        folder=Path(tempfile.mkdtemp(dir=TEMP));settings=Settings(ROOT,folder/'data',folder/'runtime')
        ledger=Ledger(folder/'operations.sqlite');owner=ProcessOwner();supervisor=ComputeSupervisor(settings,ledger,owner)
        supervisor.command=lambda body:([sys.executable,'-B','-c','print("training progress");import sys;sys.stderr.write("diagnostic")'],body.folder)
        try:
            job=await supervisor.submit(ComputeRequest(kind='classifier',folder='logs',requestId='logs'))
            await asyncio.gather(*list(supervisor.tasks.values()))
            output=supervisor.logs(job['id'],0,0)
            self.assertEqual(ledger.job(job['id'])['error'],'')
            self.assertIn(b'training progress',base64.b64decode(output['stdout']))
            self.assertEqual(base64.b64decode(output['stderr']),b'diagnostic')
            again=supervisor.logs(job['id'],output['stdoutOffset'],output['stderrOffset'])
            self.assertEqual(again['stdout'],'')
            self.assertEqual(again['stderr'],'')
        finally:
            await supervisor.close();owner.close()

    async def test_cancel_before_coroutine_starts(self):
        folder=Path(tempfile.mkdtemp(dir=TEMP));settings=Settings(ROOT,folder/'data',folder/'runtime')
        ledger=Ledger(folder/'operations.sqlite');owner=ProcessOwner();supervisor=ComputeSupervisor(settings,ledger,owner)
        supervisor.command=lambda body:([sys.executable,'-B','-c','import time;time.sleep(30)'],body.folder)
        try:
            job,_=ledger.create_job('immediate','classifier','A')
            supervisor.tasks[job['id']]=asyncio.create_task(supervisor.execute(job['id'],[sys.executable,'-B','-c','pass'],'classifier'))
            await supervisor.cancel(job['id'])
            self.assertEqual(ledger.job(job['id'])['state'],'cancelled')
            self.assertEqual(supervisor.processes,{})
        finally:
            await supervisor.close();owner.close()

    async def test_queue_serialization_duplicate_admission_and_cancel(self):
        folder=Path(tempfile.mkdtemp(dir=TEMP));settings=Settings(ROOT,folder/'data',folder/'runtime')
        ledger=Ledger(folder/'operations.sqlite');owner=ProcessOwner();supervisor=ComputeSupervisor(settings,ledger,owner)
        supervisor.command=lambda body:([sys.executable,'-B','-c','import time;time.sleep(.5)'],body.folder)
        try:
            first=await supervisor.submit(ComputeRequest(kind='classifier',folder='A',requestId='one'))
            duplicate=await supervisor.submit(ComputeRequest(kind='classifier',folder='A',requestId='one'))
            self.assertEqual(first['id'],duplicate['id'])
            with self.assertRaises(ValueError):
                await supervisor.submit(ComputeRequest(kind='classifier',folder='A',requestId='conflict'))
            second=await supervisor.submit(ComputeRequest(kind='classifier',folder='B',requestId='two'))
            await asyncio.sleep(.1)
            self.assertEqual(ledger.job(first['id'])['state'],'running')
            self.assertEqual(ledger.job(second['id'])['state'],'queued')
            await supervisor.cancel(second['id'])
            for _ in range(300):
                if ledger.job(first['id'])['state']=='completed':
                    break
                await asyncio.sleep(.01)
            self.assertEqual(ledger.job(first['id'])['state'],'completed')
            self.assertEqual(ledger.job(second['id'])['state'],'cancelled')
        finally:
            await supervisor.close();owner.close()


if __name__=='__main__':
    unittest.main()
