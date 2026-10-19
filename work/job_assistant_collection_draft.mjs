import {parseCollectionIntent,collectionEditRequest,collectionRoleKey} from './job_assistant_collection_intent.mjs';

const salesKeywords=['销售','销售工程师','销售代表','销售专员','客户经理','大客户经理','渠道销售','商务拓展','业务拓展','销售顾问','区域销售','电话销售','网络销售'];
const relatedGroups=[salesKeywords,['测试','测试工程师','软件测试','自动化测试','测试开发'],['运维','运维工程师','系统运维','网络运维','云运维','SRE']];
export function relatedCollectionKeywords(subject){
  const key=collectionRoleKey(subject);
  return relatedGroups.find(group=>group.some(word=>collectionRoleKey(word)===key))||[subject];
}
export function collectionDraftRequest(message,state={},now=Date.now()){
  const intent=parseCollectionIntent(message),editing=collectionEditRequest(message);
  // Only server-stored, unexecuted proposals in this session are editable.
  // Never recover a cancelled/executed card or use career/history text as consent.
  const latest=(state.actions||[]).at(-1);
  const plan=latest&&['pending','expired'].includes(latest.status)&&['create','create_start'].includes(latest.action)&&latest.config&&now-latest.created_at<=30*60*1000?latest:null;
  if(!editing||!intent.domain||['blocked','ambiguous'].includes(intent.kind)||intent.reason_code==='quoted_evidence')return {intent,editing:false};
  const subject=intent.subject||plan?.subject||plan?.config.keywords?.[0]||'';
  if(!subject)return {intent:{...intent,kind:'ambiguous',reason_code:'missing_draft_subject',question:'当前会话没有可修改的待确认采集方案。请先说明岗位；尚未创建或启动任务。'},editing:true};
  const same=plan&&collectionRoleKey(subject)===collectionRoleKey(plan.subject||plan.config.keywords?.[0]);
  const allowed=same&&!/(?:创建|新建)并(?:启动|开始)/.test(message)?[plan.action]:intent.allowed_actions;
  if(!allowed.some(action=>['create','create_start'].includes(action)))return {intent:{...intent,kind:'ambiguous',reason_code:'missing_draft_authorization',question:'请明确要采集的岗位并新建方案；不能用修改范围的短句启动已有任务。'},editing:true};
  return {intent:{...intent,domain:true,kind:'command',subject,allowed_actions:allowed,reason_code:same?'edit_stored_draft':'explicit_command'},editing:true,plan:same?plan:null};
}

export function routeCollectionRequest(message,state={},now=Date.now()){
  const intent=parseCollectionIntent(message);
  if(!intent.domain||!intent.context_required)return intent.domain;
  // City/keyword edits also exist in job search. Without a matching collection
  // draft, leave those short messages in their ordinary career-query workflow.
  return collectionDraftRequest(message,state,now).intent.reason_code==='edit_stored_draft';
}

