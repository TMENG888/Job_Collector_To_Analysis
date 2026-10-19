# 岗位采集与分析工作台

当前源码版本：**0.2.0 · 2026-10-19**。包含采集中心、统一岗位知识库、岗位洞察、求职助手、普通浏览器扩展，以及 Electron 桌面原型。仅监听本机地址，不要直接暴露到公网。

[本版更新与验证](docs/CHANGELOG-2026-10-19.md) · [桌面原型说明](desktop/README.md) · [历史图文说明](docs/USER_GUIDE.md)

## 本版能力与边界

- 多渠道任务、关键词扩展、城市与渠道配置、断点和资源保护；任务不再以目标条数为停止条件，按可访问范围及安全分页预算采集。限流、验证或预算停止不代表平台已采完。
- 采集中间数据经去重写入 SQLite 知识库，可直接用于洞察和助手，不需要先导出文件。
- 岗位洞察使用 TF-IDF＋逻辑回归监督筛选。已发布固定模型或当前数据集启用的候选模型可用；没有可用模型时明确停止，不静默退回纯规则纳入。
- Qwen 少样本标注、候选训练、公司与近重复隔离评测、Token 和费用估算、人工核验及手动启用。代理评测是对模型标签的一致性，不等同人工准确率或全库效果。
- 求职助手支持按本轮问题切换岗位与查询范围，采集配置变更和写操作仍需核对确认卡片。
- 普通 Chrome/Edge＋本地 MV3 扩展：配对、当前岗位读取、简历匹配、镜像交互和确认后的有界求职操作。镜像交互仍有浏览器授权、焦点及站点兼容性限制，不承诺与原生网页完全等价。
- Electron 桌面原型：本地工作台与招聘网页独立渲染，原生鼠标和键盘交互、多标签与独立会话；顶部导航统一，避免重复侧栏。招聘网页无 Node/preload 权限。
- 已移除旧平台登录和 AI 标注独立导航。历史兼容代码和测试保留，不表示旧入口仍然开放。

桌面原型只接入岗位读取和本地分类，并未把 Web 扩展的沟通、简历截图发送、智能投递通道迁移到 Electron。它不是已打包的独立 EXE 安装程序；不控制用户已有 Chrome，不保证招聘站点接受 Electron，也不规避验证或反爬。

## Web 安装与启动

主要支持 Windows，Node.js **22.13+**、npm、Python 3 和已安装的 Chrome/Edge。

```powershell
npm ci
$env:JOB_UI_PORT='8788'
$env:JOB_UI_DATA_DIR='E:\岗位工作台\data'
$env:TEMP='E:\岗位工作台\temp'
$env:TMP=$env:TEMP
New-Item -ItemType Directory -Force $env:JOB_UI_DATA_DIR,$env:TEMP
npm start
```

打开 <http://127.0.0.1:8788>。主服务默认端口仍是 8765；扩展默认连接 8788，使用扩展时建议按上例指定。不要让两个服务同时写同一数据目录。BAT 入口尊重预设的 JOB_UI_PORT。

SQLite 和固定监督分类器使用原生 Node 推理，不需要在线模型调用或 Python 即可启动。文件导入、Excel 导出仍依赖可选的 `@oai/artifact-tool`（验证版 2.8.59），该组件不是公开 npm 安装依赖；未配置时不要调用相应文件功能。

## Qwen 标注、训练与简历

安装可选 Python 依赖：

```powershell
python -m venv E:\岗位工作台\python-env
E:\岗位工作台\python-env\Scripts\python.exe -m pip install -r requirements.txt
$env:JOB_INSIGHT_PYTHON='E:\岗位工作台\python-env\Scripts\python.exe'
$env:JOB_ASSISTANT_PYTHON=$env:JOB_INSIGHT_PYTHON
$env:JOB_INSIGHT_QWEN_BASE_URL='https://你的业务空间.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
npm start
```

