// Read-only release inspection. Reports paths only, never secret contents.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const issues=[];
const shippedModels=new Map([
  ['work/models/role-screening/data-analysis-tfidf-lr-v1.json','44cb86ca5f03b01905ef5dc94a474e51511ad047df733e6a61f1f3b405a96d37'],
  ['work/models/role-screening/agent-app-tfidf-lr-v1.json','82eae6bb24fc61d1c32d7157776ee00930cef57752a531ed8b313e88180ee4d1'],
  ['work/models/role-screening/embedded-tfidf-lr-v1.json','95542a045f9c2d6881c304d2cffd749113776135cd394a11057d36a488242eeb'],
  ['work/models/role-screening/software-testing-tfidf-lr-v1.json','0974fb5b7bc9ef83d34107b837a8261f8abfbc90cc79126017332f7719e819d1'],
  ['work/models/role-screening/multirole-registry-v1.json','4a6adf7b9607e1ebbc82949321494a06dc27e882affc13e8075ff6f240b84b63'],
]);
for(const file of files){
  if(/(?:^|\/)(?:node_modules|ui_data[^/]*|output|outputs|tmp|runtime|profile|sessions|快照|models)(?:\/|$)|\.(?:sqlite(?:-.*)?|db(?:-.*)?|csv|xlsx|xls|jsonl|ndjson|enc|log|pem|key|pfx|pdf|docx|joblib|pkl|pickle|exe|dll|dmp)$/i.test(file)&&!shippedModels.has(file))issues.push([file,'private/runtime file']);
  if(shippedModels.has(file)&&createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex')!==shippedModels.get(file))issues.push([file,'shipped model hash mismatch']);
  if(!/\.(?:md|mjs|cjs|js|py|html|css|json|geojson|bat|cmd|ps1|svg|txt)$/.test(file)||file.includes('/vendor/'))continue;
  const text=await fs.readFile(path.join(root,file),'utf8');
  if(/[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|\.\.\.)[^\\/]+[\\/]/i.test(text))issues.push([file,'private machine path']);
  // Do not flag regex definitions or obviously synthetic short test credentials.
  if(/sk-ws-[A-Za-z0-9_.-]{20,}|sk-[A-Za-z0-9_-]{40,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))issues.push([file,'credential-like literal']);
  if(/\.(?:mjs|cjs|js)$/.test(file)){
    for(const m of text.matchAll(/(?:from\s*|import\s*\(|import\s*)['"]((?:\.\/|\.\.\/)[^'"]+)['"]/g)){
      if(!/\.(?:mjs|js|json)$/.test(m[1]))continue;
      try{await fs.access(path.resolve(root,path.dirname(file),m[1]));}catch{issues.push([file,'missing relative import: '+m[1]]);}
    }
  }
  if(file.endsWith('.md')){
    for(const m of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)){
      const target=m[1].split('#')[0];
      if(!target||/^[a-z]+:|^\//i.test(target))continue;
      try{await fs.access(path.resolve(root,path.dirname(file),target));}catch{issues.push([file,'missing documentation link: '+target]);}
    }
  }
}
if(issues.length){for(const [file,reason]of issues)console.error(file+': '+reason);process.exitCode=1;}
else console.log('PASS: '+files.length+' release files; no prohibited data/known credential literals/private paths; relative imports and documentation links resolve');
