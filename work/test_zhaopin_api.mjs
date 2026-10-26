import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {parseZhaopinApi,observedZhaopinTemplate,pageRequestFromTemplate,mergeZhaopinPage,fetchZhaopinPage,captureZhaopinTemplate,establishZhaopinTemplate,zhaopinTemplateForQuery,zhaopinApiCheckpoint,assertZhaopinCheckpointTask,isZhaopinCheckpointExhausted,mergeZhaopinRawRow} from './zhaopin_api.mjs';
import {YieldWindow} from './collection_yield.mjs';
import {zhaopinCheckpoint} from './zhaopin_checkpoint.mjs';

const body={code:200,data:{list:[{number:'A',name:'相邻岗位',jobDetailData:{position:{desc:{description:'真实描述'}}}}],count:181,isEndPage:0,isVerification:0}};
const request=(extra={})=>({url:()=> 'https://fe-api.zhaopin.com/c/i/search/positions?at=MEMORY_ONLY&rt=MEMORY_ONLY',method:()=> 'POST',headers:()=>({'content-type':'application/json',cookie:'MUST_NOT_COPY',authorization:'OBSERVED_ONLY','x-zp-client-id':'MEMORY_ONLY','user-agent':'browser-owned'}),postDataJSON:()=>({S_SOU_FULL_INDEX:'智能体开发',S_SOU_WORK_CITY:'763',pageSize:20,pageIndex:2,at:'MEMORY_ONLY',actionid:'SITE_GENERATED',...extra})});
const template=observedZhaopinTemplate(request(),'智能体开发','763');
assert(template);
assert.equal(template.headers.cookie,undefined);
assert.equal(template.headers['user-agent'],undefined);
assert.equal(observedZhaopinTemplate(request(),'其他关键词','763'),null);
assert.equal(observedZhaopinTemplate(request(),'智能体开发','530'),null);
assert.equal(observedZhaopinTemplate(request({pageIndex:0}),'智能体开发','763'),null);
const next=pageRequestFromTemplate(template,3);
assert.equal(next.url,template.url); // No regenerated tokens or signatures.
assert.equal(JSON.parse(next.body).pageIndex,3);
assert.equal(JSON.parse(next.body).actionid,'SITE_GENERATED');
assert.equal(template.body.pageIndex,2);
const changedQuery=zhaopinTemplateForQuery(template,'开发工程师','530');
assert.equal(changedQuery.body.S_SOU_FULL_INDEX,'开发工程师');
assert.equal(changedQuery.body.S_SOU_WORK_CITY,'530');
assert.equal(changedQuery.url,template.url);
assert.equal(template.body.S_SOU_WORK_CITY,'763');
assert.throws(()=>pageRequestFromTemplate(null,3),e=>e.code==='api_template_missing');
assert.deepEqual(parseZhaopinApi(body).rows,body.data.list);
for(const status of [401,403,429])assert.throws(()=>parseZhaopinApi({},status),e=>e.stopChannel&&e.code==='access_blocked');
assert.throws(()=>parseZhaopinApi({...body,data:{...body.data,statusCode:403}}),e=>e.code==='access_blocked');
assert.throws(()=>parseZhaopinApi({...body,data:{...body.data,statusCode:500}}),e=>e.code==='invalid_response');
for(const flag of [1,true,'1','true'])assert.throws(()=>parseZhaopinApi({...body,data:{...body.data,isVerification:flag}}),e=>e.code==='verification_required');
assert.throws(()=>parseZhaopinApi('<html>验证码</html>'),e=>e.code==='verification_required');
assert.throws(()=>parseZhaopinApi({code:500,data:{list:[],count:0}}),e=>e.code==='invalid_response');
assert.throws(()=>parseZhaopinApi({code:200,data:{list:[],count:15,isEndPage:0}}));
assert.equal(parseZhaopinApi({code:200,data:{list:[],count:0,isEndPage:1}}).explicitEmpty,true);

