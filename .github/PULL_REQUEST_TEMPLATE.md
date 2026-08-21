## 变更内容

<!-- 用一两句说明这个 PR 改了什么、为什么。 -->

## 检查清单

- [ ] 已阅读 [CONTRIBUTING.md](../CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)
- [ ] 未引入市场写操作、游戏自动化或绕过个人数据身份门的能力
- [ ] 未添加来源不明/无法证实再分发许可的素材（见 [ASSET-LICENSES.md](../ASSET-LICENSES.md)）
- [ ] 未包含任何凭据、QQ openid、个人快照或本机路径
- [ ] 行为变化已同步 `skill/SKILL.md` / `skill/references/capabilities.md`（如适用）
- [ ] `git diff --check` 通过
- [ ] `pwsh -NoProfile -File .\verify.ps1 -SourceOnly` 通过
- [ ] 新增/修改的脚本通过语法检查（`node --check` / PowerShell Parser）

## 测试说明

<!-- 贴关键测试输出；说明测试如何隔离（临时目录/假 CLI/零联网），不触碰真实工作区。 -->

## 关联 issue

<!-- Closes #123 或 N/A -->
