# ChatGPT 桌面端换肤工具调研与 V1 产品定义

调研日期：2026-09-26（Asia/Tokyo）

## 结论摘要

ChatGPT 桌面端已经提供原生外观能力：浅色/深色/跟随系统、强调色、背景色、前景色、UI 与代码字体、主题复制/导入。市场同时存在大量通过 CDP 或 CSS 运行时注入实现图片背景、布局和图标改造的项目。

因此，新项目最有价值的切入点不是再造一个高风险注入器，而是：

1. 把官方主题能力做成更好用的可视化主题工坊；
2. 让 Windows 用户真正做到一键应用、清楚知道改了什么、随时精确撤销；
3. 用对比度检查解决“好看但看不清”的普遍问题；
4. 同时输出可分享的官方 `codex-theme-v1:` 字符串，避免把用户锁进私有格式；
5. 图片/视频背景、布局重排和图标替换放入后续明确标注风险的实验通道。

## 官方能力与边界

- [OpenAI Docs：ChatGPT 桌面端 Settings](https://learn.chatgpt.com/docs/reference/settings) 明确列出基础主题、强调色、背景/前景色、UI/代码字体，以及主题分享能力。
- [OpenAI Docs：配置文件](https://learn.chatgpt.com/docs/config-file/config-advanced) 说明本地状态位于 `$CODEX_HOME`（默认 `~/.codex`），用户配置为 `config.toml`。
- [OpenAI Docs：桌面命令与深链](https://learn.chatgpt.com/docs/reference/commands) 说明桌面应用保留 `codex://` 深链。
- 官方公开文档没有承诺 CSS/DOM 注入接口，也没有把任意图片背景描述为稳定主题能力。因此 V1 不注入脚本，不修改安装包。

本机核验（本次开发环境）：Windows 商店包 `OpenAI.Codex 26.924.1866.0`，进程名为 `ChatGPT.exe`；当前 `$CODEX_HOME/config.toml` 已存在 `[desktop].appearanceTheme` 和浅/深代码主题键。安装包内部的主题动作 schema 同时识别浅/深 Chrome 主题、0–100 对比度、字体与语义色。

## GitHub 与开源项目

| 项目 | 路线 | 可借鉴 | 风险/空位 |
| --- | --- | --- | --- |
| [agent-paint](https://github.com/jzlosman/agent-paint) | 生成官方 `codex-theme-v1:` 字符串 | 稳定、便携、无需注入；MIT | 主要是主题包/站点，不是一键桌面管理器 |
| [ReTheme](https://github.com/duxweb/ReTheme) | Tauri 2 + Rust，CDP/CSS 适配层 | 版本适配、签名元数据、恢复机制；BSD-3-Clause | 注入层随客户端 DOM 变化，需要持续维护 |
| [OpenChatGPTSkin](https://github.com/u2bo/OpenChatGPTSkin) | 主题数据契约 + Runtime | “主题是数据而非任意代码”、校验与恢复；MIT | 能力强但系统复杂，兼容成本高 |
| [CC Theme](https://github.com/quanzhankeji/cc-theme) | 版本化 `.cctheme` + Adapter | 包校验、摘要、离线回退；MIT | 当前公开支持偏 macOS，Windows 路线暂停 |
| [HeiGe Codex Skin Studio](https://github.com/jonyhunter/codex-dream-skin) | 回环 CDP 注入，图片取色与主题中心 | 一张图成主题、即时切换、恢复入口；MIT | 调试端口与 DOM 适配风险；素材授权需单独处理 |
| [Paletide](https://paletide.haoyunqiankun.com/) | macOS 视觉设计器 | 图层化编辑、本机处理图片、设计师体验 | Windows 仍是明显空位 |
| [GPTskins](https://github.com/dboyza/GPTskins) | 浏览器扩展 | 用户熟悉的编辑器主题、低门槛主题选择 | 主要覆盖 Web，而不是当前桌面客户端 |

不能借用的代码：CDXTheme 的公开仓库许可证为 proprietary/all rights reserved，本项目只把它作为需求与架构观察样本，不复制实现。

## 社区与需求信号

### OpenAI Developer Community

[桌面端明暗模式独立设置讨论](https://community.openai.com/t/desktop-app-should-allow-dark-light-mode-independent-of-system-setting/761704/17) 说明用户长期需要独立于系统的外观控制，也反复遇到“改完必须完全退出再打开”这一体验问题。

### Reddit / 用户社区

- [默认暗色从灰变黑的讨论](https://www.reddit.com/r/ChatGPT/comments/1t0w3or/chatgpt_dark_theme_changed_from_gray_to_black/) 中，用户集中表达纯黑背景刺眼、希望恢复灰色，并不断寻找用户脚本/扩展替代方案；旧脚本随站点变化失效，是稳定性痛点的直接证据。
- [自定义颜色、字体、宽度与一键切换的主题引擎](https://www.reddit.com/r/ChatGPT/comments/1tz90df/i_built_a_theming_engine_for_chatgpt_custom/) 把“本地运行、无需账号、不上传、无需刷新”作为主要卖点，说明隐私和即时反馈同样重要。

### X

普通索引抓取被 X 拒绝，调研改为登录态浏览器只读搜索。搜索 `Codex theme` 后观察到：

- [Tom Nicholson 的公开帖](https://x.com/TFWNicholson/status/2103415720625496365) 把 Codex 桌面端更可定制（字体大小、主题）直接与开发者个性化和生产力联系起来。
- [Gustave Le Pamauvé 的公开帖](https://x.com/Gustave_Pamauve/status/2103393683504579067) 对 Codex 主题可以导入到 Web 页面表示明显正向反馈，说明可移植与分享是高价值能力。

X 样本是定性信号，不作为市场规模估算。

### 中文开发者生态

中文检索已经出现多个一键换肤、主题画廊、AI 生成主题和 QQ/微信群共创项目，包括 Codex Dream Skin、OpenChatGPTSkin、Codex Themes、玄翎主题以及 CodexSkin.cn。共同卖点高度一致：图片背景、主题库、本地处理、一键恢复、跨重启常驻。说明需求真实，但也意味着“再做一个注入式主题库”差异化不足。

## 用户问题排序

1. **看腻黑白灰 / 默认暗色刺眼**：需要更多温和配色和可读性检查。
2. **想要一键而不是复制脚本**：需要安装后即用、预览后应用。
3. **担心封号、账号与聊天泄露**：需要完全离线，不读取凭据/聊天，不开远端服务。
4. **更新后皮肤失效**：需要优先使用官方主题格式，并明确兼容状态。
5. **怕改坏、不会恢复**：需要先备份、精确撤销、原始外观恢复。
6. **想分享自己的主题**：需要可复制、可审查、无可执行代码的便携格式。
7. **好看但文字看不清**：需要对比度门槛和语义色预览。

## V1.0.0 范围

### 必须有

- Windows x64 桌面程序；代码结构保持 macOS/Linux 可编译
- 原创主题库、搜索、明暗筛选、实时工作区预览
- 自定义颜色/字体/对比度
- WCAG 文字对比度检查
- 官方主题字符串导入、导出/复制
- 本地快速应用到当前明暗槽位
- 完整备份 + 外观键级别撤销/恢复
- 可选重启，默认不打断 ChatGPT 任务
- 无遥测、无登录、无云服务、无脚本主题

### 明确不做

- 不修改 `WindowsApps`、`ChatGPT.app`、`app.asar` 或代码签名
- 不读取 `auth.json`、聊天记录、API Key、模型供应商或项目文件
- 不执行主题中的 CSS、JavaScript、命令或远程 URL
- 不做角色/IP 壁纸分发，避免素材版权风险
- 不声称官方合作或官方兼容认证

## 方案选择

V1 采用 Tauri 2 + React + Rust：前端负责主题设计和预览；Rust 只负责检测 `$CODEX_HOME`、验证结构、备份和格式保留式修改 `config.toml`。主题分享使用公开、可阅读的 `codex-theme-v1:` 字符串。

直接写配置属于“本机快速应用（Beta）”：它仅使用当前客户端已经读写的外观键，但这些键未在公开配置参考里作为长期契约承诺。因此应用内同时保留官方导入工作流；客户端版本变化时，用户仍可复制字符串并通过 Settings → Appearance → Import 完成导入。

## 后续路线

- 1.1（已实现）：主题成对管理（浅/深自动切换）、收藏与最近使用、系统字体检测
- 1.2：安全主题包（JSON + 摘要 + 预览，不含执行代码）与社区静态目录
- 1.3：从图片本地取色，但只生成官方颜色主题
- 2.0 Experimental：隔离的壁纸/布局增强 Adapter；按客户端版本门控、显式风险提示、启动健康检查与自动回退

## 成功指标

- 首次用户 60 秒内完成预览与应用
- 100% 应用动作可撤销；配置写入失败时不丢失原文件
- 内置主题前景/背景至少满足 WCAG AA 正文对比度（4.5:1）
- 无网络时完整可用
- ChatGPT 更新导致快速应用不可用时，官方字符串导入仍可用
