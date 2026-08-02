# 贡献指南（Contributing）

感谢你愿意为 Hanako Mail 贡献！请先阅读 [README](README.md) 了解项目结构，再参考以下约定。

## 开发环境

```bash
# 后端依赖
cd backend && npm install

# 语法校验（所有源码）
for f in backend/*.mjs routes/ui.js tools/*.js helper/*.cjs index.js; do node --check "$f"; done
```

## 分支与提交

- 直接向 `main` 提交小修复；大改动请先开 Issue 讨论。
- 提交信息使用约定式前缀：`feat:` / `fix:` / `perf:` / `refactor:` / `docs:` / `chore:` / `security:`。
- 提交前确保：语法检查通过、CHANGELOG.md 有对应条目。

## 代码约定

- 后端为 ESM（`.mjs`），无构建步骤；路由/工具沿用现有分层（backend / routes / tools / helper）。
- **不使用 emoji 作为功能图标**：UI 图标统一使用 `assets/plugin-page-template.html` 中的 `svgIcon()` 内联描边 SVG。
- 凭据处理：任何新增的敏感字段落盘前必须走 `backend/cred-crypto.mjs` 的加解密；禁止把明文凭据写入日志、前端或 localStorage。
- 子进程调用一律 `spawn(node, [entry, ...args], { shell: false })`，禁止 shell 拼接用户输入。
- 新增后端能力时同步更新 README 的「后端能力矩阵」与 CHANGELOG。

## 测试

- 单元/协议测试无测试框架：以 `node --check` 语法校验 + 自测脚本为主；涉及邮箱协议的真实联调请在本地账号环境完成。

## 发布

版本号遵循 `x.y.z`：安全修复 / 功能 / 重构对应 `minor` 递增，并在 CHANGELOG 记录。发布前请参照仓库审计清单检查密钥、本机路径与运行数据（`backend/data/`）是否被排除。
