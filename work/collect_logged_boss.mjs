import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {chromium} from 'playwright';
import {openContext} from './browser_public_channels.mjs';
import {bossSearchUrl,bossPageGuard,extractBossCards,extractBossDetail,bossCsv,bossBlockedReason} from './boss_page_adapter.mjs';
const output=path.resolve(process.argv[2]||'.'),configFile=process.argv[3];
if(!configFile)throw Error('用法：collect_logged_boss.mjs <输出目录> <BOSS配置.json>');
const config=JSON.parse(await fs.readFile(configFile,'utf8'));
const keywords=config.keywords||[],cities=config.cities||[];
if(!keywords.length||!cities.length)throw Error('BOSS必须配置关键词和城市');
for(const keyword of keywords)for(const city of cities)bossSearchUrl(keyword,city.name);
const checkpointDir=path.join(output,'断点数据','BOSS直聘');
const checkpoint=path.join(checkpointDir,'state.json'),csv=path.join(output,'boss_标准化数据.csv');
const fingerprint=crypto.createHash('sha256').update(JSON.stringify({keywords,cities})).digest('hex');
let state={fingerprint,rows:[],completedCombos:[],status:'ready'};
try{state=JSON.parse(await fs.readFile(checkpoint,'utf8'));if(state.fingerprint!==fingerprint)throw Error('BOSS断点查询配置不一致，请使用新任务目录');}catch(e){if(e.code!=='ENOENT')throw e;try{await fs.access(csv);throw Error('已有BOSS数据但缺少断点，停止以免覆盖，请人工核对');}catch(check){if(check.code!=='ENOENT')throw check;}}
await fs.mkdir(checkpointDir,{recursive:true});
async function save(){state.updatedAt=new Date().toISOString();await fs.writeFile(checkpoint+'.tmp',JSON.stringify(state,null,2));await fs.rename(checkpoint+'.tmp',checkpoint);await fs.writeFile(csv+'.tmp',bossCsv(state.rows));await fs.rename(csv+'.tmp',csv);}
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
  for(let pageNo=1;pageNo<=Math.min(10,Math.max(1,Number(config.maxPagesPerCombo)||3));pageNo++){
   await guard(list);const cards=await extractBossCards(list);
   if(!cards.length){const empty=await list.locator('.job-empty, .empty-result').first().isVisible().catch(()=>false);if(!empty)throw Error('BOSS列表结构未识别或尚未加载，已停止；请人工核对登录和页面结构');break;}
   for(const card of cards){
    const id=new URL(card.url).pathname.match(/\/job_detail\/([\w-]+)\.html/)[1];if(known.has(id))continue;
    if(state.rows.length>=Math.min(5000,Math.max(1,Number(config.maxRows)||100)))break;
    state.current={keyword,city:city.name,page:pageNo,phase:'岗位详情',job:card.title,url:card.url};await save();
    await pause();await detail.goto(card.url,{waitUntil:'domcontentloaded',timeout:60000});await pause();await guard(detail);
    const row=await extractBossDetail(detail,card,keyword,city.name);state.rows.push(row);known.add(id);await save();console.log('BOSS 已保存 '+state.rows.length+' 条：'+row.job_name);
   }
   if(state.rows.length>=Math.min(5000,Math.max(1,Number(config.maxRows)||100)))break;
   const next=list.locator('.options-pages a.next:not(.disabled), .pagination .next:not(.disabled)').first();
   if(!await next.isVisible().catch(()=>false)){
    if(pageNo===1)console.log('BOSS没有识别到可用下一页，本组合仅采集已展示列表，不推测翻页接口');break;
   }
   await pause();await next.click();await pause();await guard(list);
  }
  // A row cap is not evidence that the whole search combination is exhausted.
  if(state.rows.length>=Math.min(5000,Math.max(1,Number(config.maxRows)||100)))break collection;
  state.completedCombos.push(key);await save();
 }
 state.status='completed';state.message='已完成配置范围内页面采集，不保证达到任务目标条数';await save();console.log(state.message+'；共'+state.rows.length+'条');
}catch(e){state.status='paused';state.message=e.message;await save();console.error('BOSS采集已暂停：'+e.message+'；请人工处理后从BOSS阶段恢复，不自动重试验证。');process.exitCode=42;}
finally{await context?.close();}
