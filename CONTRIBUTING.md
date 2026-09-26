# Contributing to CodexSkin Studio

感谢你愿意改进 CodexSkin Studio。这个项目优先保护用户配置、安全恢复和离线可用性。

## 开始开发

需要 Node.js 22+、Rust stable 和 Windows WebView2。

```powershell
npm ci
npm run dev
```

运行桌面壳：

```powershell
npm run tauri dev
```

## 提交前检查

```powershell
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## 设计约束

- 主题必须是可验证的数据，不得包含可执行 CSS、JavaScript、命令或远程资源。
- 修改 ChatGPT 配置前必须备份，恢复只处理工具声明管理的外观键。
- 不读取账号凭据、聊天记录、API Key 或工作区文件。
- 新增直接配置字段时，请同时提供官方主题导入或明确的兼容兜底。
- 不提交 `node_modules`、`dist`、`src-tauri/target`、生成 schema 或本机恢复点。

Pull request 应说明用户价值、风险、兼容范围和验证结果。影响配置写入的改动必须包含 Rust 测试。
