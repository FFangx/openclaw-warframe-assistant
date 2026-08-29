# 配置参考

设计目标：装在标准位置零配置。只有身份一项必填。

## 必填

| 位置 | 键 | 说明 |
|---|---|---|
| openclaw.json → `plugins.config.warframe-fast-commands` | `ownerOpenId` | 已授权用户的 QQ openid。个人账号命令（我的账号/库存/紫卡/推荐类/商店/掉落订阅）要求「QQ 私聊 + 发送者精确命中此值」双门；不配则所有个人功能拒绝。`channels.qqbot.allowFrom` 是通配符时它是唯一身份凭证 |

## 愿望单实时监控调优（可选）

openclaw.json → `plugins.config.warframe-fast-commands.wishlist`，全部可选、带默认与钳制边界；只影响愿望单 Gateway 断线保护轮询（R4），其余行为不变。

| 键 | 默认 | 说明 |
|---|---|---|
| `staleAfterMs` | `300000`（5 分钟） | WebSocket 连接健康但超过该时长没有任何消息帧 → 判定事件流静默，进入 REST 保护轮询。市场安静期只发新订单事件，阈值设短会频繁触发轮询 |
| `protectionMinMs` | `20000` | 保护轮询间隔下限（与上限之间的随机抖动） |
| `protectionMaxMs` | `30000` | 保护轮询间隔上限 |
| `rateCapacity` | `1` | 保护 REST 全局令牌桶容量；默认不允许启动瞬时突发 |
| `rateRefillMs` | `400` | 令牌桶补一个令牌的间隔；默认使请求起点至少相隔 400ms，低于 Market 公开 3 req/s 上限 |
| `concurrencyLimit` | `2` | 保护 REST 全局并发上限 |

## 可选环境变量（给 Gateway 进程设）

| 变量 | 默认 | 用途 |
|---|---|---|
| `ALECAFRAME_DATA_DIR` | `%LOCALAPPDATA%\AlecaFrame` | AlecaFrame 数据目录（非标准安装位置时设） |
| `WARFRAME_CARD_DIR` | workspace `.cache/warframe-cards` | 卡片 PNG 输出目录 |
| `WARFRAME_DATA_CACHE_DIR` | workspace `.cache/warframe-data` | 数据缓存目录（词典/价格/图片） |
| `OPENCLAW_CLI_PATH` | `%APPDATA%\npm\node_modules\openclaw\openclaw.mjs` | OpenClaw CLI 位置（订阅 cron 管理用） |
| `WARFRAME_BROWSER` | 自动探测 Chrome→Edge | headless 截图浏览器 exe 完整路径 |
| `WFINFO_INSTALL_DIR` | `%LOCALAPPDATA%\OpenClaw\WFInfo` | 仅供 doctor 检查非标准位置的 WFInfo OpenClaw 配套版；不改变 WFInfo 自身配置 |
| `WARFRAME_OFFLINE` | 关 | 设 `1` 硬离线：禁词典/目录在线兜底（测试与排障用，日常别开） |

## 数据缓存说明（无需配置，知道即可）

| 内容 | 有效期 | 失效行为 |
|---|---|---|
| 官方词典（本地缺失时在线重建） | 7 天 | 刷新失败退陈旧快照 |
| market 价格整表 | 1 小时 | 同上，卡片标注「离线快照」 |
| 物品小图 | 永久（内容哈希） | 缺图不影响出卡 |
| 世界状态 | 45 秒外层缓存（官方内层 60 秒） | 在线源失败时只回退最近可靠规范化快照，并明确标注陈旧时间；无可靠快照则明示失败 |

清缓存：删 `WARFRAME_DATA_CACHE_DIR` 目录即可，下次查询自动重建。

## 状态文件（自动管理，别手删）

- `state/warframe-subscriptions.json`——订阅账本+去重记录
- `state/warframe-weekly.json`——周常打卡与电波采样
- `state/warframe-drops.json`——掉落监测基线（v2；旧版欠账字段已迁入 Outbox）
- `state/warframe-delivery-outbox.json`——通知 Outbox 四个切片：当前接入掉落提醒、世界状态订阅通知（裂缝/仲裁/警报/活动/商人/突击/侵袭/赏金/商店/商品/轮换的 deliver 路径）、weekly 主动周报（主周报无损原图 + 可选好货卡，逐 part 持久化 transport）与愿望单主动命中通知（REST 校准 deliver + Gateway 实时命中双源同键去重、10 分钟业务 TTL、`redactOnTerminal` 终态擦除敏感 payload），保存待投递/已投递通知、欠账补投、脱敏投递审计与幂等键墓碑（逾期与墓碑有界自动清理）
- `state/warframe-arbitration-cache.json` / `warframe-incursions-cache.json`——排期缓存（删了会自动重建）
- `state/warframe-wishlist-metrics.json`——愿望单实时监控脱敏审计指标（R4）：断线时长、订单发现延迟、QQ 投递延迟、保护/扫描计数与 Market 可用性；只存时长/计数/类别，不含 target/订单/卖家等标识；自动维护，别手删

## 部署标识与备份

- `skills/warframe-assistant/.warframe-assistant-build.json` 与插件目录同名文件——当前 commit、脏工作树标志、内容哈希和部署时间
- 两个运行目录的 `.warframe-assistant-managed.json`——安装器受管文件及 SHA-256 清单
- `.openclaw/warframe-assistant-deploy-backups/`——升级时被替换或移出的旧受管文件，可用于人工恢复；不属于运行路径
- `.openclaw/warframe-assistant-uninstall-backups/`——`uninstall.ps1` 卸载时移出的受管文件（可恢复备份，不删除）；确认不再需要后手动删除
- `WFInfo.uninstall-backup-<时间>`——`uninstall.ps1 -RemoveWFInfo` 把配套版整体移动到的同级备份目录
