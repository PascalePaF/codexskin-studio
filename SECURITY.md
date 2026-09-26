# Security Policy

## Supported versions

当前维护最新的稳定小版本。安全修复会优先发布在最新版本上。

## Reporting a vulnerability

请不要在公开 Issue 中粘贴凭据、配置文件、聊天内容或可直接利用的漏洞细节。使用 GitHub 仓库的 **Security → Report a vulnerability** 私下报告；如果私密报告尚未启用，请只创建一个不含敏感细节的 Issue，请求维护者提供私下联系渠道。

报告请包含受影响版本、操作系统、复现前提、影响范围和最小化复现。请勿附带真实账号数据。

## Project boundaries

CodexSkin Studio 不需要 ChatGPT 凭据，不读取聊天记录，也不执行主题中的代码。它会在用户明确点击应用后修改 `$CODEX_HOME/config.toml` 的声明外观键，因此配置完整性、备份和恢复问题均视为安全相关问题。
