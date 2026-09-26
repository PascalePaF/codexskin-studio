# CodexSkin Studio 1.0.0 发布与验证记录

发布日期：2026-09-26（Asia/Tokyo）

## 发布结论

V1.0.0 已完成 Windows x64 的可安装版本。产品采用“官方主题格式优先、本机快速应用为 Beta”的双路径：用户既可以一键写入当前明暗外观槽位，也可以复制可读的 `codex-theme-v1:` 字符串，通过 ChatGPT Settings → Appearance → Import 使用官方入口。

本次验收没有执行真实的主题写入，也没有重启正在承载开发任务的 ChatGPT；写入、恢复和原子替换均在隔离测试配置中验证。原生调试程序已成功启动并完成只读环境检测。

## 自动化验证

| 检查 | 结果 | 覆盖内容 |
| --- | --- | --- |
| `npm test` | 4/4 通过 | 官方字符串往返、非法前缀、对比度计算、8 套预设 AA 门槛 |
| `cargo test` | 4/4 通过 | 保留无关配置、键级恢复、恶意字体内容拦截、原子文件替换 |
| `npm run build` | 通过 | TypeScript 严格检查与 Vite 生产构建 |
| `cargo clippy --all-targets -- -D warnings` | 通过 | Rust 所有目标零告警 |
| `npm run tauri build` | 通过 | Release 可执行文件与 NSIS 安装器 |
| Release 冒烟测试 | 通过 | 独立程序成功启动并稳定运行；未触发配置写入后退出 |
| `npm audit` | 0 个已知漏洞 | 生产与开发依赖 |

## 界面验收

- 主题库：8 张主题卡片、搜索、深浅筛选、选中态与实时预览正常
- 主题工坊：颜色、字体、模式、对比度、官方字符串操作与应用反馈正常
- 安全导入：错误前缀会在对话框内被拦截，不执行输入内容
- 恢复中心：环境状态、恢复点状态、按钮禁用规则与路径展示正常
- 调研页：官方资料、GitHub、Reddit、X 等核心来源可见
- 1024×768 最小窗口：没有横向溢出，主要控件可通过纵向滚动到达
- 浏览器演示模式：不会写磁盘，可完成全部设计与预览流程

## 构建产物

### Windows x64 安装器

- 路径：`src-tauri/target/release/bundle/nsis/CodexSkin Studio_1.0.0_x64-setup.exe`
- 大小：1,277,492 bytes
- ProductVersion / FileVersion：`1.0.0`
- SHA-256：`8B5CBB50637277BAB445AB04CE666C868F6AF408039CE981109421926B6E4F55`

### 独立可执行文件

- 路径：`src-tauri/target/release/codexskin-studio.exe`
- 大小：3,372,032 bytes
- ProductVersion / FileVersion：`1.0.0`
- SHA-256：`13F34781110077DD8CCD502D200F5A3CEA73548F8C15421FFA1551CC7955219B`

## 已知边界

1. 当前安装器未签名，Windows 可能显示“未知发布者”。公开分发前应配置 Authenticode 代码签名。
2. 快速应用依赖当前 ChatGPT 桌面端使用的外观配置字段。字段发生变化时，用户仍可改走官方主题字符串导入。
3. 图片/视频壁纸、布局重排、图标替换需要 CDP/CSS 注入，不属于 1.0.0 的安全默认能力。
4. 可选“应用后重启”代码路径已实现但本次未做端到端点击验证，以免中断正在进行的 ChatGPT 任务；默认保持关闭。
5. macOS/Linux 尚未产出经过签名与验收的二进制。
