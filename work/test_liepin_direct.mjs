// 猎聘 HTTP 直连专项测试：
//  验证请求体契约、ckId 传递、响应解析、字段映射、失败码区分。
//  不发真实网络请求；真实采集已另行实测。
import assert from 'node:assert/strict';
import {liepinRequestBody, parseLiepinResponse, normalizeLiepinCard, liepinHeaders} from './direct_liepin_adapter.mjs';

let checks = 0;

// 1) 请求体结构
const body = liepinRequestBody('软件测试', '010', 3, 40, 'abc123');
const form = body.data.mainSearchPcConditionForm;
assert.equal(form.key, '软件测试'); assert.equal(form.city, '010'); assert.equal(form.dq, '010'); checks++;
assert.equal(form.currentPage, 3); assert.equal(form.pageSize, 40); checks++;
assert.equal(body.data.passThroughForm.ckId, 'abc123'); assert.equal(body.data.passThroughForm.scene, 'init'); checks++;
assert.equal(Object.keys(form).length, 20, 'form 应含 20 字段'); checks++;

// 2) 空关键词拒绝
assert.throws(() => liepinRequestBody('', '010', 0), e => e.code === 'invalid_config'); checks++;
// 3) 非法页码拒绝
assert.throws(() => liepinRequestBody('x', '010', -1), e => e.code === 'invalid_config'); checks++;

// 4) 响应解析：正常
const parsed = parseLiepinResponse({ flag: 1, data: { data: { jobCardList: [{ job: { jobId: '1', title: '软件测试' } }] } } });
assert.equal(parsed.list.length, 1); checks++;
// 5) 响应解析：-1400
assert.throws(() => parseLiepinResponse({ flag: 0, code: '-1400', msg: '出错了（400）！' }), e => e.code === 'verification_required'); checks++;
// 6) 响应解析：其他失败
assert.throws(() => parseLiepinResponse({ flag: 0, code: '-500', msg: '其他错误' }), e => e.code === 'api_schema_changed'); checks++;
// 7) 缺列表
assert.throws(() => parseLiepinResponse({ flag: 1, data: { data: {} } }), e => e.code === 'invalid_response'); checks++;

// 8) 字段映射
const row = normalizeLiepinCard({ job: { jobId: '86153773', title: '座舱软件测试工程师', salary: '15-40k·15薪', dq: '北京-大兴区', requireWorkYears: '3-8年', requireEduLevel: '统招本科', link: 'https://www.liepin.com/job/1986153773.shtml' }, comp: { compId: 9629792, compName: '埃夫特', compScale: '1000-2000人', compIndustry: '工业自动化', link: 'https://www.liepin.com/company/9629792/' } }, '软件测试', '北京');
assert.equal(row.platform, '猎聘'); assert.equal(row.job_id, '86153773'); assert.equal(row.job_name, '座舱软件测试工程师'); checks++;
assert.equal(row.company_name, '埃夫特'); assert.equal(row.salary, '15-40k·15薪'); assert.equal(row.city, '北京-大兴区'); checks++;
assert.match(row.job_url, /liepin\.com\/job\/1986153773/); checks++;

// 9) 缺 ID/标题拒绝
assert.throws(() => normalizeLiepinCard({ job: { title: 'x' } }, 'k', 'c'), e => e.code === 'invalid_response'); checks++;
assert.throws(() => normalizeLiepinCard({ job: { jobId: '1', title: '' } }, 'k', 'c'), e => e.code === 'invalid_response'); checks++;

// 10) headers 含凭据（会话渠道允许），且 csrf 一致
const h = liepinHeaders({ cookie: 'a=b', xsrf: 'TOK' });
assert.equal(h['x-xsrf-token'], 'TOK'); assert.match(h.cookie, /a=b/); checks++;

console.log(`PASS liepin direct: ${checks} checks; 请求体契约、ckId 传递、响应解析、失败码区分、字段映射`);