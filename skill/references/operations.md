# 运维细节（monitor / 订阅调度 / 卡片管线）

SKILL.md 瘦身移入（2026-08-07）。这些规则的执行主体是脚本与 cron 配置，模型日常不需要读；
排障、改调度逻辑、新装部署时查这里。

## monitor 通用契约

- 用户主动新建的世界状态订阅首次运行若当前已命中会立即提醒；安装时自动种下的默认订阅首次只记录基线；无新情报输出 `NO_REPLY`
- 只写用户指定的 `--state` 本地文件；定时任务用命令型 cron，无变化不调模型
- `--mode unpredictable`（警报/稀有入侵/活动，最多每 15 分钟联网一次）与 `--mode scheduled`（虚空商人按到达/离开边界蹲守）
  必须用不同 `--state` 文件，避免并发覆盖去重状态；恰逢其他固定边界已刷新世界状态时复用同一次结果
- scheduled 记录 `nextCheckAt`：cron 可每分钟调，未到点只读本地状态输出 `NO_REPLY` 不联网
- `--card-dir` 存在时发现新情报生成深色提醒卡；`monitor` 输出 `MEDIA:` 供兼容调用，生产订阅 cron 使用 `deliver` 子命令（通知先原子入 R3 共享 Outbox、提交账本后再逐 part 投递，见「订阅调度」）并关闭 runner announce；周常订阅的主周报保持单张完整高清 PNG（原始像素，不切段、不裁剪、不二次缩放），主动推送由 Outbox 以 `transport=lossless` part 走 QQ `/files` 并设置 `srv_send_msg=true` 一步直传原图，不再追加会压缩长图的 `msg_type=7`；渲染失败退文字，原图直传失败只补投未成功的 part（已成功 part 不重发）
- cron 直投的命令（drops/subscriptions monitor、weekly remind）异常时必须输出 NO_REPLY，不得裸 JSON
- 联网订阅每次真正刷新时写入通用审计：数据源状态、候选快照、匹配数、新匹配数和是否已生成提醒；`subscription_diagnosis` 只依据该流水回答历史/漏报问题。`seen` 只负责去重，不能再充当历史记录。

## 订阅调度

### Warframe.Market 愿望单

- 愿望单使用独立的 `state/warframe-wishlist.json`，按 QQ 会话与发送者隔离；只保存商品、愿望价、等级条件、状态和订单去重 ID，不保存卖家名，也不登录 Market。
- Gateway 生命周期内全插件只建立一条公开 `wss://ws.warframe.market/socket` / `wfm` 新订单订阅，并以内存 itemId 索引过滤；新愿望建立、改价或恢复后立即执行一次 item top 校准。设置反馈卡先发送；已有合价卖单时补发标准 `wm` 市场行情卡和私聊文本，并把当前订单写入去重，不能留到 10 分钟 cron 才延迟提醒。**该「建立后立即行情卡」与愿望管理命令的主回复仍属交互用例顺序，不经 Outbox。**
- 每个 QQ 会话另有一条 10 分钟命令型 cron，仅请求该会话当前商品的 `/v2/orders/item/{slug}/top` 做漏单/重连校准；REST 请求起点至少相隔 400ms，低于公开 3 req/s 上限。
- 新订单按 `platinum / perTrade` 计算单件价格，只匹配可见 sell 单和准确等级；同一订单每个愿望只提醒一次。命中仅推送图片和 Market 私聊文本，绝不自动交易、聊天或核销。
- **主动命中通知（生产 `deliver` 子命令与 Gateway 实时命中）已迁入 R3 共享 Outbox**（`state/warframe-delivery-outbox.json`）：命中结果确定后先原子入队，再提交 wishlist 账本（seenOrderIds/lastMatchAt/calibration），再在 wishlist 锁外逐 part 投递。业务键 = 脱敏 targetKey + 稳定「orderIdentity × 命中 wishId 集合」的 SHA-256 语义（原始 target/seller/owner/order/wish id 只进摘要，不原文落盘），REST 与 WS 对同一完整 order+wish 通知集合自动去重；愿望提醒使用保守 10 分钟业务 TTL（过期不盲发），条目在 delivered/expired 终态立即擦除 part.value（`redactOnTerminal`），只留 contentHash、part 状态、时间与脱敏结果审计——卖家名永不写入 wishlist 账本、墓碑或尝试日志。WebSocket 一笔订单命中多个 QQ target 时，全部目标的 Outbox 入队成功才一次性提交账本（每 target 独立业务键与投递状态）；任一目标入队失败不提交 seen，下轮 REST 校准同键恢复；入队成功但账本写失败下轮同键去重不重复入队；账本已提交但投递失败下轮 REST `not_due`/无新命中前先补投 pending。Gateway 启动或每次事件时先恢复相关 target 的 wishlist pending（只投 `wishlist:` 业务键前缀），outbox 跨进程锁保证与校准 cron 并发不重复发送；QQ outbound adapter 的 sendMedia/sendText 只有返回 messageId 才视为成功，结果转换为固定脱敏类别（异常只记类别不存原文）。`monitor`/`calibrate`/`gateway_start` 与 `--dry-run` 输出保持原样，不经 Outbox；`deliver --dry-run true` 只输出预览，绝不调用 QQ outbound。
- 用户只有明确发送 `已购 <短编号>` 才会停止该愿望；不回复则继续监控。Gateway 断线指数退避至 60 秒，恢复后继续共用同一连接。

