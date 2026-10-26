// One deterministic interpretation of the current human message is shared by
// routing, the model planner and authorization. Model arguments never grant it.
const collect='采集|爬取|抓取|爬一下|爬一爬|爬下|爬点|爬些|抓一下|抓下|抓点';
const actionPatterns={create:/创建|新建|建立/,resume:/续爬|续采|继续|接着|恢复|启动|开始|运行/,pause:/暂停|停止|停掉|停下/,export:/导出|下载/};
const actionNames={create:'仅创建',create_start:'创建并启动',resume:'启动或续采',pause:'暂停',export:'导出'};
const scopeWords=/采集|爬取|抓取|爬一下|爬一爬|爬下|爬点|爬些|抓一下|抓下|抓点|爬虫|续爬|续采|断点|任务|进度|日志/;
const question=/^(?:(?:请问|我想问|想了解|想知道|咨询|请解释|请说明)\s*)?(?:如何|怎么|为什么|为何|能否|是否|是不是|可否|能不能|可不可以|可以.{0,60}[吗么？?]|能.{0,60}[吗么？?])/;
const negation=/(?:不要|别|勿|禁止|不许|不允许|不需要|不用|不必|不想|不再|不)(?:再|自动|直接|帮我|立即|现在|去|进行|执行|尝试|给我|\s){0,5}$/;

export function collectionFollowupIntent(message){
  const text=String(message||'').trim().replace(/[。！!，,；;\s]+$/,'');
  if(/^(?:请)?(?:确认(?:并(?:采集|执行|启动)|执行(?:采集方案)?|采集|启动)?|执行该方案|按(?:这个|该)方案(?:执行|采集|启动))$/.test(text))return 'confirm';
  if(/^(?:请)?(?:重新准备|刷新|更新|重建)(?:这个|该|上一个|过期的)?(?:采集)?(?:方案|确认卡片|卡片)$/.test(text))return 'refresh';
  return null;
}

