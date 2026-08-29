# Changelog

本文件记录面向用户和运维者的可见变化，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
发布由 `release.ps1` 执行：读取根目录 `VERSION`，把 `## [<版本>]` 待发布章节落成带日期的版本章节（顶层 `[Unreleased]` 保持空占位），然后提交并打 `vX.Y.Z` 标签。

## [Unreleased]

### 变更

- 修正公开仓库的数据与错误说明：README 现明确区分 warframe.market v2 商品/实时订单与 v1 历史成交统计，按实际业务区分成交中位估值和奸商路线稳健低值，补充不支持输入、无匹配、403/404/429、来源故障与缓存降级的用户反馈语义；README/NOTICE 同步披露 relics.run、WFCD/社区 GitHub 静态备用源及其余生产数据主机。仓库元数据测试会扫描 Skill/扩展生产代码中的 HTTP/WebSocket 主机，任何新增且未分类或未同时写入 README/NOTICE 的数据源都会阻断验证。

## [1.2.0] - 2026-08-29

### 新增

- 帮助收敛为清晰的两层结构：`帮助` 简要展示全部 9 个功能模块、简介和准确入口，`帮助 <模块>` 逐项展示该模块的完整指令与具体说明；订阅模块覆盖裂缝、仲裁、警报、入侵、活动、突击、钢铁侵袭、赏金、商人、轮换、周常、商店、商品、掉落与管理动作。命令别名只作为模块跳转，不再维护重复的单命令帮助页。未知主题会直接列出可用模块，不进入模型。新增由唯一命令注册表生成的正式命令目录与 CI 字节一致性合同，帮助卡缓存键改为内容哈希，避免命令、帮助和文档再次漂移。
- 新增 26 项单一命令注册表，统一驱动快捷路由、隐私范围、`dispatch list`、帮助卡、文字帮助和模型工具命令摘要；删除各入口重复维护的命令目录、正则和帮助定义。直接 QQ 周常入口补齐“用户本人私聊 + 精确身份”门，并由调度器执行第二层校验；产品身份称呼统一为“用户”，现有 `owner*` 配置与账本键仅为兼容保留。
- 新增 Warframe.Market 愿望单：`愿望 商品 价格`（一次最多 5 项）建立愿望价，`愿望单`查看汇总，使用四位短编号执行`改价/暂停/继续/已购/取消`。Gateway 共用一条公开 Market WebSocket 秒级监听新卖单，每个 QQ 会话以 10 分钟 item-top 任务低频校准；新建、改价和恢复后立即检查当前卖单，已有合价订单时在设置反馈后直接补发标准 `wm` 市场行情卡并完成去重，不再延迟到校准任务。提供设置反馈、汇总、命中三类 2x 高清卡与可复制的实际 `/w` 文本；帮助卡同步新增简短入口说明；命中不自动交易、不自动聊天、不自动核销。

### 变更