- 每个 QQ 会话只建一条命令型 cron，合并该会话所有人的订阅共用一次世界状态请求；提醒发回订阅创建时的会话。安装/再次管理订阅时会把旧 `monitor + announce` 任务幂等迁移为 `deliver + no-deliver`
- 蹲守边界：仲裁按当前轮换 expiry（整点）、裂缝按最早 expiry、虚空商人按到达/离开边界、突击每日 16:00 UTC、
  钢铁侵袭每日 00:00 UTC、赏金按候选 expiry（30min 兜底）；到点前 cron 只读本地状态输出 `NO_REPLY`
- 每个命中 ID 只推一次；突击/钢铁侵袭按日 id 天然去重
- 二段播报：轮换制（裂缝/仲裁）只报「出现」；虚空商人离开前 12h、特殊活动结束前 24h、
  高价值警报（反应堆/催化剂/Forma/适配器类）截止前 1h、稀有入侵进度 ≥90% 各补报一次「最后窗口」；
  每事件每阶段一次（去重标记 `id#closing`）；阈值是脚本内常量不做用户配置
- `订阅 周常`：创建后首轮即推本周清单；之后每周一 00:00 UTC 刷新后推两张卡（周报主卡保持单张完整原始 PNG + 本周好货卡，好货卡挂了降级只发周报）；
  优先级最低不挤占其他提醒；推送经 R3 共享 Outbox 逐 part 投递——主周报 part 以 `transport=lossless` 走 QQ `/files` 的 `srv_send_msg=true` 一步直发原图（不再追加会压缩长图的 `msg_type=7`），好货卡普通 `--media`，渲染失败退 `--message` 文字；
  业务键 = 脱敏 targetKey + weeklyId + 本次 pending 周常订阅集合哈希（subscriptionId 只进摘要不入盘；同周新建订阅不会被旧 tombstone 吞掉），`expiresAt` = 本周重置边界且不晚于 48h——先原子入队，再提交 weekly seen/调度账本，再在账本锁外逐 part 投递；失败只补投未成功 part
