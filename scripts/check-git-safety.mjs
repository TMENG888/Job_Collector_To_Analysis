// Source-control guard. Print locations/reasons only, never matched secrets.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..'),staged=process.argv.includes('--staged');
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});
const files=[...new Set(git(staged?['ls-files','--cached','-z']:['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean))];
const fileSet=new Set(files),issues=[];
// One batch avoids launching a Git process per file on Windows. Read blobs
// from the index so unstaged sanitization cannot conceal a staged credential.
const indexed=new Map();
if(staged){
  const entries=git(['ls-files','--stage','-z']).split('\0').filter(Boolean).map(record=>{
    const match=record.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/);
    if(!match||match[3]!=='0')throw Error('暂存区有冲突或无法识别的记录，请先处理');
    return {hash:match[2],file:match[4]};
  });
  let batch;
  try{batch=execFileSync('git',['cat-file','--batch'],{cwd:root,input:entries.map(entry=>entry.hash).join('\n')+'\n',maxBuffer:64*1024*1024});}
  catch{console.error('无法读取暂存区，已阻止提交；请检查 Git 状态和文件大小。');process.exit(1);}
  let offset=0;
  for(const entry of entries){
    const end=batch.indexOf(10,offset),header=batch.subarray(offset,end).toString('ascii').match(/^([a-f0-9]+) blob (\d+)$/);
    if(end<0||!header||header[1]!==entry.hash)throw Error('暂存区对象协议异常，已阻止提交');
    const size=Number(header[2]);offset=end+1;
    indexed.set(entry.file,batch.subarray(offset,offset+size));offset+=size+1;
  }
}
const models=new Map([
  ['work/models/role-screening/data-analysis-tfidf-lr-v1.json','44cb86ca5f03b01905ef5dc94a474e51511ad047df733e6a61f1f3b405a96d37'],
  ['work/models/role-screening/agent-app-tfidf-lr-v1.json','82eae6bb24fc61d1c32d7157776ee00930cef57752a531ed8b313e88180ee4d1'],
  ['work/models/role-screening/embedded-tfidf-lr-v1.json','95542a045f9c2d6881c304d2cffd749113776135cd394a11057d36a488242eeb'],
  ['work/models/role-screening/software-testing-tfidf-lr-v1.json','0974fb5b7bc9ef83d34107b837a8261f8abfbc90cc79126017332f7719e819d1'],
  ['work/models/role-screening/multirole-registry-v1.json','4a6adf7b9607e1ebbc82949321494a06dc27e882affc13e8075ff6f240b84b63'],
]);
const report=(file,reason,line)=>issues.push({file,reason,...(line?{line}:{})});
let bytes=0;
for(const file of files){
  if(/(?:^|\/)(?:node_modules|ui_data[^/]*|outputs?|tmp|runtime|profile|sessions|快照|__pycache__|[^/]*_env|[^/]*_models)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:sqlite(?:-.*)?|db(?:-.*)?|csv|xlsx?|tsv|jsonl|ndjson|enc|log|pem|key|pfx|p12|pdf|docx?|joblib|pkl|pickle|exe|dll|dmp|zip|7z)$/i.test(file))report(file,'private/runtime artifact');
  if(file.startsWith('work/models/')&&!models.has(file))report(file,'unapproved model or training data');
  let buffer;
  try{buffer=staged?indexed.get(file):fs.readFileSync(path.join(root,file));if(!buffer)throw Error('missing index entry');}
  catch{report(file,'cannot read source-control candidate');continue;}
  bytes+=buffer.length;
  if(buffer.length>10*1024*1024)report(file,'large file exceeds source-only policy (10 MiB)');
  if(models.has(file)&&createHash('sha256').update(buffer).digest('hex')!==models.get(file))report(file,'published model hash changed; needs separate review');
  if(!/\.(?:md|mjs|cjs|js|py|html|css|json|geojson|bat|cmd|ps1|svg|txt|LICENSE)$/.test(file))continue;
  const text=buffer.toString('utf8'),lines=text.split(/\r?\n/);
  for(let index=0;index<lines.length;index++){
    const line=lines[index];
    if(/sk-ws-[A-Za-z0-9_.-]{20,}|sk-[A-Za-z0-9_-]{40,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line))report(file,'credential-like literal',index+1);
    for(const match of line.matchAll(/\b(?:cookie|authorization|apiKey|api_key|access_token|refresh_token|password)\s*[:=]\s*(['"])([^'"\r\n]{24,})\1/gi)){
      if(!/fixture|example|dummy|test|fake|placeholder|process\.env|\$\{|^x+$|^Bearer\s*$/i.test(match[2]))report(file,'long credential assignment; manual review required',index+1);
    }
  }
  if(/\.(?:mjs|cjs|js)$/.test(file))for(const match of text.matchAll(/(?:from\s*|import\s*\(|import\s*|require\s*\()['"]((?:\.\/|\.\.\/)[^'"]+)['"]/g)){
    if(!/\.(?:mjs|cjs|js|json)$/.test(match[1]))continue;
    const target=path.relative(root,path.resolve(root,path.dirname(file),match[1])).replaceAll('\\','/');
    if(!fileSet.has(target))report(file,'relative source dependency not versioned: '+target);
  }
}
const result={mode:staged?'index':'working-tree-candidates',files:files.length,bytes,issues};
if(process.argv.includes('--json'))console.log(JSON.stringify(result,null,2));
else if(issues.length)for(const issue of issues)console.error(`${issue.file}${issue.line?':'+issue.line:''}: ${issue.reason}`);
else console.log(`PASS source-control safety: ${files.length} files, ${bytes} bytes; no prohibited data or known credential literals; source imports versioned.`);
if(issues.length)process.exitCode=1;
