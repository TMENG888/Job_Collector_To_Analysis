import fs from 'node:fs/promises';
const root='ui_data/insights/comparisons/weighted-role-threshold-20261010/agent-population-stratified-audit';
const blind=JSON.parse(await fs.readFile(root+'/blind-review.json','utf8'));
const labels=(await fs.readFile(root+'/manual-labels.tsv','utf8')).trim().split(/\r?\n/).slice(1).map(line=>{const [id,label,quote,reason]=line.split('\t');return {audit_id:Number(id),label,quote,reason};});
const compact=s=>s.replace(/\s+/g,'');
const errors=[];
for(const b of blind){const l=labels.find(l=>l.audit_id===b.audit_id);if(!l)errors.push({id:b.audit_id,error:'missing'});else if(!compact(b.description).includes(compact(l.quote)))errors.push({id:b.audit_id,error:'quote not found',quote:l.quote});}
console.log(JSON.stringify({count:labels.length,unique:new Set(labels.map(l=>l.audit_id)).size,counts:Object.fromEntries(['t','n','u'].map(v=>[v,labels.filter(l=>l.label===v).length])),errors}));
if(process.argv[2]==='uncertain')for(const l of labels.filter(l=>l.label==='u')){const b=blind.find(b=>b.audit_id===l.audit_id);console.log(`\n[${b.audit_id}] ${b.title}\n${b.description.replace(/\s+/g,' ')}\n[/ ${b.audit_id}]`);}
