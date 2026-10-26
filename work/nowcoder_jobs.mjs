import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeAtomic,writeJsonAtomic} from './collector_storage.mjs';
import {createPoliteHttpClient} from './polite_http_client.mjs';
import {withAccountLock} from './collection_concurrency.mjs';
import {channelErrorDiagnostic} from './channel_collection_diagnostics.mjs';
import {isConditionScopedStop} from './task_collection_config.mjs';

// 牛客「职位广场」：NOWPICK 网关，匿名表单接口（POST + x-www-form-urlencoded）。
// 反向结论：/u/* 归属 nowpick.nowcoder.com；gw-c.nowcoder.com 只服务 /api/sparta/*。
// GET 返回 405，因此白名单只登记该路径与该 origin，不接受其他方法到达。
const base='https://nowpick.nowcoder.com';
const searchPath='/u/job/square-search';
const referer='https://www.nowcoder.com/jobs/fulltime/center';
const failure=(message,code='nowcoder_contract')=>Object.assign(Error(message),{code,stopChannel:true});
// 与面经通道同构：连通性故障只做观察窗封锁，窗口过后自愈，避免永久锁死渠道。
const transientFailureCodes=new Set(['network_error','network_timeout','request_cancelled']);
const blockObservationMs=30*60*1000;
function isTransientFailureCode(code){return transientFailureCodes.has(String(code||''));}
function isStaleTransientBlock(block,nowMs=Date.now()){
  if(!block||!isTransientFailureCode(block.code))return false;
  const at=Date.parse(block.at||'');
  return Number.isFinite(at)&&nowMs-at>=blockObservationMs;
}
// 服务端硬上限：pageSize>100 无效，越界页返回 totalPage=0。
const maxPageSize=100;
const recruitTypes=[{id:1,name:'校招'},{id:2,name:'实习'},{id:3,name:'社招'}];
const educationLevels=new Map([[0,'不限'],[1000,'初中及以下'],[2000,'高中'],[3000,'中专/中技'],[4000,'大专'],[5000,'本科'],[6000,'硕士'],[7000,'博士']]);
const workYearTypes=new Map([[0,'经验不限'],[1,'应届生'],[2,'3年以内'],[3,'3-5年'],[4,'5-10年'],[5,'10年以上']]);
const encoded=new Map([[0,'其他/兼职'],[1,'实习'],[2,'兼职'],[3,'全职']]);
const integer=(value,min,max,fallback)=>{
  const n=value==null||value===''?fallback:Number(value);
  if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`牛客岗位参数须为 ${min}–${max} 的整数`);
  return n;
};
function number(value){return typeof value==='number'&&Number.isFinite(value)?value:null;}
function date(value){
  const n=number(value);
  if(n===null||n<=0)return null;
  const d=new Date(n);
  return Number.isFinite(d.getTime())?d.toISOString():null;
}
function plain(value){
  return String(value||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<br\s*\/?>|<\/(?:p|div|li)>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&(nbsp|amp|lt|gt|quot|apos);/g,(_,key)=>({nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[key]).replace(/\r\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
// 薪资：salaryMin/Max 单位为「千元/月」，salaryMonth 为发薪月数；salaryType=1 为面议。
// 观测到 0-9999999 这类「未填但未置空」的哨兵值，不能当作真实高薪。
function salaryText(job){
  if(Number(job.salaryType)===1)return '面议';
  const min=number(job.salaryMin),max=number(job.salaryMax),months=number(job.salaryMonth)||0;
  if(min===null||max===null)return '';
  if(min>=9999999||max>=9999999)return '面议';
  if(min<=0&&max<=0)return '面议';
  const span=min===max?`${min}K`:`${min}-${max}K`;
  return months>0?`${span}·${months}薪`:span;
}
function cityList(job){
  const list=Array.isArray(job.jobCityList)?job.jobCityList.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()):[];
  if(list.length)return list;
  const raw=String(job.jobCity||'').trim();
  return raw?raw.split(/[,，\s]+/).filter(Boolean):[];
}
function requirementText(job){
  // ext 是接口内的 JSON 字符串；解析失败只丢扩展字段，不让整条记录失败。
  if(typeof job.ext!=='string'||!job.ext.trim())return {};
  try{
    const ext=JSON.parse(job.ext);
    return ext&&typeof ext==='object'?ext:{};
  }catch{
    return {};
  }
}
export function nowcoderJobSettings(input={},fallback={}){
  // 两种调用约定都要吃：直接传渠道配置，或传 {nowcoderJobs:<渠道配置>, keywords, label}。
  // 此前只认前者，而采集器按后者传，结果 enabled 恒为 undefined（→false）、cities 恒为空：
  // 表现为「零请求、断点不动、退出码 0」的假正常，比报错更难发现。
  if(input&&typeof input==='object'&&input.nowcoderJobs&&typeof input.nowcoderJobs==='object'){
    const wrapped=input.nowcoderJobs;
    input={...wrapped,keywords:input.keywords??wrapped.keywords,label:input.label??wrapped.label};
  }
  const enabled=input.enabled==null?fallback.enabled===true:input.enabled===true||input.enabled==='on';
  const roleKey=String(input.roleKey??fallback.roleKey??'').trim();
  const rawCategories=input.careerJobIds??fallback.careerJobIds??[];
  const careerJobIds=[...new Set((Array.isArray(rawCategories)?rawCategories:String(rawCategories).split(/[\n,，;；\s]+/)).map(x=>Number(String(x).trim())).filter(x=>Number.isSafeInteger(x)&&x>0))];
  const rawCities=input.cities??fallback.cities??[];
  const cities=[...new Set((Array.isArray(rawCities)?rawCities:String(rawCities).split(/[\n,，;；]+/)).map(x=>String(x).trim()).filter(Boolean))];
  // 接口契约（2026-10 实测）：jobCity 只认中文城市名。任何数字码（旧配置的 9/763/110100 等）
  // 都会返回 code 0 + totalCount 0 + totalPage 0 —— 表现为「跑完但零数据」，
  // 是最难排查的一类假完成。宁可在启动时直接拒绝。
  const codeLikeCities=cities.filter(city=>/^\d+$/.test(city));
  if(codeLikeCities.length)throw failure(`牛客岗位的城市必须写中文城市名，检测到数字码城市：${codeLikeCities.join('、')}；接口对数字码只会返回空结果`, 'invalid_config');
  const rawKeywords=input.keywords??fallback.keywords??[];
  const keywords=[...new Set((Array.isArray(rawKeywords)?rawKeywords:String(rawKeywords).split(/[\n,，;；]+/)).map(x=>String(x).trim()).filter(Boolean))];
  const rawTypes=input.recruitTypes??fallback.recruitTypes??recruitTypes.map(x=>x.id);
  const types=[...new Set((Array.isArray(rawTypes)?rawTypes:String(rawTypes).split(/[\n,，;；\s]+/)).map(x=>Number(String(x).trim())).filter(x=>recruitTypes.some(t=>t.id===x)))];
  if(enabled&&!careerJobIds.length&&!keywords.length&&!cities.length)throw Error('牛客岗位需要至少一个职位分类、城市或检索词，否则只会取到默认推荐流');
  const pageSize=integer(input.pageSize,1,maxPageSize,100);
  const maxJobs=input.maxJobs==null||input.maxJobs===''?null:integer(input.maxJobs,1,Number.MAX_SAFE_INTEGER);
  // 预算模式：显式给出 maxRequests 时必须尊重它。此前 automatic 会无视显式上限（例如传 1 被换成 260），
  // 小批量验收与限流演练都会失真；只有确实没给 maxRequests 时才走自动推算。
  const explicitBudget=input.maxRequests!=null&&input.maxRequests!=='';
  const automatic=input.requestBudgetMode==='automatic'?!explicitBudget:input.requestBudgetMode==null||input.requestBudgetMode==='';
  const planned=(careerJobIds.length*Math.max(1,types.length))+(keywords.length*Math.max(1,types.length))+cities.length;
  const maxRequests=explicitBudget?integer(input.maxRequests,1,200000,planned*30+200):integer(planned*30+200,1,200000);
  // 条件级保鲜期（小时）。0 = 关闭（保持历史语义：完成的条件的永久关闭）。
  // 背景：牛客每个条件跑完会被写成 completed:true，下一次轮次第 4 行直接「请求 0 次」返回，
  // 结果通道退化成一次性快照。实测（2026-10-26）只重置城市族 9 个条件再跑，
  // 首页/次页就有 211 条断点里没有的职位，一轮实收 56 条 —— 说明「已完成」不等于「没有新结果」。
  const refreshHours=Number(input.refreshHours ?? fallback.refreshHours ?? process.env.JOB_NOWCODER_REFRESH_HOURS ?? 0);
  return {enabled,roleKey,careerJobIds,cities,keywords,recruitTypes:types.length?types:[3],pageSize,maxJobs,maxRequests,requestBudgetMode:automatic?'automatic':'custom',lengthLimit:maxPageSize,refreshHours:Number.isFinite(refreshHours)&&refreshHours>0?refreshHours:0};
}
export function taskJobSettings(task){
  const input=task.nowcoderJobs||{},roleKey=input.roleKey||task.label||task.primaryKeyword||'';
  const keywords=Array.isArray(task.keywords)&&task.keywords.length?task.keywords:[task.primaryKeyword||task.label].filter(Boolean);
  const configured=Array.isArray(input.keywords)?input.keywords.length>0:typeof input.keywords==='string'&&input.keywords.trim().length>0;
  return nowcoderJobSettings({...input,roleKey,keywords:configured?input.keywords:keywords},{keywords,roleKey,enabled:input.enabled===true});
}
export function nowcoderJobPaths(outputDir){
  const directory=path.join(outputDir,'牛客岗位数据');
  // 明细用 JSON 数组而不是 JSONL：正文含真实换行，行式存储会让外部读取方截断。
  return {directory,checkpoint:path.join(directory,'nowcoder.jobs.checkpoint.json'),status:path.join(directory,'status.json'),records:path.join(directory,'岗位明细.json')};
}
export function normalizeNowcoderJob(record,{roleKey,careerJobId=null,recruitType=null,collectedAt=new Date().toISOString()}={}){
  const job=record?.data;
  // 推荐流偶尔混入非职位卡片（无 id），直接丢弃而不是伪造记录。
  if(!job||typeof job!=='object')return null;
  const id=job.id;
  if(!Number.isSafeInteger(id)||id<=0)return null;
  const ext=requirementText(job);
  const cities=cityList(job);
  const company=job.recommendInternCompany&&typeof job.recommendInternCompany==='object'?job.recommendInternCompany:{};
  const identity=Array.isArray(job.user?.identity)?job.user.identity.find(x=>x&&typeof x==='object')||{}:{};
  const type=Number(job.recruitType)||recruitType||0;
  const keys=String(job.jobKeys||'').split(/[,，]/).map(x=>x.trim()).filter(Boolean);
  const description=plain(ext.infos),requirement=plain(ext.requirements),strength=plain(ext.jobStrength);
  return {
    id:`nowcoder:job:${id}`,
    platform:'nowcoder',channel:'nowcoder',
    // 以下字段名与其他渠道一致，保证能直接并入 多平台岗位标准化汇总.csv 并参与去重。
    job_id:String(id),
    query_keyword:[roleKey,...keys.slice(0,2)].filter(Boolean).join(' | '),
    query_city:(String(job.jobCity||'').split(/[,，\s]+/).filter(Boolean)[0])||'',
    employment_type:(recruitTypes.find(x=>x.id===type)||{}).name||encoded.get(Number(job.encodedType))||'',
    tags:keys.join(' | '),
    skills:keys.join(' | '),
    job_description:`${plain(ext.infos)}${plain(ext.requirements)?`\n\n【任职要求】\n${plain(ext.requirements)}`:''}`.trim(),
    publish_time:date(job.createTime)||'',refresh_time:date(job.refreshTime)||'',deadline:date(job.deliverEnd)||'',
    company_url:Number.isSafeInteger(job.companyId)?`https://www.nowcoder.com/company/${job.companyId}`:'',
    access_level:'匿名表单接口（NOWPICK /u/job/square-search，POST x-www-form-urlencoded）',
    source_id:String(id),
    role_key:roleKey,
    job_name:String(job.jobName||'').trim(),
    company_name:String(company.companyShortName||company.companyName||identity.companyName||'').trim(),
    company_id:Number.isSafeInteger(job.companyId)?job.companyId:null,
    company_industry:String((company.industryTagNameList||[]).filter(Boolean).join('/')||job.industryName||'').trim(),
    company_scale:String(company.personScales||company.scaleTagName||'').trim(),
    company_financing:String(job.companyFinancing||'').trim(),
    boss_uid:Number.isSafeInteger(job.bossUid)?job.bossUid:null,
    boss_name:String(job.apiSimpleBossUser?.userAppellation||'').trim(),
    recruit_type:type,
    recruit_type_name:(recruitTypes.find(x=>x.id===type)||{}).name||'',
    campus_batch:String(job.graduationYear||'').trim(),
    career_job_id:Number.isSafeInteger(job.careerJobId)?job.careerJobId:(careerJobId||null),
    query_career_job_id:careerJobId||null,
    job_keys:keys,
    city:String(job.jobCity||'').trim(),
    city_list:cities,
    address:String(job.jobAddress||'').trim(),
    salary:salaryText(job),
    salary_min:number(job.salaryMin),salary_max:number(job.salaryMax),salary_month:number(job.salaryMonth),salary_type:Number(job.salaryType)||0,
    education:String(educationLevels.get(Number(job.eduLevel))||''),
    education_code:Number(job.eduLevel)||0,
    experience:String(workYearTypes.get(Number(job.workYearType))||''),
    experience_code:Number(job.workYearType)||0,
    encoded_type:String(encoded.get(Number(job.encodedType))||''),
    // 内容字段：ext 里的职位描述/要求是客户端展示正文，保留原文换行。
    description,requirement,job_strength:strength,
    content:`${description}${requirement?`\n\n【任职要求】\n${requirement}`:''}`.trim(),
    duration_days:number(job.durationDays),duration_months:number(job.durationMonths),
    feedback_days:number(job.feedbackDays),
    avg_process_rate:number(job.avgProcessRate),avg_process_days:number(job.avgProcessDay),avg_process_seconds:number(job.avgProcessSec),
    hot_job:job.hotJob===true||job.hot===true,big_chance:job.bigChance===true,
    status:Number(job.status)||0,
    job_url:`https://www.nowcoder.com/jobs/detail/${id}`,
    published_at:date(job.createTime),
    updated_at:date(job.updateTime),
    refreshed_at:date(job.refreshTime),
    deliver_begin:date(job.deliverBegin),deliver_end:date(job.deliverEnd),
    collected_at:collectedAt,
    crawl_query:{careerJobId:careerJobId||null,recruitType:recruitType||null,pageSource:5026},
  };
}
export function parseJobSearch(body,{expectPage=1}={}){
  if(!body||Number(body.code)!==0){
    const message=String(body?.msg||'未知响应').slice(0,160),code=Number(body?.code);
    const access=[999,101,401,403,429].includes(code)||/login|captcha|verify|登录|验证|频繁|限流|访问受限/i.test(message);
    throw failure(`牛客：${message}；不自动重试`,access?'access_blocked':'nowcoder_contract');
  }
  const data=body.data;
  if(!data||typeof data!=='object'||!Array.isArray(data.datas))throw failure('牛客岗位接口结构发生变化，停止并保留断点');
  const totalCount=Number(data.totalCount),totalPage=Number(data.totalPage),currentPage=Number(data.currentPage);
  if(!Number.isSafeInteger(totalCount)||totalCount<0||!Number.isSafeInteger(totalPage)||totalPage<0)throw failure('牛客岗位接口分页字段发生变化，停止并保留断点');
  return {records:data.datas,totalCount,totalPage,currentPage:Number.isSafeInteger(currentPage)?currentPage:expectPage};
}
export function deduplicateNowcoderJobs(rows){
  const groups=new Map();
  for(const row of rows){
    if(!groups.has(row.id))groups.set(row.id,[]);
    groups.get(row.id).push(row);
  }
  return [...groups.values()].map(group=>{
    // 同一条职位可能被多个分类/城市条件命中：合并抓取来源，保留内容最全的一份。
    const score=row=>(row.content||'').length;
    group.sort((a,b)=>score(b)-score(a)||String(b.updated_at||'').localeCompare(String(a.updated_at||'')));
    const merged={...group[0]};
    merged.crawl_queries=group.map(x=>x.crawl_query).filter(Boolean);
    merged.hit_count=group.length;
    return merged;
  });
}
async function readJson(file){
  try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export async function collectNowcoderJobs({taskId,outputDir,settings,request,onEvent=()=>{},shouldStop=()=>false}={}){
  const cfg=nowcoderJobSettings(settings),paths=nowcoderJobPaths(outputDir);
  if(!cfg.enabled)return {status:'disabled'};
  if(!taskId)throw Error('牛客岗位采集缺少任务ID');
  await fs.mkdir(paths.directory,{recursive:true});
  const combos=[];
  for(const type of cfg.recruitTypes){
    for(const id of cfg.careerJobIds)combos.push({key:`cat:${id}|type:${type}`,body:{careerJobId:String(id),recruitType:type},careerJobId:id,recruitType:type});
    for(const keyword of cfg.keywords)combos.push({key:`kw:${keyword}|type:${type}`,body:{query:keyword,recruitType:type},careerJobId:null,recruitType:type,keyword});
  }
  for(const city of cfg.cities)combos.push({key:`city:${city}|type:${cfg.recruitTypes[0]}`,body:{jobCity:city,recruitType:cfg.recruitTypes[0]},careerJobId:null,recruitType:cfg.recruitTypes[0],city});
  return withAccountLock(path.join(paths.directory,'collection.lock'),taskId,async()=>{
    let state=await readJson(paths.checkpoint);
    if(state&&state.task_id!==taskId)throw failure(`牛客岗位断点归属其他任务（断点 ${state.task_id}，本任务 ${taskId}）：请先归档或迁移该断点，避免把别的任务数据并入本任务`,'checkpoint_owner_mismatch');
    state=state||{task_id:taskId,role_key:cfg.roleKey,queries:{},requests:0,completed:false};
    const rows=new Map();
    // 落盘明细可能同时含历史顺序版本与去重前版本：载入时按 id 归并一次，
    // 否则同一岗位会以不同摘要重复出现在明细与汇总里。
    if(Array.isArray(state.rows))for(const row of state.rows){
      if(!row?.id)continue;
      const existing=rows.get(row.id);
      if(!existing||(existing.content||'').length<(row.content||'').length)rows.set(row.id,row);
    }
    let requests=0,phase='search',currentQuery='',reason='',stopped=false;
    const persist=async(status,extra={})=>{
      const listed=[...rows.values()];
      await writeJsonAtomic(paths.checkpoint,{...state,rows:listed,updated_at:new Date().toISOString()});
      const snapshot={task_id:taskId,pid:process.pid,enabled:true,status,phase,currentQuery,candidates:listed.length,
        pages:Object.values(state.queries).reduce((sum,q)=>sum+(q.pages||0),0),
        requests:state.requests,roundRequests:requests,reason,updated_at:new Date().toISOString(),settings:cfg,
        recoveryRetries:Number(state.recoveryRetries||0),recoverable:state.blocked?isTransientFailureCode(state.blocked.code):false,
        // terminal 决定渠道层是否把它写成跨轮阻塞：连通性/条件级/预算都只是本轮暂停，不能升级成渠道受阻。
        terminal:extra.terminal??(status==='blocked'),...extra};
      await writeJsonAtomic(paths.status,snapshot);
      return snapshot;
    };
    const recovered=isStaleTransientBlock(state.blocked)?{...state.blocked}:null;
    if(recovered){
      state={...state,blocked:null,recoveredAt:new Date().toISOString(),
        recoveries:[...(state.recoveries||[]),{code:recovered.code,message:recovered.message,blocked_at:recovered.at,at:new Date().toISOString()}].slice(-5),
        recoveryRetries:Number(state.recoveryRetries||0)+1};
      await persist('running');
      onEvent(`[牛客岗位] 连通性告警已过观察窗（${recovered.code}），自动重试并沿用现有断点`);
    }
    if(state.blocked){reason=state.blocked.message;return persist('blocked',{errorCode:state.blocked.code,recoverable:isTransientFailureCode(state.blocked.code)});}
    const http=request||createPoliteHttpClient({stateDir:process.env.JOB_HTTP_RATE_DIR||path.join(paths.directory,'shared_rate'),minimumIntervalMs:2500,jitterMs:700,attempts:2});
    const fetchPage=async(combo,page)=>{
      if(shouldStop())throw failure('已暂停','cancelled');
      if(state.requests>=cfg.maxRequests)throw failure('本轮牛客岗位请求预算已用完','request_budget');
      requests++;state.requests++;
      const body=new URLSearchParams({page:String(page),jobCity:String(combo.body.jobCity||''),careerJobId:String(combo.body.careerJobId||''),
        recruitType:String(combo.body.recruitType??3),pageSize:String(cfg.pageSize),recommend:'true',requestFrom:'0',pageSource:'5026'});
      if(combo.body.query)body.set('query',String(combo.body.query));
      const response=await http(base+searchPath,{method:'POST',body:body.toString(),headers:{
        'content-type':'application/x-www-form-urlencoded;charset=UTF-8',
        'accept':'application/json, text/plain, */*',
        origin:'https://www.nowcoder.com',referer}});
      if(!response.ok)throw failure(`牛客岗位 HTTP ${response.status}`,[401,403,429].includes(response.status)?'access_blocked':'http_error');
      let parsed;try{parsed=await response.json();}catch{throw failure('牛客岗位返回非JSON响应，停止采集','invalid_response');}
      return parseJobSearch(parsed,{expectPage:page});
    };
    const soak=async(records,combo)=>{
      const collectedAt=new Date().toISOString();let added=0;
      for(const record of records){
        const row=normalizeNowcoderJob(record,{roleKey:cfg.roleKey,careerJobId:combo.careerJobId,recruitType:combo.recruitType,collectedAt});
        if(!row)continue;
        const existing=rows.get(row.id);
        if(existing){
          // 多条件命中：只补全更完整的内容，避免旧摘要覆盖新正文。
          if((existing.content||'').length<(row.content||'').length)rows.set(row.id,{...row,hit_count:Number(existing.hit_count||1)+1});
          continue;
        }
        if(cfg.maxJobs!==null&&rows.size>=cfg.maxJobs)return added;
        rows.set(row.id,row);added++;
      }
      return added;
    };
    // 断点在先、明细在后：明细始终可从断点重建，因此可以先落断点再落明细。
    const flushRecords=async()=>{
      const listed=[...rows.values()].sort((a,b)=>a.id.localeCompare(b.id));
      await writeAtomic(paths.records,'\ufeff'+JSON.stringify(listed,null,2));
    };
    try{
      onEvent(`[牛客岗位] 表单接口 ${searchPath}：分类 ${cfg.careerJobIds.length} × 类型 ${cfg.recruitTypes.length} + 关键词 ${cfg.keywords.length} + 城市 ${cfg.cities.length}`);
      await persist('running');
      for(const combo of combos){
        if(cfg.maxJobs!==null&&rows.size>=cfg.maxJobs)break;
        currentQuery=combo.key;
        const q=state.queries[combo.key]||{nextPage:1,pages:0,completed:false,signatures:[]};
        state.queries[combo.key]=q;
        // 保鲜期到期即重开该条件：缓存只有「上次跑完」的时间戳，没有逐页 id 列表，
        // 所以重开只能从第 1 页重新看，由 soak() 去重兜住重复。这是设计好的代价。
        if(cfg.refreshHours>0&&q.completed&&q.completedAt){
          const ageMs=Date.now()-Date.parse(q.completedAt);
          if(Number.isFinite(ageMs)&&ageMs>=cfg.refreshHours*3600*1000){
            onEvent(`[牛客岗位] 条件保鲜期到期，重开：${combo.key}（上次跑完 ${q.completedAt}，已过 ${(ageMs/3600000).toFixed(1)} 小时）`);
            // 关键：signatures 必须按「本轮扫描」隔离。旧实现把上一轮整轮扫描的签名留在队列里，
            // 重开从第 1 页重扫时必然命中旧签名，被 :332 的护栏误判成 pagination_stalled 并停通道。
            // scanSeq 递增后旧签名自动失效，护栏只在本轮之内生效（真·分页失效仍会被抓住）。
            // 只保留最近两个扫描轮次的签名：既让 scanSeq 隔离生效，又不会切断 refFirst 所依赖的第 1 页记录。
            if(q.signatures.length>200){
              const keep=Array.isArray(q.signatures)?q.signatures.slice(-200):[];
              q.signatures=keep.filter(x=>x&&typeof x==='object');
            }
            q.scanSeq=(q.scanSeq||1)+1;
            q.nextPage=1;q.pages=0;q.completed=false;q.reason='refreshed';q.emptyPages=0;
          }
        }
        if(q.pending?.length){await soak(q.pending.map(x=>({data:x})),combo);q.pending=[];}
        while(!q.completed&&(cfg.maxJobs===null||rows.size<cfg.maxJobs)){
          phase='search';await persist('running');
          const data=await fetchPage(combo,q.nextPage);
          if(process.env.JOB_NOWCODER_VERBOSE==='1'){
            onEvent(`[牛客岗位·取证] ${combo.key} 请求第 ${q.nextPage} 页 → records=${data.records.length} totalCount=${data.totalCount} totalPage=${data.totalPage} scan=${q.scanSeq||1} pages=${q.pages} 已见签名=${(q.signatures||[]).filter(x=>x&&x.scan===(q.scanSeq||1)).length} refFirst=${q.refFirst?q.refFirst.slice(0,10):'null'} reason=${q.reason||'-'}`);
          }
          const ids=data.records.map(record=>Number(record?.data?.id)).filter(x=>Number.isSafeInteger(x)&&x>0);
          const signature=createHash('sha256').update(ids.slice().sort((a,b)=>a-b).join('|')).digest('hex');
          // TTL 重开的省流快路径：上一次完整扫描的第 1 页签名若与本页完全一致，说明该窗口内
          // 没有新岗位发布（列表按时间稳定排序），无需再翻全量页；只花 1 次请求即可复检并续期。
          // 签名不一致才算「有新内容」，走正常全量重扫。
          if(q.reason==='refreshed'&&q.refFirst&&ids.length&&signature===q.refFirst){
            onEvent(`[牛客岗位] ${combo.key} 重开复检：第 1 页与上次一致（共 ${data.totalCount} 条），无需重扫，直接续期`);
            q.pages=0;q.nextPage=1;
            q.signatures=q.signatures.filter(x=>x.scan!==(q.scanSeq||1)).slice(-1);
            q.signatures.push({scan:q.scanSeq||1,hash:signature});
            q.completed=true;q.reason='refresh_unchanged';
            q.total=data.totalCount;q.totalPage=data.totalPage;
            q.completedAt=new Date().toISOString();
            q.received=(q.received||0)+data.records.length;
            await persist('running');
            continue;
          }
          if(data.records.length&&ids.length===0)throw failure('本页无任何可用职位标识，停止并保留原始断点');
          const scanId=q.scanSeq||1;
          // 分页返回重复内容＝接口对同一条件不再推进（或窗口内无新增），属于「该条件跑完了」，
          // 不是整条通道的故障。旧实现直接 throw → 通道级 stopChannel，一个条件异常就把牛客整条
          // 通道掐停（实测只覆盖到第 6 个条件就被掐断）。改为条件级终止并留痕，通道继续跑完其余条件。
          if(ids.length&&q.signatures.some(x=>x.scan===scanId&&x.hash===signature)){
            onEvent(`[牛客岗位] ${combo.key} 分页重复（第 ${q.nextPage} 页与本轮已见页一致）：判定该条件已到页尾，条件级终止并继续后续条件`);
            q.completed=true;q.reason='pagination_repeated';
            q.completedAt=new Date().toISOString();
            q.repeatedPage=q.nextPage;
            await persist('running');
            break;
          }
          // 牛客对部分「关键词 + 招生类型」组合会返回空页（total=0、totalPage=0），这是该条件没有可访问
          // 结果的正常终止信号，不能当作分页失效而整通道阻塞。仍保留一次保护：连续空页才判定异常，
          // 避免接口真的退化成永远返回空页。
          if(!data.records.length){
            q.emptyPages=(q.emptyPages||0)+1;
            if(q.emptyPages>=2&&data.totalPage>0)throw failure('连续空页且总页数未结束，停止当前牛客岗位条件','pagination_stalled');
            q.completed=true;
            q.reason='empty_page';
            q.completedAt=new Date().toISOString();
            q.total=data.totalCount;q.totalPage=data.totalPage;
            q.refFirst=null;q.refAt=q.completedAt;
            await persist('running');
            break;
          }
          q.emptyPages=0;
          q.signatures.push({scan:scanId,hash:signature});q.pages++;q.nextPage++;q.total=data.totalCount;q.totalPage=data.totalPage;
          const added=await soak(data.records,combo);
          q.completed=!data.records.length||q.nextPage>data.totalPage||added===0&&data.records.length===0;
          if(q.completed){
            q.completedAt=new Date().toISOString();
            // 记下本轮扫描第 1 页的 id 签名：下一轮保鲜期重开时只花 1 次请求即可判定「窗口内有无新岗位」。
            const first=q.signatures.find(x=>x&&x.scan===scanId);
            q.refFirst=first?.hash||signature;q.refAt=q.completedAt;
          }
          q.received=(q.received||0)+data.records.length;
          await persist('running');
          await flushRecords();
        }
      }
      const complete=combos.every(combo=>state.queries[combo.key]?.completed);
      phase='done';
      const hit=rows.size;
      reason=complete?'accessible_results_finished':(cfg.maxJobs!==null&&hit>=cfg.maxJobs?'post_target_reached':'combo_target_reached');
      onEvent(`[牛客岗位] ${complete?'全部条件的可访问结果已处理':'已达到采集目标'}；去重后 ${hit} 条，请求 ${requests} 次`);
      const result=await persist(complete?'completed':'budget_paused',{count:hit});
      await flushRecords();
      return result;
    }catch(error){
      stopped=true;reason=error.message;
      const budget=['request_budget','cancelled'].includes(error.code);
      const errorCode=channelErrorDiagnostic([error]).code;
      // 非渠道级失败（预算用尽 / 连通性故障 / 条件级让位）只写观察窗与状态文件，本轮交回上层继续；
      // 其余失败必须带上 stopChannel 抛出，否则渠道层只看到 undefined，清单里会留下「无错却无数据」的假完成。
      const nonTerminal=budget||isTransientFailureCode(errorCode)||Boolean(error.conditionScoped)||isConditionScopedStop(error);
      if(!nonTerminal)state.blocked={code:errorCode,message:error.message,at:new Date().toISOString(),recoverable:false};
      const result=await persist(budget?'budget_paused':'blocked',{errorCode,recoverable:nonTerminal&&!budget,terminal:!nonTerminal});
      await flushRecords().catch(()=>{});
      onEvent(`[牛客岗位] 已停止：${error.message}；已保存数据与断点保留`);
      if(['ENOSPC','EIO','EACCES','EPERM','RESOURCE_PRESSURE'].includes(error.code))throw error;
      if(nonTerminal)return result;
      throw Object.assign(error,{code:errorCode,stopChannel:true,conditionScoped:false});
    }finally{if(!stopped)phase='idle';}
  },{interval:1000,shouldStop});
}