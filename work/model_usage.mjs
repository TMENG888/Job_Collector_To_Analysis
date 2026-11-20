// Rates are estimates aligned with the application's configured model pricing.
// Missing usage is never represented as a known zero-cost request.
export function assistantUsage(run){
  const usage={input:0,output:0,estimate:0,unknown:0,unpriced:0,requests:run?.requests?.length||0,basis:'配置单价估算，非实际账单；未计缓存折扣'};
  for(const request of run?.requests||[]){
    if(![request.prompt_tokens,request.completion_tokens].every(n=>Number.isSafeInteger(n)&&n>=0)){usage.unknown++;continue;}
    usage.input+=request.prompt_tokens;usage.output+=request.completion_tokens;
    const provider=request.provider||run.provider,model=request.model||run.model;
    const prices=provider==='deepseek'?[4,8]:provider==='qwen'&&/^qwen3\.[78]-flash$/.test(model||'')?[.8,2.7]:null;
    if(prices)usage.estimate+=(request.prompt_tokens*prices[0]+request.completion_tokens*prices[1])/1e6;
    else usage.unpriced++;
  }
  if(usage.unpriced)usage.estimate=null;
  return usage;
}