- 世界状态订阅（裂缝/仲裁/警报/活动/商人/突击/钢铁侵袭/赏金/商店/商品/轮换）的 `deliver` 子命令与掉落共用 R3 通知 Outbox
  （`state/warframe-delivery-outbox.json`）：通知结果确定后先原子入队，再提交订阅账本（seen/一次性消费/调度/审计），再逐 part 投递；
  业务键 = 脱敏 targetKey + 稳定“事件 × 命中订阅”集合（fresh 与 closing 区分，subscriptionId 只进摘要不原文落盘）；`expiresAt` = 本卡片最早的有效业务 expiry（裂缝/警报过期后不盲目补发），
  无业务 expiry 时用保守的 6h 明确默认，且不晚于 48h 默认 TTL——入队成功但账本写失败下轮同键去重不重复入队，
  账本已提交但投递失败下一轮即使调度 `not_due` 也先补投 pending；图片成功文字失败只补投文字，进程重启 pending 自动恢复。
  `monitor`（announce）子命令不经过 Outbox，输出保持原样；周常已于第三片迁入同一 Outbox（见「订阅 周常」），愿望主动命中通知已于第四片迁入（见「Warframe.Market 愿望单」）
- `订阅 掉落`（个人）：独立 cron 每分钟只查快照 mtime，变化才解密 diff；首次只建基线；
  筛选词支持 全部/prime/部件/mod/赋能/稀有/具体物品名，缺省只推 Prime 部件/赋能/稀有传说 MOD；
  通知先写入 R3 共享 Outbox 第一版（`state/warframe-delivery-outbox.json`：脱敏目标哈希、业务幂等键、内容哈希、媒体/文字
  逐 part 状态、创建/过期时间、尝试次数与结果类别），再逐 part 投递——图片成功文字失败重试只补投
  文字，进程重启后 pending 自动恢复补投，跨进程写由共享锁串行，同一业务键不重复入队；旧版 `pendingDelivery` 欠账自动
  兼容迁移（TTL 维持 48h 不丢欠账）。掉落自身按 48h 补投；世界状态时效提醒只在各自业务 `expiresAt` 前补投
- `订阅 商品`：泰辛 8 周表内给上架日期预告并到点推送；商店货单查无的转 Baro/瓦奇娅到货对账蹲守；
  常驻/每期必上的拒单并告知原因；`订阅 轮换` 为一次性（推送后自动取消，建立时告知目标日期）

## 卡片管线

- 图片卡不得出现 `VOID FISSURE`/`ARBITRATION`/`WARFRAME INTEL`/纪元英文缩写/英文数据源名；统一中文标题与来源标签
- 内嵌图 base64 只服务渲染，出口序列化统一剥离（stripDataUriReplacer），防撑爆插件 execFile maxBuffer
- 渲染时自动清理 7 天前旧卡；PNG 调色板压缩（sharp 缺失静默跳过）
- 渲染器 2x 截图；浏览器探测顺序：WARFRAME_BROWSER env → Chrome（系统/用户级）→ Edge

## 未收录奖励 AI 查证闭环

- 兜底链全链查无落「未收录奖励」时，把拆词后的内部名排队进 `.cache/warframe-data/reward-zh-inbox.json`（去重累计、上限 100、纯中文不入队），热路径不联网不调模型
- 官方源预翻译的混写名（输入含中文、仅残留 Alad V/Forma 等官方保留专名）直接放行，不落占位也不进 inbox
- 每日一条 agent 型 cron（查证需要网页搜索与判断，命令型 cron 不调模型）：读 inbox，逐键查证 Warframe.Market zh-hans / 灰机wiki
- **任务定义可部署**：`config/cron/reward-zh-ai.job.json`（declarationKey `warframe-assistant:reward-zh-ai:default`，每日 24h、isolated 会话、agentTurn 提示词含 `{{SKILL_SCRIPTS_DIR}}`/`{{OWNER_C2C}}` 占位符）是该任务的唯一源码合同。`install.ps1` 幂等创建/修复（同 key 即同一任务；只修合同字段，**绝不改动用户既有投递目标**；非真实工作区或 `-SkipCron` 时跳过，避免测试触碰真实 cron 存储）；`verify.ps1` 在源码层校验合同文件（`tests/reward-zh-cron-contract.test.ps1`），运行时层只读校验任务存在/启用/每日/isolated
- 有依据：`node skills/warframe-assistant/scripts/reward-zh-fallback.mjs learn --english <inbox键> --zh <纯中文名> --source <依据>`
  按同键回填学习词典并出队，下次推送直接命中；learn CLI 拒绝夹带英文的译名，词典只补缺不覆盖 Market/官方结果，种子键（希芙及部件）不可被 learn 覆盖
