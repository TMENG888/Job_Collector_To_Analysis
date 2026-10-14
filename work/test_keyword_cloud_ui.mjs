import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'keyword-cloud-ui-'));
const port=18989,base=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['job_collector_ui/server.mjs',String(port)],{windowsHide:true,env:{...process.env,JOB_UI_DATA_DIR:temp,JOB_UI_PORT:String(port),JOB_UI_OPEN_BROWSER:'0'}});
let browser,logs='';server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
try{
  for(let i=0;i<80;i++){try{if((await fetch(base+'/api/tasks')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const page=await browser.newPage({viewport:{width:1200,height:1000}});
  await page.goto(base);
  await page.evaluate(async()=>{
    const {renderKeywordWordCloud}=await import('/insight-wordcloud.js');
    const terms=Array.from({length:100},(_,i)=>({name:['数据分析','SQL','统计建模','Python','可视化','业务指标','用户画像','数据仓库','报表分析','机器学习'][i%10]+(i>=10?i:''),score:100-i,seed_count:200-i,lift:3,used_for_filter:i<40}));
    document.body.innerHTML=`<main style="max-width:920px;margin:auto"><article class="card insight-panel" id="insightKeywordCloud"><h3>岗位关键词词云</h3>${renderKeywordWordCloud(terms)}</article></main>`;
  });
  await page.locator('#insightKeywordCloud svg text').last().waitFor();
  assert.equal(await page.locator('#insightKeywordCloud svg text').count(),100);
  const collisions=await page.locator('#insightKeywordCloud svg text').evaluateAll(nodes=>{
    const rects=nodes.map(n=>n.getBoundingClientRect());let count=0;
    for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++)if(rects[i].left<rects[j].right&&rects[i].right>rects[j].left&&rects[i].top<rects[j].bottom&&rects[i].bottom>rects[j].top)count++;
    return count;
  });
  assert.equal(collisions,0);
  await page.locator('#insightKeywordCloud').screenshot({path:path.join(temp,'keyword-cloud-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>document.body.style.minWidth='0');
  assert.equal(await page.locator('#insightKeywordCloud svg text').count(),100);
  await page.locator('#insightKeywordCloud').screenshot({path:path.join(temp,'keyword-cloud-mobile.png')});
  const platforms=await (await fetch(base+'/api/platforms')).json();
  assert.ok(!platforms.platforms.some(p=>['yupao','boss'].includes(p.key)));assert.ok(platforms.platforms.some(p=>p.key==='job51'));
  const html=await (await fetch(base+'/')).text();for(const key of ['yupao','boss'])assert.ok(!html.includes(`value="${key}"`));assert.ok(html.includes('value="job51"'));assert.ok(html.includes('value="jobonline" checked'));
  const source=await (await fetch(base+'/app.js')).text();assert.ok(source.includes('renderKeywordWordCloud(report.topic_model?.discovered_terms)'));assert.ok(!source.includes('data-action="yupao"'));
  console.log(JSON.stringify({ok:true,checks:['100 visible words','no browser text overlap','desktop/mobile screenshots','retired channels hidden','job51 restored as opt-in','jobonline default','actual app integration'],temp}));
}catch(error){console.error(logs);throw error;}
finally{await browser?.close();server.kill();}
