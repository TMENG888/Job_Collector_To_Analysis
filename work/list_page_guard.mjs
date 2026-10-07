export function pageFailure({url, text = ''}) {
  if (/正在验证连接安全性|请勾选下方复选框|Protected by Tencent Cloud EdgeOne|请按住滑块|拖动到最右边|滑动验证|访问验证/.test(text))
    return '网站安全验证：请通过平台登录入口人工完成验证，再从断点续采';
  if (/登录[，,、\s]*查看更多职位|登录查看更多相关职位|请先登录|登录已失效|账号.{0,8}(异常|保护|限制)/.test(text))
    return '登录会话不可用或职位列表受限：请人工重新登录后续采';
  if (!url || url === 'about:blank' || !text.trim())
    return '页面空白或跳转异常，未取得有效职位列表；请人工检查平台页面和浏览器环境';
  return '';
}
export async function assertListPage(page) {
  const text = await page.locator('body').innerText({timeout:5000}).catch(()=> '');
  const reason = pageFailure({url:page.url(),text});
  if(reason) throw Object.assign(new Error(reason),{code:'USER_ACTION_REQUIRED'});
  return text;
}
export function parseZhaopinList(body) {
  const data=body?.data;
  if (!data || !Array.isArray(data.list) || !Number.isFinite(Number(data.count)) || data.count == null
      || (body.code != null && ![0,200,'0','200'].includes(body.code)))
    throw new Error('智联岗位响应业务失败或结构异常，不能判定为零岗位');
  const total=Number(data.count);
  if(total<0 || (!data.list.length && total>0 && Number(data.isEndPage)!==1))
    throw new Error('智联列表与岗位总数不一致');
  return {rows:data.list,total,endPage:Number(data.isEndPage)===1,explicitEmpty:total===0&&data.list.length===0};
}