- 仓库文档按当前实现重新核对：README/安装顺序、数据源分层、九重天筛选、正式获取/购买命令、版本与发布流程已同步；公开仓库的一次性转换清单已移除。`img/` 只保留 README 当前使用且完成内容复核的六张展示图，删除四张无引用旧卡片截图；一次性奸商静态清单生成器移至 `tools/`，不再随运行时 Skill 部署；新机环境冒烟、安装/卸载、许可证、治理和运行时合同文件继续保留。
- `开遗物`新增`九重天`硬筛选（同义`航道星舰/虚空风暴/storm`）：只保留虚空风暴裂缝（复用现有 isStorm 数据），与`钢铁`一样是确定性过滤而非`收益`偏好，也不再被当成奸商商品名进入货单搜索（`开遗物 单人 九重天` 直接出风暴路线）。新增更明确的`开遗物 对标 商品名`写法（旧写法`开遗物 商品名`/`开遗物 杜卡德 商品名`继续兼容）。参数改为严格逐词解析：筛选词、队伍、币种、偏好与商品目标可区分；任务类型词（`生存/歼灭`…）、`普通/全部`、互相冲突的组合（钢铁+九重天、白金+杜卡德、单人+4人、未入库+已入库）与空`对标`确定性拒绝并回显「已理解」与下一步命令，失败不再出现与输入无关的奸商错误。新增小型共享用户错误合同 `user-error-contract.mjs`（unsupported_input/no_match/source_unavailable/permission_denied/stale_fallback/internal_error + 安全 HTTP status/重试说明/下一步命令，复用 EndpointRequestError.diagnostic 映射，绝不透出 URL、响应体、堆栈、账号或目标标识），接入个人/公共确定性命令边界与开遗物/裂缝流程；成功但用离线快照的结果只以 `degraded` 提示缓存来源，不伪装成失败。
- PC 世界状态改为 DE 官方 `worldState.php` 首选并在本地统一规范化；warframestat 降为非阻塞交叉验证与官方故障备用，其 404、超时或熔断不再拖慢已验证的官方结果。官方 HTTP 200 但关键集合缺失时会拒绝写入可靠缓存，两源都不可用时继续诚实回退最近可靠规范化缓存。
- PC 世界状态的备用链按实况能力收口：DE 官方 `worldState.php` 成功时直接返回；官方失败后以 warframestat 构成完整基座，browse.wf Oracle 只在 `ActiveMissions`/`VoidStorms` 字段合同、HTTP `Last-Modified` 15 分钟年龄门禁和最近可靠裂缝 ID 连续性核对全部通过时叠加裂缝。Oracle 部分镜像不能单独构成完整状态，组合结果不写可靠缓存；所有在线源失败才回退最近可靠规范化缓存并明确陈旧时间。
- 世界状态快照增加可审计质量信封与逐字段来源：官方/warframestat 记录 provider、抓取时间、上游时间、延迟、关键集合完整性和内容哈希；Oracle 叠加另带只覆盖裂缝的部分信封与已验证 `Last-Modified`，doctor 与巡检可判断字段来自哪里、多新鲜、是否完整。
- 个人账号命令的识别正则、执行动作与参数来源统一归入命令注册表；AlecaFrame 执行器只消费注册表匹配结果并清洗参数，不再维护第二套命令白名单。注册表合同会拒绝缺少执行适配元数据的个人命令，避免快捷路由、权限门和实际执行再次漂移。
- 愿望单的裸 QQ 命令、模型命令和兼容订阅入口统一使用同一业务用例，固定执行身份校验、账本更新、校准任务同步、实时索引刷新、主反馈和当前行情跟随；备用入口不再漏掉即时行情，通用调度器也不再执行缺少监控编排的半套愿望写入。
- 普通订阅的三个 QQ 快捷入口与模型工具 `operation=command/subscription` 统一使用同一业务用例，集中执行可信身份归一、账本管理、世界状态与掉落监测任务同步，并以一致的降级警告报告后台任务同步失败；入口层不再复制订阅编排。
- 周常查看与核销的三个 QQ 快捷入口、模型工具和调度器 fallback 统一使用同一业务用例，集中执行用户 QQ 私聊身份校验、命令规范化与周常模块调用；旧的入口层权限分支和直跑 `weekly.mjs manage` 指引已删除。
- 个人账号查询的三个 QQ 快捷入口、模型工具和调度器 fallback 统一使用同一业务用例，集中执行注册表命令识别、精确匹配的用户 QQ 私聊身份校验与只读 AlecaFrame 查询；旧的入口层权限分支和直跑 `alecaframe.mjs parse` 指引已删除。
- 仲裁、实时情报和通用公开短命令的三个 QQ 快捷入口、模型工具与调度器 fallback 统一使用同一公开查询用例；用户私聊增强改为调用级显式权限，不再写入可能污染后续请求的进程全局环境。
- 愿望单单例 Gateway WebSocket 拆出可单测健康状态机（`extension/wishlist-gateway.mjs`，注入时钟/定时器/WebSocket构造/账本索引/订单处理/恢复扫描）：状态区分 未连接/连接中/健康/断线，记录断线起点、最近活跃与恢复时间及断线/重连计次。只有「曾经健康 → 断线 → 重新连接成功」才立即对活跃愿望执行一次当前订单恢复扫描——逐 target 复用现有 REST `/top` 校准与 R3 Outbox、同业务键去重链（命中先原子入队再提交 seen/calibration），初次正常连接不扫、同一恢复周期单飞（连接抖动不并发重复）、重复 open 不重扫、stop 后不扫、扫描失败留 `lastError` 下次恢复周期重试；QQ outbound 不可用时仍执行校准与入队，欠账留盘下轮补投。现有 10 分钟校准 cron 与 R3 Outbox 语义不变。
- WebSocket 断线（或构造失败）与「连接健康但事件流静默超过阈值（默认 5 分钟，可配置）」都会进入 REST 保护轮询（`skill/scripts/wishlist-protection.mjs` 纯原语 + 网关状态机集成）：按 20～30 秒抖动间隔（默认，可配置）执行一次合并校准扫描，连接恢复且事件流新鲜即退出并取消轮询。扫描先按去重后的 `itemId+rank` 把多 target/多用户相同的 Market 请求全局合并为每组合并一次请求，再逐 target 走原有 per-target 匹配与 R3 Outbox 原子入队/seen 提交链（10 分钟校准语义与业务键去重不变）；每个 Market 请求经过全局令牌桶（默认容量 1、每 400ms 补 1，请求起点至少相隔 400ms，低于 Market 公开 3 req/s 上限）与真实并发上限（默认 2），断线→重连→轮询不会瞬时打满 Market；恢复扫描与保护轮询共用单飞执行槽，扫描进行中不并发重复。Market 完全不可用时如实标记（per-target 记 restError、不写新鲜 calibration、状态机记 lastScanError 由下一轮重试），绝不伪装新鲜。新增脱敏审计指标文件 `state/warframe-wishlist-metrics.json`：断线时长、订单发现延迟、QQ 投递延迟、保护/扫描计数与 Market 可用性——只存时长/计数/类别，不含 target、订单、卖家等任何标识，也独立于愿望账本与 Outbox（不改用户状态语义）。参数（`staleAfterMs`/`protectionMinMs`/`protectionMaxMs`/`rateCapacity`/`rateRefillMs`/`concurrencyLimit`）见 `CONFIG.md` 可在 `plugins.config['warframe-fast-commands'].wishlist` 配置。

### 修复

