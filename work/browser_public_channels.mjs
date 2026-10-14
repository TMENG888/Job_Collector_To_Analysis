import fs from 'node:fs/promises';
import path from 'node:path';
import {ChannelError,evidence,guard,openContext,readCheckpoint,saveCheckpoint} from './browser_channel_common.mjs';
import {yieldNote} from './collection_yield.mjs';

export {ChannelError,blockedReason,openContext} from './browser_channel_common.mjs';

const sleep = ms => new Promise(r=>setTimeout(r,ms));

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
export async function collectJobonline(keyword,city,{checkpointPath,request={},maxPages=10,maxRows=100,contextFactory=openContext,yieldWindow=null,onDefer=()=>{}}) {
  const saved=await readCheckpoint(checkpointPath);
  if(saved.completed)return saved.records||[];
  const records=new Map((saved.records||[]).map(r=>[r.job_id,r]));
  const resumePage=Math.max(1,Number(saved.nextPageNo||saved.pageNo||1));
  let cursor={nextPageNo:resumePage,nextCardIndex:Number(saved.nextCardIndex||0),pageSignature:saved.pageSignature||''};
  let lowYield=null;
  const save=(extra={})=>saveCheckpoint(checkpointPath,{records:[...records.values()],pageNo,...cursor,completed,low_yield:lowYield,...extra});
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
      const pageIds=[];
      const signature=JSON.stringify(cards);
      const startIndex=pageNo<resumePage?cards.length:pageNo===resumePage&&signature===cursor.pageSignature?cursor.nextCardIndex:0;
      if(pageNo>=resumePage)cursor={nextPageNo:pageNo,nextCardIndex:startIndex,pageSignature:signature};
      for(let i=startIndex;i<cards.length&&records.size<maxRows;i++){
        await sleep(Math.max(1200,request.minimumIntervalMs||0));await guard(page);
        await page.locator('.left_title').nth(i).click({timeout:5000});
        await page.waitForURL('**/positionDetail?**',{timeout:10000});
        await page.waitForFunction(()=>document.querySelector('.job-sec .text'),{},{timeout:20000});await guard(page);
        const detail=await page.evaluate(extractJobonlineDetail);
        if(!detail.job_id||!detail.job_description)throw new ChannelError('就业在线详情字段缺失，停止采集并保留断点');
        const row={...cards[i],...detail,company_size:detail.company_size||cards[i].company_size,salary:detail.salary||'',platform:'就业在线',query_keyword:keyword,query_city:city.name,access_level:'公开页面详情',collected_at:new Date().toISOString()};
        records.set(row.job_id,row);
        pageIds.push(row.job_id);
        cursor.nextCardIndex=i+1;
        await save();
        await page.goBack({waitUntil:'domcontentloaded',timeout:20000});await waitList();
      }
      console.log(`jobonline ${keyword}/${city.name}: 第${pageNo}页，${records.size}条`);
      if(records.size>=maxRows)break;
      const next=page.getByRole('button',{name:'下一页',exact:true});
      if(!await next.count()||!await next.isEnabled()){completed=true;break;}
      if(pageNo>=resumePage) {cursor={nextPageNo:pageNo+1,nextCardIndex:0,pageSignature:''};await save();}
      if(pageNo>=resumePage && yieldWindow && pageIds.length) {
        const probe=yieldWindow.observe(pageIds);
        if(probe.defer){lowYield={...probe,at:new Date().toISOString()};await save();onDefer();console.log(`[低收益切换] jobonline ${keyword}/${city.name}: ${yieldNote(probe)}`);break;}
      }
      if(pageNo===maxPages)break;
      const previous=await page.locator('.position_item_left').first().innerText();
      await sleep(Math.max(1200,request.minimumIntervalMs||0));await guard(page);await next.click();
      await page.waitForFunction(prev=>document.querySelector('.position_item_left')?.innerText!==prev,previous,{timeout:15000});
    }
    await save();return [...records.values()];
  }catch(error){
    error.stopChannel=true;error.partialRows=[...records.values()];
    completed=false;await save({error:error.message});
    if(page)await evidence(page,checkpointPath,error);throw error;
  }finally{if(page)await page.close().catch(()=>{});if(context)await context.close();}
}
