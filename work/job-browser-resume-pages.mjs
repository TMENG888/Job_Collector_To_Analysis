import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

export async function renderResumePages(bytes,{binary=process.env.JOB_ASSISTANT_PYTHON||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe')}={}){
  if(!Buffer.isBuffer(bytes)||bytes.length>3*1024*1024||bytes.subarray(0,5).toString()!=='%PDF-')throw Error('截图需要3MB以内的原版式PDF');
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,['-B','-I',fileURLToPath(new URL('./job-browser-resume-pages.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const chunks=[];let size=0,finished=false;
    const done=(error)=>{if(finished)return;finished=true;clearTimeout(timer);if(error){reject(Error(error));return;}
      try{const value=JSON.parse(Buffer.concat(chunks).toString());if(value.error)throw Error(value.error);
        if(!Array.isArray(value.pages)||!value.pages.length||value.pages.length>6)throw Error('无效PDF截图');
        for(const p of value.pages)if(p.mime!=='image/jpeg'||createHash('sha256').update(Buffer.from(p.base64,'base64')).digest('hex')!==p.sha256)throw Error('PDF截图校验失败');
        resolve({pages:value.pages,sha256:createHash('sha256').update(bytes).digest('hex')});
      }catch(e){reject(Error('原版式截图生成失败：'+e.message));}};
    const timer=setTimeout(()=>{child.kill();done('PDF截图超时，未采用部分页面');},20000);
    child.stdout.on('data',b=>{size+=b.length;if(size>9*1024*1024){child.kill();done('PDF截图过大');}else chunks.push(b);});
    child.stderr.resume();child.on('error',()=>done('本机PDF渲染运行时不可用'));child.stdin.on('error',()=>done('PDF读取失败'));child.on('close',()=>done());child.stdin.end(bytes);
  });
}
