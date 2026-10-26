import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const out=path.resolve('ui_data/insights/comparisons/wordcloud-20261010');
const data=JSON.parse(await fs.readFile(path.join(out,'results.json'),'utf8'));
const source=await fs.readFile('job_collector_ui/public/insight-wordcloud.js','utf8');
const moduleUrl='data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const browser=await chromium.launch({headless:true,executablePath:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
const measurements=[];
try{
 const page=await browser.newPage();
 for(const variant of data.variants)for(const width of [1000,390]){
  await page.setViewportSize({width,height:1000});
  await page.setContent('<style>body{margin:24px;font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#075b61}main{max-width:900px;margin:auto}svg{width:100%;height:auto}h1{font-size:20px}small{font-size:12px}</style><main></main>');
  await page.evaluate(async({moduleUrl,terms,name})=>{const {renderKeywordWordCloud}=await import(moduleUrl);document.querySelector('main').innerHTML='<h1>'+name+'</h1>'+renderKeywordWordCloud(terms);},{moduleUrl,terms:variant.terms,name:variant.name});
  await page.evaluate(()=>document.fonts.ready);
  const metrics=await page.locator('svg text').evaluateAll(nodes=>{
   const boxes=nodes.map(n=>n.getBoundingClientRect());let collisions=0;
   for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)if(boxes[i].left<boxes[j].right&&boxes[i].right>boxes[j].left&&boxes[i].top<boxes[j].bottom&&boxes[i].bottom>boxes[j].top)collisions++;
   const screenSizes=nodes.map(n=>parseFloat(getComputedStyle(n).fontSize)*n.getScreenCTM().a);
   return {visible:nodes.length,collisions,min_screen_font_px:Math.min(...screenSizes),readable_at_11px:screenSizes.filter(s=>s>=11).length,horizontal_overflow:document.documentElement.scrollWidth>innerWidth};
  });
  assert.equal(metrics.visible,variant.terms.length);assert.equal(metrics.collisions,0);assert.equal(metrics.horizontal_overflow,false);
  await page.locator('main').screenshot({path:path.join(out,`${variant.id}-${width}.png`)});
  measurements.push({id:variant.id,width,...metrics});
 }
 // Display alternative: responsive wrapping, no 900-wide SVG缩小; same evidence-backed words.
 const fusion=data.variants.find(v=>v.id==='fusion');
 await page.setViewportSize({width:390,height:1000});
 await page.setContent('<style>body{margin:20px;font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#075b61}h1{font-size:18px}.cloud{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;justify-content:center}.cloud span{max-width:100%;overflow-wrap:anywhere}</style><main><h1>短语融合 · 手机不缩字</h1><div class="cloud"></div></main>');
 await page.evaluate(terms=>{const max=Math.max(...terms.map(t=>t.score));for(const t of terms){const s=document.createElement('span');s.textContent=t.name;s.style.fontSize=(12+12*Math.sqrt(t.score/max)).toFixed(1)+'px';document.querySelector('.cloud').append(s);}},fusion.terms);
 const responsive=await page.locator('.cloud span').evaluateAll(nodes=>({visible:nodes.length,min_screen_font_px:Math.min(...nodes.map(n=>parseFloat(getComputedStyle(n).fontSize))),horizontal_overflow:document.documentElement.scrollWidth>innerWidth}));
 assert.equal(responsive.visible,fusion.terms.length);assert.ok(responsive.min_screen_font_px>=12);assert.equal(responsive.horizontal_overflow,false);
 await page.locator('main').screenshot({path:path.join(out,'fusion-responsive-mobile.png')});
 await fs.writeFile(path.join(out,'browser-checks.json'),JSON.stringify({measurements,responsive},null,2));
 console.log(JSON.stringify({measurements,responsive},null,2));
}finally{await browser.close();}
