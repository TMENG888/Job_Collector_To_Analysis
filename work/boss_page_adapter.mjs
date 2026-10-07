// Read only the rendered recruitment page. No private API calls or tokens.
export const bossCities={北京:'101010100',天津:'101030100',上海:'101020100',重庆:'101040100',南京:'101190100',苏州:'101190400',杭州:'101210100',武汉:'101200100',广州:'101280100',深圳:'101280600',成都:'101270100',西安:'101110100'};
export const bossColumns=['platform','query_keyword','query_city','job_id','job_name','company_id','company_name','salary','city','district','experience','education','employment_type','company_nature','company_size','industry','publish_time','refresh_time','deadline','tags','skills','job_description','address','recruiter_name','recruiter_title','job_url','company_url','source_total','access_level','collected_at'];
export function bossSearchUrl(keyword,city){
 if(!bossCities[city])throw Error('BOSS暂不支持该查询城市：'+city);
 const url=new URL('https://www.zhipin.com/web/geek/job');url.searchParams.set('query',keyword);url.searchParams.set('city',bossCities[city]);return url.href;
}
export function bossJobUrl(value){
 try{const u=new URL(value,'https://www.zhipin.com');if(u.protocol!=='https:'||u.hostname!=='www.zhipin.com'||!/^\/job_detail\/[\w-]+\.html$/.test(u.pathname))return null;return u.origin+u.pathname;}catch{return null;}
}
export function bossBlockedReason({url='',text='',challenge=false,login=false,status=200}){
 if(status===403||status===429)return '访问受限（HTTP '+status+'），请停止采集并在官网人工确认账号状态';
 if(challenge||/验证码|安全验证|访问异常|访问过于频繁|操作过于频繁|账号异常|账号保护|账号被冻结|请完成验证/.test(text)||/captcha|verify|security-check/i.test(url))return '出现验证码、安全验证或账号保护，请在官网登录窗口人工处理后再续爬';
 if(login||/\/web\/user\//.test(url)||/请先登录|登录后查看|登录后查看更多/.test(text))return '登录会话失效，请重新人工登录，关闭登录窗口后再续爬';
 return '';
}
export async function bossPageGuard(page){
 const url=page.url();
 const challenge=await page.locator('iframe[src*="captcha"], .geetest_panel, .verify-wrap, #captcha').first().isVisible().catch(()=>false);
 const login=await page.locator('.login-register-content, .login-form').first().isVisible().catch(()=>false);
 // Restrict text checks to prompts, not JD content mentioning security work.
 const text=await page.locator('.error-content, .verify-wrap, .security-check, .login-register-content, .empty-result, .job-empty').allTextContents();
 const reason=bossBlockedReason({url,text:text.join('\n'),challenge,login});if(reason)throw Object.assign(Error(reason),{code:'BOSS_USER_ACTION'});
}
export async function extractBossCards(page){
 return page.locator('a[href*="/job_detail/"]').evaluateAll(anchors=>anchors.map(a=>{
  const card=a.closest('.job-card-wrapper, .job-card-box, .job-list li, .job-primary')||a;
  const text=s=>card.querySelector(s)?.textContent?.trim()||'';
  return {url:a.href,title:text('.job-name, .job-title')||a.querySelector('.job-name')?.textContent?.trim()||'',salary:text('.salary'),company:text('.company-name'),location:text('.job-area, .job-location'),tags:[...card.querySelectorAll('.tag-list li, .job-tags span')].map(x=>x.textContent.trim())};
 })).then(cards=>{const unique=new Map();for(const c of cards){const url=bossJobUrl(c.url);if(url&&c.title)unique.set(url,{...c,url});}return [...unique.values()];});
}
export async function extractBossDetail(page,card,keyword,city){
 const visible=await page.locator('.job-sec-text, .job-detail-section .job-description, .job-description .text').first().isVisible().catch(()=>false);
 if(!visible)throw Error('BOSS详情结构未识别或没有可见JD，已停止，不能把列表摘要当岗位详情');
 const description=(await page.locator('.job-sec-text, .job-detail-section .job-description, .job-description .text').first().innerText()).trim();
 if(!description)throw Error('BOSS岗位描述为空，已停止等待检查页面结构');
 const get=async selector=>{const locator=page.locator(selector).first();return await locator.isVisible().catch(()=>false)?await locator.innerText({timeout:2000}).catch(()=> ''):'';};
 const tags=card.tags||[];
 const row=Object.fromEntries(bossColumns.map(k=>[k,'']));
 return {...row,platform:'BOSS直聘',query_keyword:keyword,query_city:city,job_id:new URL(card.url).pathname.match(/\/job_detail\/([\w-]+)\.html/)[1],job_name:(await get('.job-banner .name h1, .job-banner h1')).trim()||card.title,
  company_name:(await get('.company-info .name, .sider-company .company-name')).trim()||card.company,salary:(await get('.job-banner .salary')).trim()||card.salary,
  city:(card.location||'').split(/[·-]/)[0]||city,district:(card.location||'').split(/[·-]/)[1]||'',experience:tags.find(x=>/年|经验不限|应届/.test(x))||'',education:tags.find(x=>/本科|大专|硕士|博士|高中|中专|学历不限/.test(x))||'',
  // Do not guess employment type/company scale from unrelated page text.
  company_size:(await get('.sider-company .company-scale')).trim(),industry:(await get('.sider-company .company-industry')).trim(),tags:tags.join(' | '),job_description:description,address:(await get('.location-address')).trim(),job_url:card.url,access_level:'人工登录正常页面可见详情（试验接入）',collected_at:new Date().toISOString()};
}
export function bossCsv(rows){const cell=v=>{const s=String(v??'');return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};return '\uFEFF'+[bossColumns.join(','),...rows.map(r=>bossColumns.map(k=>cell(r[k])).join(','))].join('\r\n');}
