import fs from 'node:fs/promises';
import path from 'node:path';
import {nativeTaskCounts} from './collector_native_sink.mjs';
import {taskJobStatistics} from './task_job_statistics.mjs';
import {liveCollectionMetrics} from './live_collection_metrics.mjs';
import {collectionCounts,publicCountChannels} from './collection_counts.mjs';

export async function readTaskCollectionMetrics(task,{manifest=null,countCsvRows=async()=>0,readLegacy=liveCollectionMetrics}={}){
  const native=await nativeTaskCounts(task.outputDir,task.id);
  const database=await fs.stat(path.join(task.outputDir,'统一采集数据.sqlite')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  let jobStats=null,jobStatsError=null;
  if(database)try{jobStats=await taskJobStatistics(task.outputDir,task.id);}catch(error){jobStatsError=error.message;}
  const liveCollection=database?{task_id:task.id,source:'sqlite',updatedAt:jobStats?.updatedAt||new Date().toISOString(),publicRows:publicCountChannels.reduce((sum,key)=>sum+(native.platformCounts[key]||0),0),platformCounts:{...native.platformCounts},details:[]}:await readLegacy(task);
  const csv={};
  if(!database)for(const key of ['zhaopin','yupao','boss'])csv[key]=await countCsvRows(path.join(task.outputDir,key+'_标准化数据.csv'));
  const counts=collectionCounts({native,live:liveCollection,manifest,csv});
  Object.assign(liveCollection.platformCounts,counts.platformCounts);liveCollection.publicRows=counts.publicRows;
  return {native,liveCollection,counts,jobStats,jobStatsError};
}
