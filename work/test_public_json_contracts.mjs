import assert from 'node:assert/strict';
import {parseIguopinPage} from './public_json_contracts.mjs';
import {checkedJsonResponse} from './collection_policy.mjs';
assert.equal(parseIguopinPage({data:{list:[],total:0,page_size:20}}).total,0);
assert.equal(parseIguopinPage({data:{list:[{job_id:1,job_name:'工程师'}],total:'40',page_size:'20'}}).total,40);
for(const data of [{},{list:[],total:undefined},{list:[],total:-1},{list:[{}],total:1},{list:[{job_id:'',job_name:'岗位'}],total:1},{list:[{job_id:1,job_name:'岗位'}],total:0}]) {
  assert.throws(()=>parseIguopinPage({data}),error=>error.stopChannel&&error.code==='invalid_response');
}
for(const status of [401,403,429]) await assert.rejects(checkedJsonResponse(new Response('{}',{status}),'国聘'),error=>error.stopChannel&&error.code==='access_blocked');
await assert.rejects(checkedJsonResponse(new Response('<html>安全验证</html>'),'国聘'),error=>error.code==='verification_required');
console.log('PASS 国聘真实空列表、分页结构、缺失岗位ID、限流及验证页面停止');
