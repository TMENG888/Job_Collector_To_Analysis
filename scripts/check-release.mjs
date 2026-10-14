// Read-only release inspection. Reports paths only, never secret contents.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const issues=[];
for(const file of files){
  if(/(?:^|\/)(?:node_modules|ui_data[^/]*|outputs|快照|models)(?:\/|$)|\.(?:sqlite(?:-.*)?|db|csv|xlsx|xls|jsonl|ndjson|enc|log|pem|key|pfx)$/i.test(file))issues.push([file,'private/runtime file']);
  if(!/\.(?:md|mjs|js|py|html|css|json|bat|svg|txt)$/.test(file)||file.includes('/vendor/'))continue;
  const text=await fs.readFile(path.join(root,file),'utf8');
  if(/[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|\.\.\.)[^\\/]+[\\/]/i.test(text))issues.push([file,'private machine path']);
  // Do not flag regex definitions or obviously synthetic short test credentials.
  if(/sk-[a-f0-9]{32,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))issues.push([file,'credential-like literal']);
  if(/\.(?:mjs|js)$/.test(file)){
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
