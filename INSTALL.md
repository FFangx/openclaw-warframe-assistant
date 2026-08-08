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

脚本会完成三件事：

1. 将 `skill/` 同步到 `skills/warframe-assistant/`
2. 将 `extension/` 同步到 `.openclaw/extensions/warframe-fast-commands/`
3. 将 `config/AGENTS.warframe.md` 的受控安全片段追加到工作区 `AGENTS.md` 末尾；再次运行会原地更新，不会重复追加

修改 `AGENTS.md` 前会保留 `AGENTS.md.warframe-assistant.bak`。只更新安全片段可加 `-AgentsOnly`；完全不改 `AGENTS.md` 可加 `-SkipAgents`；删除该受控片段可运行 `-RemoveAgents`。脚本不会覆盖片段以外的个人规则。

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
npm i sharp        # PNG 压缩，卡片体积 -70%；不装功能不受影响
node scripts/prefetch-icons.mjs   # 预热全量物品小图（~64MB），掉落/购物卡行内图秒出；不跑则按需下载
```

装 AlecaFrame：官网安装 → 先启动它再进游戏 → 过一次加载点（进任务/中继站）→ 生成 `%LOCALAPPDATA%\AlecaFrame\lastData.dat`。

可选安装本项目配套的 WFInfo 修改版。在 WFInfo 设置中把“开奖决策”切到“奸商目标”；主人私聊发送 `开遗物 商品名`（旧写法`开遗物 杜卡德 商品名`同样可用）后，助手会原子写入 `%APPDATA%\WFInfo\ducat_strategy.json`。OpenClaw 先列达到商品保本线的“立即可开＋建议获取”遗物；WFInfo 识别实际四项奖励后，使用同一批今日/90 天成交中位计算并在游戏覆盖层标出选择。策略过期、缺失或任一奖励没有可靠估值时只展示普通信息，不强行推荐。

## 4. 自检

```bash
node skills/warframe-assistant/scripts/doctor.mjs
```

逐项检查 Node/目录可写/浏览器/7 个数据源连通/AlecaFrame/OpenClaw CLI，末尾输出**功能矩阵**。❌ 项按提示补齐；⚠️ 项代表降级可用。

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

## 常见翻车点

- 发命令没反应 → Gateway 日志搜 `Warframe`；插件没加载多半是 `plugins.allow` 漏写或 configSchema 校验失败（配置字段拼错会导致**整个配置拒载**）
- 卡片是英文 → 词典没就位；跑 doctor 看「词典层端到端」一项
- 图糊 → 确认走的是插件路径而不是模型用 message 工具发图（SKILL.md 已禁止，模型不听话就换模型/提档位）
- `本地能跑、QQ 挂` → 多半是输出超过插件 execFile 缓冲，先看 Gateway 日志错误名
