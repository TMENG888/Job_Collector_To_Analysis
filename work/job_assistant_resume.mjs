import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const MAX_BYTES=3*1024*1024,MAX_CHARS=40000;
const script=path.join(path.dirname(fileURLToPath(import.meta.url)),'job_assistant_resume_parser.py');
export function resumeMessage(text){
  const value=String(text||'').trim();
  const prefix=/^(?:(?:这是|以下是)?(?:我的|个人|求职)?简历(?:内容|正文)?\s*[:：\n])/;
  const headings=(value.match(/(?:工作经历|项目经历|教育背景|教育经历|专业技能|技术技能|技能清单|个人技能)/g)||[]);
  const structured=new Set(headings).size>=2&&(/\n/.test(value)||/(?:工作经历|项目经历|教育背景|教育经历|专业技能|技术技能|技能清单|个人技能)\s*[:：]/.test(value));
  const selfProfile=/^我(?:会|熟悉|掌握|擅长)/.test(value)&&!/^(?:我会不会|我会被)/.test(value);
  return prefix.test(value)||structured||selfProfile?value.replace(prefix,'').trim():null;
}
function normalized(text){
  const value=String(text||'').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim();
  if(!value)throw new Error('未读取到简历正文；扫描PDF或图片暂不支持OCR，请粘贴文字版');
  if(value.length>MAX_CHARS)throw new Error('简历正文不能超过40000字，请精简后重试');
  if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value))throw new Error('文件不是可读取的简历文本，请使用TXT、文字PDF或DOCX');
  return value;
}
async function pythonBinary(){
  if(process.env.JOB_ASSISTANT_PYTHON)return process.env.JOB_ASSISTANT_PYTHON;
  const candidates=[path.resolve(path.dirname(process.execPath),'../../python/python.exe'),path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe')];
  for(const candidate of candidates){try{await fs.access(candidate);return candidate;}catch{}}
  throw new Error('本机PDF/DOCX解析运行时不可用，请先粘贴简历正文');
}
export async function extractResumeAttachment(body,{binary=pythonBinary}={}){
  const filename=String(body?.filename||'');
  if(!filename||filename.length>240)throw new Error('附件文件名无效');
  const extension=path.extname(filename).toLowerCase();
  if(!['.txt','.md','.pdf','.docx'].includes(extension))throw new Error('支持TXT、Markdown、文字PDF和DOCX；图片和旧版DOC请先转换');
  const encoded=body?.base64;
  if(typeof encoded!=='string'||encoded.length>Math.ceil(MAX_BYTES/3)*4||!encoded.length||encoded.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('附件无效或超过3MB');
  const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>MAX_BYTES)throw new Error('附件无效或超过3MB');
  if(['.txt','.md'].includes(extension)){
    let text;
    try{text=new TextDecoder(bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':'utf-8',{fatal:true}).decode(bytes);}
    catch{try{text=new TextDecoder('gb18030',{fatal:true}).decode(bytes);}catch{throw new Error('文本编码不可读取，请保存为UTF-8后重试');}}
    return {filename:path.basename(filename),text:normalized(text),format:extension.slice(1),characters:normalized(text).length};
  }
  const executable=await binary();
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,['-I',script,extension.slice(1)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',finished=false;
    const finish=(error)=>{if(finished)return;finished=true;clearTimeout(timer);if(error){reject(new Error(error));return;}try{const parsed=JSON.parse(output);if(parsed.error)throw new Error(parsed.error);const text=normalized(parsed.text);resolve({filename:path.basename(filename),text,format:extension.slice(1),characters:text.length});}catch(error){reject(new Error(error.message?.startsWith('未读取')||error.message?.startsWith('简历')||error.message?.startsWith('PDF')||error.message?.startsWith('DOCX')?error.message:'附件解析失败，请使用文字版PDF、DOCX或粘贴正文'));}};
    const timer=setTimeout(()=>{child.kill();finish('附件解析超时，请精简文件或直接粘贴正文');},12000);
    child.stdout.on('data',data=>{output+=data.toString('utf8');if(output.length>300000){child.kill();finish('附件正文过长，请精简后重试');}});
    child.stderr.resume();child.on('error',()=>finish('本机解析运行时不可用，请直接粘贴正文'));child.stdin.on('error',()=>finish('附件读取失败'));
    child.on('close',code=>finish(code!==0?'附件解析失败，请检查文件格式':null));
    // File bytes stay in memory and stdin; no original upload or parser output is logged.
    child.stdin.end(bytes);
  });
}
