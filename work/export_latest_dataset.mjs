import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {updateUnifiedDataset} from './unified_collection_store.mjs';
import {latestCsvName,latestWorkbookName,latestManifestName} from './latest_dataset.mjs';
import {parseChannelCsv} from './public_channel_csv.mjs';
import {writeJsonAtomic,renameWithSharingRetry} from './collector_storage.mjs';
import {assertCollectorResources} from './collector_resources.mjs';

export function excelSafeText(value){
  const text=String(value??'').toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'').slice(0,32766);
  return /^[=+@-]/.test(text)?`'${text}`:text;
}

export async function buildLatestWorkbook(content,destination,{previewPath}={}){
  const {Workbook,SpreadsheetFile}=await import('@oai/artifact-tool');
  const {jobColumnAliases}=await import('./job_dataset.mjs');
  const rows=parseChannelCsv(content);
  const columns=[...new Set(['job_name','company_name','city','salary','experience','education','platform','job_id','job_description',...rows.flatMap(Object.keys)])];
  const wb=Workbook.create(),sheet=wb.worksheets.add('岗位数据');
  const clean=excelSafeText;
  sheet.getRangeByIndexes(0,0,rows.length+1,columns.length).values=[columns.map(key=>jobColumnAliases[key]||key),...rows.map(row=>columns.map(key=>clean(row[key])))];
  const range=sheet.getRangeByIndexes(0,0,rows.length+1,columns.length);
  range.format.font={name:'Microsoft YaHei',size:10,color:'#1F2937'};
  range.format.columnWidth=22;range.format.rowHeight=22;
  sheet.getRangeByIndexes(0,0,1,columns.length).format={fill:'#155E75',font:{name:'Microsoft YaHei',size:10,bold:true,color:'#FFFFFF'},horizontalAlignment:'center'};
  sheet.getRangeByIndexes(0,8,rows.length+1,1).format.columnWidth=65;
  sheet.freezePanes.freezeRows(1);sheet.freezePanes.freezeColumns(2);sheet.showGridLines=false;
  wb.recalculate();
  if(previewPath){
    console.log((await wb.inspect({kind:'table',range:'岗位数据!A1:F4',include:'values,formulas',tableMaxRows:4,tableMaxCols:6})).ndjson);
    const image=await wb.render({sheetName:'岗位数据',range:'A1:F4',scale:1.5});
    await fs.writeFile(previewPath,new Uint8Array(await image.arrayBuffer()));
  }
  const temporary=`${destination}.tmp-${process.pid}.xlsx`;
  const output=await SpreadsheetFile.exportXlsx(wb);await output.save(temporary);
  await renameWithSharingRetry(temporary,destination);
  return rows.length;
}

export async function exportLatestDataset(task,{resources=assertCollectorResources,build=buildLatestWorkbook}={}){
  const statusPath=path.join(task.outputDir,'最新导出状态.json');
  await writeJsonAtomic(statusPath,{status:'running',startedAt:new Date().toISOString(),task_id:task.id});
  try{
    const refreshed=await updateUnifiedDataset(task,{publishCsv:true});
    if(refreshed.latestSnapshotError)throw new Error(refreshed.latestSnapshotError);
    const manifestPath=path.join(task.outputDir,latestManifestName);
    const snapshot=JSON.parse(await fs.readFile(manifestPath,'utf8'));
    if(!snapshot.rows)throw new Error('尚无已保存岗位数据');
    const content=await fs.readFile(path.join(task.outputDir,latestCsvName),'utf8');
    if(createHash('sha256').update(content).digest('hex')!==snapshot.hash)throw new Error('候选数据正在更新，请重试导出');
    let warning='';
    try{
      await resources(4*1024**3);
      const workbookRows=await build(content,path.join(task.outputDir,latestWorkbookName));
      const current=JSON.parse(await fs.readFile(manifestPath,'utf8'));
      await writeJsonAtomic(manifestPath,{...current,workbook:latestWorkbookName,workbookRows,workbookHash:snapshot.hash,workbookUpdatedAt:new Date().toISOString()});
    }catch(error){warning=`CSV已更新，可用于洞察；Excel未更新：${error.message}`;}
    const result={task_id:task.id,status:warning?'partial':'completed',rows:snapshot.rows,updatedAt:new Date().toISOString(),csv:latestCsvName,workbook:warning?null:latestWorkbookName,warning};
    await writeJsonAtomic(statusPath,result);return result;
  }catch(error){await writeJsonAtomic(statusPath,{task_id:task.id,status:'failed',error:error.message,updatedAt:new Date().toISOString()});throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(await exportLatestDataset(JSON.parse(process.argv[2]))));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
