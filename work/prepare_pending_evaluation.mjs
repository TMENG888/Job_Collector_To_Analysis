import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const dir='ui_data/insights/comparisons/pending-v3-test';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const fingerprint=r=>hash(r.description.normalize('NFKC').toLowerCase().replace(/\s/g,''));
const baseline=await read('ui_data/insights/comparisons/2026-10-07T12-35-57-026Z/legacy.json');
const old80=await read('ui_data/insights/comparisons/2026-10-07T12-35-57-026Z/audit.json');
const old200=await read('ui_data/insights/comparisons/audit-200-v2/sample-blind.json');
const report=await read('ui_data/insights/岗位市场洞察.json');
const excluded=new Set([...Object.values(old80).flat(),...old200.rows].map(fingerprint));
const seenUser=new Set([5,10,16,22,41,42,46,50,53,56,57,63,64,69,76,87,88,89,93,96]);
const pending=new Set(report.selection_review.rows.map(r=>r.row_no));
const eligible=baseline.decisions.filter(r=>pending.has(r.row_no)&&!excluded.has(fingerprint(r))&&!seenUser.has(r.row_no));
const order=(rows,salt)=>[...rows].sort((a,b)=>hash(salt+':'+a.row_no).localeCompare(hash(salt+':'+b.row_no)));
const selected=order(eligible,'pending120-fixed-20261007').slice(0,120);
assert.equal(selected.length,120);
const blind=selected.map(r=>({row_no:r.row_no,title:r.title,platform:r.platform,description:r.description}));
if(process.argv.includes('--prepare')){
 await fs.mkdir(dir,{recursive:true});
 await assert.rejects(fs.access(dir+'/sample-blind.json'));
 await fs.writeFile(dir+'/sample-blind.json',JSON.stringify({source_sha256:old200.source_sha256,eligible:eligible.length,protocol:'120条新待复核固定随机；前60开发，后60留出；排除旧80/200正文与用户所列20条；先标签后预测；不改变生产报告',rows:blind},null,2));
 console.log(JSON.stringify({samples:120,eligible:eligible.length,sample_hash:hash(JSON.stringify(blind))}));
}else if(process.argv.includes('--read')){
 const start=Number(process.argv[process.argv.indexOf('--read')+1]||0);
 const stored=await read(dir+'/sample-blind.json');
 for(const [i,r] of stored.rows.slice(start,start+10).entries()){
   const lines=r.description.split(/[\n。；;]/).map(s=>s.trim()).filter(Boolean);
   const keep=new Set([0,1,2]);
   const domain=/智能体|\bagents?\b|\brag\b|大模型|大语言|llm|langchain|dify|coze|AI.?应用|large.language|AI.?服务/i;
   lines.forEach((line,j)=>{if(domain.test(line.normalize('NFKC'))){keep.add(j);if(j)keep.add(j-1);if(j+1<lines.length)keep.add(j+1);}});
   const excerpt=[...keep].sort((a,b)=>a-b).map(j=>lines[j]).filter(Boolean).join('\n');
   console.log(`\n#${start+i+1} ROW ${r.row_no} ${r.title} [原文${r.description.length}字]\n${process.argv.includes('--evidence')?excerpt:r.description}`);
 }
}