- 愿望单并发门合同测试改用显式任务闸门，不再依赖 5～10ms 定时器碰巧尚未执行；较慢 CI 上仍稳定验证「并发最多 2 个、第三个 FIFO 排队」，消除与真实功能无关的竞态失败。
- 发布准备元数据统一到 `1.2.0`，并修正发布说明与脚本接口：版本号必须在可审查的准备提交中同时更新 VERSION、两个 package manifest、lockfile、INSTALL 与待发布 CHANGELOG；`release.ps1` 只负责验证、盖日期、提交和打 tag，不再提供会在验证后单独改 VERSION、造成包版本漂移的 `-Version` 路径。
- 每日奖励译名/1999 日历增益 AI 维护任务改为纯后台运行，强制 `delivery.mode=none` 并在安装升级时清理旧 QQ channel/to；模型的英文计划、进度或最终摘要不再进入 QQ。提示词同时要求禁止过程播报、只生成一次最终响应，空 inbox 仍严格返回 `NO_REPLY`。
- 深层/时光科研词缀不再把 Oracle 词典说明里未解析的 `|val|` 参数占位符直接上卡：DE 官方 worldState Conquests 的个人词缀（`Variables`）只给键、不携带数值（TimeDilation 实锤），此前会显示「技能持续时间减少 |val|%。」。现在先用 warframestat 说明中的数字填充占位符（保留 ShieldDelay 500% 等动态替换），仍有 `|...|` 残留时优先采用同键完整审核静态说明（TimeDilation 按官方 Update 36.0 与 Hotfix 36.1.6 口径显示「缩短技能：技能持续时间减少 50%」），否则用诚实中文缺数值提示（`ARCHIMEDEA_UNRESOLVED_DESC_ZH`）；漂移监控把未解析占位符计为说明漂移（`descPlaceholder`，样本 `reason=unresolved-placeholder`），官方备用源 tailMap 路径行为不变。
- 1999 日历增益中文名+效果改为成对收录与展示：以用户核验的灰机wiki「1999日历」页六人组覆写表为权威源更新静态路径表（硬化装甲/特浓咖啡/吸引力/强制输血/打孔纸带/人多势众/重型标枪/有福同享 等），社区状态行自带的 `description` 不再被丢弃；周报卡增益行同时显示中文名与效果说明并自动换行（去掉 ellipsis 截断），行高按估算保守留白。新增逐条季度实拍路径的 CI 离线用例。
- 新增「1999 日历增益译名查证闭环」：全链查无的未知增益路径进入日历专属 inbox（`.cache/warframe-data/calendar-upgrade-inbox.json`），每日同一条 AI 定时任务（`config/cron/reward-zh-ai.job.json` 合同已扩展）用灰机wiki「1999日历」页查证后用 `calendar-upgrade-fallback.mjs learn --path/--name/--desc/--source` 回填学习词典（中文名+效果+来源，冲突安全、原子落盘、只补缺不覆盖），查无实据 dismiss，写入失败保留待重试；无实据时保持「新增日历增益（上游尚未提供中文说明）」诚实占位，绝不猜测翻译。
- 新增漂移监控区分「缺中文名」与「有中文名但缺效果说明」两类（`drift-report.mjs`），当前赛季日历路径全部纳入离线漂移用例。
- 1999 日历大奖 `ModDropChanceBooster3DayStoreItem` 不再落「游戏内奖励（名称待同步）」占位，按灰机wiki 口径译为「3 天 Mod 掉落几率加成」。
- R3 通知 Outbox 第一片先迁移掉落通知：通知以脱敏目标哈希、业务幂等键（快照同步事件）、内容哈希和媒体/文字逐 part 状态落盘（`state/warframe-delivery-outbox.json`），再逐 part 投递——图片成功文字失败只补投文字，不会重发成功图片；进程/Gateway 重启后 pending 自动恢复，跨进程写由共享锁串行，同一业务键不会重复入队；每条记录带创建/过期时间（48h）、尝试次数与固定结果类别，不保存 QQ 目标原文或原始异常。旧版 `pendingDelivery` 欠账自动兼容迁移（不丢欠账、TTL 维持 48h），掉落状态文件升到 v2；监测行为与静默 `NO_REPLY` 输出不变。周报和愿望通知仍待 R3 后续切片迁移。
- R3 通知 Outbox 第二片迁入世界状态订阅通知（`subscriptions.mjs` deliver 路径）：通知结果确定后先原子入队再提交订阅账本（seen/一次性消费/调度/审计），再逐 part 投递——投递失败留欠账，账本已提交但投递失败时下一轮即使调度 `not_due` 也会先补投 pending；入队成功但账本写失败时下一轮按同一业务键去重，不会重复入队，也不会重发已成功 part。业务键按脱敏 targetKey 与稳定“fresh/closing 事件 × 命中订阅”集合构造，新建订阅命中同一事件不会被旧 tombstone 吞掉；Outbox 支持调用方显式 `expiresAt`：世界状态聚合通知使用本次卡片最早的有效业务 expiry（裂缝/警报等过期后不再盲目补发），无业务 expiry 时用保守的 6h 明确默认，且不晚于 48h 默认 TTL（掉落 48h 行为不变）。投递失败记录、进程重启恢复与同键去重同第一片；`monitor`（announce）子命令输出保持原样不经 Outbox，周常无损双卡与愿望通知留待后续切片。
- R3 通知 Outbox 第三片迁入 weekly 主动周报（`subscriptions.mjs` deliver 路径）：生成周报结果后先原子入队，再提交 weekly seen/调度账本，再在账本锁外逐 part 投递——主周报 part 以 `transport=lossless` 持久化投递模式（QQ `/files` + `srv_send_msg=true` 一步原图直发，不再追加会压缩长图的 `msg_type=7`），好货卡普通 `--media`，渲染失败退 `--message` 文字；主图成功好货卡失败只补投好货卡，不重发已成功图；入队成功但账本写失败下轮按同一业务键去重，账本已提交但投递失败下轮即使调度 `not_due` 也先补投 pending。业务键 = 脱敏 targetKey + weeklyId + 本次待推送 weekly 订阅 id 集合的哈希语义（subscriptionId 只进入 SHA-256 摘要，不原文落盘），同周新建订阅得到新业务键，不会被已投递的旧 tombstone 吞掉；`expiresAt` 使用本周下次重置边界（过周不补发旧周报），不晚于 48h 默认 TTL。Outbox part schema 向后兼容新增 `transport`（旧记录载入归一为默认普通 `--media`，行为不变），`contentHash` 包含投递模式；`monitor`（announce）子命令输出保持原样不经 Outbox，愿望通知仍待后续切片。
- R3 通知 Outbox 第四片迁入愿望单主动命中通知（`wishlist.mjs` REST 校准 `deliver` CLI + Gateway 单例 WebSocket 实时命中两条生产链）：命中结果确定后先原子入队再提交 wishlist 账本（seen/lastMatchAt/calibration），再在 wishlist 锁外逐 part 投递——WebSocket 一笔订单命中多个 QQ target 时全部入队成功才一次性提交账本，任一目标入队失败不提交会吞提醒的 seen 状态（下轮 REST 校准按同一业务键恢复）；业务键 = 脱敏 targetKey + 稳定「orderIdentity × 命中 wishId 集合」的 SHA-256 语义（原始 target/seller/owner/order/wish id 只进摘要），REST 与 WS 对同一 order+wish 集合自动去重，不会双源重复提醒；愿望提醒使用保守 10 分钟业务 TTL（过期不盲发），Outbox 新增通用 `redactOnTerminal`：愿望条目 delivered/expired 后立即擦除 part.value，只保留 contentHash、part 状态、时间与脱敏结果审计（卖家名永不写入 wishlist 账本/墓碑/尝试日志），掉落/世界状态/周报记录不带该标记行为不变；`monitor`/`calibrate`/`gateway_start` 与 dry-run 输出保持原样不经 Outbox，Gateway 启动时先恢复相关 target 的 wishlist pending（同业务键重试不重复发送），adapter 的 sendMedia/sendText 结果转换为固定脱敏类别（服务端明确接受/拒绝、异常不落盘），交互用例（愿望管理主回复与建立后立即行情卡）不改动。
- 愿望单通用兜底入口不再把已知的非 QQ 通道伪装为 QQ；真实通道会进入统一身份门，模型说明也不再暴露可绕过插件编排的愿望写脚本。
- 完整运行时验收不再因 OpenClaw CLI 输出良性配置警告而误判 cron 合同失败；仍以退出码和实际任务字段严格判断。
- 命令注册表改为同步 CommonJS 核心加 ESM 兼容门面，使 OpenClaw 插件加载器无需顶层 `await` 即可读取同一注册表；同时修正完整验收，使 `plugins doctor` 即使错误地返回零退出码，只要报告插件加载失败也会阻断部署。
- 周一订阅改走 QQ 原图直传并关闭 runner announce；周报保持与手动“周常”相同的单张原始 PNG，使用 QQ `/files` 的 `srv_send_msg=true` 一步发送，绕开会把主动长图缩成约 2048px JPEG 的 `file_info + msg_type=7` 两步链路。周报与本周好货全部发送成功后才写入本周去重标记，发送失败可在下一轮重试。
- 本周好货的已购计数按本期轮换到期时间精确核销：不再把泰辛服务端提前写入的未来三周购买记录，或圣言者无法归入本期的旧账/常驻长周期记录，误显示为“本周已购”。
- 周常「周日收尾提醒」不再因零网络而过报未完成：提醒前拉取一次本周世界状态（每周一次、带 5 分钟缓存，失败自动退回保守模式），执刑官猎杀与午夜电波周常也能像交互式「周常」那样按快照自动核销——修复「已完成执刑官猎杀、提醒仍列未完成」的实机问题。
- 安装器与卸载器不再被 OpenClaw CLI 的 stderr 配置警告打断（Windows PowerShell 5.1 下该警告会被当作 NativeCommandError 中止 cron 合同步骤）。

