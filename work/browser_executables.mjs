import fs from 'node:fs/promises';

// Both are complete, installed vendor runtimes. Never fall back to the source EXE when switching.
export const standardBrowserExecutable='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const isolatedBrowserExecutable='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
export async function resolveBrowserExecutable(kind='standard'){
  if(!['standard','isolated'].includes(kind))throw Error('无效浏览器程序类型');
  const executable=kind==='isolated'?isolatedBrowserExecutable:standardBrowserExecutable;
  try{await fs.access(executable);}catch{throw Error(`未找到完整的${kind==='isolated'?' Edge':' Chrome'}安装，请安装后重试；不会退回相同 EXE`);}
  return executable;
}
