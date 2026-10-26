// 前程无忧会话助手（方案A）：
//  复用受管浏览器（与采集器同一入口/同一 profile），打开前程无忧搜索页；
//  由你手动完成阿里云滑块验证（一次），会话保存在受管 profile 中；
//  随后采样一页岗位，确认会话可用（不模拟轨迹、不接打码平台）。
// 用法： node job51_session_helper.mjs
process.env.JOB_COLLECTION_MODE = process.env.JOB_COLLECTION_MODE || 'http_preferred_browser_fallback';
// 动态 import：确保上面的环境变量在模块加载前生效（ESM 静态 import 会提升）。
const {connectManagedContext} = await import('./managed_browser.mjs');

const KW = process.env.JOB51_KW || '销售工程师';
const SEARCH_URL = 'https://we.51job.com/pc/search?jobArea=010000&keyword=' + encodeURIComponent(KW) + '&searchType=2';

async function main() {
  // 与采集器一致：使用受管浏览器（连接现有实例，若无则启动）。
  const context = await connectManagedContext('job51');
  try {
    const page = context.pages().find(p => { try { return new URL(p.url()).hostname.endsWith('51job.com'); } catch { return false; } })
      || context.pages()[0] || await context.newPage();
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('导航:', e.message));
    await page.bringToFront();
    console.log('\n已在受管浏览器中打开前程无忧。请：');
    console.log('  1. 若出现"请按住滑块，拖动到最右边"，请手动拖动完成验证');
    console.log('  2. 确认能看到前程无忧的岗位列表');
    console.log('完成后回到本窗口按 Enter 继续验证（不需要关闭浏览器窗口）...');
    await new Promise(resolve => process.stdin.once('data', resolve));

    // 采样：监听网站自身的 /api/job/search-pc 响应
    const captured = [];
    page.on('response', async r => {
      try {
        const u = new URL(r.url());
        if (u.pathname === '/api/job/search-pc') {
          const ct = r.headers()['content-type'] || '';
          let info = `status=${r.status()} ct=${ct}`;
          if (ct.includes('json')) {
            const b = await r.json().catch(() => null);
            const items = b?.resultbody?.job?.items;
            const total = b?.resultbody?.job?.totalCount ?? b?.resultbody?.job?.totalcount;
            if (Array.isArray(items)) info += ` items=${items.length} total=${total} 样本=${items[0]?.jobName || ''}`;
          }
          captured.push(info);
        }
      } catch {}
    });
    await page.evaluate(() => {
      const vm = [...document.querySelectorAll('*')].map(e => e.__vue__).find(x => x?.$options?.name === 'PCSearch' && typeof x.getSearch === 'function');
      if (vm) { vm.searchParams = vm.searchParams || {}; vm.searchParams.pageNum = 1; Promise.resolve(vm.getSearch(1)).catch(() => {}); return 'vue'; }
      const btn = [...document.querySelectorAll('button,a')].find(b => /搜索/.test(b.innerText));
      if (btn) { btn.click(); return 'click'; }
      return 'none';
    }).then(m => console.log('触发搜索方式:', m)).catch(e => console.log('触发失败:', e.message));
    await page.waitForTimeout(8000);

    console.log('\n===== 会话采样结果 =====');
    if (!captured.length) {
      console.log('未捕获到 /api/job/search-pc 响应——可能仍在验证页或页面结构变化。');
      const body = await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '');
      console.log('页面内容:', body);
    } else {
      for (const c of captured) console.log(' ', c);
      console.log('\n✅ 会话可用：51job 可通过受管会话采集。');
    }
  } finally {
    // 只释放租约，不关闭浏览器窗口；采集器复用同一实例。
    await context.close();
  }
}
await main();