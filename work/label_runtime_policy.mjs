// Reliability pacing, not browser fingerprinting or security-challenge evasion.
export function labelPolicy(platform, config = {}) {
  const minimum = platform === 'kimi' ? 30000 : 15000;
  const bounded = (value, fallback, low, high) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.min(high, Math.max(low, Number(value))) : fallback;
  return {
    batchSize: platform === 'kimi' ? 1 : Math.floor(bounded(config.batchSize, 3, 1, 5)),
    cooldownMs: bounded(config.cooldownMs, minimum, minimum, 300000),
    responseTimeoutMs: bounded(config.responseTimeoutMs, platform === 'kimi' ? 240000 : 180000, 30000, 600000),
    longBreakEveryBatches: Math.floor(bounded(config.longBreakEveryBatches, platform === 'kimi' ? 5 : 10, 5, 50)),
    longBreakMs: bounded(config.longBreakMs, 60000, 30000, 600000),
    platformRetryAttempts: Math.floor(bounded(config.platformRetryAttempts, 2, 1, 3)),
    retryBackoffMs: bounded(config.retryBackoffMs, 30000, 30000, 300000),
  };
}

export function classifyPlatformFailure(message = '') {
  const text = String(message);
  if (/安全验证|人机验证|验证码|账号保护|异常请求|环境.{0,10}风险|滑块|captcha|security.check|访问过于频繁|请求过于频繁|操作过于频繁|too many requests|rate limit|\b429\b/i.test(text))
    return { code: 'security_or_rate_limit', pause: true, requiresHuman: true, cooldownMs: 30 * 60000, recovery: '停止自动请求。在平台页面人工检查安全验证或账号限制；等待平台允许后确认恢复，禁止绕过验证。' };
  if (/尚未登录|登录失效|请先登录|请登录|重新登录|登录后使用|sign.in|session expired/i.test(text))
    return { code: 'login_required', pause: true, requiresHuman: true, cooldownMs: 0, recovery: '在平台登录页面完成人工登录并关闭登录窗口，再确认恢复同一任务。' };
  if (/聊天的人太多|优先队列|稍后再试|系统繁忙|服务繁忙|当前排队|额度.{0,12}(不足|用完|耗尽)|次数.{0,12}(上限|用完)|达到.{0,12}限制|今日.{0,12}上限|quota|capacity|overloaded/i.test(text))
    return { code: 'capacity_or_quota', pause: true, requiresHuman: false, cooldownMs: 15 * 60000, recovery: '平台容量或额度不足，任务已暂停且不自动重发。等待平台恢复或额度重置后继续；其他平台可独立运行。' };
  if (/当前对话含历史同岗位内容|请人工新建空白对话/.test(text))
    return { code: 'conversation_required', pause: true, requiresHuman: true, cooldownMs: 0, recovery: '人工新建空白对话后确认恢复；已保存的岗位不会重复标注。' };
  return { code: 'transient_error', pause: false, requiresHuman: false, cooldownMs: 0, recovery: '有限次指数退避；仍失败则保留进度并停止，请检查日志。' };
}

export function visiblePlatformNotice(bodyText = '') {
  // Do not treat job descriptions mentioning CAPTCHA development as a live platform challenge.
  const text = String(bodyText);
  const security = text.match(/请完成(?:安全|人机)?验证|访问过于频繁|请求过于频繁|异常请求|操作过于频繁|当前(?:网络|环境)存在风险|滑动[^\n]{0,20}(?:完成|通过)验证|拖动[^\n]{0,20}滑块/);
  if (security) return { ...classifyPlatformFailure('安全验证'), notice: security[0] };
  const capacity = text.match(/(?:和Kimi)?聊天的人太多[^\n]{0,80}|[^\n]{0,20}优先队列|系统繁忙[^\n]{0,60}|服务繁忙[^\n]{0,60}|当前排队[^\n]{0,60}|额度[^\n]{0,12}(?:不足|用完|耗尽)|次数[^\n]{0,12}(?:上限|用完)|今日[^\n]{0,12}上限/);
  if (capacity) return { ...classifyPlatformFailure(capacity[0]), notice: capacity[0] };
  return null;
}

export function pacingDelay(policy, completedBatches, responseMs = 0, random = Math.random) {
  const adaptive = Math.min(120000, Math.max(policy.cooldownMs, responseMs * .25));
  return Math.ceil(adaptive + adaptive * .25 * random() + (completedBatches % policy.longBreakEveryBatches === 0 ? policy.longBreakMs : 0));
}

export function resumeBlock(state, now = Date.now()) {
  if (!state || state.status !== 'paused') return '';
  if (state.retryAfter && Date.parse(state.retryAfter) > now) return `平台冷却至 ${state.retryAfter}，请勿反复启动。${state.recovery || ''}`;
  if (state.requiresHuman) return `需人工处理后确认恢复。${state.recovery || ''}`;
  return '';
}