- 查无实据：`dismiss --english <键>` 出队，保持诚实占位；禁止凭猜测翻译
- inbox 为空时只回复 `NO_REPLY`，不打扰 QQ 会话
- **持久化与并发**：inbox/学习词典的读写全部经进程内串行队列（入队/出队/清空同队列，先入队后 dismiss 不会复活条目）+ 临时文件 rename 原子落盘；多进程并发（订阅监测与每日任务分属不同进程）时最坏是丢失一次更新，文件不会损坏
- **测试隔离铁律**：任何跑 inbox/学习词典的测试必须先把 `WARFRAME_DATA_CACHE_DIR` 指向临时目录（2026-08-21 实拍：`subscriptions-audit.test.mjs` 未隔离，把合成名 `totally alad v xyz thing` 写进了真实运行时与仓库缓存目录的 inbox，且清空过真实 inbox；模块已改为按需解析该环境变量，测试在文件顶部设置即可生效）

## 数据源漂移监控（只读诊断）

- `scripts/drift-report.mjs` 是纯函数漂移检测模块：统计 + 可审计键样本，零凭据、零联网、零写入，禁止用于生产告警、cron、缓存写入或运行时改动
- 单次只读 CLI：`node scripts/drift-report.mjs health [--health <endpoint-health.v1.json>]` 输出 Market/worldstate 端点健康聚合（端点数、熔断中数、失败类别次数、最近失败/成功时间、各端点退避状态）；只输出白名单字段，即使文件混入 url/headers/token/body 也不外泄
- 电波挑战漂移（缺 requiredCount/路径译名/关键字段）只报统计与键样本，绝不猜数量；`checkoffSafe=false` 只表示自动核销被保守禁用，不是完成判定
- 科研词缀与 1999 日历增益占位统计不接收、不输出任何个人分数/快照字段
- 商店装配泄漏扫描：合成未知名必须落中文占位；`scanZhTableLeaks` 可对当前 `weekly-static.json` 用户可见中文表逐值扫描（合法英文保留词走白名单）
- DE 官方 worldState 结构漂移：关键集合缺失/畸形 → `cacheable=false`（拒绝写可靠缓存），与 `hasCompleteArchimedeas` 的周报可靠缓存口径叠加
- 完整覆盖见 `scripts/drift-report.test.mjs`（随 `verify.ps1 -SourceOnly` 运行）

## AlecaFrame 快照边界

- 快照只在登录/加载场景时更新；结果必须显示快照时间；`刷新账号` 只提示用户过加载点，不得伪称已强制刷新
- 原始 lastData.dat、账号标识、物品实例 ID、登录令牌不得进入模型上下文或 QQ 回复；禁读 WFMarketToken.tk
- `账号周常` 只显示快照中能验证的字段；自动核销只采信带周界校验的字段（Expiry/ResetDate 在未来、或与本周 worldstate id 对账），
  无法归属周期的记录（如科研分数）只展示不勾选

## QQ 渠道细节

- 群聊只接管当前单条明确短命令；上下文按群/发送者/引用链隔离，不拼相邻群友消息
- 短命令硬拦截后禁止调模型、禁止模型改写；每命令只发一次图
- 消息归一：Unicode NFKC、全角转半角、大小写统一、空格折叠（`遗物前x1`=`遗物 前x1`=`遗物　前 X1`）
- 纪元简称：古=Lith、前=Meso、中=Neo、后=Axi
- warframestat 不支持 mobile 世界状态（market 查价支持），遇到如实说明
