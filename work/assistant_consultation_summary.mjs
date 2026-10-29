import {salarySampleSummary} from '../job_collector_ui/public/salary-sample-summary.js';
const units={day:'元/天',hour:'元/时',month:'元/月',year:'元/年'};
const cell=s=>String(s).replace(/[|\r\n]/g,' ');

// Summarize deterministic statistics; retain full benchmark objects for inspection.
export function summarizeConsultationSalary(segments,{verified=false,cities=[],roles=[]}={}){
  const rows=[];let inferred=false;
  for(const segment of segments){
    const stage=segment.stage==='internship'?'实习':'正式';
    const benchmark=segment.salary_benchmark;
    if(!benchmark){rows.push(`| — | ${stage} | — | — | 查询未成功 |`);continue;}
    const groups=benchmark.segments?.length?benchmark.segments:[benchmark];
    for(const group of groups){
      const location=cell([group.city||cities.join('、')||'城市未限定',group.role||roles.join('、')].filter(Boolean).join(' · '));
      let found=false;
      for(const [period,stats] of Object.entries(group.groups||{})){
        if(!stats.count)continue;
        found=true;inferred ||= stats.period_inferred_rows>0;
        rows.push(`| ${location} | ${stage} | ${units[period]} | ${stats.count} | ${cell(salarySampleSummary(stats))} |`);
      }
      if(!found)rows.push(`| ${location} | ${stage} | — | 0 | 暂无可用薪资 |`);
    }
  }
  return ['| 城市／方向 | 阶段 | 单位 | 样本 | 原始报价分布 |','| --- | --- | --- | ---: | --- |',...rows].join('\n')+
    '\n\n'+(verified?'以上是本轮方向核验的JD样本，非随机抽样；':'以上是本库同方向岗位样本；')+'中位数按每条报价区间中点计算，报价范围取原始区间端点。小样本仅描述这些岗位，不代表市场行情；日薪与月薪不直接折算。'+(inferred?'部分月薪周期按招聘格式推定，需确认。':'');
}
