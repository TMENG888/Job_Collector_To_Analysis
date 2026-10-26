/* Shared UI checks only; backend authorization remains authoritative. */
((root) => {
  function eligibility(state, values, {working=false, available=true}={}) {
    const f=state?.finder, resume=state?.resume;
    const running=!!f?.busy, sending=running&&!!f?.run?.delivery;
    const busy=working||running||!!f?.planning||!!state?.uploading;
    const common=[];
    if(!available||!state)common.push('状态未连接，请等待刷新');
    if(running)common.push(sending?'自动沟通运行中，请先停止本批':'匹配预览运行中，请先停止预览');
    else if(busy)common.push('正在处理，请稍候');
    if(state){
      if(!resume?.configured)common.push('请上传PDF简历');
      if(!state.model?.configured)common.push('请配置助手模型');
      if(!f?.plan)common.push('请先生成检索词');
      if(!values.share)common.push('请勾选脱敏简历与JD使用授权');
    }
    const valid=(n,min,max,integer=false)=>Number.isFinite(n)&&n>=min&&n<=max&&(!integer||Number.isInteger(n));
    if(!valid(values.count,1,300,true))common.push('遍历上限须为1–300的整数');
    if(!valid(values.coverage,50,100))common.push('证据覆盖阈值须为50%–100%');
    if(!valid(values.budget,.05,2))common.push('匹配预算须为0.05–2元');
    const send=[...common];
    if(resume?.configured&&!resume.previewed)send.push('请逐页预览PDF并确认已核对全部页面');
    if(!values.delivery)send.push('请勾选本批自动沟通授权');
    if(!valid(values.recipients,1,5,true))send.push('本批沟通人数须为1–5的整数');
    if(!valid(values.interval,60,300))send.push('沟通间隔须为60–300秒');
    return {busy,running,sending,previewReasons:common,sendReasons:send};
  }
  root.recruiterEligibility=eligibility;
  if(typeof module!=='undefined')module.exports=eligibility;
})(globalThis);
