import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {assertCollectorResources} from './collector_resources.mjs';
import {writeJsonAtomic} from './collector_storage.mjs';
import {connectManagedContext} from './managed_browser.mjs';

const sleep = ms => new Promise(r=>setTimeout(r,ms));
export class ChannelError extends Error {
  constructor(message, code='layout_changed') { super(message); this.code=code; this.stopChannel=true; }
}
export function blockedReason(text) {
  if (/访问验证|请按住滑块|拖动到最右边|人机验证|安全验证|验证码/.test(text)) return '检测到网站安全验证，请通过平台登录入口人工完成验证后再续采；不会自动处理滑块';
  if (/登录后.{0,8}(查看|搜索)|请先登录|登录已失效|账号.{0,8}(异常|保护|限制)/.test(text)) return '登录或账号状态需要人工处理，请重新登录后续采';
  return '';
}
async function guard(page) {
  const visible=page.locator('#WAF_NC_WRAPPER, .aliyunCaptcha-sliding-body, .nc-container, .geetest_panel, .verify-wrap, .captcha-dialog').filter({visible:true});
  const challengeText=(await visible.allInnerTexts()).join('\n');
  const text=await page.locator('body').innerText({timeout:2000}).catch(()=>'');
  // Generic words in a JD (e.g. "验证码开发") are not evidence of a challenge.
  const prompt=/请按住滑块|拖动到最右边|请进行如下验证|请先登录|登录后.{0,8}(查看|搜索)|登录已失效|账号.{0,8}(异常|保护|限制)/.test(text)?text:'';
  const reason = blockedReason(challengeText||prompt);
  if(reason) throw new ChannelError(reason,'verification_required');
}
export async function openContext(key, settings) {
  await assertCollectorResources();
  return connectManagedContext(key);
}
async function readCheckpoint(file) { try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;} }
async function saveCheckpoint(file,data) {
  await writeJsonAtomic(file,data);
}
async function evidence(page,file,error) {
  const details={code:error.code||'navigation_error',message:error.message,url:page.url(),at:new Date().toISOString(),pageText:(await page.locator('body').innerText().catch(()=>'')).slice(0,2000)};
  await fs.writeFile(file+'.diagnostic.json',JSON.stringify(details,null,2),'utf8');
  await page.screenshot({path:file+'.png'}).catch(()=>{});
}
export function parse51Payload(body) {
  const job=body?.resultbody?.job;
  if (!job || !Array.isArray(job.items)) throw new ChannelError('前程无忧响应无有效岗位列表：可能需要登录、验证或接口结构已变更','invalid_response');
  return {items:job.items,total:Number(job.totalCount??job.totalcount??job.items.length)};
}
export async function collect51Records(keyword,city,{checkpointPath,request={},maxPages=100,contextFactory=openContext}) {
  const saved=await readCheckpoint(checkpointPath);
  if(saved.completed) return {records:saved.records||[],total:saved.total||0};
  const records=new Map((saved.records||[]).map(r=>[String(r.jobId),r]));
  let context,page,total=saved.total||0,pageNo=1,completed=false;
  try {
    context=await contextFactory('job51');page=await context.newPage();
    let pending=null,lastError=null;
    const responses=new Map();
    const listener=response=>{
      let url;try{url=new URL(response.url());}catch{return;}
      if(!url.pathname.endsWith('/api/job/search-pc'))return;
      const num=Number(url.searchParams.get('pageNum')||1);
      pending=(async()=>{
        if(!response.ok())throw new ChannelError(`前程无忧岗位接口 HTTP ${response.status()}，请人工检查访问状态`,'http_error');
        const parsed=parse51Payload(await response.json());responses.set(num,parsed);
      })().catch(e=>{lastError=e;});
    };
    page.on('response',listener);
    await page.goto(`https://we.51job.com/pc/search?jobArea=${encodeURIComponent(city.code)}&keyword=${encodeURIComponent(keyword)}&searchType=2`,{waitUntil:'domcontentloaded',timeout:30000});
    async function awaitPage(num) {
      const deadline=Date.now()+30000;
      while(Date.now()<deadline){
        await guard(page);
        if(lastError)throw lastError;
        if(responses.has(num))return responses.get(num);
        await sleep(250);
      }
      throw new ChannelError(`前程无忧第${num}页未返回岗位数据：已记录页面诊断，请人工检查登录、验证或网络`,'response_timeout');
    }
    let parsed=await awaitPage(1);total=parsed.total;
    const pages=Math.min(Math.ceil(total/20)||1,maxPages);
    for(pageNo=1;pageNo<=pages;pageNo++) {
      if(pageNo%5===0&&contextFactory===openContext)await assertCollectorResources();
      if(pageNo>1){
        await sleep(Math.max(1200,request.minimumIntervalMs||0));await guard(page);
        const next=page.locator('.btn-next');
        if(!await next.count()||!await next.isEnabled())throw new ChannelError('前程无忧分页控件不可用，保留已有记录；请复核页面结构');
        await next.click({timeout:5000});parsed=await awaitPage(pageNo);
      }
      for(const row of parsed.items)if(row.jobId)records.set(String(row.jobId),row);
      completed=pageNo===pages&&pages>=Math.ceil(total/20);
      await saveCheckpoint(checkpointPath,{records:[...records.values()],total,pageNo,completed});
      console.log(`job51 ${keyword}/${city.name}: ${pageNo}/${pages}，${records.size}条`);
    }
    page.off('response',listener);if(pending)await pending;
    return {records:[...records.values()],total};
  }catch(error){
    error.stopChannel=true;error.records=[...records.values()];error.total=total;
    await saveCheckpoint(checkpointPath,{records:error.records,total,pageNo,completed:false,error:error.message});
    if(page)await evidence(page,checkpointPath,error);
    throw error;
  }finally{if(page)await page.close().catch(()=>{});if(context)await context.close();}
}

