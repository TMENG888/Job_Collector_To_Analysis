import {rolesInQuestion} from './job_assistant_roles.mjs';

export function wantsSalaryComparison(message){
  const text=String(message||'');
  return /薪资|薪酬|工资|待遇|月薪|年薪|日薪/.test(text)&&/对比|比较|比起|相比|比其他/.test(text)&&(/其他.{0,12}(?:岗位|职位|方向)|其他数据库|各(?:岗位|方向)|不同(?:岗位|职位)|全库/.test(text)||rolesInQuestion(text).length>1);
}

export function requireSalaryComparison(plan,message){
  if(!wantsSalaryComparison(message))return plan;
  const comparison={id:'salary-comparison',kind:'salary_comparison',question:'查询同城市、同招聘阶段的其他岗位薪资，逐方向比较并汇总差异'};
  const parts=plan.parts.filter(p=>p.kind!=='salary_comparison');
  while(parts.length>3){const general=parts.findLastIndex(p=>p.kind==='general');parts.splice(general>=0?general:parts.length-1,1);}
  return {...plan,parts:[...parts,comparison]};
}

export function salaryComparisonSummary(segments,baseRoles){
  const groups=segments.flatMap(segment=>{
    const benchmark=segment.salary_benchmark;
    return (benchmark?.segments?.length?benchmark.segments:benchmark?[benchmark]:[]).map(group=>({...group,stage:segment.stage}));
  });
  const lines=[];
  for(const base of groups.filter(g=>baseRoles.includes(g.role))){
    for(const other of groups.filter(g=>!baseRoles.includes(g.role)&&g.city===base.city&&g.stage===base.stage)){
      for(const period of ['month','day','hour','year']){
        const a=base.groups?.[period],b=other.groups?.[period];
        if(!a?.published||!b?.published||!Number.isFinite(a.median)||!Number.isFinite(b.median)||a.median<=0)continue;
        const difference=b.median-a.median;
        lines.push(`${other.city} · ${other.role}的报价中点中位数${difference===0?'与'+base.role+'相同':`比${base.role}${difference>0?'高':'低'} ${Math.abs(difference).toLocaleString('en-US')} ${ {month:'元/月',day:'元/天',hour:'元/时',year:'元/年'}[period]}（${Math.abs(difference/a.median*100).toFixed(1)}%）`}，样本分别为 ${b.count} / ${a.count} 条。`);
      }
    }
  }
  return (lines.length?lines.map(line=>'- '+line).join('\n'):'部分方向缺少足量的同城市、同招聘阶段及同薪资周期样本，暂不计算差额。')+'\n\n以上仅比较库内招聘报价；经验、学历、渠道和采集时间构成仍可能不同，不能据此推断职业收益或个人涨薪。';
}
