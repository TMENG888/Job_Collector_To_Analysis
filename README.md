# Job Collector To Analysis

本机岗位采集、统一知识库、AI 打标、岗位洞察与多会话求职助手。仅监听 `127.0.0.1`，不要直接暴露到公网。

更新：2026-10-14。源码不包含真实任务、招聘数据、简历、聊天历史、密钥或登录态。

[图文使用说明](docs/USER_GUIDE.md) · [求职助手说明](docs/求职助手_使用说明.md) · [后端数据通路](docs/统一岗位知识库_后端设计.md) · [本次更新](docs/CHANGELOG-2026-10-14.md)

![多会话求职助手与统一样式](docs/images/09-assistant.jpg)

插图均为本版前端的只读合成演示，不是实际采集结果、薪资结论或算法效果验证。

## 本版能力

- 统一浅色灰绿 UI、图标导航、弹窗、手机会话抽屉。
- 有界多渠道并发、账号锁、断点续采、详情缓存、低新增监测；调整仅在已配置条件内，不绕过验证。
- 平台＋岗位 ID 自动去重写入任务 SQLite，约 15 秒归集中央 SQLite/WAL 知识库。
- 洞察、打标与助手原生读取数据库，不强制先合并文件/导出 CSV；文件导入和下载为兼容能力。
- 四类画像使用中心向外权重递减词云，支持单图缩放/重置/放大；经验—薪资折线、学历和城市环状图、联动条件薪资统计。
- 技术—薪资增量非负回归已退出产品展示；历史代码与测试保留，不作为涨薪建议。
- 多会话纯聊天、净化后的 Markdown、聊天内简历附件、跨岗位检索/统计/比较，可选 DeepSeek / 通义文本模型。
- 采集闭环：读任务/进度/日志 → 准备方案 → 人工按钮确认 → 创建、启动/续采、暂停或下载 → 返回真实回执。聊天中的“确认”只定位卡片；过期需重新准备，不直接执行。

检索为结构化过滤＋关键词加权，不是向量检索；embedding 不是启动前提。岗位自动分类尚未在全部方向完成独立人工验收，请核验具体 JD。

## 环境与依赖

主要支持 Windows。Node.js **22.13+**（使用 `node:sqlite`）、Python 3、完整 Chrome；浏览器切换需要 Edge。简历文字 PDF 解析需 Python `pypdf`，DOCX 使用标准库；扫描件不支持 OCR。

```powershell
npm ci
npm test
npm start
```

默认 <http://127.0.0.1:8765>，也可双击启动 BAT。已有实例可能为 8788，以终端输出为准；不要同时用同一数据目录运行两个主服务。

Excel 导出、XLSX/CSV 读写仍依赖 **`@oai/artifact-tool`（验证版 2.8.59）**，这是 Codex 提供的非公开可选依赖，`npm ci` 不会安装。发布副本延迟加载此组件，原生知识库读取不要求它；文件业务及相应测试仍需有权使用的环境。本次没有替换或打包该组件。

主控制台已内置助手，通常不需要独立服务。兼容旧主服务可运行 `node work/job_assistant_service.mjs`：助手默认 8791，连接旧主端口 8788；主服务为 8765 时先设置 `$env:JOB_UI_PORT='8765'`。

## 使用流程

1. 平台登录页人工完成登录和必要验证。
2. 创建任务，核对岗位关键词、城市、目标、渠道和节奏，运行有界并发采集。
3. 自动去重入库后点击“用于岗位洞察”，无需等任务结束或 CSV 导出。
4. 洞察读取固定版本快照，画像和薪资按条件联动；数据更新需重新生成报告。
5. 助手直接问岗位需求、同条件比较或上传简历；操作采集需核对确认卡并点击按钮。
6. 需要文件时“下载数据（可选）”，更新本任务最新文件，不修改原始断点。

可用性以 `work/channel_availability.mjs` 和任务状态为准。BOSS、鱼泡停止新请求，历史适配器保留；前程无忧重新接入正常页面会话，不保证访问始终可用。资源不足、登录、限流和页面异常需人工处理，目标条数不是交付保证。

薪资为招聘月薪中点统计，不证明因果涨薪；有效样本少于 5 条不报分位，5–19 条提示小样本。不同平台仍可能存在同岗重复。

## 本机配置

启动前设置环境变量，程序不自动读取 `.env`。

| 变量 | 用途 |
| --- | --- |
| `JOB_UI_PORT` | 主端口，默认 8765，BAT 尊重已有值 |
| `JOB_UI_DATA_DIR` | 状态/数据库/日志，默认项目 `ui_data/` |
| `JOB_UI_OPEN_BROWSER` | `1` 时打开控制台 |
| `JOB_UI_NODE` / `JOB_UI_PYTHON` | BAT Node / 合并脚本 Python |
| `JOB_INSIGHT_DATASET_ROOT` | 兼容文件目录，默认项目 `outputs/` |
| `JOB_BROWSER_PROFILE_ROOT` | 受管理浏览器资料目录 |
| `JOB_ASSISTANT_PYTHON` | PDF/DOCX Python，PDF 需 pypdf |
| `JOB_ASSISTANT_SESSIONS_DIR` | 加密历史绝对目录 |
| `JOB_ASSISTANT_PORT` | 兼容助手端口，默认 8791 |

模型在助手右上弹窗配置；密钥由 Windows 当前用户 DPAPI 加密，不回显、不入 Git。聊天中暴露过的密钥应撤销重建，供应商侧建议设预算。

## 目录与验收

```text
job_collector_ui/server.mjs        主服务和编排
job_collector_ui/public/           五模块 UI、Markdown、图表与地图
work/collect_*.mjs                 采集和并发调度
work/job51/                       前程无忧适配器
work/collector_native_sink.mjs     任务 SQLite 入库
work/job_knowledge_*.mjs           中央知识库、版本与接口
work/job_assistant_*.mjs           多轮工具、会话、模型及确认
work/analyze_job_market_sample.mjs 生产洞察
scripts/                         演示、测试、发布检查
docs/                            图文说明与更新记录
```

`npm test` 仅执行列明的合成/临时目录测试，不访问真实招聘平台或模型；部分资源检查是 Windows 本机只读诊断。其他 `test_*.mjs` 包含历史 UI、浏览器、私有数据集成，不要批量对生产执行。私有验收资料不随源码发布。

```powershell
npm run docs:demo
npm run test:docs
npm run check:release
```

演示 <http://127.0.0.1:18979> 为真实前端＋合成数据，不读取生产库，不采集、不调用模型。允许 GET 和严格限定的固定会话读取回放，业务写操作全部拒绝。退出时在终端 Ctrl+C。

升级前确认无活动采集/打标/分析，备份数据库与私有配置后人工重启。源码推送不代表运行服务已重载。

## 第三方与责任

[D3、Marked、DOMPurify 及地图来源](THIRD_PARTY_NOTICES.md)。采集/模型须遵守条款、授权与隐私要求；不支持任意命令、自动投递、验证码破解或绕过账号保护。
