const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export async function gotoWithRetries(page,url,{attempts=3,timeout=30000,waitUntil='domcontentloaded',wait=sleep}={}){
  const maxAttempts=Math.max(1,Math.min(5,Number(attempts)||3));
  let lastError;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    try{
      if(page.url()!==url)await page.goto(url,{waitUntil,timeout});
      if(page.url()!=='about:blank')return;
      lastError=new Error('浏览器导航后仍停留在 about:blank');
    }catch(error){lastError=error;}
    if(attempt<maxAttempts)await wait(500*attempt);
  }
  throw new Error(`浏览器页面访问失败，已重试 ${maxAttempts} 次：${lastError?.message||'页面仍为空白'}`,{cause:lastError});
}
