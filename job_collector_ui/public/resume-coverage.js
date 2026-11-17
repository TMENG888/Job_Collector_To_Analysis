export const coverageVersion='jd-requirement-coverage-v1';
export function requirementCoverage(assessment){
  if(assessment?.version!==coverageVersion||assessment.complete!==true||!Array.isArray(assessment.items))return null;
  const ids=new Set();for(const r of assessment.items){if(!r.id||ids.has(r.id)||typeof r.optional!=='boolean'||!['met','partial','not_evidenced'].includes(r.status)||!r.jd_evidence||(!r.resume_evidence&&r.status!=='not_evidenced'))return null;ids.add(r.id);}
  const main=assessment.items.filter(r=>!r.optional),matched=main.filter(r=>r.status==='met').length,partial=main.filter(r=>r.status==='partial').length;
  return {total:main.length,matched,partial,notEvidenced:main.length-matched-partial,optional:assessment.items.length-main.length,percentage:main.length?100*matched/main.length:null};
}
export function coverageRankedJobs(jobs,assessments={}){
  return jobs.toSorted((a,b)=>{const x=requirementCoverage(assessments[a.key])?.percentage,y=requirementCoverage(assessments[b.key])?.percentage;return (x==null?1:0)-(y==null?1:0)||(x==null?0:y-x)||a.rank-b.rank;});
}
