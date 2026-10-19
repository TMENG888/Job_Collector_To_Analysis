import {roleFamilies} from './job_knowledge_schema.mjs';

// Query aliases only. Admission/classifier rules remain unchanged.
const aliases={
  '嵌入式开发':/嵌入式软件开发|单片机|固件|\bBSP\b/i,
  '智能体/大模型应用':/\bLLM\b/i,
  'AI漫剧创作':/漫剧/i,
  '测试工程':/测试开发|自动化测试/i,
  '网络安全':/信息安全|渗透测试/i,
  '运维/云平台':/\bSRE\b|\bDevOps\b/i,
  '通用软件开发':/软件开发|软件工程师|开发工程师/i,
};
export function roleIntentText(value){
  // Quoted job descriptions are evidence, not instructions to change scope.
  return String(value||'').replace(/```[\s\S]*?```/g,'').replace(/^\s*>.*$/gm,'')
    .split(/(?:JD原文|岗位原文|招聘原文|引用原文)\s*[:：]/i)[0];
}
function mentions(value){
  const text=roleIntentText(value),found=[];
  for(const family of roleFamilies){
    for(const re of [new RegExp(family.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'),family.query,aliases[family.name]].filter(Boolean)){
      for(const match of text.matchAll(new RegExp(re.source,re.flags.replace(/[gy]/g,'')+'g'))){
        found.push({role:family.name,start:match.index,end:match.index+match[0].length});
      }
    }
  }
  // Prefer the specific phrase: 网络运维 is not a second, broad 运维 query;
  // 大模型算法 is not also the generic 算法 family.
  return found.filter(m=>!found.some(other=>(other.start<=m.start&&other.end>=m.end&&(other.end-other.start>m.end-m.start))||((m.role==='通用软件开发'&&other.role!==m.role||m.role==='机器学习/算法'&&other.role==='大模型算法')&&other.start<m.end&&other.end>m.start)))
    .sort((a,b)=>a.start-b.start).filter((m,i,all)=>!all.slice(0,i).some(x=>x.role===m.role&&x.start===m.start));
}
export const rolesInQuestion=value=>[...new Set(mentions(value).map(m=>m.role))];

export function resolveRoleChange(message,previous=[]){
  const text=roleIntentText(message);
  if(/所有岗位|全部岗位|不限岗位|(?:取消|去掉|清空|移除|放开)(?:所有|当前|的)?岗位(?:方向)?(?:条件|限制|筛选)|岗位(?:方向)?(?:条件|限制)?不限/.test(text))return {changed:true,unrestricted:true,roles:[]};
  const positives=[],removed=[],additions=[];
  for(const clause of text.split(/[，,。；;\n]/)){
    if(/(?:不|不要|无需|不用)(?:再)?(?:加入|添加|新增|切换|改查)/.test(clause))continue;
    const switchAt=clause.match(/(?:切换|换|改|转)(?:查询|查|看)?(?:到|成|为)|(?:只看|只查|仅看|仅查)/);
    const target=switchAt?clause.slice(switchAt.index+switchAt[0].length):clause;
    if(/(?:不|不要|无需|不用)(?:再)?(?:加入|添加|新增|切换|改查)/.test(target))continue;
    const hits=mentions(target);
    let verb='set';
    for(const hit of hits){
      const prefix=target.slice(0,hit.start);
      const action=prefix.match(/(?:加入|添加|新增|增加|补充|也看|再看|同时看|移除|去掉|删除|排除|不看|不查|不要|不找|不考虑|保留|仍看|只看|只查|改看|改查|换成|切换到)/g)?.at(-1);
      if(action)verb=/移除|去掉|删除|排除|不看|不查|不要|不找|不考虑/.test(action)?'remove':/加入|添加|新增|增加|补充|也看|再看|同时看/.test(action)?'add':'set';
      (verb==='remove'?removed:verb==='add'?additions:positives).push(hit.role);
    }
  }
  const unique=a=>[...new Set(a)];
  const changed=!!(positives.length||removed.length||additions.length);
  if(changed){
    const roles=unique([...(positives.length?positives:previous).filter(r=>!removed.includes(r)),...additions]);
    if(roles.length>4)return {changed:false,question:'一次最多比较4个岗位方向，请分批分析。'};
    return {changed:true,roles,focusRoles:unique([...positives,...additions]),question:roles.length?'':'已移除所选岗位方向。请指定新方向，或说“不限岗位”。'};
  }
  // Do not silently interpret all sales jobs as technical sales, or reuse stale
  // testing/operations conditions for an unsupported new occupation.
  if(/销售/.test(text)&&!/不看销售|不要销售|不查销售|不加入销售/.test(text))return {changed:false,question:'“销售”包含多种岗位；当前知识库支持的对应方向是“销售工程师（技术销售）”，不代表所有销售岗。是否查询销售工程师？也可以指定其他岗位方向。'};
  if(/(?:切换到|换成|改查|只查|只看|加入|添加)(?:岗位[:：]?)?\s*\S+/.test(text)&&!/(?:城市|地区|学历|经验|北京|上海|广州|深圳|杭州|成都|本科|硕士|博士|实习|全职|市场|统计|薪资|月薪|日薪|年薪|年包|校招|社招|秋招|春招|正式|不限)/.test(text))return {changed:false,question:'未识别到支持的岗位方向，请提供具体岗位名称；本轮未沿用旧方向查数。'};
  return {changed:false};
}
