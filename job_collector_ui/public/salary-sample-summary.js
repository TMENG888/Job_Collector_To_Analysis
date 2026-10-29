const amount=n=>Number(n).toLocaleString('zh-CN',{maximumFractionDigits:1});

// A small sample can describe its own quotes without supporting market inference.
export function salarySampleSummary(group,{format=amount,includeQuotes=false}={}){
  if(!group?.count)return '暂无可用报价';
  if(!Number.isFinite(group.median))return '历史结果未保存样本中位数，请重新查询';
  const lines=[`报价中点中位数 ${format(group.median)}`];
  if(Number.isFinite(group.quote_min)&&Number.isFinite(group.quote_max))lines.push(`报价范围 ${format(group.quote_min)}–${format(group.quote_max)}`);
  if(group.published&&Number.isFinite(group.p25)&&Number.isFinite(group.p75))lines.push(`中间50% ${format(group.p25)}–${format(group.p75)}`);
  if(group.count<5)lines.push('小样本，仅供参考');
  if(includeQuotes&&group.raw_quotes?.length)lines.push(`原始报价：${group.raw_quotes.join('、')}`);
  return lines.join('；');
}
