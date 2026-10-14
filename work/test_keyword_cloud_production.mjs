import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
const base='http://127.0.0.1:8788',out=path.resolve('ui_data/insights/comparisons/wordcloud-production-20261010');
await fs.mkdir(out,{recursive:true});
const live=await (await fetch(base+'/api/insights')).json();
assert.equal(live.report.topic_model.discovered_terms.length,100);
assert.equal(live.report.topic_model.display_model.version,'keyword-cloud-fusion-v1');
assert.equal(live.report.keyword_selection.keywords.length,20);assert.equal(live.report.relevant_sample_rows,2300);
for(const file of ['app.js','styles.css','insight-wordcloud.js'])assert.equal(await(await fetch(base+'/'+file)).text(),await fs.readFile('job_collector_ui/public/'+file,'utf8'),'Live assets match disk: '+file);
const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
try{
 const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/insights');await page.locator('#insightKeywordCloud').waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelectorAll('#insightKeywordCloud svg text').length===100);
 await page.evaluate(()=>document.fonts.ready);
 const desktop=await page.locator('#insightKeywordCloud svg text').evaluateAll(nodes=>{
  const boxes=nodes.map(n=>n.getBoundingClientRect());let collisions=0;
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)if(boxes[i].left<boxes[j].right&&boxes[i].right>boxes[j].left&&boxes[i].top<boxes[j].bottom&&boxes[i].bottom>boxes[j].top)collisions++;
  return {words:nodes.length,collisions,visible:boxes.every(b=>b.width>0),min_font_px:Math.min(...nodes.map(n=>parseFloat(getComputedStyle(n).fontSize)*n.getScreenCTM().a))};
 });
 assert.equal(desktop.collisions,0);assert.ok(desktop.visible);assert.ok(desktop.min_font_px>=11);
 await page.locator('#insightKeywordCloud').screenshot({path:path.join(out,'desktop.png')});
 await page.setViewportSize({width:390,height:844});
 const mobile=await page.locator('#insightKeywordCloud .wordcloud-mobile span').evaluateAll(nodes=>({words:nodes.length,min_font_px:Math.min(...nodes.map(n=>parseFloat(getComputedStyle(n).fontSize))),all_visible:nodes.every(n=>n.getBoundingClientRect().width>0),overflow:nodes.some(n=>{const b=n.getBoundingClientRect();return b.left<0||b.right>innerWidth;})}));
 assert.equal(mobile.words,100);assert.ok(mobile.min_font_px>=13);assert.ok(mobile.all_visible);assert.equal(mobile.overflow,false);
 assert.equal(await page.locator('#insightKeywordCloud svg').isVisible(),false);
 await page.locator('#insightKeywordCloud').screenshot({path:path.join(out,'mobile.png')});
 assert.deepEqual(errors,[]);
 const summary={live_version:live.report.topic_model.display_model.version,display_words:100,filter_words:20,selected_rows:2300,desktop,mobile,browser_errors:errors,server_restart_needed:false};
 await fs.writeFile(path.join(out,'verification.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({...summary,out},null,2));
}finally{await browser.close();}