## [1.1.6] - 2026-08-23

### 修复

- 安装器与全部 PowerShell 脚本现兼容 Windows PowerShell 5.1（Win10/11 内置外壳）：仓库所有 `.ps1` 改为 UTF-8 带 BOM，避免中文本地化系统（ANSI 代码页 936/932 等）把无 BOM 脚本按 ANSI 解码后吞掉引号/括号/换行，导致解析失败或执行丢行——此前新用户按 INSTALL.md 在中文 Windows 上一键安装会直接失败。仓库元数据合同的 lockfile 版本校验改经 Node 读取（5.1 的 `ConvertFrom-Json` 无法解析 package-lock v3 的空字符串根键）。新增 `tests/ps1-encoding.test.ps1`（BOM 合同测试）与 CI 的 PowerShell 5.1 验证矩阵防止回归；新增 `scripts/env-smoke.ps1` 供新机/虚拟机一键冒烟。

## [1.1.5] - 2026-08-23

### 修复

- 仲裁订阅/查询卡片的阵营标签修复「未知阵营」：warframestat 与 browse.wf 排期对同名阵营命名不一致（`Infested` vs `Infestation`），二次翻译查无后回退成「未知阵营」；现按「规范名 → FC_* 代码 → 终值原样」幂等标准化，两个来源渲染一致，只有真正缺失才显示「未知阵营」。
- 发布版本元数据对齐：`skill/package.json`、`extension/package.json`、`skill/package-lock.json` 根版本与 `INSTALL.md` 的当前版本全部与根 `VERSION` 一致（修复 v1.1.4 发布提交只改 VERSION/CHANGELOG、漏改包版本导致仓库元数据合同校验失败、CI 变红的问题）。

## [1.1.4] - 2026-08-22

### 新增

