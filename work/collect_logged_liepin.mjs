import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {collectLiepin} from './liepin_channel.mjs';
import {assertTaskOutputOwnership} from './task_dataset_scope.mjs';
import {writeNativeChannelRows} from './collector_native_sink.mjs';

// Explicit registered task only. This compatibility entry no longer creates an
// unowned desktop directory or writes a separate CSV dataset.
if(!process.argv[2])throw new Error('请提供采集中心已登记的任务输出目录');
const outputDir=path.resolve(process.argv[2]),keyword=process.argv[3]||'测试工程师',city={name:process.argv[4]||'全国'};
const maxRows=Math.max(1,Math.min(100000,Number(process.argv[5])||100));
const owner=JSON.parse(await fs.readFile(path.join(outputDir,'任务归属.json'),'utf8'));
const taskId=owner.task_id;
await assertTaskOutputOwnership({id:taskId,outputDir});
const dir=path.join(outputDir,'断点数据');await fs.mkdir(dir,{recursive:true});
const key=createHash('sha256').update(keyword+'\0'+city.name).digest('hex').slice(0,16);
try{
  const rows=await collectLiepin(keyword,city,{taskId,checkpointPath:path.join(dir,'liepin_'+key+'.json'),maxRows,maxNewRows:1000,maxPages:20});
  await writeNativeChannelRows(outputDir,taskId,rows);
  console.log(JSON.stringify({platform:'猎聘',rows:rows.length,outputDir,detail_status:'list_only'}));
}catch(error){
  if(error.partialRows?.length)await writeNativeChannelRows(outputDir,taskId,error.partialRows);
  console.error('猎聘采集停止：'+(error.code||'navigation_error')+'；断点已保留，请人工检查会话或输出目录');
  process.exitCode=error.code==='OUTPUT_LOCKED'?43:44;
}
