import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedBaseURL,workspaceURL,isWorkspaceURL,workspaceViewForURL,isRecruitingURL,allowRecruitingResource,navigationDecision,viewBounds,COMMANDS} from './policy.mjs';

test('local workspace only; no credentials or external origin',()=>{
  assert.equal(checkedBaseURL(),'http://127.0.0.1:8788');
  for(const url of ['https://evil.com','http://localhost:8788','http://127.0.0.1:8788/evil','http://a:b@127.0.0.1:8788','http://127.0.0.1:8788/#x'])assert.throws(()=>checkedBaseURL(url));
  assert.equal(workspaceURL('http://127.0.0.1:8788','insights'),'http://127.0.0.1:8788/insights');
  assert.throws(()=>workspaceURL('http://127.0.0.1:8788','browser'));
  assert.equal(isWorkspaceURL('http://127.0.0.1:8788/tasks','http://127.0.0.1:8788'),true);
  assert.equal(isWorkspaceURL('http://127.0.0.1:8789/tasks','http://127.0.0.1:8788'),false);
});
test('desktop active tab follows local route including SPA and task detail',()=>{
  const base='http://127.0.0.1:8788';
  for(const [url,expected] of [['/tasks','tasks'],['/tasks/123','tasks'],['/insights','insights'],['/browser','browser'],['/?view=assistant','assistant'],['/unknown',null]])assert.equal(workspaceViewForURL(base+url,base),expected);
  assert.equal(workspaceViewForURL('https://www.zhipin.com/browser',base),null);
});
test('recruiting navigation exact domains and HTTPS; blank is never fallback',()=>{
  for(const url of ['https://www.zhipin.com/','https://passport.zhaopin.com/login','https://www.liepin.com/job/123'])assert.equal(isRecruitingURL(url),true);
  for(const url of ['about:blank','file:///C:/','javascript:alert(1)','https://zhipin.com.evil.com','http://www.zhipin.com','https://user:pass@www.zhipin.com','https://www.zhipin.com:8888','http://127.0.0.1:8788'])assert.equal(navigationDecision(url),'deny');
});
test('website resources cannot reach localhost/private IP or files',()=>{
  for(const url of ['https://static.zhipin.com/a.js','https://cdn.example.com/a.png','wss://chat.zhipin.com/ws','data:image/png;base64,AA==','blob:https://www.zhipin.com/a'])assert.equal(allowRecruitingResource(url),true,url);
  for(const url of ['file:///C:/secret','http://127.0.0.1:8788/api/browser/status','https://localhost/','https://a.localhost/','https://10.1.1.1/','https://192.168.1.1/','https://[::1]/','http://public.example/'])assert.equal(allowRecruitingResource(url),false,url);
});
test('native viewport leaves trusted toolbar/panel unobscured',()=>{
  assert.deepEqual(viewBounds(1440,900,'browser'),{x:0,y:152,width:1100,height:722});
  assert.deepEqual(viewBounds(1440,900,'workspace'),{x:0,y:56,width:1440,height:818});
  assert.equal(COMMANDS.has('executeJavaScript'),false);assert.equal(COMMANDS.has('send'),false);assert.equal(COMMANDS.has('classify'),true);
});