- 杜卡德兑换命令默认改为「已入库保留」：所有含该部件的遗物均已入库的部件视为不可再生（无法常规刷取），默认全部保留并单独展示在卡片的「已入库保留」区，绝不进入自动兑换候选；未入库/状态未知的部件全部参与候选并按 杜卡德÷白金 从高到低排序，每个候选行新增 已入库/未入库 徽标。新增 `杜卡德 600 激进`（等价 `保留0`）把已入库部件也纳入候选；`保留N`/`保留N套` 保持数量保留语义（vault 不再默认保护）。
- 奸商购物与「开遗物 <商品名>」的市场路线改为「当前挂单稳健低值」口径：最低价明显低于次低价且相对今日成交中位偏低（判定为钓鱼/抢跑单）时改用次低价，无卖单回退今日/90 天成交中位；今日/90 天中位与日均成交量始终作为对照展示，Baro 到访期低价挂单立即反映、钓鱼单不会砸穿参考价。
- 奸商推荐卡重做为「实用性分级 + 三列对比」：每件商品按「补足机会成本 / 虚空商人价 / 市场价与需求度」三列展示；推荐标签由经济套利改为社区口碑分级（S 公认必买 / A 强推 / B 看需求 / C 收藏向，内置常见 Primed 分级表 `baro-tier.json`，未收录按类型兜底），并新增需求度（市场求购单数 + 近 48 小时成交量）与逐件中文商品说明（Market 官方 zh-hans）。
- 遗物行改为「全奖励清单」（照遗物资料正查模板样式）：每件奖励一行——官方中文名（与 `wm` 同款：Market zh-hans → 官方词典兜底）+ 库存持有状态与数量（成品/蓝图命名差异自动兼容）+ 白金/杜卡德图标数字 + 近期成交，彩色档位前缀（稀有/罕见/常见，按掉落率判定）；清单随行数自动缩放行高，不再用星标与税。
- 新增 66 项 Baro 商品静态清单（`baro-static.json`，构建脚本一次性生成）：出卡不再逐件请求 Market 详情接口；Market 没有的商品（primed_shred/遗物等）诚实降级展示。

### 修复

- `奸商推荐`/`开遗物 <商品名>` 的 Market 与官方 worldState 拉取接入 `http-resilience`（网络级错误重试 2 次、端点健康记录与熔断，与 `wm` 共用同一份健康文件）；官方 VoidTraders 货单提取结果新增 2 分钟 TTL 磁盘缓存（原每次实时下载约 9 秒），逐商品行情/税/挂单失败改为单项降级（该行无价展示）不再整条失败——修复 QQ 实机「查询暂时失败」「暂时无法计算动态盈亏线」的超时类故障。
- Market 404 视为确定性「无条目」：不再重试、不计入连续失败、不开熔断，并负缓存（详情 7 天 / 统计 1 小时 / 订单 60 秒）；修复 Baro 货单一批无条目商品把共享端点熔断、连累正常商品的问题。
- 遗物纪元映射纠错：后纪 = Axi（古纪/前纪/中纪/后纪 中英别名均已支持），Market 遗物条目为 `{纪元}_{编号}_relic`；修复「后纪 M5 Relic 搜成 Neo、遗物被误判无市场条目/无税/无说明」的问题。
- 遗物奖励档位改按掉落率判定（≤3% 稀有 / ≤12% 罕见 / 其余常见）：修复将 25.33% 常见奖励（每枚遗物下三件）误标为罕见的问题。

## [1.1.3] - 2026-08-21

### 修复

- 扩展路由合同测试现在同时识别源码仓库与 OpenClaw 受管安装目录中的 `SKILL.md`，使正式运行时全层验证不再依赖仓库专用相对路径。

## [1.1.2] - 2026-08-21

### 修复

- 发布合同测试现在同时接受待发布章节和已盖日期的正式发布章节，避免从正式标签安装时预检把正常的已发布状态误判为重复发布。

## [1.1.1] - 2026-08-21

### 修复

- Windows CI 现在由 PowerShell 显式枚举测试文件，避免 Node 20 把 `*.test.mjs` 当作字面路径而误报失败；包级 `npm test` 同步改用 Node 测试运行器的自动发现。

## [1.1.0] - 2026-08-21

### 新增

