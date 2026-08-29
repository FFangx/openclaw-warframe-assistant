# 贡献指南（Contributing）

感谢你愿意为这个个人维护的 Warframe 助手项目贡献。请先读完本文件再动手，
它很短，但能避免大量返工。

## 项目定位（先对齐预期）

- 个人维护、业余时间驱动的项目：**没有 SLA**，issue/PR 的响应完全看维护者时间。
- 目标用户是项目作者自己（QQ 私聊/群聊使用），公开仓库面向学习与复用。
- **只读边界不可妥协**：不得引入任何市场写操作（挂单/改单/删单/自动压价）、游戏内自动化/宏、
  或绕过「主人私聊 + 精确身份」门读取个人数据的能力。以「测试能过」为理由弱化这些边界会被直接拒绝。
- 游戏素材授权有严格约束，见 [ASSET-LICENSES.md](ASSET-LICENSES.md)：不要往仓库里添加来源不明、
  无法证实再分发许可的图片/素材。

## 行为准则

参与即视为同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 怎么报告问题

- **安全问题**：见 [SECURITY.md](SECURITY.md)——私有漏洞报告优先，未启用前不要在公开渠道贴细节。
- **功能问题/建议**：开 issue，用仓库自带的 issue 模板（Bug report / Feature request）。
  请包含：命令原文、期望输出、实际输出、`doctor.mjs` 功能矩阵截图或文本、数据时间。

## 开发环境

- Windows + PowerShell 7（`pwsh`）+ Node.js 20 或 24。
- 零 npm 强依赖：Skill 脚本只用 Node 内置模块；`sharp` 是可选优化（见 `skill/package.json`）。
- 克隆后无需安装任何依赖即可跑测试（如要验证 lockfile 一致性：`cd skill && npm ci --ignore-scripts`）。

## 改动前必读

- `skill/SKILL.md`：AI 行为契约（硬性规则）。功能行为说明在 `skill/references/capabilities.md`，
  改功能时**必须**同步它。
- `AGENTS.md`（工作区路由，含运行时 Skill 路径与安全边界约定）。
- 版本唯一来源是根目录 `VERSION`；`skill/package.json` 与 `extension/package.json` 的 `version` 必须与它一致
  （`tests/repo-metadata.test.ps1` 强制校验）。extension 是私有、不发布到 npm 的插件包，版本与仓库发布对齐，
  不要单独升它的版本号。

## 测试要求（提交前必须全绿）

```powershell
# 1. 代码风格与空白
git diff --check

# 2. 源码层全量验证（Skill 测试、扩展合同、安装器生命周期、发布/卸载/元数据合同）
pwsh -NoProfile -File .\verify.ps1 -SourceOnly
```

- 新增 PowerShell 脚本或测试：用 `pwsh -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile('文件', [ref]$null, [ref]$errs)"` 做语法检查。
- 新增 `.mjs` 文件：`node --check 文件`。
- 新增行为必须配合同测试：`skill/scripts/*.test.mjs`（零联网、零凭据、临时目录隔离）、
  `extension/*.test.mjs`、或 `tests/*.test.ps1`。**测试绝不允许**触碰真实 OpenClaw 工作区、
  真实 `%APPDATA%`、真实 cron 或真实 QQ/账号——一律用 GUID 临时目录与假 CLI。
- 不要为了让测试通过而放松安全断言。

维护者需要重建奸商商品的静态税率/说明清单时，在仓库根目录运行
`node tools/build-baro-static.mjs`。它会联网并覆盖 `skill/scripts/baro-static.json`；提交前必须审查数据差异。
这是维护工具，不属于运行时 Skill。

安装器或卸载器有较大改动时，可在一次性 Windows VM 中运行
`scripts/env-smoke.ps1`，验证干净环境安装、幂等重装、数据保留卸载和完全清理卸载。

## 分支与提交

- 小改动直接基于 `main` 开分支；提交信息用英文祈使句前缀，如 `fix:`、`feat:`、`test:`、`docs:`、`build:`。
- `img/` 只保留 README 实际引用且已在 `ASSET-LICENSES.md` 登记的展示图；不要提交任何凭据、
  个人快照、`tests/cn-reward-result.json` 之类本机输出。
- 发布流程由维护者用 `release.ps1` 执行；贡献者不需要打标签。

## 发布前素材核对

公开仓库发布的素材处置见 [ASSET-LICENSES.md](ASSET-LICENSES.md) 第 4 节处置清单：
内置 DE 游戏素材（货币/遗物/源力石/未开封紫卡）按 DE Content Policy 非商业条件保留（渠道如实记录、不主张 AlecaFrame 授权）；
genesis-assets 派生图标随附 `LICENSES/` 的 Apache-2.0 全文与来源说明；
`img/` 展示图必须逐项登记并经过隐私检查。新增内置素材前先读该文件。
