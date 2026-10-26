// 前程无忧会话采集（方案A）专项测试：
//  验证 job51 在混合模式下的能力声明、会话门槛、以及 API 监听采集器的契约。
//  不发真实网络请求；使用固定 fixture。
import assert from 'node:assert/strict';
import {collect51Records, parse51Payload} from './job51/collector.mjs';
import {normalize51Records} from './job51/normalizer.mjs';
import {ChannelError} from './browser_channel_common.mjs';
import {channelAcquisition, HYBRID_MODE} from './channel_acquisition.mjs';
import {collectionChannelAvailable} from './channel_availability.mjs';
import {browserFallbackAllowed} from './browser_fallback_policy.mjs';

let checks = 0;

// 1) 元数据：job51 为会话代理（浏览器提供 WAF 会话 + 调用接口）；任何模式可用
assert.equal(channelAcquisition.job51.directHttpReady, false); checks++;
assert.equal(collectionChannelAvailable('job51'), true); checks++;
assert.equal(collectionChannelAvailable('job51', {transportMode: HYBRID_MODE}), true); checks++;
assert.equal(browserFallbackAllowed({mode: HYBRID_MODE, platform: 'job51', httpReady: false, errors: []}), true); checks++;
// 验证类错误阻止浏览器回退（需人工处理）
assert.equal(browserFallbackAllowed({mode: HYBRID_MODE, platform: 'job51', httpReady: false, errors: [{code: 'verification_required'}]}), false); checks++;

// 2) 响应解析契约：无岗位列表应停止
assert.throws(() => parse51Payload({ resultbody: {} }), e => e instanceof ChannelError && e.code === 'invalid_response'); checks++;
assert.throws(() => parse51Payload({ resultbody: { job: { items: [] } } }), e => e.code === 'invalid_response'); checks++;

// 3) 正常响应解析
const payload = { status: '1', resultbody: { job: { items: [{ jobId: '1', jobName: '销售工程师' }], totalCount: 522 } } };
const parsed = parse51Payload(payload);
assert.equal(parsed.total, 522); assert.equal(parsed.items.length, 1); checks++;

// 4) 会话缺失时 collect51Records 应报错而不是静默返回空
const fakeFactory = async () => { throw new ChannelError('缺少本地会话', 'client_unavailable'); };
await assert.rejects(
  collect51Records('销售工程师', { name: '北京', code: '010000' }, { checkpointPath: '/tmp/nonexistent-' + Date.now() + '.json', contextFactory: fakeFactory }),
  e => e instanceof ChannelError
); checks++;

// 5) 标准化字段映射
const rows = normalize51Records([{ jobId: '9', jobName: '销售', fullCompanyName: '测试公司', provideSalaryString: '1-2万', jobAreaString: '北京' }], '销售工程师', { name: '北京' }, 100, { htmlToText: v => String(v || '').trim(), collectedAt: '2026-10-16' });
assert.equal(rows[0].platform, '前程无忧'); assert.equal(rows[0].job_id, '9'); assert.equal(rows[0].query_keyword, '销售工程师'); checks++;

console.log(`PASS job51 session: ${checks} checks; 会话渠道门槛、验证阻止回退、响应契约、失败不静默、字段映射`);