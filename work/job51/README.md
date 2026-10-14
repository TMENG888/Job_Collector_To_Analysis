# 前程无忧（job51）采集模块

## 文件结构

- `collector.mjs`：打开本地共享浏览器、监听岗位搜索响应、分页采集并保存断点。
- `normalizer.mjs`：把前程无忧原始岗位字段转换为 Job Collector 的统一字段。
- `../browser_channel_common.mjs`：公开浏览器渠道共用的登录／安全验证检测、浏览器连接、断点和诊断截图。
- `../collect_public_job_platforms.mjs`：任务编排、历史数据迁移、CSV 输出和采集清单。
- `../managed_browser.mjs`：共享浏览器生命周期与本地登录态复用。
- `../collection_policy.mjs`：HTTP、限流和安全验证响应处理。

## 调用链

`job_collector_ui/server.mjs` → `collect_parallel_channels.mjs` → `collect_public_job_platforms.mjs` → `job51/collector.mjs` → `job51/normalizer.mjs`

## 安全规则

采集仅使用正常页面会话。遇到登录、验证码、安全验证、HTTP 401／403／429 或页面结构异常时立即停止当前渠道，保存断点、诊断 JSON 和截图，不自动绕过验证。

## 测试

在项目根目录运行：

```powershell
node work/test_public_browser_channels.mjs
node work/test_channel_retirement.mjs
```
