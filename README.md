# CodexSkin Studio 1.2.0

[![Windows CI](https://github.com/PascalePaF/codexskin-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/PascalePaF/codexskin-studio/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-6e8cff.svg)](LICENSE)

一个 Windows 优先、本地优先的 ChatGPT 桌面皮肤工具。它把官方颜色主题与可选的会话级图片背景组合在一个可视化工作台里，不修改官方安装包、`app.asar`、签名文件、账号信息或聊天数据。

## 下载 Windows 安装版

前往 [GitHub Releases](https://github.com/PascalePaF/codexskin-studio/releases/latest) 下载 `CodexSkin Studio_1.2.0_x64-setup.exe`。当前社区构建没有商业代码签名证书，Windows 首次运行时可能显示“未知发布者”；发布页同时提供 SHA-256，便于校验文件完整性。

## 1.2 已完成

- 选择本机 PNG、JPEG、WebP 作为 ChatGPT 图片背景，最大 8 MiB
- 实时调整图片强度、暗色遮罩、模糊、缩放、水平/垂直焦点和面板透明度
- 选择背景只进入主内容区，或延伸到整个窗口
- 图片真实格式、像素尺寸与文件体积在 Rust 后端重新校验
- 图片背景通过只绑定 `127.0.0.1` 的会话级增强通道应用，不修改 ChatGPT 安装文件
- 首次启用若需要重开 ChatGPT，会先显示明确确认；默认不会中断当前任务
- 一键移除当前效果或彻底清除 CodexSkin 保存的图片副本
- 独立 Chromium 冒烟测试覆盖载入图片、注入、健康检查、应用状态和清理回退

- 8 套原创浅色/深色主题，支持搜索与筛选
- 4 组浅色/深色主题组合，可一次应用并跟随系统明暗切换
- 本地收藏、最近使用与上次选择记忆
- 本机字体扫描与可搜索的字体候选列表
- 模拟 ChatGPT 工作区的实时预览
- 自定义强调色、背景、前景、Diff 与 Skill 颜色、对比度和字体
- 自动计算 WCAG 对比度，并给出 AA/AAA 可读性结论
- 生成、复制和导入官方 `codex-theme-v1:` 外观字符串
- 一键写入 `$CODEX_HOME/config.toml` 的当前外观槽位
- 每次写入前保存完整应急备份，同时只记录和恢复外观相关键
- “撤销上次应用”与“恢复首次使用前外观”不会覆盖模型、权限、插件等其他配置
- 可选的应用后重启（默认关闭，避免打断正在运行的任务）
- 浏览器演示模式：离开 Tauri 壳也能预览和设计主题

> CodexSkin Studio 是独立社区项目，与 OpenAI 没有隶属或背书关系。ChatGPT、Codex 及相关名称归各自权利人所有。

## 安装使用

从源码执行 `npm run tauri build` 后，Windows x64 安装器位于：

```text
src-tauri/target/release/bundle/nsis/CodexSkin Studio_1.2.0_x64-setup.exe
```

也可以直接运行 `src-tauri/target/release/codexskin-studio.exe`。构建产物默认不提交到 Git；当前本地构建没有商业代码签名证书，Windows 可能显示“未知发布者”。

## 开发运行

环境要求：Node.js 22+、Rust stable、Windows 10/11 的 WebView2（Windows 11 通常已内置）。

```powershell
npm install
npm run tauri dev
```

只查看前端：

```powershell
npm run dev
```

## 验证与构建

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

Windows 安装包会输出到 `src-tauri/target/release/bundle/nsis/`。不打安装包时，可运行：

```powershell
npm run tauri build -- --no-bundle
```

生成的独立程序位于 `src-tauri/target/release/codexskin-studio.exe`。

## 安全模型

直接应用只管理 `[desktop]` 下的以下键：

- `appearanceTheme`
- `appearanceLightCodeThemeId`
- `appearanceDarkCodeThemeId`
- `appearanceLightChromeTheme`
- `appearanceDarkChromeTheme`

首次应用会保存这些键的原始值；每次应用和恢复前都会备份完整 `config.toml`。主题字符串导入仅接受固定前缀、固定字段、十六进制颜色和有限数值，不执行 CSS、JavaScript、命令、远程 URL 或任意文件路径。

“一键应用到 ChatGPT”属于本机快速应用 Beta：它使用当前桌面客户端已经读写的外观键，但这些键尚未成为公开的长期配置契约。若未来客户端调整字段，仍可使用“复制官方格式”，在 ChatGPT 的 Settings → Appearance → Import 中导入。

图片背景是明确标注的实验功能。官方文档目前只公开背景**颜色**，没有公开任意图片背景字段。CodexSkin 只接受固定图片类型和有限数值，生成自己的受限样式；HTTP 与 WebSocket 都必须是同一端口上的 `127.0.0.1`。它不会安装常驻服务、修改快捷方式或接受第三方脚本。关闭 ChatGPT 后增强层自动失效；保存的图片副本位于 CodexSkin 自己的应用数据目录。

## 调研与产品判断

完整调查、竞品矩阵、社区需求、风险与路线图见 [docs/RESEARCH.md](docs/RESEARCH.md)。

1.2.0 的实施计划见 [docs/PLAN-1.2.0.md](docs/PLAN-1.2.0.md)，发布验证、已知边界与 SHA-256 见 [docs/RELEASE-NOTES-1.2.0.md](docs/RELEASE-NOTES-1.2.0.md)。

## 许可证

[MIT](LICENSE)
