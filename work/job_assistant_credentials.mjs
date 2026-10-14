import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export const assistantProviders=Object.freeze({
  deepseek:{label:'DeepSeek',endpoint:'https://api.deepseek.com/chat/completions',defaultModel:'deepseek-flash'},
  qwen:{label:'通义千问 DashScope',endpoint:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',defaultModel:''},
});
// All secrets travel through stdin, never process arguments or shell interpolation.
// Use .NET directly: inherited PowerShell module paths may target a different PS version.
const dpapiScripts={
  encrypt:`$ErrorActionPreference='Stop'; [void][Reflection.Assembly]::LoadWithPartialName('System.Security'); $bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); try { [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))) } finally { [Array]::Clear($bytes,0,$bytes.Length) }`,
  decrypt:`$ErrorActionPreference='Stop'; [void][Reflection.Assembly]::LoadWithPartialName('System.Security'); $encrypted=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $bytes=[Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); try { [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes)) } finally { [Array]::Clear($bytes,0,$bytes.Length) }`,
};
export function windowsProtect(operation,value){
  if(process.platform!=='win32')throw new Error('本机密钥保存仅支持Windows DPAPI');
  if(!Object.hasOwn(dpapiScripts,operation))throw new Error('不支持该加密操作');
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',dpapiScripts[operation]],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',done=false;
    const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(new Error('本机密钥加密或解密失败，请在当前Windows账户重新配置'));else resolve(output.trim());};
    const timer=setTimeout(()=>{child.kill();finish(true);},15000);
    child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(output.length>20000){child.kill();finish(true);}});
    // Never forward PowerShell diagnostics: errors may contain secret arguments.
    child.stderr.resume();child.on('error',()=>finish(true));child.stdin.on('error',()=>finish(true));
    child.on('close',code=>finish(code!==0||!output));
    child.stdin.end(value);
  });
}
export function createAssistantCredentialStore(configPath,{protect=windowsProtect}={}){
  let queue=Promise.resolve();
  async function read(){try{return JSON.parse(await fs.readFile(configPath,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('本机模型配置不可读取，请重新配置');}}
  function metadata(config){return {configured:!!(config?.encrypted_key&&Object.hasOwn(assistantProviders,config.provider)&&config.model),provider:assistantProviders[config?.provider]?.label||'DeepSeek',provider_id:Object.hasOwn(assistantProviders,config?.provider)?config.provider:'deepseek',model:config?.model||'',storage:'Windows DPAPI · 当前用户加密',consent_required:false,default_on_send:true};}
  return {
    status:async()=>metadata(await read()),
    load:async()=>{const config=await read();if(!metadata(config).configured)return {};return {JOB_ASSISTANT_PROVIDER:config.provider,JOB_ASSISTANT_MODEL:config.model,JOB_ASSISTANT_API_KEY:await protect('decrypt',config.encrypted_key)};},
    save(body){
      const task=queue.then(async()=>{
        const provider=String(body?.provider||''),model=String(body?.model||'').trim(),key=String(body?.apiKey||'').trim();
        if(!Object.hasOwn(assistantProviders,provider))throw new Error('不支持该模型供应商');
        if(!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(model))throw new Error('请填写有效模型ID');
        if(key.length<12||key.length>512||/\s/.test(key))throw new Error('请填写有效的新API密钥');
        const encrypted_key=await protect('encrypt',key);
        const config={version:1,provider,model,encrypted_key,updated_at:new Date().toISOString()};
        await fs.mkdir(path.dirname(configPath),{recursive:true});
        const temporary=configPath+'.'+randomUUID()+'.tmp';
        try{await fs.writeFile(temporary,JSON.stringify(config),{mode:0o600,flag:'wx'});await fs.rename(temporary,configPath);}
        finally{await fs.unlink(temporary).catch(()=>{});}
        return metadata(config);
      });
      queue=task.catch(()=>{});return task;
    },
  };
}
