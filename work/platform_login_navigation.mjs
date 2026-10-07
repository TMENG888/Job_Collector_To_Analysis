import {randomInt} from 'node:crypto';

export async function navigatePlatformLogin(page,key,url,{onlyIfBlank=false}={}){
  if(onlyIfBlank&&page.url()!=='about:blank')return;
  const hostname=new URL(url).hostname;
  if(key==='yupao'&&(hostname==='yupao.com'||hostname.endsWith('.yupao.com'))){
    const delayMs=randomInt(3000,8001);
    await page.bringToFront();
    console.log(`鱼泡浏览器已打开，将等待 ${(delayMs/1000).toFixed(1)} 秒后访问登录页面`);
    await new Promise(resolve=>setTimeout(resolve,delayMs));
    // If the user has already navigated in the login window, preserve that page.
    if(onlyIfBlank&&page.url()!=='about:blank')return;
  }
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
}
