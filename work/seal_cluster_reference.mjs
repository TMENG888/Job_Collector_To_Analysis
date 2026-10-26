import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export function validateAnnotations(packet,manifest,annotations,taxonomy){
 const ids=new Map(packet.map(r=>[r.id,r]));
 if(ids.size!==packet.length||manifest.length!==packet.length||annotations.length!==packet.length)throw Error('Incomplete or duplicate packets');
 const seen=new Set();
 for(const a of annotations){
  if(seen.has(a.id)||!ids.has(a.id))throw Error('Duplicate/unknown annotation');seen.add(a.id);
  if(!Object.hasOwn(taxonomy,a.label))throw Error('Unknown occupational label');
  if(!['high','medium','low'].includes(a.confidence)||!a.reason?.trim())throw Error('Missing evidence confidence/reason');
  if(!a.quote||a.quote.length<6||!ids.get(a.id).text.includes(a.quote))throw Error(`Non-exact evidence: ${a.id}`);
 }
 const keys=new Set(manifest.map(r=>r.key));if(keys.size!==packet.length)throw Error('Duplicate keys');
 const companies=new Set(manifest.filter(r=>r.split==='calibration').map(r=>r.company_hash));
 if(manifest.some(r=>r.split==='test'&&companies.has(r.company_hash)))throw Error('Company split leakage');
 return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 const out=path.resolve(process.argv[2]||'ui_data/insights/comparisons/cluster-reference-codex-20261017');
 const read=f=>JSON.parse(fs.readFileSync(path.join(out,f),'utf8'));
 const protocol=read('protocol.json'),packet=read('blind-packet.json'),manifest=read('manifest.json');
 const annotations=Array.from({length:5},(_,i)=>read(`annotations-0${i+1}.json`)).flat();
 validateAnnotations(packet,manifest,annotations,protocol.taxonomy);
 const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(path.join(out,f))).digest('hex');
 fs.writeFileSync(path.join(out,'reference-labels.json'),JSON.stringify(annotations,null,2),{flag:'wx'});
 fs.writeFileSync(path.join(out,'reference-seal.json'),JSON.stringify({sealed_at:new Date().toISOString(),
  note:'Sealed after outcome-hidden duty labeling and before mapping/test metrics; single Codex annotator, not independent human truth.',
  hashes:Object.fromEntries(['protocol.json','manifest.json','blind-packet.json','reference-labels.json'].map(f=>[f,hash(f)])),
  labels:annotations.length,counts:annotations.reduce((a,r)=>(a[r.label]=(a[r.label]||0)+1,a),{})},null,2),{flag:'wx'});
 console.log(JSON.stringify({sealed:true,rows:annotations.length}));
}