使用供应商控制台提供的真实 OpenAI 兼容 Base URL（不含 /chat/completions）。默认地址为 DashScope 兼容入口，具体模型可用性以你的地域、业务空间和账户权限为准。模型默认为 qwen3.7-flash。

在岗位洞察中配置自己的 API Key，再点击标注、训练并手动启用。Key 采用当前 Windows 用户 DPAPI 加密，不写入源码。Qwen 会接收经过字段处理的岗位文本；提交前确认有权向供应商发送。费用显示按设定单价估算，实际账单与代金券抵扣以供应商为准。

PDF 文字解析需 pypdf，原版式页面渲染需 pypdfium2/Pillow。简历截图只接受原版式 PDF；DOCX 请先自行转 PDF。简历需在本机重新上传，不随源码分发。

## 浏览器扩展与桌面

扩展源码在 `job_collector_ui/browser-extension/`。在 Chrome/Edge 扩展管理页开启开发者模式并加载该目录，在工作台完成配对。浏览器登录和验证码由用户手动处理；不要把登录会话上传 GitHub。

桌面原型首次启动：

```powershell
pwsh -NoProfile -File .\desktop\start.ps1 -Install -BaseUrl http://127.0.0.1:8788
```

后续可在资源管理器中双击 `desktop/打开岗位工作台.cmd`。需要 PowerShell 7；优先查找 Codex 已有运行时或系统安装。Electron 44.9.0 从官方固定版本下载并校验 SHA256。为遵循本机约定，桌面运行时、日志和独立会话默认放 E 盘；E 盘不存在会明确停止，不悄悄回退 C 盘。

`pwsh.exe` 仅负责启动环境，不是容器；实际 GUI 由 electron.exe 运行。源码更新后重开 App 即可加载桌面壳更新。Web 后端更新是否需要重启须另外确认，源码推送不会自动重启生产服务。

## 数据与发布

本仓库包含程序源码、合成测试及 4 个经哈希校验的固定监督推理模型；不包含原始训练/标注样本、岗位数据库、任务配置、采集结果、真实简历、聊天记录、API Key、浏览器登录态、私有候选模型、虚拟环境或 Electron 二进制。新电脑需要重新配置密钥、数据路径和个人候选分类器。

`work/models/role-screening/` 是严格白名单，仅发布固定推理权重及注册清单。用户训练的新模型及训练日志仍留在自己的数据目录。固定模型仅覆盖数据分析、嵌入式开发、测试工程和智能体/大模型应用；其他岗位必须在本机完成标注、训练和启用。

配置通过环境变量或本机私有配置读取，不自动加载 .env。常用变量：

| 变量 | 用途 |
| --- | --- |
| JOB_UI_PORT / JOB_UI_DATA_DIR | 本机端口和私有数据目录 |
| JOB_TASK_OUTPUT_ROOT / JOB_TASK_BACKUP_ROOT | 任务输出与备份目录 |
| JOB_INSIGHT_DATASET_ROOT | 兼容文件数据集目录 |
| JOB_INSIGHT_CLASSIFIER_DIR | 私有候选模型、标注记录与密钥目录 |
| JOB_INSIGHT_PYTHON / JOB_ASSISTANT_PYTHON | 训练与简历解析 Python |
| JOB_INSIGHT_QWEN_BASE_URL | 自己的供应商兼容 Base URL |
| JOB_ASSISTANT_SESSIONS_DIR | 加密聊天历史目录 |

## 检查与已知限制

```powershell
npm test
npm run test:desktop
npm run check:release
```

默认测试使用合成数据和临时目录；私有数据、实网集成及付费标注不属于默认验收。完整验证结果和未通过项见本版更新记录。测试不替代真实站点登录、发送和长期稳定性验收。

历史图文说明记录旧版本，可能含已移除的入口或目标条数配置；当前功能以本 README、本版更新和代码为准。第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，不改变原第三方许可。
