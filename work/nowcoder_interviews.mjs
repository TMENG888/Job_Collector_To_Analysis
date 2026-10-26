import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeJsonAtomic} from './collector_storage.mjs';
import {createPoliteHttpClient} from './polite_http_client.mjs';
import {withAccountLock} from './collection_concurrency.mjs';
import {analyzeInterviewPosts} from './interview_influence.mjs';
import {channelErrorDiagnostic} from './channel_collection_diagnostics.mjs';

const base='https://gw-c.nowcoder.com';
const failure=(message,code='nowcoder_contract')=>Object.assign(Error(message),{code,stopChannel:true});
// 断网/解析失败/超时/取消只是本机连通性问题，不是渠道契约变化。
// 旧告警 stato.blocked 永不失效时，网络恢复后通道仍会被永久封锁；
// 这里为“可自愈”错误设定观察窗，窗口过后自动解除并记录重试次数。
const transientFailureCodes=new Set(['network_error','network_timeout','request_cancelled']);
const blockObservationMs=30*60*1000;
function isTransientFailureCode(code){return transientFailureCodes.has(String(code||''));}
function isStaleTransientBlock(block,nowMs=Date.now()){
  if(!block||!isTransientFailureCode(block.code))return false;
  const at=Date.parse(block.at||'');
  return Number.isFinite(at)&&nowMs-at>=blockObservationMs;
}
const integer=(value,min,max,fallback)=>{
  const n=value==null||value===''?fallback:Number(value);
  if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`面经参数须为 ${min}–${max} 的整数`);
  return n;
};
export function interviewSettings(input={},fallback={}){
  const terms=input.keywords??fallback.keywords??[];
  const keywords=[...new Set((Array.isArray(terms)?terms:String(terms).split(/[\n,，;；]+/)).map(x=>String(x).trim()).filter(Boolean))];
  const enabled=input.enabled==null||input.enabled===true||input.enabled==='on';
  const roleKey=String(input.roleKey??fallback.roleKey??'').trim();
  if(enabled&&(!roleKey||!keywords.length||keywords.length>20||keywords.some(x=>x.length>100)))throw Error('面经需要岗位名称及1–20个检索词，每词不超过100字');
  // null is persisted as unlimited; never use Infinity (JSON would lose it).
  const maxPosts=input.maxPosts==null||input.maxPosts===''?null:integer(input.maxPosts,1,Number.MAX_SAFE_INTEGER);
  const automatic=input.requestBudgetMode==='automatic'||input.maxRequests==null||input.maxRequests===''||(input.collectionLimitVersion!==2&&Number(input.maxRequests)===250);
  const maxRequests=automatic?(maxPosts===null?null:Math.min(Number.MAX_SAFE_INTEGER,maxPosts*2+keywords.length*100)):integer(input.maxRequests,1,100000,250);
  return {enabled,defaultChannelVersion:1,collectionLimitVersion:2,roleKey,keywords,maxPosts,maxRequests,requestBudgetMode:automatic?'automatic':'custom',halfLifeDays:integer(input.halfLifeDays,30,1095,180)};
}
export function taskInterviewSettings(task){
  const input=task.interviews||{},roleKey=input.roleKey||task.label||task.primaryKeyword||'';
  const keywords=Array.isArray(task.keywords)&&task.keywords.length?task.keywords:[task.primaryKeyword||task.label].filter(Boolean);
  const configured=Array.isArray(input.keywords)?input.keywords.length>0:typeof input.keywords==='string'&&input.keywords.trim().length>0;
  return interviewSettings({...input,roleKey,enabled:input.defaultChannelVersion===1?input.enabled:true,keywords:configured?input.keywords:keywords},{keywords,roleKey});
}
export function interviewPaths(outputDir){
  const directory=path.join(outputDir,'面经数据');
  return {directory,checkpoint:path.join(directory,'nowcoder.checkpoint.json'),status:path.join(directory,'status.json')};
}
async function readJson(file){
  try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function plain(value){
  return String(value||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<br\s*\/?>|<\/(?:p|div|li)>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&(nbsp|amp|lt|gt|quot|apos);/g,(_,key)=>({nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[key]).trim();
}
function date(value){
  if(value==null||value==='')return null;
  const n=typeof value==='number'||/^\d+$/.test(String(value))?Number(value):Date.parse(value);
  const d=new Date(n);
  return Number.isFinite(d.getTime())?d.toISOString():null;
}
function count(value){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;}
export function normalizeInterview(record,{keyword,roleKey,collectedAt=new Date().toISOString(),detail=null}={}){
  const data=record?.data??record??{};
  const type=Number(data.contentType??record?.contentType);
  if(![74,250].includes(type))return null;
  const item=type===250?data.contentData:data.momentData;
  if(!item||typeof item!=='object')throw failure('面经搜索记录缺少正文数据');
  if(type===250&&typeof item.id==='number'&&!Number.isSafeInteger(item.id))throw failure('面经大整数ID未按字符串传输，拒绝使用失真标识');
  const token=String(type===250?item.id:item.uuid);
  if(!(type===250?/^\d{1,20}$/:/^[a-f0-9]{32}$/).test(token))throw failure('面经记录标识格式发生变化');
  const full=detail||item,frequency={...data.frequencyData,...item.frequencyData,...detail?.frequencyData};
  const content=plain(full.richText||full.content||item.richText||item.content).slice(0,200000);
  return {id:`nowcoder:${type}:${token}`,platform:'nowcoder',kind:type===250?'discuss':'moment',source_id:token,role_key:roleKey,role_scope:'task_search_cohort',query_keywords:[keyword],title:plain(full.title||item.title)||content.slice(0,70),content,content_status:detail?'detail':'search_excerpt',url:type===250?`https://www.nowcoder.com/discuss/${token}`:`https://www.nowcoder.com/feed/main/detail/${token}`,created_at:date(full.createdAt??full.createTime??item.createdAt??item.createTime),updated_at:date(full.editTime??item.editTime),collected_at:collectedAt,metrics_at:collectedAt,metrics:{views:count(frequency.viewCnt),likes:count(frequency.likeCnt),favorites:count(frequency.followCnt),comments:count(frequency.totalCommentCnt)},top_level_comments:count(frequency.commentCnt),metric_sources:{views:'frequencyData.viewCnt',likes:'frequencyData.likeCnt',favorites:'frequencyData.followCnt',comments:'frequencyData.totalCommentCnt'},content_hash:createHash('sha256').update(content).digest('hex')};
}
export function parseInterviewSearch(body){
  assertBusiness(body);
  const data=body.data;
  if(!data||!Array.isArray(data.records)||!Number.isSafeInteger(data.totalPage)||data.totalPage<0||!Number.isSafeInteger(data.total)||data.total<0)throw failure('牛客搜索接口结构发生变化，停止并保留断点');
  return data;
}
function assertBusiness(body){
  if(!body||Number(body.code)!==0){
    const message=String(body?.msg||'未知响应').slice(0,160);
    const access=[999,101,401,403,429].includes(Number(body?.code))||/login|captcha|verify|登录|验证|频繁|限流|访问受限/i.test(message);
    throw failure(`牛客：${message}；不自动重试`,access?'access_blocked':'nowcoder_contract');
  }
}
export async function readInterviewSnapshot(task,{includePosts=false,now=Date.now(),offset=0,limit=20}={}){
  const paths=interviewPaths(task.outputDir),status=await readJson(paths.status);
  if(status&&status.task_id!==task.id)throw Error('面经状态任务归属不一致');
  if(status?.status==='running'){
    let alive=false;try{if(Number.isSafeInteger(status.pid)&&status.pid>0){process.kill(status.pid,0);alive=true;}}catch{}
    if(!alive){status.status='paused';status.reason='采集进程已停止，可复用断点继续';}
  }
  const settings=taskInterviewSettings(task);
  if(status&&['blocked','budget_paused'].includes(status.status)&&status.errorCode)status.diagnostic=channelErrorDiagnostic([{code:status.errorCode,message:status.reason}]);
  if(!includePosts)return status?{...status,enabled:settings.enabled===true,settings}:{enabled:settings.enabled===true,status:'ready',candidates:0,details:0,settings};
  const saved=await readJson(paths.checkpoint);
  if(saved&&saved.task_id!==task.id)throw Error('面经断点任务归属不一致');
  const unique=deduplicateInterviewPosts(saved?.posts||[]);
  const result=analyzeInterviewPosts(unique,{roleKey:settings.roleKey,now,halfLifeDays:settings.halfLifeDays||180});
  result.rows.sort((a,b)=>(a.influence.rank??Infinity)-(b.influence.rank??Infinity)||a.id.localeCompare(b.id));
  return {task_id:task.id,status:await readInterviewSnapshot(task),model:result.model,total:result.rows.length,rawCount:saved?.posts?.length||0,duplicateCount:(saved?.posts?.length||0)-unique.length,offset,limit,posts:result.rows.slice(offset,offset+limit),scope:'同一任务岗位搜索范围；搜索相关不等于已人工确认同岗',ranking_at:new Date(now).toISOString()};
}
export function deduplicateInterviewPosts(posts){
  const groups=new Map();
  for(const post of posts){
    const key=post.content_status==='detail'&&post.content?.length>=80?JSON.stringify([post.role_key,post.title,post.content_hash]):post.id;
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(post);
  }
  return [...groups.values()].map(group=>{
    const timestamp=post=>Number.isFinite(Date.parse(post.created_at))?Date.parse(post.created_at):Infinity;
    group.sort((a,b)=>timestamp(a)-timestamp(b)||a.id.localeCompare(b.id));
    return {...group[0],duplicate_ids:group.slice(1).map(x=>x.id)};
  });
}
export async function collectNowcoderInterviews({taskId,outputDir,settings,request,onEvent=()=>{},shouldStop=()=>false}){
  const cfg=interviewSettings(settings),paths=interviewPaths(outputDir);
  if(!cfg.enabled)return {status:'disabled'};
  if(!taskId)throw Error('面经采集缺少任务ID');
  await fs.mkdir(paths.directory,{recursive:true});
  return withAccountLock(path.join(paths.directory,'collection.lock'),taskId,async()=>{
    let state=await readJson(paths.checkpoint);
    if(state&&state.task_id!==taskId)throw Error('面经断点任务归属不一致');
    state=state||{task_id:taskId,role_key:cfg.roleKey,posts:[],queries:{},requests:0};
    if(state.role_key!==cfg.roleKey)throw Error('不能复用其他岗位的面经断点');
    const posts=new Map(state.posts.map(x=>[x.id,x]));
    let requests=0,phase='search',currentKeyword='',reason='',stopped=false;
    const persist=async(status,extra={})=>{
      state={...state,posts:[...posts.values()],updated_at:new Date().toISOString()};
      await writeJsonAtomic(paths.checkpoint,state);
      const snapshot={task_id:taskId,pid:process.pid,enabled:true,status,phase,currentKeyword,candidates:posts.size,details:[...posts.values()].filter(x=>x.content_status==='detail').length,pages:Object.values(state.queries).reduce((s,q)=>s+(q.pages||0),0),requests:state.requests,roundRequests:requests,reason,updated_at:state.updated_at,settings:cfg,recoveryRetries:Number(state.recoveryRetries||0),recoverable:state.blocked?isTransientFailureCode(state.blocked.code):false,...extra};
      await writeJsonAtomic(paths.status,snapshot);
      return snapshot;
    };
    const recovered=isStaleTransientBlock(state.blocked)?{...state.blocked}:null;
    if(recovered){
      state={...state,blocked:null,recoveredAt:new Date().toISOString(),
        recoveries:[...(state.recoveries||[]),{code:recovered.code,message:recovered.message,blocked_at:recovered.at,at:new Date().toISOString()}].slice(-5),
        recoveryRetries:Number(state.recoveryRetries||0)+1};
      await persist('running');
      onEvent(`[面经流程] 连通性告警已过观察窗（${recovered.code}），自动重试并沿用现有断点`);
    }
    if(state.blocked){reason=state.blocked.message;return persist('blocked',{errorCode:state.blocked.code,recoverable:isTransientFailureCode(state.blocked.code)});}
    const http=request||createPoliteHttpClient({stateDir:process.env.JOB_HTTP_RATE_DIR||path.join(paths.directory,'shared_rate'),minimumIntervalMs:4000,jitterMs:700,attempts:1});
    const get=async(endpoint,options={})=>{
      if(shouldStop())throw failure('已暂停','cancelled');
      if(cfg.maxRequests!==null&&requests>=cfg.maxRequests)throw failure('本轮面经请求预算已用完','request_budget');
      requests++;state.requests++;
      const response=await http(base+endpoint,{...options,headers:{'content-type':'application/json',origin:'https://www.nowcoder.com',referer:'https://www.nowcoder.com/search/all',...options.headers}});
      if(!response.ok)throw failure(`牛客 HTTP ${response.status}`,[401,403,429].includes(response.status)?'access_blocked':'http_error');
      let body;try{body=await response.json();}catch{throw failure('牛客返回非JSON响应，停止采集','invalid_response');}
      assertBusiness(body);return body;
    };
    const detail=async(post)=>{
      if(post.content_status==='detail')return;
      phase='detail';await persist('running');
      const endpoint=post.kind==='discuss'?`/api/sparta/detail/content-data/detail/${post.source_id}`:`/api/sparta/detail/moment-data/detail/${post.source_id}`;
      const body=await get(endpoint);
      if(!body.data||typeof body.data!=='object'||!('content' in body.data||'richText' in body.data))throw failure('牛客详情缺少正文，不用搜索摘要冒充完整面经');
      if(typeof (body.data.richText||body.data.content)!=='string'||!plain(body.data.richText||body.data.content))throw failure('牛客详情正文为空或格式已改变，停止并保留断点');
      const detailId=post.kind==='discuss'?body.data.id:body.data.uuid;
      if(detailId!=null&&String(detailId)!==post.source_id)throw failure('牛客详情标识与请求不一致，拒绝混入其他帖子');
      const type=post.kind==='discuss'?250:74;
      const record={data:{contentType:type,[type===250?'contentData':'momentData']:{id:post.source_id,uuid:post.source_id},frequencyData:{}}};
      const normalized=normalizeInterview(record,{keyword:post.query_keywords[0],roleKey:cfg.roleKey,detail:body.data});
      posts.set(post.id,{...normalized,query_keywords:post.query_keywords});await persist('running');
    };
    try{
      onEvent('[面经流程] 牛客公开搜索 → 去重保存 → 详情补全 → 时效影响力排名');
      await persist('running');
      for(const post of posts.values())if(post.content_status!=='detail')await detail(post);
      for(const keyword of cfg.keywords){
        currentKeyword=keyword;
        const q=state.queries[keyword]||{nextPage:1,pages:0,completed:false,signatures:[]};state.queries[keyword]=q;
        const consume=()=>{
          const remaining=[];
          for(const post of q.pending||[]){
            const existing=posts.get(post.id);
            if(existing)existing.query_keywords=[...new Set([...existing.query_keywords,keyword])];
            else if(cfg.maxPosts===null||posts.size<cfg.maxPosts)posts.set(post.id,post);
            else remaining.push(post);
          }
          q.pending=remaining;
        };
        consume();await persist('running');
        for(const post of posts.values())if(post.content_status!=='detail')await detail(post);
        while(!q.completed&&(cfg.maxPosts===null||posts.size<cfg.maxPosts)){
          phase='search';await persist('running');
          const data=parseInterviewSearch(await get('/api/sparta/pc/search',{method:'POST',body:JSON.stringify({type:'all',query:keyword,page:q.nextPage,tag:[{id:818,name:'面经'}],order:1,gioParams:{}})}));
          const pagePosts=data.records.map(record=>normalizeInterview(record,{keyword,roleKey:cfg.roleKey})).filter(Boolean);
          if(data.records.length&&!pagePosts.length)throw failure('搜索结果均为未知内容类型，停止并保留原始断点');
          const signature=createHash('sha256').update(pagePosts.map(x=>x.id).sort().join('|')).digest('hex');
          if(q.signatures.includes(signature)&&data.records.length)throw failure('搜索分页重复，停止当前面经渠道','pagination_stalled');
          if(!data.records.length&&q.nextPage<=data.totalPage)throw failure('搜索返回空页但总页数尚未结束','pagination_stalled');
          q.signatures.push(signature);q.pages++;q.nextPage++;q.total=data.total;q.totalPage=data.totalPage;
          q.completed=!data.records.length||q.nextPage>data.totalPage;
          q.pending=pagePosts;consume();
          await persist('running');
          for(const post of posts.values())if(post.content_status!=='detail')await detail(post);
        }
      }
      const complete=cfg.keywords.every(k=>state.queries[k]?.completed&&!state.queries[k]?.pending?.length);
      phase='rank';reason=complete?'accessible_results_finished':'post_target_reached';
      onEvent(`[面经流程] ${complete?'可访问搜索结果已处理':'已达到采集目标篇数'}；面经独立保存，未计入岗位数`);
      return persist(complete?'completed':'budget_paused');
    }catch(error){
      stopped=true;reason=error.message;
      const budget=['request_budget','cancelled'].includes(error.code);
      const errorCode=channelErrorDiagnostic([error]).code;
      if(!budget)state.blocked={code:errorCode,message:error.message,at:new Date().toISOString(),recoverable:isTransientFailureCode(errorCode)};
      const result=await persist(budget?'budget_paused':'blocked',{errorCode});
      onEvent(`[面经流程] 已停止：${error.message}；已保存数据与断点保留`);
      if(['ENOSPC','EIO','EACCES','EPERM','RESOURCE_PRESSURE'].includes(error.code))throw error;
      return result;
    }finally{if(!stopped)phase='idle';}
  },{interval:1000,shouldStop});
}