function occurrences(text,pattern){return [...text.matchAll(new RegExp(pattern.source,'g'))].filter(match=>!/(?:已经|曾经|尚未|还未|已|被|未)$/.test(text.slice(0,match.index))).map(match=>({index:match.index,value:match[0],negative:negation.test(text.slice(0,match.index))}));}
export function collectionRoleKey(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/(?:工程师|岗位|专员|岗)$/,'').trim();}
export function collectionEditRequest(message){
  const text=String(message||'').trim();
  if(!text||/```|^\s*>|(?:日志|原文|示例|文档|网页|工具返回|上轮回答|模型回答|助手回复).{0,8}(?:[:：]|写着|显示|说|如下|内容为)|^(?:简历|岗位职责|任职要求|附件内容)\s*[:：]/m.test(text)||question.test(text)||/[吗么？?]\s*$/.test(text)||/不要|别|禁止|不许|不需要|不用|不必|不想/.test(text))return false;
  return /(?:(?:全(?:部)?|所有)(?:平台|渠道|城市)|全国|(?:增加|添加|扩展|拓展|补充|生成|更新|修改|调整|改成|改为|只要|仅用|只用|仅采|只采|去掉|移除|减少|再加|加上).{0,30}(?:关键词|检索词|搜索词|相关词|城市|平台|渠道|节奏|北京|上海|广州|深圳|销售|条)|(?:相关|类似|同类).{0,12}(?:关键词|检索词|搜索词)|(?:关键词|检索词|城市|平台|渠道|节奏)(?:改为|改成|换成|[:：])|(?:不设|取消).{0,6}(?:目标|上限|条数)|不限条数)/.test(text);
}
function subjectOf(text){
  const leading=text.match(/^(?:(?:帮我|请|把|将)\s*)?([^，,。；;\n]{1,35}?)(?:这一|这个|这类)(?:岗位|方向)/);
  const created=text.match(/(?:创建|新建|建立)(?:并(?:启动|开始|运行))?(?:一个|一项)?\s*(.*?)(?:采集任务|爬虫任务|任务)/);
  const gathered=text.match(new RegExp(`(?:${collect})(.*)`));
  let subject=leading?.[1]??created?.[1]??gathered?.[1]??'';
  subject=subject.split(/[，,。；;\n]/)[0].split(/(?:目标)?\s*\d+(?:\.\d+)?\s*(?:万)?\s*条/)[0];
  subject=subject.replace(/^(?:下|一下|点|一些|一批|一个|更多的?)\s*/,'').replace(/[吧呗呀啊呢！!？?。\s]+$/,'').replace(/(?:可以|行|能做)?[吗么]$/,'').replace(/(?:的)?(?:岗位数据|数据|采集任务|任务)$/,'').replace(/[“”「」『』"']/g,'').trim();
  return /^(?:全部|所有|更多|全平台|全城市|全国|全平台和全城市|相关|类似|按原条件)?$/.test(subject)?'':subject;
}

export function parseCollectionIntent(message){
  const raw=String(message??'').normalize('NFKC').trim();
  // Quotes, pasted documents and fenced code are evidence, not instructions.
  const text=raw.replace(/```[\s\S]*?```/g,'').replace(/[“「『"][^”」』"\n]*[”」』"]/g,'').replace(/^\s*>.*$/gm,'').trim();
  const base={version:1,domain:false,kind:'none',allowed_actions:[],reason_code:'not_collection',subject:'',read_tool:null};
  if(!text||/^(?:简历|履历|岗位原文|岗位职责|岗位要求|任职要求|JD原文|日志原文|日志内容|示例|引用|附件内容)\s*[:：]/i.test(text))return base;
  if(/(?:日志|原文|示例|文档|网页|工具返回|上轮回答|模型回答|助手回复).{0,8}(?:[:：]|写着|显示|说|如下|内容为)/.test(text))return {...base,domain:scopeWords.test(text),kind:'read',read_tool:'collection_task_logs',reason_code:'quoted_evidence'};
  const followup=collectionFollowupIntent(text);
  if(followup)return {...base,domain:true,kind:'followup',followup,reason_code:'stored_plan_only'};
  // A profession named "爬虫/数据采集" is not an instruction to operate the
  // collector. Protect business/career questions even without skill/salary words.
  const career=/简历|匹配|薪资|技能|技术要求|岗位要求|求职|项目经历|商业模式|盈利|赚钱|业务方向|业务场景|就业|职业|前景/.test(text)||/(?:爬虫|数据采集|网页采集|网络爬虫)(?:开发)?(?:工程师|岗位|职位|开发岗)/.test(text);
  const direct=new RegExp(`^(?:(?:请|麻烦|帮我|给我|请帮我|请你|劳烦|现在|我要|我想|我需要|想要)\\s*)*(?:${collect}|创建|新建|续采|续爬|启动|暂停|停止|导出|下载)`).test(text);
  const taskQuery=/(?:查看|查询|检查|刷新|列出|看看).{0,60}任务.{0,20}(?:进度|状态|日志|列表)|(?:查看|查询|检查|刷新|列出|看看).{0,60}(?:进度|状态|日志).{0,20}任务/.test(text);
  if(career&&!direct&&!taskQuery&&!/采集中心|爬虫中心|采集任务|爬虫任务/.test(text))return base;
  if(/^(?:数据)?(?:采集|爬虫|爬取)(?:工程师|开发工程师|开发岗)/.test(text)&&career&&!direct&&!taskQuery&&!/采集中心|爬虫中心|采集任务|爬虫任务/.test(text))return base;
  const nativeDomain=scopeWords.test(text)||/暂停|停掉/.test(text)||/^(?:新建|创建)(?:任务|并启动)?$/.test(text)||/(?:导出|下载).{0,15}(?:数据|最新)/.test(text);
  const domain=nativeDomain||collectionEditRequest(text);
  if(!domain)return base;
  const result={...base,domain:true,...(!nativeDomain?{context_required:true}:{}),subject:subjectOf(raw),reason_code:'read_only',kind:'read',read_tool:/日志|异常|为什么|为何|不增长|没有新增/.test(text)?'collection_task_logs':/列表|有哪些|所有|全部|多少|当前.*任务/.test(text)?'collection_tasks':'collection_task_status'};
  if(/不是不|并非不|并不是不/.test(text))return {...result,kind:'ambiguous',reason_code:'unclear_negation',question:'这轮的否定表达有歧义。请直接说明要执行还是不执行哪项采集操作；尚未执行。'};
  const positive=new Set(),negative=new Set();let inquiry=false,collectPositive=false,readRequested=false;
  for(const clause of text.split(/[，,。；;！!\n]/).map(v=>v.trim()).filter(Boolean)){
    if(question.test(clause)||/(?:吗|么|需要什么|的(?:原理|方法|机制)|怎么做|如何做)[？?\s]*$/.test(clause)||/^(?:只|仅)?(?:查看|查询|查|列出|检查|刷新|统计|看看)/.test(clause)){if(/进度|状态|日志|列表|为什么|为何/.test(clause))readRequested=true;else if(new RegExp(collect).test(clause))inquiry=true;continue;}
    for(const[action,pattern]of Object.entries(actionPatterns))for(const match of occurrences(clause,pattern))(match.negative?negative:positive).add(action);
    for(const match of occurrences(clause,new RegExp(collect))){if(match.negative)negative.add('collect');else if(!/^(?:中心|任务|进度|日志|工具|机制|功能)/.test(clause.slice(match.index+match.value.length)))collectPositive=true;}
  }
  const existing=/这个|该任务|原任务|现有|已有|上次|之前|第[一二三四五六七八九十1-9].{0,2}任务/.test(text);
  if(collectPositive&&!positive.size)positive.add(existing?'resume':'collect');
  // Contradictions and several different write operations need human resolution.
  const types=[...positive].filter(action=>action!=='create'&&action!=='collect');
  if([...positive].some(action=>negative.has(action))||types.length>1||positive.has('create')&&types.some(action=>action!=='resume'))return {...result,kind:'ambiguous',reason_code:'conflicting_actions',read_tool:null,question:'本轮包含相互冲突或多个采集操作。请先明确要新建、续采、暂停还是导出；尚未执行。'};
  let allowed=[];
  if(positive.has('create'))allowed=positive.has('resume')&&!negative.has('resume')?['create','create_start']:['create'];
  else if(positive.has('collect')&&!negative.has('create'))allowed=negative.has('resume')?['create']:['create','create_start'];
  else if(types.length===1&&!negative.has(types[0]))allowed=[types[0]];
  if(negative.has('collect'))allowed=allowed.filter(action=>!['create','create_start','resume'].includes(action));
  if(!allowed.length){
    if(inquiry)return {...result,kind:'ambiguous',reason_code:'inquiry_not_execution',question:'这轮是在询问采集方法或可行性，还未授权准备执行方案。若要操作，请说明要采集的岗位或要续采的任务；尚未执行。'};
    if(negative.size)return readRequested?{...result,reason_code:'explicit_read_only'}:{...result,kind:'blocked',reason_code:'explicit_denial',question:'已保留本轮“不执行”的要求，不会准备或启动被禁止的采集操作。可以继续查询任务状态。'};
    return result;
  }
  return {...result,kind:'command',read_tool:null,allowed_actions:allowed,reason_code:'explicit_command'};
}

export function authorizeCollectionAction(message,action){
  const intent=parseCollectionIntent(message);
  if(intent.allowed_actions.includes(action)){
    if(['create','create_start'].includes(action)&&!intent.subject)return {ok:false,intent,code:'COLLECTION_INTENT_MISSING_SUBJECT',question:'请说明要采集哪个岗位；不指定条数也可以。尚未创建或启动任务。'};
    return {ok:true,intent};
  }
  const onlyCreate=action==='create_start'&&intent.allowed_actions.includes('create');
  const explanation=onlyCreate?'只请求创建任务时不能自动启动；请准备仅创建方案':'用户本轮没有明确请求该写操作；只允许查询或给出建议';
  return {ok:false,intent,code:'COLLECTION_INTENT_ACTION_MISMATCH',explanation,question:intent.question||(onlyCreate?'你只要求创建任务。我可以准备“仅创建”的确认卡片，不会启动采集。':intent.allowed_actions.length?`本轮允许的是${intent.allowed_actions.map(name=>actionNames[name]).join(' / ')}，不是${actionNames[action]||action}。请明确希望新建还是续采哪个任务；尚未执行。`:'没有识别到明确采集操作。请说明要采集的岗位，或要查询、续采的任务；尚未执行。')};
}

export function resolveCollectionClarification(message,pending,now=Date.now()){
  // A short human choice may fill a stored, human-derived subject, but never
  // confirms a card or revives an old/expired execution. Model fields are absent.
  if(!pending?.subject||!Number.isFinite(pending.updated_at)||now-pending.updated_at>30*60*1000)return message;
  const choice=String(message).trim().replace(/[。！!\s]+$/,'');
  const verb=/^(?:新建|创建)(?:一个)?(?:任务)?$/.test(choice)?'创建':/^(?:新建|创建)并启动(?:任务)?$/.test(choice)?'创建并启动':/^(?:续采|续爬)(?:原任务|这个任务|任务)?$/.test(choice)?'继续采集':null;
  if(!verb)return message;
  const subject=String(pending.subject).replace(/[“”"\r\n]/g,'').slice(0,120);
  const command=verb==='继续采集'?`${verb}${subject}的数据`:`${verb}${subject}采集任务`;
  return `${command}\n上轮条件参考：\n> ${String(pending.request||'').replace(/[\r\n]+/g,' ').slice(0,1500)}`;
}
