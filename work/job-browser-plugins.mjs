import {browserSites,siteForURL,safeBrowserURL,cleanJobURL} from './job-browser-contracts.mjs';
import {zhaopinCities} from './collection_cities.mjs';
import {liepinCities} from './liepin_cities.mjs';
export const browserPlugins=[
  {id:'match-resume',name:'简历与岗位匹配',permission:'手动发送脱敏简历及当前岗位给已配置的Qwen，生成有原文依据的匹配分析',version:'1.0.0'},
  {id:'communication',name:'求职沟通',permission:'单次发送逐次确认；BOSS批次发送需预览原版式PDF并授权搜索范围、人数与间隔；身份或结果不明即停止',version:'1.2.0'},
  {id:'smart-apply',name:'智能投递',permission:'读取投递按钮并准备方案；你确认后仅点击一次，不自动群投',version:'1.0.0'},
  {id:'search',name:'按条件搜索',permission:'在当前招聘网站打开搜索结果',version:'1.0.0'},
  {id:'collect-page',name:'整理当前页岗位',permission:'读取当前页可见岗位卡片；最多100条，不自动翻页',version:'1.0.0'},
  {id:'read-detail',name:'读取当前岗位详情',permission:'读取当前页可见的职位标题与职责',version:'1.0.0'},
];
export function searchBrowserURL(siteId,keyword,city=''){
  const site=browserSites.find(s=>s.id===siteId),term=String(keyword||'').trim();
  if(!site||!term||term.length>80||String(city).length>30)throw Error('请选择网站并填写80字以内的岗位关键词');
  const cityText=String(city).trim(),requestedCity=/^(?:全国|不限|全部|全部城市)$/.test(cityText)?'':cityText;let u;
  if(siteId==='boss'){
    const cities={'全国':'100010000','北京':'101010100','上海':'101020100','广州':'101280100','深圳':'101280600','杭州':'101210100','成都':'101270100'};
    if(requestedCity&&!cities[requestedCity])throw Error('BOSS插件目前支持全国、北京、上海、广州、深圳、杭州、成都；其他城市请在网页内选择');
    u=new URL('https://www.zhipin.com/web/geek/job');u.searchParams.set('query',term);u.searchParams.set('city',cities[requestedCity]||cities['全国']);
  }else if(siteId==='liepin'){
    if(requestedCity&&!Object.hasOwn(liepinCities,requestedCity))throw Error('猎聘城市尚未接入，请在网页内选择');
    u=new URL('https://www.liepin.com/zhaopin/');u.searchParams.set('key',term);if(requestedCity)u.searchParams.set('dq',liepinCities[requestedCity]);
  }else if(siteId==='zhaopin'){
    if(requestedCity&&!Object.hasOwn(zhaopinCities,requestedCity))throw Error('智联城市尚未接入，请在网页内选择');
    u=new URL('https://www.zhaopin.com/jobs');u.searchParams.set('kw',term);if(requestedCity)u.searchParams.set('jl',zhaopinCities[requestedCity]);
  }else if(siteId==='shixiseng'){
    u=new URL('https://www.shixiseng.com/interns');u.searchParams.set('k',term);if(requestedCity)u.searchParams.set('c',requestedCity);
  }else if(siteId==='iguopin'){
    if(requestedCity)throw Error('国聘请在网页内选择城市；插件不会静默忽略城市条件');
    u=new URL('https://www.iguopin.com/job');u.searchParams.set('keyword',term);
  }else{
    if(requestedCity)throw Error('前程无忧请在网页内选择城市；插件不会静默忽略城市条件');
    u=new URL('https://we.51job.com/pc/search');u.searchParams.set('keyword',term);u.searchParams.set('searchType','2');
  }
  return safeBrowserURL(u.href);
}
const selectors={
  boss:{links:'a[href*="/job_detail/"]',details:'.job-sec-text,.job-detail-section .text'},
  liepin:{links:'a[href*="/job/"],a[href*="/a/"]',title:'h1,.name-box .job-title',company:'.job-title-container .company-name,.job-title-content .company-name,.company-info .company-name,[data-selector="job-company-name"]',details:'.job-intro-container,.job-intro-content,[data-selector="job-intro-content"],.job-description'},
  zhaopin:{links:'a[href*="jobs.zhaopin.com/"],a[href*="/jobdetail/"]',details:'.describtion__detail-content,.job-detail-describe,.job-description'},
  job51:{links:'a[href*="jobs.51job.com/"],a[href*="/jobdetail"]',details:'.job_msg,.job-detail-description,.job-description'},
  iguopin:{links:'a[href*="/job/detail"],a[href*="/job_detail"],a[href*="/jobs/detail"]',details:'.job-description,.job-content,.position-description'},
  shixiseng:{links:'a[href*="/intern/"],a[href*="/job/"]',details:'.job_detail,.job-desc,.job-description'},
};
export async function browserAccessState(page){
  const path=new URL(page.url()==='about:blank'?'https://blank.invalid':page.url()).pathname;
  const access=await page.evaluate(()=>{
    const visible=e=>e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
    const challenge=[...document.querySelectorAll('#WAF_NC_WRAPPER,.geetest_panel,.aliyunCaptcha-sliding-body,.nc-container,.captcha-dialog,[class*="captcha-container"],.verify-wrap')].some(visible);
    const body=(document.body?.innerText||'').slice(0,15000);
    return {challenge:challenge||/Security Verification|Just a moment|安全验证|人机验证/i.test(document.title)||/请完成安全验证|请拖动滑块|请按住滑块|访问过于频繁|访问异常|人机验证|请求过于频繁|账号存在异常|确认您是真人|正在验证连接安全性/.test(body),login:!![...document.querySelectorAll('.login-dialog,.login-modal,[role="dialog"]')].find(e=>visible(e)&&/手机|扫码|登录/.test(e.innerText||''))};
  }).catch(()=>{throw Error('当前页面状态无法核验，插件未执行，请等待页面加载完成');});
  if(access.challenge||/\/(?:403|429)(?:\.html)?(?:\/|$)/i.test(path))return {blocked:true,kind:'verification',message:'网站要求验证或限制访问，插件已暂停；请在页面中手动处理后再点击插件'};
  if(access.login||/\/(?:login|passport|user\/login|web\/user)(?:\/|$)/i.test(path))return {blocked:true,kind:'login',message:'网站要求登录，插件已暂停；请在页面中手动登录后重试'};
  return {blocked:false,kind:'ready',message:''};
}
export async function readBrowserPlugin(page,id){
  const site=siteForURL(page.url());if(!site)throw Error('请先打开一个已接入的招聘网站');
  const access=await browserAccessState(page);if(access.blocked)throw Object.assign(Error(access.message),{code:'HUMAN_REQUIRED'});
  const spec=selectors[site.id];let rows;
  if(id==='collect-page'){
    rows=await page.locator(spec.links).evaluateAll(links=>{
      const seen=new Set();return links.filter(a=>a.getClientRects().length&&getComputedStyle(a).visibility!=='hidden').map(a=>{
        const card=a.closest('article,li,.job-card-wrapper,.job-card-box,.joblist-box__item,.job-card,.job-list-item,.job-item')||a.parentElement;
        const get=s=>card?.querySelector(s)?.innerText?.trim()||'';
        return {url:a.href,title:(a.getAttribute('title')||get('.jobTitleBox [title],.job-title-box [title],.job-name,.job-title,.job-title-box,.jobinfo__title')||a.innerText||'').trim().slice(0,180),company:get('.company-name,.company__title,.companyName,.company-info h3'),salary:get('.salary,.job-salary,.job-salary__text'),city:get('.job-area,.work-city,.city,.area,.job-address'),description:''};
      }).filter(r=>r.title&&!seen.has(r.url)&&seen.add(r.url)).slice(0,100);
    });
    if(!rows.length)throw Error('未识别到当前页的可见岗位卡片；可能未加载、需要登录或网站结构已变化。未触发后续翻页');
  }else if(id==='read-detail'){
    rows=[await page.evaluate(spec=>{
      const get=s=>[...document.querySelectorAll(s)].find(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden')?.innerText?.trim()||'';
      return {url:location.href,title:get(spec.title||'h1'),company:spec.company&&location.pathname.startsWith('/a/')?'':get(spec.company||'.company-name,.company__title,.companyName'),salary:get('.salary,.job-salary,.job-salary__text'),city:get('.job-area,.job-address,.work-city'),description:get(spec.details).slice(0,30000)};
    },spec)];
    if(!rows[0].title||rows[0].description.length<30)throw Error('当前页不是可识别的完整岗位详情；未用整页导航、广告或登录文案充当职责');
  }else throw Error('不支持的读取插件');
  return rows.map(r=>({...r,url:cleanJobURL(r.url),site:site.id,platform:site.name,capturedAt:new Date().toISOString(),source:'embedded-browser-visible-dom'})).filter(r=>siteForURL(r.url)?.id===site.id);
}
