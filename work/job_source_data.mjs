import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';

const shortFields=['platform','job_id','job_name','company_name','company_id','salary','city','district','experience','education','employment_type','industry','company_size','company_nature','query_keyword','query_city','publish_time','refresh_time','deadline','collected_at','tags','skills','job_url','company_url','address','access_level','detail_status','acquisition_mode'];
const integer=(value,fallback,max)=>{if(value==null||value==='')return fallback;const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>max)throw Error('分页参数无效');return n;};
function options(input={}){
  const result={taskId:String(input.taskId||'all'),platform:String(input.platform||'all'),q:String(input.q||'').trim(),page:integer(input.page,1,10000000),pageSize:integer(input.pageSize,50,100)};
  if(result.taskId.length>200||result.platform.length>80||result.q.length>120)throw Error('源数据筛选参数过长');
  return result;
}
function openTask(task){
  const db=new DatabaseSync(path.join(task.outputDir,'统一采集数据.sqlite'),{readOnly:true});
  try{db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500; BEGIN');
    if(db.prepare('SELECT task_id FROM metadata').get()?.task_id!==task.id)throw Error('任务数据库归属不一致');
    return db;
  }catch(error){db.close();throw error;}
}
function condition(scope){
  const where=[],params=[];
  if(scope.platform!=='all'){where.push('platform=?');params.push(scope.platform);}
  if(scope.q){
    const like='%'+scope.q.replace(/[\\%_]/g,'\\$&')+'%';
    where.push("(job_id LIKE ? ESCAPE '\\' OR "+['job_name','company_name','city','query_keyword','job_description'].map(field=>`CAST(json_extract(data,'$.${field}') AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ')+')');
    params.push(...Array(6).fill(like));
  }
  return {sql:where.length?' WHERE '+where.join(' AND '):'',params};
}
export function querySourceRows(tasks,input={}){
  const scope=options(input),active=tasks.filter(t=>!t.archived&&t.id&&t.outputDir);
  if(scope.taskId!=='all'&&!active.some(t=>t.id===scope.taskId))throw Error('采集任务不存在或已归档');
  const warnings=[],catalog=[],selected=[],platforms=new Map(),filter=condition(scope);
  const handles=[];
  try{
    for(const task of active){
      let db;
      const entry={id:task.id,label:task.label||task.id,rows:null,available:false};catalog.push(entry);
      try{db=openTask(task);handles.push(db);const groups=db.prepare('SELECT platform,COUNT(*) AS n FROM jobs GROUP BY platform').all();
        const total=groups.reduce((sum,p)=>sum+Number(p.n),0);entry.rows=total;entry.available=true;
        if(scope.taskId!=='all'&&task.id!==scope.taskId)continue;
        for(const group of groups)platforms.set(group.platform,(platforms.get(group.platform)||0)+Number(group.n));
        const count=scope.q||scope.platform!=='all'?Number(db.prepare('SELECT COUNT(*) AS n FROM jobs'+filter.sql).get(...filter.params).n):total;
        selected.push({task,db,count});
      }catch(error){
        // Missing legacy/native stores stay visible in the task selector. Never
        // create an empty replacement database or substitute derived KB rows.
        entry.rows=null;entry.available=false;
        if(scope.taskId==='all'||scope.taskId===task.id)warnings.push(`${task.label||task.id}：采集库暂不可读或归属未通过核对，未计入本次表格`);
      }
    }
    const total=selected.reduce((sum,item)=>sum+item.count,0),pages=Math.max(1,Math.ceil(total/scope.pageSize));scope.page=Math.min(scope.page,pages);
    let skip=(scope.page-1)*scope.pageSize,remaining=scope.pageSize;const rows=[];
    for(const {task,db,count} of selected){
      if(!remaining)break;if(skip>=count){skip-=count;continue;}
      const records=db.prepare('SELECT platform,job_id,data FROM jobs'+filter.sql+' ORDER BY platform,job_id LIMIT ? OFFSET ?').all(...filter.params,remaining,skip);
      for(const record of records){const raw=JSON.parse(record.data),body=String(raw.job_description??'');
        rows.push({taskId:task.id,taskLabel:task.label||task.id,platform:record.platform,jobId:record.job_id,
          fields:Object.fromEntries(shortFields.filter(key=>Object.hasOwn(raw,key)).map(key=>[key,raw[key]])),descriptionPreview:body.slice(0,180),descriptionLength:body.length});
      }
      remaining-=records.length;skip=0;
    }
    return {scope,total,pages,rows,tasks:catalog,platforms:[...platforms].map(([platform,rows])=>({platform,rows})).sort((a,b)=>b.rows-a.rows),warnings,
      checkedAt:new Date().toISOString(),source:'task-native-sqlite',countPolicy:'同一任务内按平台＋岗位ID合并；跨任务分别展示。字段为采集入库时保存的值，不使用洞察标签或薪资折算结果。'};
  }finally{for(const db of handles)db.close();}
}
export function querySourceDetail(tasks,input={}){
  const task=tasks.find(t=>t.id===input.taskId&&!t.archived&&t.outputDir);
  if(!task||typeof input.platform!=='string'||typeof input.jobId!=='string'||input.jobId.length>500||input.platform.length>80)throw Error('岗位记录参数无效');
  const db=openTask(task);try{
    const record=db.prepare('SELECT data FROM jobs WHERE platform=? AND job_id=?').get(input.platform,input.jobId);
    if(!record)throw Error('采集库中没有这条岗位记录');
    return {taskId:task.id,taskLabel:task.label||task.id,raw:JSON.parse(record.data)};
  }finally{db.close();}
}
export function createSourceDataService(dataDir){
  let queue=Promise.resolve();
  function run(kind,input){
    const action=async()=>{
      let tasks;try{tasks=JSON.parse(await fs.readFile(path.join(dataDir,'tasks.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;tasks=[];}
      if(!Array.isArray(tasks))throw Error('采集任务目录格式无效');
      const selected=tasks.filter(t=>!t.archived).map(({id,label,outputDir,archived})=>({id,label,outputDir,archived}));
      return new Promise((resolve,reject)=>{
        const worker=new Worker(new URL(import.meta.url),{workerData:{kind,input,tasks:selected}});let settled=false;
        const timer=setTimeout(()=>{settled=true;void worker.terminate();reject(Error('源数据查询超时，请缩小任务或平台范围'));},45000);
        worker.once('message',message=>{settled=true;clearTimeout(timer);message.ok?resolve(message.result):reject(Error(message.error));});
        worker.once('error',error=>{settled=true;clearTimeout(timer);reject(error);});
        worker.once('exit',()=>{clearTimeout(timer);if(!settled)reject(Error('源数据查询中断，请重试'));});
      });
    };
    const result=queue.then(action);queue=result.catch(()=>{});return result;
  }
  return {list:input=>run('list',input),detail:input=>run('detail',input)};
}
if(!isMainThread&&workerData?.tasks){
  try{const result=workerData.kind==='detail'?querySourceDetail(workerData.tasks,workerData.input):querySourceRows(workerData.tasks,workerData.input);parentPort.postMessage({ok:true,result});}
  catch(error){parentPort.postMessage({ok:false,error:String(error.message).slice(0,250)});}
}
