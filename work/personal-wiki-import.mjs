import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const personalPython=()=>process.env.JOB_ASSISTANT_PYTHON||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
export function runPersonalProcess(binary,args,input,{maxBytes=10*1024*1024,timeout=30000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});let chunks=[],size=0,done=false;
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);error?reject(new Error(error)):resolve(Buffer.concat(chunks));};
    const timer=setTimeout(()=>{child.kill();finish('本机文档处理超时，未采用部分结果');},timeout);
    child.stdout.on('data',bytes=>{size+=bytes.length;if(size>maxBytes){child.kill();finish('本机文档处理结果过大');}else chunks.push(bytes);});
    child.stderr.resume();child.stdin.on('error',()=>finish('本机文档输入失败'));child.on('error',()=>finish('本机文档处理运行时不可用'));child.on('close',code=>finish(code?'本机文档处理失败，请核对材料格式':null));child.stdin.end(input);
  });
}
export async function localImageText(bytes,extension,tempRoot){
  await fs.mkdir(tempRoot,{recursive:true});const file=path.join(tempRoot,randomUUID()+extension);
  try{
    await fs.writeFile(file,bytes,{flag:'wx'});
    const result=await runPersonalProcess('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./personal-wiki-ocr.ps1',import.meta.url)),file],null,{maxBytes:200000});
    return JSON.parse(result.toString('utf8')).text||'';
  }finally{await fs.unlink(file).catch(()=>{});}
}
export async function buildPersonalResume(data){
  return runPersonalProcess(personalPython(),['-B','-I',fileURLToPath(new URL('./personal-wiki-resume.py',import.meta.url))],JSON.stringify(data),{maxBytes:3*1024*1024});
}
export function githubTarget(input){
  const url=new URL(String(input));
  if(url.protocol!=='https:'||url.hostname!=='github.com'||url.port||url.username||url.password)throw Error('只支持公开 github.com 个人主页或仓库地址');
  const parts=url.pathname.split('/').filter(Boolean);
  if(parts.length<1||parts.length>2||parts.some(p=>!/^[-\w.]{1,100}$/.test(p)||p==='.'||p==='..'))throw Error('请提供 GitHub 个人主页或仓库首页，不接受任意网页/文件路径');
  return {owner:parts[0],repo:parts[1]?.replace(/\.git$/,''),url:'https://github.com/'+parts.join('/')};
}
export async function readGitHub(input,{fetcher=fetch,deep=false}={}){
  const target=githubTarget(input);
  async function get(suffix,optional=false){
    const response=await fetcher('https://api.github.com/'+suffix,{headers:{accept:'application/vnd.github+json','user-agent':'Local-Job-Personal-Wiki'},redirect:'error',signal:AbortSignal.timeout(15000)});
    if(optional&&response.status===404)return null;
    if(!response.ok)throw Error(`GitHub读取失败（HTTP ${response.status}），未重试；请检查公开访问或限额`);
    if(Number(response.headers.get('content-length'))>800000)throw Error('GitHub材料过大');
    const reader=response.body.getReader();let size=0,chunks=[];try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>800000)throw Error('GitHub材料过大');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  let text,documents=[],commit=null,reading=null;
  if(target.repo){
    const base=`repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`,repo=await get(base);
    if(deep){const branch=String(repo.default_branch||'main').split('/').map(encodeURIComponent).join('/');const revision=await get(base+'/git/ref/heads/'+branch);commit=revision.object?.sha;if(!/^[a-f0-9]{40}$/i.test(commit||''))throw Error('GitHub版本标识无效');}
    const readme=await get(base+'/readme'+(commit?'?ref='+commit:''),true);
    const readmeText=readme?.encoding==='base64'?Buffer.from(readme.content,'base64').toString('utf8'):'';
    text=`项目：${repo.full_name}\n项目描述：${repo.description||''}\n主要语言：${repo.language||'未注明'}\n仓库所有者：${repo.owner.login}\nFork：${repo.fork?'是，不能视为独立原创':'否（仍需核对个人贡献）'}\nREADME 原文：\n${readme?.encoding==='base64'?Buffer.from(readme.content,'base64').toString('utf8'):''}`;
    if(deep){
      documents.push({path:readme?.path||'README.md',kind:'readme',text:readmeText.slice(0,14000)});
      const tree=await get(base+'/git/trees/'+commit+'?recursive=1');
      const safe=p=>typeof p==='string'&&p.length<220&&!p.split('/').some(x=>!x||x==='.'||x==='..')&&!/[\\\x00-\x1f]/.test(p)&&!/(^|\/)(node_modules|vendor|dist|build|coverage|\.git|ui_data|test-results|\.env)(\/|\.|$)|(?:lock|credentials|secret|token|private|usage|session)|\.(?:min\.[cm]?js|map)$/i.test(p);
      const eligible=(tree.tree||[]).filter(f=>f.type==='blob'&&f.size<=24000&&safe(f.path)&&f.path.toLowerCase()!==documents[0].path.toLowerCase());
      const score=p=>/^(package\.json|pyproject\.toml|requirements\.txt)$/i.test(p)?100:/^(docs\/.*(?:architecture|design)|desktop\/README)/i.test(p)?90:/^docs\//i.test(p)?70:/^(src|work|desktop|app)\//i.test(p)&&/\.(?:[cm]?js|ts|tsx|py)$/.test(p)?60:/\.(?:md|json)$/.test(p)?30:0;
      const ranked=eligible.filter(f=>score(f.path)).sort((a,b)=>score(b.path)-score(a.path)||a.path.localeCompare(b.path));
      const chosen=[];const choose=items=>{for(const item of items)if(!chosen.includes(item))chosen.push(item);};
      choose(ranked.filter(f=>score(f.path)===100).slice(0,1));
      choose(ranked.filter(f=>/\.md$/i.test(f.path)).slice(0,2));
      choose(ranked.filter(f=>/\.(?:[cm]?js|ts|tsx|py)$/.test(f.path)&&!/(?:test|fixture|mock)/i.test(f.path)).slice(0,3));
      choose(ranked);
      let characters=documents[0].text.length;
      for(const file of chosen.slice(0,7)){
        if(characters>=37000)break;
        const content=await get(base+'/contents/'+file.path.split('/').map(encodeURIComponent).join('/')+'?ref='+commit,true);
        if(content?.encoding!=='base64'||content.type!=='file')continue;
        const value=Buffer.from(content.content,'base64').toString('utf8');if(value.includes('\u0000'))continue;
        const body=value.slice(0,Math.min(9000,39000-characters));characters+=body.length;
        documents.push({path:file.path,kind:/\.md$/i.test(file.path)?'documentation':/\.(json|toml|txt)$/i.test(file.path)?'manifest':'code',text:body,truncated:body.length<value.length});
      }
      reading={commit,treeTruncated:!!tree.truncated,availableFiles:eligible.length,readFiles:documents.length,scope:'只读公开仓库的有界快照；未执行代码，也不证明个人贡献'};
      text=documents.map(d=>'文件：'+d.path+'\n'+d.text).join('\n\n').slice(0,40000);
    }
  }else{
    const user=await get('users/'+encodeURIComponent(target.owner)),repos=await get('users/'+encodeURIComponent(target.owner)+'/repos?per_page=10&sort=updated');
    text=`GitHub 用户：${user.login}\n公开姓名：${user.name||''}\n公开简介：${user.bio||''}\n最近更新的公开仓库（最多10个，仅作目录，不证明本人贡献）：\n${repos.map(r=>`${r.full_name} | ${r.description||''} | ${r.language||''} | fork=${r.fork}`).join('\n')}`;
  }
  if(text.length>40000)throw Error('GitHub材料正文超过40000字，请精简来源');
  return {url:target.url,text,...(deep?{documents,commit,reading}:{})};
}
