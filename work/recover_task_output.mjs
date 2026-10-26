import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {writeJsonAtomic} from './collector_storage.mjs';
import {writeNativeChannelRows,nativeTaskCounts} from './collector_native_sink.mjs';
import {checkpointRows} from './unified_collection_store.mjs';
import {normalize51Records} from './job51/normalizer.mjs';
import {snapshotTaskOutput,defaultTaskBackupRoot} from './task_output_backup.mjs';

const text=value=>String(value||'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').trim();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=file=>fs.readFile(file,'utf8').then(JSON.parse);
const join=value=>Array.isArray(value)?value.map(v=>typeof v==='object'?v.tag||v.tagName||v.itemValue||v.value||v.name||'':v).filter(Boolean).join(' | '):String(value||'');

export function normalizeRecoveredRaw(data,name){
  const keyword=data.keyword||'',city=data.city?.name||'',total=data.total||data.first?.total||0;
  if(name.startsWith('shixiseng_'))return checkpointRows(data,name);
  if(name.startsWith('jobonline_')||name.startsWith('liepin_')||name.startsWith('猎聘_'))return data.records||[];
  if(name.startsWith('job51_')||name.startsWith('前程无忧_'))return normalize51Records(data.records||[],keyword,data.city||{name:''},total,{htmlToText:text,collectedAt:data.collected_at||''});
  if(name.startsWith('智联招聘_')||data.completion_reason!==undefined)return (data.records||[]).map(row=>{
    const detail=row.jobDetailData?.position||{},staff=row.jobDetailData?.staff||row.staffCard||{},location=detail.workLocation||{};
    return {platform:'智联招聘',query_keyword:keyword,query_city:city,job_id:row.number||String(row.jobId||''),job_name:row.name,company_id:row.companyNumber,company_name:row.companyName,salary:row.salary60||row.salaryReal,city:row.workCity,district:row.cityDistrict,experience:row.workingExp,education:row.education,employment_type:row.workType,company_nature:row.propertyName||row.property,company_size:row.companySize,industry:row.industryName,publish_time:row.publishTime,refresh_time:detail.date?.positionUpdateTime||detail.date?.positionUpdateTimeText||'',deadline:detail.date?.dateEnd||'',tags:join([...(row.showSkillTags||[]),...(row.welfareLabel||[])]),skills:join([...(row.jobSkillTags||[]),...(row.skillLabel||[]),...(row.jobKeyword?.keywords||[])]),job_description:text(detail.desc?.description||row.jobDescription||''),address:location.workAddress||location.address||'',recruiter_name:staff.staffName||'',recruiter_title:staff.hrJob||'',job_url:row.positionUrl||row.positionURL,company_url:row.companyUrl,source_total:total,access_level:'原始数据恢复（未重新请求网站）',collected_at:data.collected_at||''};
  });
  if(name.startsWith('国聘_')||name.startsWith('iguopin_'))return (data.records||[]).map(row=>({platform:'国聘',query_keyword:keyword,query_city:city,job_id:String(row.job_id||''),job_name:row.job_name,company_id:row.company_id,company_name:row.company_name,salary:row.is_negotiable?'面议':`${row.min_wage||''}-${row.max_wage||''}${row.wage_unit_cn||''}`,city:(row.district_list||[]).map(v=>v.area_cn).join(' | '),experience:row.experience_cn,education:row.education_cn,employment_type:row.recruitment_type_cn||row.nature_cn,company_nature:row.company_info?.nature_cn,company_size:row.company_info?.scale_cn,industry:row.company_info?.industry_cn,publish_time:row.start_time,refresh_time:row.refresh_time||row.update_time,deadline:row.end_time,tags:join(row.job_custom_tags_cn),skills:join(row.major_cn),job_description:text(row.contents),address:(row.company_info?.district_list||[]).map(v=>v.address).filter(Boolean).join(' | '),job_url:`https://www.iguopin.com/job/detail?id=${row.job_id}`,source_total:total}));
  if(name.startsWith('中国公共招聘网_'))return (data.records||[]).map(row=>({platform:'公共招聘网',query_keyword:keyword,query_city:city,job_id:String(row.acb200||''),job_name:row.aca112,company_id:String(row.aab001||''),company_name:row.aab004,salary:row.acb241||row.acb242?`${row.acb241||''}-${row.acb242||''} 元/月`:'',city:row.area_||row.aab302,experience:row.acb240,education:row.acb239,employment_type:row.acb228,industry:row.aca111_,job_description:text(row.acb214||row.acb213||row.job_description||''),source_total:total}));
  return [];
}