const state={keyword:'智能体开发',city:{name:'广州',code:'763'},records:new Map([['OLD',{number:'OLD'}]]),lastPageIndex:10,observedPages:new Set(),yieldWindow:new YieldWindow(new Set(),{minimumRecords:60,pages:3})};
mergeZhaopinPage(state,parseZhaopinApi(body),2);
assert.equal(state.lastPageIndex,10); // Compatible with the old resume cursor.
assert.equal(state.records.size,2);
mergeZhaopinPage(state,parseZhaopinApi({...body,data:{...body.data,list:[{...body.data.list[0],name:'详情更新'}]}}),2);
assert.equal(state.records.size,2);
assert.equal(state.records.get('A').name,'详情更新');
assert.equal(state.yieldWindow.window.length,1); // Each real response page counted once.
mergeZhaopinPage(state,{rows:[],total:181,endPage:true,explicitEmpty:false},11);
mergeZhaopinPage(state,parseZhaopinApi(body),1);
assert.equal(state.endPage,true); // A page-one enrichment must not erase exhaustion.
const checkpoint=zhaopinCheckpoint(state);
assert.equal(checkpoint.last_page_index,11);
assert.equal(checkpoint.end_page,true);
assert(!JSON.stringify(checkpoint).includes('MEMORY_ONLY'));
assert.equal(checkpoint.records.find(r=>r.number==='A').name,'相邻岗位'); // No relevance filtering.
assert.equal(assertZhaopinCheckpointTask({records:[]},'CURRENT').records.length,0); // Old format allowed in an owned directory.
assert.throws(()=>assertZhaopinCheckpointTask({task_id:'FOREIGN',records:[]},'CURRENT'),e=>e.code==='task_ownership_mismatch');
const bootstrapState={...state,total:state.records.size,taskId:'CURRENT',apiFirstPageVerified:false};
const bootstrapCheckpoint=zhaopinApiCheckpoint(bootstrapState);
assert.equal(bootstrapCheckpoint.complete,false);
assert.equal(bootstrapCheckpoint.end_page,false);
assert.equal(bootstrapCheckpoint.task_id,'CURRENT');
assert.equal(isZhaopinCheckpointExhausted(bootstrapCheckpoint),false); // Even when raw row count equals source total.
bootstrapState.apiFirstPageVerified=true;
assert.equal(isZhaopinCheckpointExhausted(zhaopinApiCheckpoint(bootstrapState)),true);
assert.equal(isZhaopinCheckpointExhausted({total:2,records:[{},{}]}),true); // Legacy exhaustion preserved.
const known=body.data.list[0];
assert.equal(mergeZhaopinRawRow(known,{number:'A',name:'SSR列表'}).jobDetailData.position.desc.description,'真实描述');
assert.equal(mergeZhaopinRawRow({number:'A'},known).jobDetailData.position.desc.description,'真实描述');
assert.equal(mergeZhaopinRawRow(known,{...known,jobDetailData:{position:{desc:{description:'最新详情'}}}}).jobDetailData.position.desc.description,'最新详情');

let calls=0;
const fetched=await fetchZhaopinPage({evaluate:async(fn,options)=>{calls++;assert.equal(JSON.parse(options.body).pageIndex,3);return {status:200,text:JSON.stringify(body)};}},template,3);
assert.equal(fetched.rows.length,1);assert.equal(calls,1);
await assert.rejects(()=>fetchZhaopinPage({evaluate:async()=>{calls++;return {status:403,text:'<html>Access denied</html>'};}},template,4),e=>e.code==='access_blocked');
assert.equal(calls,2); // Access failures cause no hidden retries.
await assert.rejects(()=>fetchZhaopinPage({evaluate:async()=>({networkError:true})},template,4),e=>e.code==='network_error');

const page=new EventEmitter();
const live={keyword:'智能体开发',city:{code:'763'},records:new Map(),lastPageIndex:1,observedPages:new Set()};
let persisted=0;
const capture=captureZhaopinTemplate(page,live,()=>persisted++);
const wrong=request({S_SOU_FULL_INDEX:'旧关键词'});
page.emit('request',wrong);page.emit('response',{request:()=>wrong,status:()=>200,text:async()=>JSON.stringify(body)});
await capture.settle();assert.equal(capture.template,null);
const right=request();page.emit('request',right);page.emit('response',{request:()=>right,status:()=>200,text:async()=>JSON.stringify(body)});
await capture.settle();assert(capture.template);assert.equal(persisted,1);
await capture.dispose();assert.equal(page.listenerCount('request'),0);assert.equal(page.listenerCount('response'),0);
const emptyPage=new EventEmitter();emptyPage.evaluate=async()=>{};
const emptyCapture=captureZhaopinTemplate(emptyPage,{...live,records:new Map()});
await assert.rejects(()=>establishZhaopinTemplate(emptyPage,emptyCapture,{timeoutMs:0,before:async()=>{}}),e=>e.code==='api_template_missing');
await emptyCapture.dispose();
console.log('zhaopin_api: template/session pagination, response guards, old resume cursor, ID dedup, exhaustion, privacy and no hidden retries passed');
