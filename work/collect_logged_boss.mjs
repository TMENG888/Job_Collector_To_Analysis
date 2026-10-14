import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {chromium} from 'playwright';
import {openContext} from './browser_public_channels.mjs';
import {writeAtomic,writeJsonAtomic} from './collector_storage.mjs';
import {collectionExitCode} from './collection_policy.mjs';
import {collectionChannelAvailable} from './channel_availability.mjs';
import {otherChannelValidCount,validJobRecord} from './task_collection_target.mjs';
import {bossSearchUrl,bossPageGuard,extractBossCards,extractBossDetail,bossCsv,bossBlockedReason} from './boss_page_adapter.mjs';
const output=path.resolve(process.argv[2]||'.'),configFile=process.argv[3];
if(!collectionChannelAvailable('boss')){
 console.log('BOSS采集适配未通过验收，渠道已撤下：跳过网站请求，已有数据和断点保留。');
 process.exit(0);
}
if(!configFile)throw Error('用法：collect_logged_boss.mjs <输出目录> <BOSS配置.json>');
const config=JSON.parse(await fs.readFile(configFile,'utf8'));
const taskTarget=Number(config.taskTargetRows||0);
const otherValid=taskTarget?await otherChannelValidCount(output,'boss',process.env.JOB_COLLECTOR_TASK_ID||config.task_id):0;
const remaining=taskTarget?Math.max(0,taskTarget-otherValid):Infinity;
const keywords=config.keywords||[],cities=config.cities||[];
if(!keywords.length||!cities.length)throw Error('BOSS必须配置关键词和城市');
for(const keyword of keywords)for(const city of cities)bossSearchUrl(keyword,city.name);
const checkpointDir=path.join(output,'断点数据','BOSS直聘');
const checkpoint=path.join(checkpointDir,'state.json'),csv=path.join(output,'boss_标准化数据.csv');
const fingerprint=crypto.createHash('sha256').update(JSON.stringify({keywords,cities})).digest('hex');
let state={fingerprint,rows:[],completedCombos:[],status:'ready'};
try{state=JSON.parse(await fs.readFile(checkpoint,'utf8'));if(state.fingerprint!==fingerprint)throw Error('BOSS断点查询配置不一致，请使用新任务目录');}catch(e){if(e.code!=='ENOENT')throw e;try{await fs.access(csv);throw Error('已有BOSS数据但缺少断点，停止以免覆盖，请人工核对');}catch(check){if(check.code!=='ENOENT')throw check;}}
await fs.mkdir(checkpointDir,{recursive:true});
const outputRows=()=>taskTarget?state.rows.filter(validJobRecord).slice(0,remaining):state.rows;
const capReached=()=>outputRows().length>=Math.min(remaining,Math.min(5000,Math.max(1,Number(config.maxRows)||100)));
async function save(){state.task_id=process.env.JOB_COLLECTOR_TASK_ID||config.task_id||'';state.updatedAt=new Date().toISOString();state.outputRows=outputRows().length;state.otherValidRows=otherValid;await writeJsonAtomic(checkpoint,state);await writeAtomic(csv,bossCsv(outputRows()));}
if(taskTarget&&remaining===0){state.status='target_reached';await save();console.log('本任务有效数据已达到目标，不再打开 BOSS 搜索页');process.exit(0);}
const profile=path.join(process.env.LOCALAPPDATA||os.tmpdir(),'CodexJobCollectorProfilesV2','boss');
let context;
const pause=()=>new Promise(resolve=>setTimeout(resolve,Math.max(5000,Number(config.minimumIntervalMs)||6000)+Math.floor(Math.random()*Math.max(0,Number(config.jitterMs)||2000))));
try{
 context=await openContext('boss');
 let responseBlock='';context.on('response',response=>{if(new URL(response.url()).hostname.endsWith('.zhipin.com')&&[403,429].includes(response.status()))responseBlock=bossBlockedReason({status:response.status()});});
 const list=context.pages()[0]||await context.newPage(),detail=await context.newPage();
 async function guard(page){if(responseBlock)throw Object.assign(Error(responseBlock),{code:'BOSS_USER_ACTION'});await bossPageGuard(page);}
 const known=new Set(state.rows.map(r=>r.job_id));
 state.status='running';await save();
 collection: for(const keyword of keywords)for(const city of cities){
  const key=JSON.stringify([keyword,city.name]);if(state.completedCombos.includes(key))continue;
  state.current={keyword,city:city.name,phase:'职位列表'};await save();
  await list.goto(bossSearchUrl(keyword,city.name),{waitUntil:'domcontentloaded',timeout:60000});await pause();await guard(list);
  let comboExhausted=false;
  for(let pageNo=1;pageNo<=Math.min(10,Math.max(1,Number(config.maxPagesPerCombo)||3));pageNo++){
   await guard(list);const cards=await extractBossCards(list);
   if(!cards.length){const empty=await list.locator('.job-empty, .empty-result').first().isVisible().catch(()=>false);if(!empty)throw Error('BOSS列表结构未识别或尚未加载，已停止；请人工核对登录和页面结构');comboExhausted=true;break;}
   for(const card of cards){
    const id=new URL(card.url).pathname.match(/\/job_detail\/([\w-]+)\.html/)[1];if(known.has(id))continue;
    if(capReached())break;
    state.current={keyword,city:city.name,page:pageNo,phase:'岗位详情',job:card.title,url:card.url};await save();
    await pause();await detail.goto(card.url,{waitUntil:'domcontentloaded',timeout:60000});await pause();await guard(detail);
    const row=await extractBossDetail(detail,card,keyword,city.name);state.rows.push(row);known.add(id);await save();console.log('BOSS 已保存 '+state.rows.length+' 条：'+row.job_name);
   }
   if(capReached())break;
   const next=list.locator('.options-pages a.next:not(.disabled), .pagination .next:not(.disabled)').first();
   if(!await next.isVisible().catch(()=>false)){
    comboExhausted=true;
    if(pageNo===1)console.log('BOSS没有识别到可用下一页，本组合仅采集已展示列表，不推测翻页接口');break;
   }
   await pause();await next.click();await pause();await guard(list);
  }
  // A row cap is not evidence that the whole search combination is exhausted.
  if(capReached())break collection;
  if(comboExhausted)state.completedCombos.push(key);
  else console.log('BOSS组合达到配置页数上限，未标记穷尽：'+keyword+'/'+city.name);
  await save();
 }
 state.status='completed';state.message='已完成配置范围内页面采集，不保证达到任务目标条数';await save();console.log(state.message+'；共'+state.rows.length+'条');
}catch(e){state.status='paused';state.message=e.message;state.errorCode=e.code||'collection_error';process.exitCode=collectionExitCode(e);await save().catch(error=>{console.error(error.message);process.exitCode=42;});console.error('BOSS渠道受阻：'+e.message+'；断点和数据已保留，人工处理后可恢复，不自动重试验证。');}
finally{await context?.close();}
