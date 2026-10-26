# HTTP 采集运行依赖

就业在线公开接口的标准 SM 请求编码使用 MIT 许可的 `sm-crypto@0.3.13`（传递依赖 `jsbn@1.1.0`）。版本与完整性摘要固定在根目录 `package-lock.json`，安装时不执行包生命周期脚本。

猎聘会话捕获助手使用 `playwright-core@1.62.1`，仅包含 JavaScript 控制库，不下载浏览器；助手显式选择本机已有的 Chrome，保持普通浏览器交互与人工验证流程，不提供 stealth 或验证码绕过。

本机 C 盘空间有限，请使用附带脚本把小型运行依赖与 npm 缓存留在 E 盘；项目根 `node_modules` 仅为 Junction，Node 无需自定义加载器或环境变量。不要迁移或复制 Codex 运行时。

```powershell
node work/install_collector_dependencies.mjs "E:/Codex/work/20261022-channel-repair/jobonline/runtime" "E:/Codex/work/20261022-channel-repair/jobonline/npm-cache"
node work/test_jobonline_direct.mjs
```

也可用 `npm run install:collector -- <外部绝对目录> <缓存绝对目录>`。脚本需使用带 npm 的 Node 安装运行；安装完成后普通 Node 与桌面服务均按 Node 标准包解析访问 Junction。已有普通 `node_modules` 或指向其他位置的链接不会被替换；安装目录若含其他内容也会拒绝覆盖。

`checkJobonlineDependencies()` 可在启动渠道时做一次离线预检。依赖缺失时返回 `dependency_missing`、`stopChannel: true`，不发网络请求；修复前不应遍历所有关键词/城市并反复报同一错误。预检成功不等同于实网接口可用，服务端契约变化、验证、401/403/429 仍应停止渠道。

此安装步骤只修复本地依赖，不变更采集任务、登录资料、请求频率或断点。新建任务的就业在线城市使用用户选定的城市，不再无条件扩展至全部 30 城；历史任务如需调整，应由维护流程另行核对，不能以重置断点方式迁移。
