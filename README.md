<div align="center">

# 🎴 OpenClaw Warframe 助手

**Warframe 国际服 QQ 机器人：短命令秒出精美卡片，AI 只做路由和点评，数据不经模型编造**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/FFangx/openclaw-warframe-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/FFangx/openclaw-warframe-assistant/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)](FAQ.md)
[![OpenClaw](https://img.shields.io/badge/Runs%20on-OpenClaw-orange)](https://openclaw.ai)
[![Game](https://img.shields.io/badge/Warframe-国际服-8b5cf6)](https://www.warframe.com)

[安装](INSTALL.md) · [配置](CONFIG.md) · [FAQ](FAQ.md) · [能力详单](skill/references/capabilities.md) · [更新日志](CHANGELOG.md) · [素材授权](ASSET-LICENSES.md) · [安全](SECURITY.md)

</div>

---

## 长什么样

**世界状态不是只列清单**——既能筛出适合速刷的裂缝，也能按奖励反查当前哪一轮赏金正在掉落：

| `裂缝 速刷` | `赏金 阿耶精华` |
|:---:|:---:|
| <img src="img/showcase-fissure-speed.png" width="440"/> | <img src="img/showcase-bounty-aya.png" width="440"/> |
| *普通/钢铁分区、任务标签与剩余时间* | *当前轮次、地点、任务等级与命中概率* |

**个人库存直接参与决策**——不是只会查数据，而是回答「我现在开什么」「怎样凑够杜卡德最省白金」：

| `开遗物 未入库 白金 速刷 单人` | `杜卡德 600` |
|:---:|:---:|
| <img src="img/showcase-open-relic.png" width="440"/> | <img src="img/showcase-ducat-600.png" width="440"/> |
| *库存 × 缺件 × 行情 × 当前裂缝，给出 TOP8* | *按可靠成交中位规划组合，并计算机会成本* |

**长期进度也能一图看懂**——周常卡自动核对本机快照，紫卡列表统一复算词条并给出保守参考区间：

| `周常` | `我的紫卡` |
|:---:|:---:|
| <img src="img/showcase-weekly.png" width="440"/> | <img src="img/showcase-my-rivens.png" width="440"/> |
| *执刑官、科研、固定功课、回廊、电波与 1999 日历* | *已开封/未开封、词条等级、样本状态与行情区间* |

深色卡片 · 官方中文译名 · 货币带游戏图标 · 2x 高清渲染 · 个人数据仅从本机只读快照取得 · 展示图不含其他玩家身份信息

## 能干什么

- **查价**：`wm 悟空p`、`wm 赋能充沛 满级`——warframe.market 实时卖单/买单、90 天成交中位、游戏私聊模板
- **遗物与获取路线**：`遗物 前x1` 正查六奖励价格与精炼期望；`遗物 战刃` 反查哪个遗物出；`获取 Wukong Prime 系统蓝图`给单部件详细路线，`获取 Caliban p`给整套四部件总览
- **世界状态**：`裂缝`完整列出普通/钢铁任务并标注速刷、舒适、长线、额外收益；主人私聊时逐任务推荐兼容库存遗物；另有仲裁、警报、入侵、突击、钢铁侵袭、赏金、虚空商人
- **订阅推送**：十三类事件按边界蹲守去重推送（裂缝/仲裁好场/警报/虚空商人/掉落/周常……），不轰炸
- **周常一图流**：11 项周常清单 + AlecaFrame 快照**自动打卡** + 回廊奖励轨道 + 电波赛季进度与满级预测
- **杜卡德规划**（需 [AlecaFrame](https://alecaframe.com)）：`杜卡德 600` 按可靠的今日/90 日成交中位寻找白金损失最低的组合，并标日均量；不以最低卖单估值。默认按成品拥有状态智能保留，`保留N/保留N套` 可显式覆盖
- **奸商路线比较**：Prime 部件机会成本＋奸商现金，对比 0 级市场价＋准确交易税，告诉你该换还是直接买
- **个人数据**（需 [AlecaFrame](https://alecaframe.com)）：`开遗物`按遗物价值推 TOP8，加`钢铁`只匹配钢铁裂缝；`开遗物 商品名`先按奸商商品保本线筛选，再列“立即可开＋最多三种建议获取”，不假定野队四人开同一遗物。另有库存估值、掉落监测、紫卡估价、精炼/奸商购物推荐、商店已购对账、本周好货；非 `wm` 估值统一优先采用可靠今日成交中位，样本不足回退 90 日中位
- **WFInfo 游戏内决策（可选）**：指定商品的`开遗物`把目标、保本线和同口径奖励估值同步到 WFInfo OpenClaw 配套版；开奖后按实际四项奖励标出“保留白金 / 兑换杜卡德”，无需切回 QQ。用 `install.ps1 -WithWFInfo` 安装固定且经双哈希校验的独立 Apache-2.0 组件。旧命令`开遗物 杜卡德 商品名`继续兼容；策略缺价时 WFInfo 自动使用同目录全 Prime 估值索引（`prime-reward-index.mjs` 预热，24h 刷新）补缺，索引无效时仍安全停判
- **自然语言与衔接**：「悟空p多少钱」「哪里刷夜灵p」「这周还剩啥没做」——AI 负责意图路由和一两句点评，数字全部来自脚本；短命令卡会保留短时脱敏实体上下文，因此下一句“这个甲多少钱”能直接续查行情

卡片底部会按当前结果给出最多两条“下一步”命令，例如获取路线发现遗物均已入库时提示`wm 夜灵p`，Market 整套卡则提示`获取 夜灵p`。

所有回答生成 600~800px 深色图片卡，官方中文译名，货币带游戏图标。

## 架构一眼看懂

```mermaid
flowchart LR
    QQ[QQ 消息] --> P{OpenClaw 插件}
    P -->|短命令<br/>硬拦截| S[确定性脚本<br/>独立回归验证]
    P -->|自然语言| AI[AI 模型]
    AI -->|结构化工具调用| D[warframe_assistant<br/>dispatch / lookup / subscription]
    D --> S
    S --> C[🎴 图片卡]
    S -.本地策略.-> W[WFInfo 游戏覆盖层]
    S -.只读.-> A[(AlecaFrame<br/>本机快照)]
    S --> API[(warframestat<br/>warframe.market<br/>browse.wf)]
    CRON[OpenClaw cron] -->|订阅蹲守| S
```

- `skill/`：确定性运行脚本＋完整脚本回归（零 npm 强依赖，`sharp` 可选）+ SKILL.md（AI 行为契约）+ 素材
- `extension/`：OpenClaw 插件（严格裸命令硬拦截 + 自然语言结构化工具；工具生成的卡片由插件直接投递 QQ）
- `config/AGENTS.warframe.md`：安装器追加到用户 `AGENTS.md` 的只读与隐私安全边界

数据源：api.warframestat.us、api.warframe.market v2、browse.wf（官方导出）、DE 官方 worldState、AlecaFrame 本机快照（只读）。详见 [NOTICE.md](NOTICE.md)。

## 快速开始

### 交给 AI 安装（推荐）

把下面整段复制给能够操作本机终端的 AI 编程助手（Codex、Claude Code 等）。它可以直接完成安装或升级；QQ 官方机器人仍需你自行申请。

```text
请帮我在这台 Windows 电脑上安装或升级 OpenClaw Warframe 助手：
https://github.com/FFangx/openclaw-warframe-assistant

你获准执行完成本次安装所需的本机检查、下载、文件同步、验证和 OpenClaw Gateway 重启。请按以下边界操作：

1. 先读取仓库的 README.md、INSTALL.md、SECURITY.md 和 config/AGENTS.warframe.md，再开始修改。
2. 检查 Windows、Git、Node.js 20+、OpenClaw、Chrome/Edge 和现有 OpenClaw 工作区。缺少前置软件、需要管理员权限或需要修改系统级设置时，先告诉我影响并征得同意。
3. 仓库不存在时从上述官方地址克隆；已经存在时先检查工作树，保留我的所有改动，不得 reset、强制覆盖或删除。若本地改动妨碍升级，停下来说明。
4. 默认只安装 OpenClaw 助手。只有我明确同意时才给 install.ps1 加 -WithWFInfo；WFInfo 是独立的 Apache-2.0 配套组件，不得把它并入本仓库。
5. 使用仓库提供的 install.ps1，不要手工复制受管文件，也不要使用 -SkipPreflight、-SkipAgents 或 -SkipCron 绕过默认安全步骤。优先使用 PowerShell 7（pwsh）；若本机没有，再按 INSTALL.md 的兼容命令执行。
6. 保留现有 openclaw.json、AGENTS.md、自定义插件、cron、订阅、状态、缓存和个人文件。不得读取、上传或回显 API Key、QQ/OpenID、Market Token、AlecaFrame 原始快照等敏感数据；缺少 ownerOpenId 时只说明应由我在本机填写的位置，不得猜测。
7. 安装后运行 doctor.mjs 和 verify.ps1。全部通过后再重启 Gateway，并只读确认插件已加载、Gateway 仅按现有配置监听。不得发送真实 QQ 消息，不得操作游戏、交易、聊天或账号资产。
8. 最后用简短中文报告：安装版本与提交、实际安装路径、是否安装 WFInfo、doctor/verify/Gateway 结果、仍需我手动完成的配置；报告中不得包含凭据或个人标识。

遇到文档与实际环境不一致、验证失败或任何可能破坏现有数据的情况，请停止并说明，不要用跳过检查或删除数据的方式硬装。
```

如果你确定需要游戏内开奖决策，可在提示词末尾补一句：`我明确同意同时安装 WFInfo 配套版。`

### 手动安装

先克隆仓库（或直接下载 ZIP）：

```powershell
git clone https://github.com/FFangx/openclaw-warframe-assistant.git
cd openclaw-warframe-assistant
```

前置门槛请先读 [INSTALL.md](INSTALL.md)——**QQ 官方机器人申请是整个链路里最麻烦的一步**，不是本项目能简化的。

```powershell
# 在仓库根目录执行：同步 skill、插件，并幂等更新 AGENTS.md 安全片段
# ExecutionPolicy Bypass 只作用于本次进程，不修改系统全局策略
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

# 同时安装经固定版本和 SHA-256 校验的 WFInfo 配套版（启用游戏内开奖决策）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -WithWFInfo

# 装好后自检环境，输出功能矩阵
node "$env:USERPROFILE\.openclaw\workspace\skills\warframe-assistant\scripts\doctor.mjs"

# 一次验证源码测试、部署一致性、运行时入口、插件和 Gateway
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1
```

安装器会先跑源码测试，再用受管文件清单同步 Skill/插件并逐文件校验 SHA-256；源码已删除的旧受管文件会移入工作区内的可恢复部署备份。运行时的 `.warframe-assistant-build.json` 记录版本、Git commit、脏工作树标志和内容哈希，`doctor.mjs` 会直接显示当前运行构建。

## 公开安装生命周期（安装 / 升级 / 卸载）

| 操作 | 命令 | 说明 |
|---|---|---|
| 安装 | `.\install.ps1` | 同步 Skill/插件、幂等更新 AGENTS.md 安全片段、按合同安装每日 cron（详见 INSTALL.md） |
| 升级 | `.\install.ps1`（同一命令） | 只更新受管文件；被替换/移出的旧受管文件进入 `.openclaw\warframe-assistant-deploy-backups\` 可恢复备份，`node_modules`、状态、缓存和个人配置绝不误动 |
| 预览卸载 | `.\uninstall.ps1 -WhatIf` | 只打印将要做什么，不改任何文件 |
| 卸载 | `.\uninstall.ps1` | 见下方「卸载边界」 |
| 卸载（含 WFInfo 配套版） | `.\uninstall.ps1 -RemoveWFInfo` | 显式开关；验证受管标记后把整个 WFInfo 目录**移动**为同级 `.uninstall-backup-时间` 备份，不删除 |

**卸载边界（安全合同，由 `tests/uninstall.test.ps1` 锁定）**：

- 默认只处理**有受管标记**的内容：`skills/warframe-assistant/` 与 `.openclaw/extensions/warframe-fast-commands/` 中登记在
  `.warframe-assistant-managed.json` 清单里的文件，以及 AGENTS.md 中 BEGIN/END 标记内的受控安全片段。所有文件**移动**到
  `.openclaw\warframe-assistant-uninstall-backups\` 可恢复备份，**绝不永久删除**；未标记的用户文件原样保留，含用户文件的目录不会删除。
- cron 只按 **declarationKey 精确匹配**删除 `config/cron/reward-zh-ai.job.json` 声明的任务；订阅/掉落监测任务是用户数据（按会话哈希的 key），
  只报告、不删除。
- WFInfo 只在 `-RemoveWFInfo` 且验证 `.openclaw-wfinfo-companion.json` 受管标记后做可恢复移动；无标记的目录直接拒绝。
- 用户数据（`state/`、`.cache/`、部署备份、`AGENTS.md.warframe-assistant.bak`）默认全部保留，卸载总结里会列出。

## 支持边界

- 个人维护的业余项目：**无 SLA**，issue/PR 响应不保证时限，见 [SUPPORT.md](SUPPORT.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 仅支持 **Windows**（AlecaFrame 限制）与 **Warframe 国际服**（国服无公开 API，见 FAQ）；Linux/Mac 未测试。
- 运行时需 Node.js 20+（CI 同时验证 20 与 24）与 Chrome/Edge；`sharp` 为可选优化，不装功能不受影响。
- 安全边界不可协商：无市场写操作、无游戏内自动化、个人数据仅限主人私聊。发现安全问题的报告方式见 [SECURITY.md](SECURITY.md)。

## 隐私摘要

- **离开本机的数据**：只有查询本身（物品名、命令、世界状态请求）发给公开数据源——api.warframestat.us、api.warframe.market、
  browse.wf、DE 官方 worldState 与 AlecaFrame CDN（词典/图片兜底）。这些请求**不含**你的 QQ openid、账号标识或任何凭据。
- **永不离开本机的数据**：AlecaFrame 个人快照（库存/账号/周报数据）只在本机只读解析；订阅账本、周常状态、卡片与缓存都写在你的
  OpenClaw 工作区内。本项目不读取 warframe.market 登录令牌，不上传任何快照。
- 安装器写入的 AGENTS.md 受控片段只声明只读与隐私边界，不含任何身份信息。

## 发布

版本唯一来源是仓库根目录的 `VERSION`（当前 `1.1.3`）。GitHub Actions 在每次 push/PR/tag 时于 **Node 20 与 24** 两个版本上运行
`verify.ps1 -SourceOnly`（源码测试 + 安装器生命周期 + 全部合同测试），并校验 `skill/package-lock.json` 可复现；
第三方 action 固定完整 commit SHA、`checkout` 关闭凭据持久化、权限保持最小只读。正式发布走 `release.ps1`：它校验干净工作树、`main` 与远端一致、源码验证通过、tag 不存在，然后把 `CHANGELOG.md` 的 `[Unreleased]` 章节落成版本章节并打 `vX.Y.Z` 标签：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\release.ps1 -Version 1.1.3   # 预览用 -DryRun，推送加 -Push
```

## 三条实话（装之前必读）

1. **安全边界要进启动上下文**：本项目禁止一切市场写操作与游戏自动化。安装器会把仓库维护的受控片段追加到 `AGENTS.md`，并在升级时原地更新、不重复追加；SKILL.md 同时保留同一方向的运行规则。仍建议给主力模型开高思考档位（如 `thinking=high`）。
2. **Windows 优先**：AlecaFrame 只有 Windows 版；不装它时个人功能全部不可用，公开查询功能正常（词典自动走在线兜底）。Linux/Mac 未测试。
3. **只读承诺**：不读游戏内存、不注入、不操作游戏进程；只读 AlecaFrame 落盘文件与公开 API。不碰 warframe.market 登录令牌。使用风险自负，与 Digital Extremes 无关。

## 文档

| 文档 | 内容 |
|---|---|
| [INSTALL.md](INSTALL.md) | 安装步骤与前置门槛（含卸载生命周期） |
| [CONFIG.md](CONFIG.md) | 配置项（必填 1 项 + 可选环境变量） |
| [FAQ.md](FAQ.md) | 常见问题 |
| [NOTICE.md](NOTICE.md) | 授权范围：素材/数据排除与数据源归属 |
| [ASSET-LICENSES.md](ASSET-LICENSES.md) | 第三方素材来源与授权范围逐项清单（含公开发布前处置） |
| [SECURITY.md](SECURITY.md) | 安全漏洞报告（私有漏洞报告渠道） |
| [SUPPORT.md](SUPPORT.md) | 支持边界（个人项目，无 SLA） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南与测试要求 |
| [PUBLIC-RELEASE.md](PUBLIC-RELEASE.md) | 公开仓库转换的风险核对清单与维护方式 |
| [config/AGENTS.warframe.md](config/AGENTS.warframe.md) | 安装器维护的全局只读与隐私边界 |
| skill/references/capabilities.md | 全部能力的完整行为说明与降级矩阵 |

## License

代码 MIT（见 [LICENSE](LICENSE)）。游戏素材版权归 Digital Extremes，社区数据源归属见 [NOTICE.md](NOTICE.md)；
内置素材的逐项来源、授权范围与公开发布处置见 [ASSET-LICENSES.md](ASSET-LICENSES.md)；
genesis-assets 派生图标的 Apache-2.0 全文与来源说明见 [LICENSES/](LICENSES/genesis-assets.md)。
