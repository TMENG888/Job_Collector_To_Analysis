// 就业在线 HTTP 直连专项测试：
//  验证 SM 加密链路的格式契约、响应解析、字段映射与失败处理。
//  不发真实网络请求；仅校验加密/解析逻辑（真实采集已另行实测）。
import assert from 'node:assert/strict';
import {jobonlineRequest, parseJobonlineResponse, normalizeJobonline, JOBONLINE_SM2_PUBLIC_KEY, jobonlineHeaders} from './direct_jobonline_adapter.mjs';


let checks = 0;

// 1) SM2 公钥格式：04 开头、130 hex
assert.match(JOBONLINE_SM2_PUBLIC_KEY, /^04[0-9a-f]{128}$/); checks++;

// 2) 请求构造：URL、方法、加密字段格式
const req = jobonlineRequest('软件测试', { name: '北京', code: '110100' });
assert.match(req.url, /showlist\?bodytarget=SEARCH_RESULT_PAGE$/); checks++;
assert.equal(req.options.method, 'POST'); checks++;
assert.equal(req.options.headers['e-content-path'].length, 456, 'E-CONTENT-PATH 应为 456 字符'); checks++;
assert.equal(req.options.headers['e-sign'].length, 64, 'E-SIGN 应为 64 字符'); checks++;
assert.match(req.options.headers['e-content-path'], /^04/); checks++;
const body = JSON.parse(req.options.body);
assert.match(body.businessData, /^[0-9a-f]+$/); checks++;
assert.equal(body.businessData.length, 1184, 'businessData 应为 1184 字符'); checks++;

// 3) 每次请求密钥不同（随机性）
const req2 = jobonlineRequest('软件测试', { name: '北京', code: '110100' });
assert.notEqual(req.options.headers['e-content-path'], req2.options.headers['e-content-path']); checks++;
assert.notEqual(req.options.body, req2.options.body); checks++;

// 4) 城市代码：非6位数字时置空（全国）
const reqNoCity = jobonlineRequest('软件测试', { name: '全国', code: '全国' });
assert.ok(reqNoCity, '全国查询应可构造'); checks++;

// 5) 空关键词拒绝
assert.throws(() => jobonlineRequest('', { name: '北京', code: '110100' }), e => e.code === 'invalid_config'); checks++;

// 6) 响应解析：正常
const parsed = parseJobonlineResponse({ code: '200', message: '', object: { searchList: [{ id: '1', positionName: '软件测试' }] } });
assert.equal(parsed.list.length, 1); checks++;

// 7) 响应解析：5009 契约变化
assert.throws(() => parseJobonlineResponse({ code: '5009', message: '未获取到解密后数据' }), e => e.code === 'api_schema_changed'); checks++;

// 8) 响应解析：非200业务码
assert.throws(() => parseJobonlineResponse({ code: '20010', message: '请求异常' }), e => e.code === 'invalid_response'); checks++;

// 9) 响应解析：缺列表
assert.throws(() => parseJobonlineResponse({ code: '200', object: {} }), e => e.code === 'invalid_response'); checks++;

// 10) 字段映射
const row = normalizeJobonline({ id: '2060274608455696387', positionName: '销售工程师/高级销售工程师', companyName: '某公司', cityName: '深圳市', lowSalary: '1', highSalary: '1.8', jobAge: '经验不限', category: '社招', nature: '民营', industryName: '制造业', publishTime: 1789805634 }, '销售工程师', '深圳');
assert.equal(row.platform, '就业在线'); assert.equal(row.job_id, '2060274608455696387'); assert.equal(row.query_keyword, '销售工程师'); checks++;
assert.equal(row.city, '深圳市'); assert.match(row.salary, /1-1\.8万元/); assert.equal(row.company_name, '某公司'); checks++;
assert.match(row.job_url, /positionDetail\?id=2060274608455696387/); checks++;

// 11) 缺 ID/标题拒绝
assert.throws(() => normalizeJobonline({ positionName: 'x' }, 'k', 'c'), e => e.code === 'invalid_response'); checks++;
assert.throws(() => normalizeJobonline({ id: '1', positionName: '' }, 'k', 'c'), e => e.code === 'invalid_response'); checks++;

// 12) 请求头不含凭据
const h = jobonlineHeaders();
assert.ok(!/authorization|cookie|token/i.test(Object.keys(h).join(','))); checks++;

console.log(`PASS jobonline direct: ${checks} checks; SM 加密格式契约、随机密钥、响应解析、失败码区分、字段映射、无凭据`);