- 正式短命令改为`获取 <Prime部件|战甲p>`和`购买 <物品>`；“哪里刷/怎么刷/哪里买/在哪换”继续可用，但统一交给自然语言路由后规范化调用。
- 短命令与 AI 之间新增会话上下文桥：成功卡片保留 15 分钟/4 轮的脱敏实体摘要，群聊按发送者隔离，后续“这个甲多少钱”等指代可直接续查；实时数据仍重新调用工具。
- `获取/购买/wm/遗物/裂缝/商店`卡片新增结构化“下一步”命令提示，和 AI 上下文复用同一份`nextActions`。
- `获取 <Prime部件|战甲p>`获取路线：复用遗物反查、WFCD 掉点、当前赏金和可选本机库存，具体部件给详细候选，战甲简称给四部件总览；按“库存优先→当前赏金/常驻节点→条件或悬赏轮换”给行动路线，并明确展示遗物掉率、目标开奖率与非时间口径的联合概率。
- 未收录奖励 AI 查证闭环：兜底链查无时把拆词后的内部名写入 `reward-zh-inbox.json`；`reward-zh-fallback.mjs` 新增 `learn/dismiss/inbox` CLI；每日 agent 型 cron 用网页搜索查证 Market/灰机wiki 后按同键回填学习词典，下次推送直接命中，查无实据 `dismiss` 保持诚实占位。
- 科研词缀、1999 日历奖励与增益名称自动解析（官方语言键尾段索引 + 社区状态表兜底、7 天缓存），不再要求逐周手改 `weekly-static.json`。
- 数据源漂移监控（`drift-report.mjs`，只读诊断）：午夜电波挑战 requiredCount/译名/关键字段缺失、科研词缀与 1999 日历增益占位、商店装配内部名泄漏、DE 官方 worldState 结构漂移与端点健康熔断聚合，全部输出统计＋可审计键样本，零凭据、零联网、零写入；`node scripts/drift-report.mjs health` 单次读取 `endpoint-health.v1.json` 输出脱敏聚合（次数/类别/最近时间/退避状态），`doctor.mjs` 端点健康区同步显示聚合行。
- Prime 奖励估值索引生成器（`prime-reward-index.mjs`，独立安全 CLI）：从全量遗物奖励表（现有正式 Relics.json 数据链，本地只读、缺失走 CDN 兜底）中筛出英文规范名含独立单词 Prime 的可交易奖励（明确排除 Forma/Requiem 等），与现有可靠成交统计（今日/90 日成交中位＋日均量，Prime MOD 用 rank 0 口径）预热成 WFInfo 同目录标准索引 `%APPDATA%\WFInfo\prime_reward_prices.json`（schemaVersion=1，含 generatedAt/expiresAt、覆盖统计与按 OCR 英文规范名索引的 platinum/basis/dailyVolume，只有可靠成交统计、platinum > 0 且基准为今日/90 日才入）。默认 24h TTL、并发 ≤4、同目录临时文件完整写入后单次原子 rename 替换（目标替换失败绝不触碰现有文件，旧文件路径与字节原样保留）；新鲜缓存零联网复用，generatedAt 明显晚于当前时间（>5 分钟）拒绝复用，过期/损坏/刷新失败诚实上报且绝不覆盖上一份文件；CLI 支持 `--output/--ttl-hours/--concurrency/--limit/--force`。
- WFInfo 配套版受管安装：`install.ps1 -WithWFInfo`（或独立 `install-wfinfo.ps1`）固定下载 `openclaw-v9.8.2.1`，校验发布包与可执行文件双 SHA-256，验证必需许可证/说明文件，幂等安装并在升级时保留可恢复备份；`doctor.mjs` 只读检查配套版本和文件哈希。WFInfo 仍是独立发布的 Apache-2.0 组件，不并入本仓库 MIT 源码。

### 变更

- 已开封紫卡列表卡估价与详情页同口径：按词条相似度的拍卖估价（词条全同/正词条全同/共享≥2 三档区间，样本<3 标注「相似样本不足」，行情不可用诚实降级）。

### 修复

- 周常科研自动核销要求本周得分证据（分数较上周样本变化、午夜电波相关挑战进度或 HEX 令牌变化），无证据只显示「快照显示 X 研究点 · 尚未确认本周完成」，绝不核销；无历史样本的首周同样保守。
- 周常科研自动核销开始核对 AlecaFrame 的 `EntratiVaultCountResetDate` 周重置边界；字段已推进到下一周界时，即使本周研究点与上周相同也能正确核销，过期或错位字段继续保守拒绝。
- 官方源预翻译的混写奖励名（如「异融 Alad V 导航坐标」）不再因残留官方保留的拉丁专名（Alad V/Forma）落「未收录奖励」，也不进 AI inbox；纯英文名照旧排队查证。
- 未收录奖励 inbox 学习闭环加固：inbox/学习词典读写全部经同一串行队列并以临时文件 rename 原子落盘，「先入队后 dismiss」不再可能被排队中的写入复活条目，崩溃/中断不再留下半写 JSON；种子词典键（希芙及部件）不可被 learn 覆盖。
- 修复 `subscriptions-audit.test.mjs` 未隔离缓存目录的问题：测试运行会把合成 fixture（如 `totally alad v xyz thing`）写进真实运行时与仓库缓存目录的 `reward-zh-inbox.json`（2026-08-21 实拍泄漏），现在测试强制使用临时目录，且模块改为按需解析 `WARFRAME_DATA_CACHE_DIR`。
- 入侵奖励兜底链补上希芙蓝图：DE 世界状态把该配方写成 `GrineerCombatKnifeSortieBlueprint`，别名归一新增 `sheev sortie blueprint → sheev blueprint`，学习词典种子补「希芙蓝图」；火卫一 Gulliver 入侵不再落「未收录奖励」。
- 入侵奖励「未收录奖励」根治：显示名先经别名归一（`grineer combat knife`→`sheev` 等）再查词典，并新增持久化学习词典 `.cache/warframe-data/reward-zh-fallback.json`（种子：希芙/刀刃/散热片/刀柄），组合译名自动写回（只补缺、不覆盖 Market/官方结果）。
- 战甲强化 Mod（uniqueName 以 `Card` 结尾的 Powersuits 路径）在掉落/库存卡上显示官方中文名（如「摆荡钩索」），不再漏出英文；掉落卡缓存 key 升 `drops-v9`。
- 未开封紫卡估价恢复：wm 统计行对未开封紫卡无 `mod_rank`，不再被 `Number(null)===0` 误滤成无价，保持成交中位口径。
- 修复 `release.ps1` 在 git 推送进度输出触发 `NativeCommandError` 时中断的问题（2026-08-17 首次发布实锤）；并修复版本折叠后内容错挂到新 `[Unreleased]` 章节的结构问题。

### 工程

