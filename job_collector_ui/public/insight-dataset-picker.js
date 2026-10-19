import {finalDatasetCatalog,localPathKey} from './insight-transfer.js';

// Knowledge metadata is sufficient on its own. Slow/unavailable collectors must
// not make an otherwise healthy SQLite catalog appear disconnected.
export async function loadInsightCatalog(api) {
  const data=await api('/api/insights/datasets');
  if(!Array.isArray(data?.datasets))throw new Error('数据源目录返回格式异常');
  if(data.catalog==='knowledge-v1'||data.datasets.some(item=>item.resolution==='knowledge')) {
    return [{path:'kb://all',name:'全部岗位知识库',role:'自动识别',resolution:'knowledge',format:'sqlite'},
      ...data.datasets.filter(item=>item.resolution==='knowledge'&&item.path!=='kb://all')];
  }
  const taskData=await api('/api/tasks');
  return finalDatasetCatalog(data.datasets,taskData.tasks||[]);
}

export function populateInsightPickers(document,datasets) {
  for(const [id,placeholder] of [['insightDataset','选择岗位数据集']]) {
    const select=document.getElementById(id);if(!select)continue;
    const previous=id==='insightDataset'?document.querySelector('#insightForm input[name="inputFile"]')?.value:select.value;
    const option=document.createElement('option');option.value='';option.textContent=placeholder;
    if(id==='insightDataset')option.disabled=true;
    select.replaceChildren(option);
    for(const item of datasets) {
      const entry=document.createElement('option');entry.value=item.path;
      entry.textContent=`${item.name} · ${item.resolution==='knowledge'?'数据库直连':item.format||'xlsx'}${item.collecting?' · 采集中':''}`;
      select.append(entry);
    }
    let selected=datasets.find(item=>localPathKey(item.path)===localPathKey(previous))?.path||'';
    if(id==='insightDataset'&&previous&&!selected){
      const current=document.createElement('option');current.value=previous;current.textContent='当前已选数据源';select.append(current);selected=previous;
    }
    select.value=selected;
  }
}
