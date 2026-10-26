// 离线自检：智联条件的续采语义（起始页、已见 ID、逐页回写、风控让位后从 nextPage 续）。
// 全部走注入的 request，不发任何真实请求。
import { collectZhaopinSession } from './direct_zhaopin_session.mjs';

const city = { name: '广州', code: '763' };
const session = { cookie: 'at=PROBE' };
const pages = new Map([
  [1, Array.from({ length: 20 }, (_, i) => ({ number: `CC000000000J1${String(i).padStart(3, '0')}`, name: `岗位1-${i}` }))],
  [2, Array.from({ length: 20 }, (_, i) => ({ number: `CC000000000J2${String(i).padStart(3, '0')}`, name: `岗位2-${i}` }))],
  [3, Array.from({ length: 20 }, (_, i) => ({ number: `CC000000000J3${String(i).padStart(3, '0')}`, name: `岗位3-${i}` }))],
  [4, Array.from({ length: 5 }, (_, i) => ({ number: `CC000000000J4${String(i).padStart(3, '0')}`, name: `岗位4-${i}` }))],
]);

let requested = [];
const makeRequest = ({ failAtPage } = {}) => async (url, options) => {
  const raw = options.body;
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw instanceof Uint8Array ? raw : Uint8Array.from(raw));
  const page = JSON.parse(text).pageIndex;
  requested.push(page);
  if (failAtPage && page === failAtPage) {
    return { status: 200, text: async () => JSON.stringify({ code: 200, data: { isVerification: 1 } }) };
  }
  const list = pages.get(page) || [];
  return {
    status: 200,
    text: async () => JSON.stringify({ code: 200, data: { count: 65, list, isEndPage: page >= 4 ? 1 : 0 } }),
  };
};

// ① 一次风控让位：p1 累积 20 行后 p2 命中校验，逐页回写必须已经落盘 p1 的行与 nextPage=2。
const seenCheckpoints = [];
let yielded = null;
try {
  await collectZhaopinSession('数据采集', city, {
    request: makeRequest({ failAtPage: 2 }), session,
    onProgress: async p => { seenCheckpoints.push({ nextPage: p.nextPage, rows: p.rows.length }); },
  });
} catch (error) { yielded = error.code; }
console.log(`① 风控让位: code=${yielded} 回写次数=${seenCheckpoints.length} 回写=${JSON.stringify(seenCheckpoints)}`);

// ② 带断点续采：跳过已见 ID，从 p2 继续到末页，openapi 空页不再误判。
requested = [];
const result = await collectZhaopinSession('数据采集', city, {
  request: makeRequest(), session,
  startPage: 2, seenIds: ['p1-0', 'p1-1'],
  onPage: p => { if (p.page <= 2) console.log(`② p${p.page} +${p.added} 累计${p.unique}/${p.total} endPage=${p.endPage}`); },
  onProgress: async () => {},
});
console.log(`② 续采: requested=${JSON.stringify(requested)} 新增=${result.rows.length} endReached=${result.endReached} nextPage=${result.nextPage} total=${result.total}`);
console.log(`② 已见 ID 未重复: ${result.rows.every(r => !r.job_id.startsWith('p1-'))}  acquisition_mode=${result.rows[0]?.acquisition_mode}  access_level=${result.rows[0]?.access_level}`);

// ③ maxPages 上限：必须标记 pageLimitReached，并把 nextPage 钳在 pageLimit（不能写成 completed=true）。
const capped = await collectZhaopinSession('数据采集', city, {
  request: makeRequest(), session, maxPages: 3, onProgress: async () => {},
});
console.log(`③ 上限: pagesFetched=${capped.pagesFetched} endReached=${capped.endReached} pageLimitReached=${capped.pageLimitReached} nextPage=${capped.nextPage}`);

// ④ 来源冷却闸门抛出的请求错误必须降级为条件级让位，不得整渠道停采。
// 闸门错误自带 stopChannel:true，若原样上抛会把 45 个组合一起判死。
let gateError = null;
try {
  await collectZhaopinSession('数据采集', { name: '深圳', code: '765' }, {
    request: async () => { throw Object.assign(new Error('该站点处于跨任务冷却期，请稍后人工检查登录、访问限制或限流状态'), { code: 'origin_cooldown', stopChannel: true }); },
    session, onProgress: async () => {},
  });
} catch (error) { gateError = error; }
console.log(`④ 冷却闸门让位: code=${gateError?.code} stopChannel=${gateError?.stopChannel} conditionScoped=${gateError?.conditionScoped}`);
console.log(`④ 提示语: ${gateError?.message}`);