- 新增安全卸载 `uninstall.ps1`：只处理受管标记内容（Skill/插件清单文件与受控 AGENTS 片段，全部移入可恢复备份、绝不删除），cron 只按 `config/cron/reward-zh-ai.job.json` 的 declarationKey 精确删除，WFInfo 仅在显式 `-RemoveWFInfo` 且验证受管 marker 后做可恢复移动；全流程支持 `-WhatIf`。
- 版本与包元数据统一到根 `VERSION=1.1.0`：`skill/package.json` 与 `extension/package.json` 对齐（MIT、去掉无效 main、`sharp` 移入 optionalDependencies、新增可复现 `package-lock.json`，锁文件按官方 registry 生成、生命周期脚本不执行）。
- 许可证与素材治理：`LICENSE` 恢复为标准 MIT 原文，素材/数据排除移入 `NOTICE.md`，新增 `ASSET-LICENSES.md` 逐项素材来源与授权状态清单（DE 非商业粉丝政策、genesis-assets Apache-2.0 可验证、DE 游戏素材按政策保留且取得渠道如实记录）。
- 新增开源治理文件：`SECURITY.md`（私有漏洞报告优先）、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SUPPORT.md`（无 SLA）、`CODEOWNERS`、issue 表单、PR 模板与 Dependabot 配置。
- CI 供应链加固：Node 20 与 24 双版本矩阵；第三方 action 固定完整 commit SHA（注释原 tag）；`checkout` 关闭凭据持久化；保持最小只读权限；新增 `npm ci --ignore-scripts` 锁文件可复现校验。
- 每日「奖励译名 AI 查证」任务具备可部署合同：`config/cron/reward-zh-ai.job.json`（declarationKey `warframe-assistant:reward-zh-ai:default`，每日 24h、isolated agent 会话）成为该任务的唯一源码来源；`install.ps1` 幂等创建/修复（保留既有投递目标，测试工作区或 `-SkipCron` 时跳过，不触碰真实 cron），`verify.ps1` 源码层校验合同（`tests/reward-zh-cron-contract.test.ps1`）、运行时层只读校验任务存在/启用/每日/isolated。
- WFInfo 配套合同：奸商目标模式在策略缺价时读取同目录标准 `prime_reward_prices.json` 兜底（策略内价格始终优先；索引 schema/时间/字段严格校验，缺失、损坏、过期、generatedAt 明显晚于当前时间（>5 分钟）或全部条目无效时整体忽略，条目级无效价格（platinum 非有限正数、basis 非今日/90 日口径、成交量非有限或为负）逐项跳过、旧别名 90d/90-day 规范化为 90days，并维持原有缺价安全停判；索引有效期不超出策略有效期）。
- WFInfo 托管安装器合同测试覆盖固定发布清单、离线安装、许可证随包、幂等重装、错误哈希拒绝且不破坏现有安装、验证后升级与旧版本备份。
- 安全卸载加固（`uninstall.ps1`，Codex 复核）：备份目录每次运行唯一（时间戳+树名+GUID 短尾，碰撞时递增后缀），同秒重跑/重装再卸载不再可能复用并静默覆盖旧备份；备份目录创建移入 `ShouldProcess` 守卫内，`-WhatIf` 显式零写入（不再依赖 cmdlet 偏好传播）；受管文件移动去掉 `-Force`，目标已存在时大声失败而非覆盖。

### 测试

- 新增卸载合同测试（`tests/uninstall.test.ps1`，50 项）：GUID 临时工作区 + 假 openclaw CLI，覆盖 WhatIf 零改动（含无临时文件残留）、受管文件可恢复备份、未标记用户文件保留、AGENTS 片段精确移除、cron 精确 declarationKey（订阅哈希 key 不动）、WFInfo 显式开关 + marker 校验 + 可恢复移动、仓库根目录拒绝、幂等二次卸载、manifest 路径穿越负向测试（`..` 逃逸/绝对路径/空路径均拒绝且零移动）、备份目录跨运行唯一性（重装再卸载不覆盖旧备份）。
- 新增仓库元数据合同测试（`tests/repo-metadata.test.ps1`）：VERSION/skill/extension 三处版本一致、标准 MIT 原文、sharp 仅 optional、锁文件官方 registry、治理文件存在且无邮箱/QQ/SLA 承诺、文档版本漂移检查。
- 新增未收录奖励学习闭环回归：CLI 子进程级 `inbox→learn→词典命中→出队` 与 `inbox→dismiss→出队`、100 项上限挤兑、并发入队去重累计与原子落盘、dismiss 与排队写入的串行顺序、种子键不可覆盖、学习词典不覆盖 Market/官方译名。
- 新增每日任务端到端模拟（`reward-zh-daily-task.test.mjs`）：以静态证据表替换联网+模型判断，其余全走真实 CLI 子进程，验证每日 agent 任务全链与空 inbox 的 `NO_REPLY` 分支，零联网零模型。
- 新增漂移监控合同测试（`drift-report.test.mjs`，全部零联网零凭据）：电波挑战缺失统计不猜数字且自动核销被保守禁用、科研词缀/日历增益占位统计不含个人分数、合成未知名装配必须落中文占位、当前 `weekly-static.json` 用户可见中文表逐值零泄漏扫描、DE 官方 worldState 关键集合缺失拒绝写可靠缓存、端点健康白名单脱敏聚合与 CLI 只读子进程验证。
- 新增 Prime 奖励索引回归（`prime-reward-index.test.mjs`，全部零联网零凭据）：构建口径与覆盖统计、严格校验（schema/时间/未来 generatedAt/过期/负有效期/条目逐项跳过/空结果拒绝）、集合来源（仅 Intact 行/按英文名去重/无 slug 跳过/仅含独立单词 Prime 且排除 Forma/Requiem）、新鲜缓存零联网复用、过期与损坏重建、刷新失败保旧文件、原子替换失败注入（写临时或 rename 任意错误时旧目标路径与字节不变、无临时残留）、并发上限、并行性能粗测、原子写入无残留、CLI 参数错误与离线 fresh 子进程。

### 文档

- README 新增公开安装生命周期（安装/升级/卸载）、支持边界（个人项目无 SLA、Windows + 国际服）与隐私摘要（离开本机的只有查询本身，快照/凭据永不离机）。
- 新增 `ASSET-LICENSES.md`（素材来源与授权状态清单）与 `PUBLIC-RELEASE.md`（公开仓库转换核对清单与维护方式）；INSTALL.md 新增卸载章节，CONFIG.md 补充卸载备份路径。
- 许可证治理复核修订（Codex 复核）：`LICENSES/` 新增 genesis-assets 的 Apache-2.0 全文（上游逐字节副本）与来源/核对说明；货币/遗物/源力石/未开封紫卡确认为 DE 游戏素材，按 DE Content Policy 非商业条件保留（取得渠道如实记录、不主张 AlecaFrame 授权），不再列为发布阻塞；`img/` 截图记为所有者接受并延后处理的已知隐私/展示风险（非阻塞）；SECURITY.md 协调披露改为不承诺时限的个人项目措辞。

## [1.0.0] - 2026-08-17

首个带标签的发布，包含截至 `54ff3f3` 的全部历史提交。

### 新增

- 确定性短命令图片卡体系：`wm` 市场价格（含满级/指定等级交易税、`/w` 私聊模板、90 天成交统计）、遗物正反查、裂缝/仲裁/警报/入侵/活动/虚空商人世界状态。
- 库存感知推荐：裂缝推荐（白金/杜卡德口径、入库筛选、速刷/舒适/收益偏好）、精炼推荐、杜卡德规划（目标/清仓/安全保留）、奸商购物推荐。
- `开遗物`：按遗物价值推 TOP8，支持钢铁裂缝口径；`开遗物 商品名` 按奸商商品保本线筛选，输出「立即可开 + 最多三种建议获取」，野队默认按自己单枚遗物计算。
- 十三类持久订阅：裂缝/仲裁好场/警报/入侵/活动/虚空商人/重要情报/掉落/周常/赏金/商店/轮换日历/仲裁推荐，按刷新边界蹲守、去重推送、二段播报。
- 周常一图流：11 项周常 + AlecaFrame 快照自动打卡 + 回廊轨道 + 电波赛季进度。
- 本机个人账号：库存/遗物/赋能/账号状态/账号周常（仅用户本人 QQ 私聊，含快照时间）。
- 掉落监测：AlecaFrame 快照 diff，推带市价的掉落卡，发送前持久化补投队列。
- 自然语言结构化工具路由：`command/lookup/subscription` 三操作，模型只做路由与点评，卡片由插件直投 QQ。
- WFInfo 游戏内决策（可选）：`开遗物 商品名` 写入保本线策略，开奖后按实际四项奖励标「保留白金 / 兑换杜卡德」；WFInfo 双模式 + 简体中文界面。
- 商店查询（十类游戏内商店、序号直选、已购对账、本周好货）、轮换日历、紫卡估价、赏金查询/反查。

### 修复

- 卖单不再取 `sell[0]`：全部卡片改用真实升序卖单与中位成交估值（`95d75cf`、`1690bbe`）。
- Market 超时/网络异常增加端点级重试与熔断（`c21e08e`），warframestat 403 走健康退避与官方备用源。
- 世界状态备用源官方规范化：双科研、回廊、1999 日历、电波、执刑官三段任务等。
- 订阅审计 v2：可回答「为什么没提醒/多久没轮换到」，空候选池降级为 `source_unavailable`。
- 入侵连写奖励名、新午夜电波挑战译名、游戏商店商品名 0 内部名泄漏（`2dc8215`、`cdaafb1`、`54ff3f3`）。
- QQ 渠道 MEDIA 重复投递、卡片直投、指代问句误拦截、多物品库存查询等实机问题。

### 工程

- 受管部署：`install.ps1` 契约测试 + 逐文件 SHA-256 校验 + 陈旧文件可恢复隔离 + `.warframe-assistant-build.json` 构建标识。
- 可重复构建：`.gitattributes` 固定 LF（`003697c`）。
- `verify.ps1` 全链路验证：源码/运行时测试、安装器生命周期、哈希一致性、入口冒烟、doctor、插件 doctor、Gateway 状态。
- 证据协议：所有状态性结论携带 `scope/evidenceType/asOf/expiresAt/freshness/finding/source`（`d970a31`）。
- 新增 Windows CI（`.github/workflows/ci.yml`）：push/PR/tag 触发，运行源码 Skill 测试、扩展契约测试、安装器生命周期与陈旧文件隔离验证（`verify.ps1 -SourceOnly`），不接触真实 QQ、个人快照或凭据。
- 新增发布闭环：根目录 `VERSION` 作为版本唯一来源；`release.ps1` 强制干净工作树、`main` 与远端一致、源码验证通过、tag 不存在，并生成版本化 CHANGELOG 章节与 `vX.Y.Z` 标签。
- 受管部署的 `.warframe-assistant-build.json` 开始记录 `version`，Skill 与插件必须同一版本构建。

### 测试

- 新增 `alecaframe.mjs` 白名单解析回归。
- 新增紫卡（rivens）解析回归。
- 新增轮换日历回归。
- 新增关键卡片渲染结构回归（固定 HTML 结构断言）。
- 扩充 Market 主流程错误分类合同。

### 文档

- 用户指南补齐赏金/突击/钢铁侵袭、商店、本周好货、轮换日历、紫卡、订阅诊断与新午夜电波回退语义。
