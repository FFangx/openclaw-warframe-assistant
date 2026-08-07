# 配置参考

设计目标：装在标准位置零配置。只有身份一项必填。

## 必填

| 位置 | 键 | 说明 |
|---|---|---|
| openclaw.json → `plugins.config.warframe-fast-commands` | `ownerOpenId` | 主人的 QQ openid。个人账号命令（我的账号/库存/紫卡/推荐类/商店/掉落订阅）要求「QQ 私聊 + 发送者精确命中此值」双门；不配则所有个人功能拒绝。`channels.qqbot.allowFrom` 是通配符时它是唯一身份凭证 |

## 可选环境变量（给 Gateway 进程设）

| 变量 | 默认 | 用途 |
|---|---|---|
| `ALECAFRAME_DATA_DIR` | `%LOCALAPPDATA%\AlecaFrame` | AlecaFrame 数据目录（非标准安装位置时设） |
| `WARFRAME_CARD_DIR` | workspace `.cache/warframe-cards` | 卡片 PNG 输出目录 |
| `WARFRAME_DATA_CACHE_DIR` | workspace `.cache/warframe-data` | 数据缓存目录（词典/价格/图片） |
| `OPENCLAW_CLI_PATH` | `%APPDATA%\npm\node_modules\openclaw\openclaw.mjs` | OpenClaw CLI 位置（订阅 cron 管理用） |
| `WARFRAME_BROWSER` | 自动探测 Chrome→Edge | headless 截图浏览器 exe 完整路径 |
| `WARFRAME_OFFLINE` | 关 | 设 `1` 硬离线：禁词典/目录在线兜底（测试与排障用，日常别开） |

## 数据缓存说明（无需配置，知道即可）

| 内容 | 有效期 | 失效行为 |
|---|---|---|
| 官方词典（本地缺失时在线重建） | 7 天 | 刷新失败退陈旧快照 |
| market 价格整表 | 1 小时 | 同上，卡片标注「离线快照」 |
| 物品小图 | 永久（内容哈希） | 缺图不影响出卡 |
| 世界状态 | 实时 | 失败明示，绝不伪造 |

清缓存：删 `WARFRAME_DATA_CACHE_DIR` 目录即可，下次查询自动重建。

## 状态文件（自动管理，别手删）

- `state/warframe-subscriptions.json`——订阅账本+去重记录
- `state/warframe-weekly.json`——周常打卡与电波采样
- `state/warframe-drops.json`——掉落监测基线
- `state/warframe-arbitration-cache.json` / `warframe-incursions-cache.json`——排期缓存（删了会自动重建）
