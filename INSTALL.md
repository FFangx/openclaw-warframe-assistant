# 安装

按顺序做，每步都有验证点。全程 Windows（AlecaFrame 限制，见 FAQ）。

## 0. 前置门槛（先掂量）

| 前置 | 难度 | 说明 |
|---|---|---|
| **QQ 官方机器人** | 🔴 最高 | 去 [q.qq.com](https://q.qq.com) 申请开放平台机器人并在 OpenClaw 配好 `channels.qqbot`。审核流程、沙箱限制、消息频率限制都在这一步——本项目帮不了你，OpenClaw 文档是你的朋友。没有它就没有 QQ 入口 |
| **OpenClaw** | 🟡 中 | Gateway 正常运行、能收发 QQ 消息、cron 可用 |
| **一个像样的模型** | 🟡 中 | 自然语言路由和点评质量取决于它；**务必开高思考档位**（低档位有钻红线空子的实锤案例，见 README 三条实话） |
| Node.js 20+ | 🟢 低 | 脚本运行时（内置 fetch） |
| Chrome 或 Edge | 🟢 低 | headless 截图渲卡；非标准路径设 `WARFRAME_BROWSER` |
| AlecaFrame | ⚪ 可选 | 个人功能（库存/掉落/紫卡/打卡/购物推荐）必需；不装则这些功能不可用，公开查询不受影响 |

## 1. 一键安装或升级

在仓库根目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`ExecutionPolicy Bypass` 只对这一次 PowerShell 进程生效，不会修改系统全局执行策略。脚本默认安装到 `%USERPROFILE%\.openclaw\workspace`；自定义工作区可在末尾追加 `-Workspace "D:\你的\workspace"`。

如果要启用游戏内开奖决策，一次安装 OpenClaw 助手和固定版本的 WFInfo 配套版：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -WithWFInfo
```

WFInfo 默认安装到 `%LOCALAPPDATA%\OpenClaw\WFInfo`；可用 `-WFInfoInstallDir "D:\Apps\WFInfo"` 指定目录。安装器只下载清单固定的 `FFangx/WFinfo` 发布包，并同时校验压缩包和 `WFInfo.exe` 的 SHA-256。升级前请退出正在运行的 WFInfo；旧目录会保留为同级 `WFInfo.backup-时间`，安装器不会自动启动程序。

脚本会完成这些事：

1. 先运行当前源码的脚本测试与插件合同测试；失败时不改运行时
2. 将 `skill/` 与 `extension/` 通过 staging 同步到运行时，并逐文件校验 SHA-256
3. 将 `config/AGENTS.warframe.md` 的受控安全片段追加到工作区 `AGENTS.md` 末尾；再次运行会原地更新，不会重复追加
4. 按 `config/cron/reward-zh-ai.job.json` 幂等安装/修复每日「奖励译名 AI 查证」agent 任务（declarationKey `warframe-assistant:reward-zh-ai:default`；缺则创建、字段漂移则修复、不动既有投递目标；工作区旁没有 `openclaw.json` 或加 `-SkipCron` 时跳过，测试工作区不会触碰真实 cron）
5. 仅在指定 `-WithWFInfo` 时安装或校验 WFInfo 配套版；它是单独的 Apache-2.0 组件，不并入本项目 MIT 源码

修改 `AGENTS.md` 前会保留 `AGENTS.md.warframe-assistant.bak`。只更新安全片段可加 `-AgentsOnly`；完全不改 `AGENTS.md` 可加 `-SkipAgents`；删除该受控片段可运行 `-RemoveAgents`。脚本不会覆盖片段以外的个人规则。

每个运行目录会写入 `.warframe-assistant-managed.json` 与 `.warframe-assistant-build.json`。以后升级时，只有上个版本明确登记为受管、但新源码已经删除的文件才会移出运行目录；它们保存在 `.openclaw/warframe-assistant-deploy-backups/`，不会误删 `node_modules`、状态、缓存或个人配置。首次切换到受管部署时，历史 `.bak`、旧脚本测试和旧内置文档也会移入同一可恢复备份。

需要预览动作时使用 PowerShell 通用参数 `-WhatIf`。

### 手动安装

如果不运行安装器，手动复制：

```
<你的 OpenClaw workspace>/
  skills/warframe-assistant/     ← 本仓库 skill/ 整个拷进去
  .openclaw/extensions/warframe-fast-commands/   ← 本仓库 extension/ 整个拷进去
```

然后还需要将 [`config/AGENTS.warframe.md`](config/AGENTS.warframe.md) 的受控片段追加到工作区 `AGENTS.md`；推荐仍运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -AgentsOnly`，避免复制遗漏或升级后产生重复片段。

## 2. 配置（只有 1 个必填）

在 OpenClaw 配置（openclaw.json）给插件填主人 openid：

```jsonc
{
  "plugins": {
    "config": {
      "warframe-fast-commands": {
        "ownerOpenId": "<你的 QQ openid>"   // 个人账号命令的身份门；不知道就先跳过，看 FAQ「怎么拿 openid」
      }
    }
  }
}
```

⚠ 如果你的配置里设了 `plugins.allow` 白名单，必须把 `warframe-fast-commands` 加进去——**这个白名单是全量的，漏写任何一个在用插件都会把它禁掉**。

其余路径全部自动推导（脚本/状态/卡片目录跟随安装位置），可选环境变量见 [CONFIG.md](CONFIG.md)。

## 3. 可选增强

```bash
cd skills/warframe-assistant
npm ci                     # 按 lockfile 安装；sharp 是 optionalDependencies，默认一并装上（PNG 压缩，卡片体积 -70%）
npm ci --omit=optional     # 完全跳过 sharp 的最小安装；不装功能不受影响
node scripts/prefetch-icons.mjs   # 预热全量物品小图（~64MB），掉落/购物卡行内图秒出；不跑则按需下载
```

装 AlecaFrame：官网安装 → 先启动它再进游戏 → 过一次加载点（进任务/中继站）→ 生成 `%LOCALAPPDATA%\AlecaFrame\lastData.dat`。

配套 WFInfo 推荐用第一节的 `-WithWFInfo` 安装；也可单独运行 `.\install-wfinfo.ps1`。在 WFInfo 设置中把“开奖决策”切到“奸商目标”；主人私聊发送 `开遗物 商品名`（旧写法`开遗物 杜卡德 商品名`同样可用）后，助手会原子写入 `%APPDATA%\WFInfo\ducat_strategy.json`。OpenClaw 先列达到商品保本线的“立即可开＋建议获取”遗物；WFInfo 识别实际四项奖励后，使用同一批今日/90 天成交中位计算并在游戏覆盖层标出选择。策略过期、缺失或任一奖励没有可靠估值时只展示普通信息，不强行推荐。另可用 `node skill/scripts/prime-reward-index.mjs`（部署后为 `scripts/prime-reward-index.mjs`，默认输出 `%APPDATA%\WFInfo\prime_reward_prices.json`、24h 有效期）预热全 Prime 奖励估值索引：策略缺价时 WFInfo 从该索引补缺（策略内价格始终优先），索引过期/损坏/无效时 WFInfo 仍按缺价安全停判，刷新失败不会覆盖上一份索引。

## 4. 自检

```bash
node skills/warframe-assistant/scripts/doctor.mjs
```

逐项检查 Node/目录可写/浏览器/7 个数据源连通/AlecaFrame/OpenClaw CLI/WFInfo 配套版文件与版本，末尾输出**功能矩阵**。❌ 项按提示补齐；⚠️ 项代表降级可用。

需要验证“当前源码就是正在运行的版本”时，在仓库根目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1
```

它会统一检查源码测试、安装器升级生命周期、源码/运行时哈希、当前源码声明的运行时测试、确定性入口出卡、环境 doctor、插件 doctor 和 Gateway 状态。运行时测试按源码清单选择，不会被旧备份中的历史测试污染。

## 5. 重启 Gateway 并验证

```powershell
openclaw.cmd gateway restart
```

Gateway 日志确认插件数量包含本插件（搜 `plugins:`）。然后 QQ 私聊机器人：

1. 发 `帮助` → 应秒回功能总览卡（不经模型，验证插件拦截）
2. 发 `裂缝` → 应回当前裂缝卡（验证世界状态链路）
3. 主人私聊发 `开遗物` → 应回遗物价值 TOP8；`裂缝`卡应逐任务附库存遗物（验证两套推荐逻辑）
4. 发 `wm 悟空p` → 应回价格卡（验证 market 链路）
5. 发 `我的账号` → 装了 AlecaFrame 且 ownerOpenId 配对时回账号卡；否则拒绝（验证个人门）
6. 发一句自然语言「悟空p多少钱」→ 应先出卡再补一句点评（验证两段式）

订阅推送依赖 cron：发 `订阅 裂缝 钢铁 生存` 后，用 `openclaw cron list` 确认生成了对应任务。

## 6. CI 与发布

- **CI**：`.github/workflows/ci.yml` 在每次 push 到 `main`、PR 与 `v*` tag 时于 windows-latest 上运行 `verify.ps1 -SourceOnly`——源码 Skill 测试、扩展契约测试、安装器生命周期、卸载/元数据/发布合同与陈旧文件隔离验证，**Node 20 与 24 两个版本**都跑；第三方 action 固定完整 commit SHA、`checkout` 关闭凭据持久化、权限最小只读；另校验 `skill/package-lock.json` 可复现（`npm ci --ignore-scripts`）。CI 不接触真实 QQ、个人快照或凭据。
- **版本**：根目录 `VERSION` 是版本唯一来源（当前 `1.1.6`）。受管部署的 `.warframe-assistant-build.json` 会记录 `version`，`verify.ps1` 运行时层强制 Skill 与插件版本一致且等于源码 `VERSION`。`skill/package.json` 与 `extension/package.json` 的 `version` 字段与 `VERSION` 对齐（两者均不发布到 npm，属于仓库发布的一部分；`tests/repo-metadata.test.ps1` 强制校验）。
- **发布**：在仓库根目录运行 `.\release.ps1`（`-DryRun` 预览、`-Version X.Y.Z` 改版本、`-Push` 推送）。脚本门禁：干净工作树、`main` 与 `origin/main` 一致、`verify.ps1 -SourceOnly` 通过、`vX.Y.Z` tag 不存在、CHANGELOG 顶部 `[Unreleased]` 空占位且存在与 `VERSION` 对齐的待发布 `## [X.Y.Z]` 章节；通过后给待发布章节盖日期、提交 `release vX.Y.Z` 并打附注标签。

## 7. 卸载（安全边界）

在仓库根目录运行；**先预览**：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -WhatIf   # 只打印将要做什么
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1           # 实际卸载
```

卸载默认**只**处理有受管标记的内容，且全部是可恢复的：

1. `skills/warframe-assistant/` 与 `.openclaw/extensions/warframe-fast-commands/` 中登记在
   `.warframe-assistant-managed.json` 清单里的文件 → **移动**到 `.openclaw\warframe-assistant-uninstall-backups\<时间>\`；
   未标记的用户文件原样保留，含用户文件的目录不会被删除。
2. 工作区 `AGENTS.md` 中 BEGIN/END 标记内的受控安全片段被移除，其余个人内容逐字保留（`-SkipAgents` 可跳过）。
3. cron 只按 `config/cron/reward-zh-ai.job.json` 的 **declarationKey 精确匹配**删除对应任务；订阅/掉落监测任务
   （按会话哈希的 key）是用户数据，只报告、不删除（`-SkipCron` 可跳过）。
4. WFInfo 配套版只在显式加 `-RemoveWFInfo` 且验证 `.openclaw-wfinfo-companion.json` 受管标记后，把整个目录
   **移动**为同级 `WFInfo.uninstall-backup-<时间>` 备份（绝不删除）；无标记的目录直接拒绝。

卸载**不会**删除的用户数据：`state/`（订阅账本/周常/掉落状态）、`.cache/`、部署备份
（`.openclaw\warframe-assistant-deploy-backups\`）与 `AGENTS.md.warframe-assistant.bak`——总结里会列出。
确认不再需要后，可手动删除备份目录。卸载边界由 `tests/uninstall.test.ps1` 合同测试锁定。

## 常见翻车点

- 发命令没反应 → Gateway 日志搜 `Warframe`；插件没加载多半是 `plugins.allow` 漏写或 configSchema 校验失败（配置字段拼错会导致**整个配置拒载**）
- 卡片是英文 → 词典没就位；跑 doctor 看「词典层端到端」一项
- 图糊 → 确认走的是插件路径而不是模型用 message 工具发图（SKILL.md 已禁止，模型不听话就换模型/提档位）
- `本地能跑、QQ 挂` → 多半是输出超过插件 execFile 缓冲，先看 Gateway 日志错误名
