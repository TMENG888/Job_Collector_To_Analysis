// Pure text classification; no browser/runtime dependencies.
export function blockedReason(text) {
  if (/访问验证|请按住滑块|拖动到最右边|人机验证|安全验证|验证码/.test(text)) return '检测到网站安全验证，请人工检查；不会自动处理滑块或绕过验证';
  if (/登录后.{0,8}(查看|搜索)|请先登录|登录已失效|账号.{0,8}(异常|保护|限制)/.test(text)) return '登录或账号状态需要人工处理';
  return '';
}