export function extractJobonlineCards() {
  return [...document.querySelectorAll('.position_item_left')].map(e=>{
    const txt=s=>e.querySelector(s)?.textContent.trim()||'';
    const info=[...e.querySelectorAll('.left_info span')].map(x=>x.textContent.replace(/^[\s|\u00a0]+/,'').trim());
    return {job_name:txt('.left_title'),salary:txt('.salary'),city:info[0]||'',experience:info.find(x=>/经验|\d.*年/.test(x))||'',education:info.find(x=>/本科|专科|硕士|博士|中学|中专|学历/.test(x))||'',employment_type:info.includes('实习')?'实习':'',company_name:txt('.name'),company_nature:txt('.nature'),company_size:txt('.size').replace(/^[\s|\u00a0]+/,''),source_agency:e.parentElement.textContent.match(/职位来源[：:]\s*([^\n]+)/)?.[1]?.trim()||''};
  });
}
export function extractJobonlineDetail() {
  const section=title=>[...document.querySelectorAll('.job-sec')].find(e=>e.querySelector('h3')?.textContent.trim()===title);
  const desc=section('职位描述:')?.querySelector('.text')?.textContent.trim()||'';
  const company=document.querySelector('h2')?.parentElement;
  const companyText=[...(company?.querySelectorAll('p')||[])].map(e=>e.textContent.trim()).join('\n');
  return {job_id:new URL(location.href).searchParams.get('id')||'',job_url:location.href,job_description:desc,address:document.querySelector('.location-address')?.textContent.trim()||'',tags:[...(section('职位亮点:')?.querySelectorAll('li')||[])].map(e=>e.textContent.trim()).join(' | '),industry:companyText.match(/行业[：:]\s*([^\n]+)/)?.[1]?.trim()||'',company_size:companyText.match(/人数[：:]\s*([^\n]+)/)?.[1]?.trim()||'',salary:document.body.innerText.match(/\d[\d.]*\s*(?:[-–]\s*[\d.]+)?(?:万)?元\/(?:月|天|日|年)/)?.[0]||'',refresh_time:document.body.innerText.match(/职位同步时间[：:]\s*([\d/.-]+)/)?.[1]||''};
}
export async function collectJobonline(keyword,city,{checkpointPath,request={},maxPages=10,maxRows=100,contextFactory=openContext}) {
  const saved=await readCheckpoint(checkpointPath);
  if(saved.completed)return saved.records||[];
  const records=new Map((saved.records||[]).map(r=>[r.job_id,r]));
  let context,page,pageNo=1,completed=false;
  try{
    context=await contextFactory('jobonline');page=await context.newPage();
    await page.goto(`https://www.jobonline.cn/findPositions?q=${encodeURIComponent(keyword)}`,{waitUntil:'domcontentloaded',timeout:30000});
    async function waitList(){
      const deadline=Date.now()+25000;
      while(Date.now()<deadline){await guard(page);
        if(await page.locator('.position_item_left').count())return true;
        if((await page.locator('body').innerText()).includes('没有找到相关职位')&&!await page.getByText('数据加载中',{exact:true}).isVisible().catch(()=>false)){
          await sleep(1200);await guard(page);
          if(!await page.locator('.position_item_left').count()&&!await page.getByText('数据加载中',{exact:true}).isVisible().catch(()=>false))return false;
        }
        await sleep(300);
      }throw new ChannelError('就业在线列表加载超时，请检查网络或页面结构');
    }
    for(pageNo=1;pageNo<=maxPages;pageNo++){
      if(!await waitList()){completed=true;break;}
      const cards=await page.evaluate(extractJobonlineCards);
      for(let i=0;i<cards.length&&records.size<maxRows;i++){
        await sleep(Math.max(1200,request.minimumIntervalMs||0));await guard(page);
        await page.locator('.left_title').nth(i).click({timeout:5000});
        await page.waitForURL('**/positionDetail?**',{timeout:10000});
        await page.waitForFunction(()=>document.querySelector('.job-sec .text'),{},{timeout:20000});await guard(page);
        const detail=await page.evaluate(extractJobonlineDetail);
        if(!detail.job_id||!detail.job_description)throw new ChannelError('就业在线详情字段缺失，停止采集并保留断点');
        const row={...cards[i],...detail,company_size:detail.company_size||cards[i].company_size,salary:detail.salary||'',platform:'就业在线',query_keyword:keyword,query_city:city.name,access_level:'公开页面详情',collected_at:new Date().toISOString()};
        records.set(row.job_id,row);
        await saveCheckpoint(checkpointPath,{records:[...records.values()],pageNo,completed:false});
        await page.goBack({waitUntil:'domcontentloaded',timeout:20000});await waitList();
      }
      console.log(`jobonline ${keyword}/${city.name}: 第${pageNo}页，${records.size}条`);
      if(records.size>=maxRows)break;
      const next=page.getByRole('button',{name:'下一页',exact:true});
      if(!await next.count()||!await next.isEnabled()){completed=true;break;}
      if(pageNo===maxPages)break;
      const previous=await page.locator('.position_item_left').first().innerText();
      await sleep(Math.max(1200,request.minimumIntervalMs||0));await guard(page);await next.click();
      await page.waitForFunction(prev=>document.querySelector('.position_item_left')?.innerText!==prev,previous,{timeout:15000});
    }
    await saveCheckpoint(checkpointPath,{records:[...records.values()],pageNo,completed});return [...records.values()];
  }catch(error){
    error.stopChannel=true;error.partialRows=[...records.values()];
    await saveCheckpoint(checkpointPath,{records:error.partialRows,pageNo,completed:false,error:error.message});
    if(page)await evidence(page,checkpointPath,error);throw error;
  }finally{if(page)await page.close().catch(()=>{});if(context)await context.close();}
}