// Apply only the human-requested dimensions; a planner cannot silently reset
// cities/platforms/pace/target while expanding keywords, or vice versa.
export function collectionDraftArgs(message,state,args,{cities,platforms,now=Date.now()}){
  const context=collectionDraftRequest(message,state,now),base=context.plan?.config;
  const allCities=/(?:(?:全(?:部)?|所有)城市|全国|不限城市|城市不限)/.test(message),allPlatforms=/(?:全(?:部)?|所有)(?:平台|渠道)/.test(message);
  const expand=/(?:相关|类似|同类).{0,14}(?:关键词|检索词|搜索词)|(?:扩展|拓展|补充|生成).{0,20}(?:关键词|检索词|搜索词)/.test(message);
  const selectedCities=cities.filter(city=>message.includes(city));
  const selectedPlatforms=Object.entries(platforms).filter(([key,name])=>message.includes(name)||message.includes(key)).map(([key])=>key);
  const remove=/去掉|移除|删掉|删除|减少/.test(message),append=/增加|添加|补充|再加|加上/.test(message);
  const pace=/保守|慢速/.test(message)?'safe':/均衡/.test(message)?'balanced':/快速/.test(message)?'fast':null;
  const cityField=message.match(/(?:城市|地区)(?:改为|改成|换成|设为|[:：])\s*([^，,。；;\n]+)/)?.[1];
  if(cityField&&!allCities&&!selectedCities.length)throw Object.assign(new Error('未识别支持城市'),{code:'COLLECTION_INTENT_CITY_UNSUPPORTED',question:'没有识别到采集中心已支持的指定城市。请提供支持城市，或选择“全部已支持城市”；尚未修改或执行。'});
  const platformField=message.match(/(?:渠道|平台)(?:改为|改成|换成|设为|[:：])\s*([^，,。；;\n]+)/)?.[1];
  if(platformField&&!allPlatforms&&!selectedPlatforms.length)throw Object.assign(new Error('未识别可用渠道'),{code:'COLLECTION_INTENT_PLATFORM_UNSUPPORTED',question:'没有识别到可用的指定渠道，停用渠道不能启用。请指定可用平台；尚未修改或执行。'});
  const merged={...args};
  if(base){
    merged.label=base.label;merged.keywords=base.keywords;merged.cities=base.cities;merged.platforms=base.platforms;merged.pace=base.pace;merged.target_rows=base.target_rows;
    if(base.city_scope==='all'&&!selectedCities.length)merged.city_scope='all';
    if(args.action!==context.plan.action)merged.action=args.action; // authorization rejects escalation
  }
  if(allCities){merged.cities=cities;merged.city_scope='all';}
  else if(selectedCities.length)merged.cities=base&&remove?base.cities.filter(city=>!selectedCities.includes(city)):base&&append?[...new Set([...base.cities,...selectedCities])]:selectedCities;
  if(allPlatforms){merged.platforms=Object.keys(platforms);merged.platform_scope='all';}
  else if(selectedPlatforms.length)merged.platforms=base&&remove?base.platforms.filter(platform=>!selectedPlatforms.includes(platform)):base&&append?[...new Set([...base.platforms,...selectedPlatforms])]:selectedPlatforms;
  if(pace)merged.pace=pace;
  if(expand){
    const subject=context.intent.subject,group=relatedCollectionKeywords(subject);
    const proposed=args.keywords||[];
    if(!Array.isArray(proposed)||proposed.some(word=>typeof word!=='string'))throw new Error('扩展关键词必须是字符串列表');
    if(group.length===1&&!proposed.length)throw Object.assign(new Error('缺少可信相关词'),{code:'COLLECTION_INTENT_KEYWORDS_REQUIRED',question:'当前岗位尚无内置相关词组。请补充具体相关检索词，我会保留其他采集条件并更新确认方案；尚未执行。'});
    const core=collectionRoleKey(subject);
    const allowed=word=>group.includes(word)||collectionRoleKey(word).includes(core);
    if(proposed.some(word=>!allowed(word)))throw Object.assign(new Error('扩展词偏离岗位主题'),{code:'COLLECTION_INTENT_KEYWORD_MISMATCH',question:'部分扩展词与本次岗位主题不一致。请提供这些词或删去无关方向；尚未执行。'});
    merged.keywords=[...new Set([subject,...(base?.keywords||[]),...group,...proposed])].slice(0,15);
  }else if(base&&/(?:关键词|检索词|搜索词)(?:改为|改成|换成|[:：])/.test(message)){
    const list=message.split(/(?:关键词|检索词|搜索词)(?:改为|改成|换成|[:：])/)[1]?.split(/[。；;\n]/)[0];
    const words=list?.split(/[、，,和及]+/).map(word=>word.trim()).filter(Boolean)||[];
    const related=word=>relatedCollectionKeywords(context.intent.subject).includes(word)||collectionRoleKey(word).includes(collectionRoleKey(context.intent.subject));
    if(words.some(word=>!related(word)))throw Object.assign(new Error('关键词偏离岗位主题'),{code:'COLLECTION_INTENT_KEYWORD_MISMATCH',question:'修改的关键词包含其他岗位方向。请明确要新建其他岗位任务，或保留本次岗位相关词；尚未执行。'});
    merged.keywords=remove?base.keywords.filter(word=>!words.includes(word)):append?[...new Set([...base.keywords,...words])]:[context.intent.subject,...words];
    merged.keywords=[...new Set(merged.keywords)].slice(0,15);
  }
  if(base&&!/(\d+(?:\.\d+)?)\s*(万)?\s*条/.test(message)&&base.target_rows)merged.target_rows=base.target_rows;
  const count=message.match(/(\d+(?:\.\d+)?)\s*(万)?\s*条/);
  if(base&&count)merged.target_rows=Number(count[1])*(count[2]?10000:1);
  if(/不设(?:置)?(?:目标|上限|条数)|不限条数|取消.{0,4}(?:目标|上限|条数)/.test(message))merged.target_rows=null;
  return {args:merged,...context,expand};
}
