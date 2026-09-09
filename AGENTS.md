# Agent entrypoint

- Setup、首次部署、接入新的 CLI 或新增 profile：先读 [docs/agent-setup.md](docs/agent-setup.md)，按步骤完成注册、完整用户身份授权和真实验证，再交付可用状态。
- 运行与排错命令见 [README.zh.md](README.zh.md) / [README.md](README.md)。参数与脚本以当前 checkout 的 `--help` 和 `package.json` 为准。
- 编码前核对当前 worktree、branch 和未提交改动；保留他人的修改。生产修复先写有意义的失败回归，再实现并在该 worktree 执行 `pnpm ci:local`。
- 仅文档修改核验路径、链接、命令与状态，不为此启动真实 bot 或重新请求账号授权。
