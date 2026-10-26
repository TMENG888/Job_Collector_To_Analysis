import {matchPrompt,validateJobMatch} from './job-browser-match.mjs';

// These cues only guard the model's requirement tiers; they do not replace the
// supervised role classifier or establish that the applicant meets a condition.
const optionalCue=/(?:优先|加分|非必需|非必须|不强制|不作硬性要求|preferred|nice[ -]to[ -]have)/i;
const strictCue=/(?:必须|务必|硬性|仅限|只招|不接受|不得|至少|不少于|不得少于|mandatory|required)/i;
const eligibilityCue=/(?:本科|硕士|博士|大专|专科|学历|学位|毕业|届|在读|工作经验|\d+\s*年.*经验|经验.*\d+\s*年|到岗|出勤|每周|实习.{0,15}(?:个月|周|天)|连续.{0,10}(?:个月|周|天)|线下面试|线下.{0,5}面试|工作地点|工作地址|持有.{0,15}(?:证|执照))/i;

function tier(row){
  const quote=row.jd_evidence||'',declared=row.requirement_type;
  // A mixed mandatory/optional quotation cannot be softened by model metadata.
  if(strictCue.test(quote.replace(/非必须|非必需|不强制|不作硬性要求/g,'')))return 'hard';
  if(optionalCue.test(quote))return 'preferred';
  if(eligibilityCue.test(quote))return 'hard';
  if(declared==='core')return 'core';
  // Unknown/legacy tiers and unsupported claims of optionality fail closed.
  return 'hard';
}

export function validateDesktopJobMatch(value,resume,job){
  const base=validateJobMatch({...value,questions:[]},resume,job);
  function enrich(rows,raw){
    return rows.map(row=>{const original=raw.find(r=>r?.jd_evidence?.trim()===row.jd_evidence)||{};return {...row,requirement_type:tier({...original,jd_evidence:row.jd_evidence})};});
  }
  const allMatches=enrich(base.matches,value.matches),allGaps=enrich(base.gaps,value.gaps);
  const preferredMatches=allMatches.filter(r=>r.requirement_type==='preferred');
  const preferredGaps=allGaps.filter(r=>r.requirement_type==='preferred');
  const matches=allMatches.filter(r=>r.requirement_type!=='preferred');
  const gaps=allGaps.filter(r=>r.requirement_type!=='preferred');
  const blockingGaps=gaps.filter(r=>r.requirement_type==='hard');
  const questions=[],informationalQuestions=[];
  const unresolvedHard=job.description.split(/[。；;\n]/).map(s=>s.trim()).filter(Boolean).some(clause=>
    tier({jd_evidence:clause,requirement_type:'core'})==='hard'&&!allMatches.some(m=>m.jd_evidence.includes(clause)));
  for(const item of (Array.isArray(value.questions)?value.questions:[]).slice(0,5)){
    if(typeof item==='string'){questions.push(item.slice(0,180));continue;}
    if(!item||typeof item.question!=='string'){
      questions.push('模型的问题结构无效，需要复核');continue;
    }
    const text=item.question.slice(0,180),quote=typeof item.jd_evidence==='string'?item.jd_evidence.trim():'';
    const valid=quote.length>=5&&quote.length<=300&&job.description.includes(quote);
    const unboundQualification=!quote&&eligibilityCue.test(text)&&unresolvedHard;
    if(item.type==='informational'&&!unboundQualification&&(!quote||(valid&&tier({jd_evidence:quote,requirement_type:'core'})!=='hard'))){
      informationalQuestions.push(text);
    }else questions.push(text);
  }
  const denominator=matches.length+gaps.length;
  const result={...base,matches,gaps,preferredMatches,preferredGaps,blockingGaps,questions,informationalQuestions,coverage:denominator?matches.length/denominator:0,matchPolicy:'tiered-v1'};
  if(blockingGaps.length||questions.length){
    result.greeting='';result.safetyNote='硬性资格缺少证据或有阻塞问题，仅保留复核，不自动沟通';
  }
  return result;
}

export const desktopMatchPrompt=matchPrompt+`
桌面匹配规则（以下细化并覆盖上方JSON字段结构）：必须区分硬性资格、核心职责/技能、可选加分项。matches与gaps每项增加requirement_type，取值hard/core/preferred。hard包括JD明确的学历、届次、经验年限、地点、出勤、到岗、实习时长、必须证书及明确强制条件；core是其余主要职责与普通技能；preferred只能用于JD明确写“优先/加分/非必需”的条款。不得把有“必须/至少/不少于/硬性”的条款标为preferred或core。混合条款请拆成独立的连续原文证据，不把核心要求与加分项合成同一项。简历未提供证据不等于不具备；未知hard列入gaps，未知core也列入gaps但不自动视为硬性不符。可选项不影响核心证据覆盖。
questions改为对象数组：{"question":"问题","type":"blocking或informational","jd_evidence":"对应JD连续原文；JD未写明的普通咨询留空"}。只有明确必需资格不符/未知才用blocking；薪资、面试流程等普通咨询或JD根本未提出的到岗/周期条件用informational，不能编造必需条件放入gaps。不要仅因有普通咨询或加分项缺口拒绝草拟招呼，但招呼不得声称已满足未知条件，逐字引用至少一段已匹配简历事实，不补写身份与联系方式。`;
