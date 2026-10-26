// Install small collector dependencies outside C: while retaining Node's standard
// package resolution. Never replace an existing node_modules directory/junction.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function installCollectorDependencies(installDir, cacheDir) {
  if (!installDir || !cacheDir || !path.isAbsolute(installDir) || !path.isAbsolute(cacheDir)) {
    throw Error('请传入依赖安装目录与 npm 缓存目录的绝对路径；默认不向 C 盘写入依赖');
  }
  const target = path.resolve(installDir), cache = path.resolve(cacheDir);
  if (target === path.parse(target).root || target === root || target.startsWith(root + path.sep)) {
    throw Error('依赖安装目录必须是项目外的独立目录');
  }
  const link = path.join(root, 'node_modules'), destination = path.join(target, 'node_modules');
  const targetEntries = await fs.readdir(target).catch(error=>{if(error.code!=='ENOENT')throw error;return [];});
  if (targetEntries.length) {
    const manifest = await fs.readFile(path.join(target,'package.json'),'utf8').then(JSON.parse).catch(()=>null);
    if (manifest?.name !== 'job-collector-workspace') throw Error('依赖安装目录已有其他内容，未覆盖；请使用空目录或本项目专属依赖目录');
  }
  const existing = await fs.lstat(link).catch(error => { if(error.code !== 'ENOENT') throw error; return null; });
  if (existing) {
    if (!existing.isSymbolicLink() || path.resolve(await fs.realpath(link)) !== path.resolve(destination)) {
      throw Error('项目已有 node_modules；为保护既有目录/链接，未覆盖。请使用既有依赖安装方案');
    }
  }
  await fs.mkdir(target, {recursive:true});
  await fs.mkdir(cache, {recursive:true});
  for (const name of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(root, name), path.join(target, name));
  // Run npm's JavaScript entry point directly, without shell quoting or lifecycle scripts.
  const npmRoot = path.dirname(process.execPath);
  const candidates = [path.join(npmRoot, 'node_modules/npm/bin/npm-cli.js'), path.join(npmRoot, '../node_modules/npm/bin/npm-cli.js')];
  let npmCli;
  for (const candidate of candidates) if (await fs.access(candidate).then(()=>true,()=>false)) {npmCli=candidate;break;}
  if (!npmCli) throw Error('当前 Node 安装没有 npm-cli.js；请使用带 npm 的 Node 运行安装脚本');
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[npmCli,'ci','--prefix',target,'--cache',cache,'--ignore-scripts','--no-audit','--no-fund'],{stdio:'inherit',windowsHide:true});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`npm ci 失败（${code}）`)));
  });
  if (!existing) await fs.symlink(destination, link, process.platform==='win32'?'junction':'dir');
  console.log('Collector dependencies installed; project node_modules points to external dependency directory.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installCollectorDependencies(process.argv[2],process.argv[3]).catch(error=>{console.error(error.message);process.exitCode=1;});
}