export async function recoverTaskOutput(task,{dataDir,backupRoot=defaultTaskBackupRoot(),apply=false}={}){
  if(!dataDir)throw new Error('恢复必须提供任务注册目录');
  const registered=(await read(path.join(dataDir,'tasks.json'))).find(t=>t.id===task.id);
  if(!registered||path.resolve(registered.outputDir)!==path.resolve(task.outputDir)||registered.label!==task.label)throw new Error('恢复路径必须与控制台任务注册记录完全一致');
  if(['running','stopping'].includes(registered.status))throw new Error('恢复前必须暂停任务');
  if(path.basename(path.resolve(task.outputDir))!==task.id||path.basename(path.dirname(path.resolve(task.outputDir)))!=='任务数据')throw new Error('拒绝恢复非独立任务目录');
  const existingOwner=await read(path.join(task.outputDir,'任务归属.json')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(existingOwner&&existingOwner.task_id!==task.id)throw new Error('现有目录属于其他任务');
  const profile=await read(task.profilePath);if(profile.task_id!==task.id)throw new Error('任务配置归属不符');
  const files=[];async function scan(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())throw new Error('原目录含链接，拒绝恢复');const file=path.join(dir,entry.name);if(entry.isDirectory())await scan(file);else files.push({file,relative:path.relative(task.outputDir,file),bytes:await fs.readFile(file)});}}
  await scan(task.outputDir);
  const evidence=[];let scoped=0;
  for(const file of files.filter(f=>/^(断点数据|原始数据)[\\/].*\.json$/.test(f.relative)&&!f.relative.endsWith('.diagnostic.json'))){const data=JSON.parse(file.bytes.toString('utf8'));if(data.task_id&&data.task_id!==task.id)throw new Error(`混入其他任务：${file.relative}`);if(data.task_id===task.id)scoped++;if(data.keyword&&!task.keywords.includes(data.keyword))throw new Error(`关键词不符：${file.relative}`);evidence.push({...file,data});}
  if(!scoped)throw new Error('缺少可验证任务 ID 的残留证据，禁止凭空补建归属');
  const knowledge=new DatabaseSync(path.join(dataDir,'knowledge','岗位知识库.sqlite'),{readOnly:true});let oldRows;
  try{const source=knowledge.prepare('SELECT * FROM tasks WHERE task_id=?').get(task.id);if(!source||path.resolve(source.output_dir)!==path.resolve(task.outputDir)||source.label!==task.label)throw new Error('知识库与任务注册信息不一致');oldRows=knowledge.prepare('SELECT j.raw FROM jobs j JOIN memberships m ON m.job_key=j.job_key WHERE m.task_id=?').all(task.id).map(row=>JSON.parse(row.raw));}finally{knowledge.close();}
  const rows=[...oldRows];
  for(const file of evidence){
    // Older Zhaopin files lack task_id. Accept only matching raw/checkpoint pairs
    // inside this registered task, with exactly equal records and query scope.
    if(!file.data.task_id){const paired=evidence.find(other=>other!==file&&other.data.keyword===file.data.keyword&&other.data.city?.name===file.data.city?.name&&hash(JSON.stringify(other.data.records||[]))===hash(JSON.stringify(file.data.records||[]))&&other.relative.startsWith(file.relative.startsWith('断点数据')?'原始数据':'断点数据'));if(!paired||!file.data.keyword||!task.keywords.includes(file.data.keyword)||!task.cities.includes(file.data.city?.name)||!file.relative.includes('智联招聘'))throw new Error(`无归属的文件证据不足：${file.relative}`);}
    rows.push(...normalizeRecoveredRaw(file.data,path.basename(file.file)));
  }
  for(const row of rows)if(row.task_id&&row.task_id!==task.id)throw new Error('恢复记录混入其他任务');
  const keys=new Set(rows.filter(row=>row.platform&&row.job_id).map(row=>`${row.platform}\0${row.job_id}`));
  const report={task_id:task.id,source:task.outputDir,historicalRows:oldRows.length,evidenceFiles:evidence.length,expectedUniqueRows:keys.size,apply,networkRequests:0,inventedCheckpoints:false};
  if(!apply)return report;
  const evidenceDirectory=path.join(path.dirname(path.resolve(backupRoot)),'recovery-evidence',task.id,new Date().toISOString().replace(/[:.]/g,'-'));
  if(path.resolve(evidenceDirectory).startsWith(path.resolve(task.outputDir)+path.sep))throw new Error('证据备份不能放在原目录内');
  await fs.mkdir(evidenceDirectory,{recursive:true});
  for(const file of files){const destination=path.join(evidenceDirectory,'original',file.relative);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,file.bytes,{flag:'wx'});}
  await fs.writeFile(path.join(evidenceDirectory,'历史知识库记录.json'),JSON.stringify(oldRows),{flag:'wx'});
  await fs.writeFile(path.join(evidenceDirectory,'恢复前清单.json'),JSON.stringify({...report,files:files.map(file=>({file:file.relative,sha256:hash(file.bytes),bytes:file.bytes.length})),task:registered},null,2),{flag:'wx'});
  await writeJsonAtomic(path.join(task.outputDir,'任务归属.json'),{task_id:task.id,label:task.label,backup_root:path.resolve(backupRoot),recovered_at:new Date().toISOString(),recovery_evidence:evidenceDirectory});
  await fs.copyFile(task.profilePath,path.join(task.outputDir,'岗位配置.json'));
  await snapshotTaskOutput(task,{root:backupRoot});
  await writeNativeChannelRows(task.outputDir,task.id,rows.map(row=>({...row,task_id:task.id})));
  const counts=await nativeTaskCounts(task.outputDir,task.id);
  await snapshotTaskOutput(task,{root:backupRoot});
  const completed={...report,evidenceDirectory,...counts};await writeJsonAtomic(path.join(task.outputDir,'目录恢复报告.json'),completed);
  return completed;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),dataDir=path.resolve(args[0]||'ui_data'),id=args[1];
  const task=(await read(path.join(dataDir,'tasks.json'))).find(task=>task.id===id);if(!task)throw new Error('任务不存在');
  console.log(JSON.stringify(await recoverTaskOutput(task,{dataDir,apply:args.includes('--apply')}),null,2));
}
