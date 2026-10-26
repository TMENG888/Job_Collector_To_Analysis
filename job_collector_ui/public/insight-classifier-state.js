const percent=value=>value==null?'未提供':(value*100).toFixed(1)+'%';
export function classifierAcceptanceIssues(evaluation){
  if(!evaluation||evaluation.eligible===true)return [];
  const issues=[],test=evaluation.test,validation=evaluation.validation;
  const count=(value,min,label)=>{if(!Number.isFinite(value)||value<min)issues.push(`${label} ${Number.isFinite(value)?value:'未提供'}，需 ≥${min}`);};
  const score=(value,min,label)=>{if(!Number.isFinite(value)||value<min)issues.push(`${label} ${percent(value)}，需 ≥${min*100}%`);};
  count(test?.n,40,'测试样本');count(test?.positive,10,'测试正例');count(test?.negative,10,'测试负例');
  score(test?.precision,.85,'测试精确率');score(test?.recall,.65,'测试召回率');
  score(validation?.precision,.85,'验证精确率');score(validation?.recall,.65,'验证召回率');
  if(evaluation.deploymentEligible===false)issues.push('额外发布验收未通过');
  return issues.length?issues:['发布验收未通过，保留本轮标签'];
}
export function classifierAnalysisState(state){
  const role=state?.screening?.role||'当前岗位',run=state?.run;
  if(!state)return {kind:'loading',title:'正在读取分类器',reason:'正在核对当前数据集的模型状态…'};
  if(state.screening?.ready===true)return {kind:'ready',title:role+' · 可分析',reason:run?.status==='completed'&&run.eligible===false?'使用已有合格模型；本轮候选未替换。':'使用当前岗位的合格专用分类器。'};
  if(state.analysis?.ready===true&&state.analysis.mode==='candidate-trial'&&state.analysis.runId===run?.id)return {kind:'trial',title:role+' · 可试分析',reason:'候选未达标，允许全量试分析；结果仅供探索，不替换合格模型。'};
  if(['preparing','labeling','training'].includes(run?.status))return {kind:'pending',title:role+' · 训练中',reason:'训练完成后，可生成全量分析；未达标候选仅供试分析。'};
  if(state.analysis?.error)return {kind:'blocked',title:role+' · 模型不可用',reason:state.analysis.error};
  if(run?.status==='completed'&&run.eligible===false)return {kind:'blocked',title:role+' · 候选未达标',reason:classifierAcceptanceIssues(run.evaluation).join('；')+'。需补充有效样本后重新训练。'};
  return {kind:'blocked',title:role+' · 待训练',reason:state.analysis?.error||state.screening?.error||'请先确认标注规范，再联合标注并训练。'};
}
export function insightReportContext({report,inputFile='',running=false,normalize=value=>String(value||'')}={}){
  const stale=!!report&&normalize(inputFile)!==normalize(report.input_file);
  return {stale,hideReport:stale&&!running,title:stale&&!running?'当前数据集尚未生成报告':null};
}
