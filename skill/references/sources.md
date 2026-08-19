# Warframe 数据源实测备忘（2026-08-02）

## 简体中文术语来源优先级

1. 优先采用《Warframe》简体中文官网：`https://www.warframe.com/zh-hans`
2. 官网未本地化或检索不到的新内容，采用非官方 Warframe 中文维基：`https://warframe.huijiwiki.com/wiki/Mainpage`
3. 两处都没有可靠译名时使用清楚的中文释义，并避免在用户可见卡片中直接显示英文内部名称

用户可见翻译边界：太阳系具体节点名和战甲名称保留英文；星球、任务、阵营、纪元、周期、活动、首领、奖励、武器与部件全部中文化。Market 国际服私聊模板因实际交易用途保留必要英文。未命中翻译时显示中文占位说明，不回显英文原文。

已核对：Deep Archimedea＝深层科研，Temporal Archimedea＝时光科研，Netracells＝衰退室，The Descendia＝沉沦之地。

## 世界状态与静态资料

- 世界状态：`GET https://api.warframestat.us/{platform}`；科研轮换可用子端点 `GET /{platform}/archimedeas` 做字段级补取
- 科研词缀中文：`oracle.browse.wf/dicts/en.json` × `zh.json`（227 键，其中 `/Lotus/Language/Conquest/` 200 键）。两份索引：英文显示名 → 候选（warframestat 路径用，按说明原文/数字消歧）；语言键尾段（剥 `Condition_/PersonalMod_/MissionVariant_[Lab|Hex]Conquest_` 前缀后）→ 候选（官方备用源只有路径尾段时直查，按 LAB/HEX 前缀消歧重名，如 Reinforcements＝LAB 协调阵线/HEX 支援）。名称与 `_Desc` 官方简中说明同源返回；缓存 24 小时
- 科研轮换风险词缀：官方 worldState 的 `difficulties[].risks` 是数组，普通/精英难度逐项拆分（精英独有风险标 `isHard`），不再把数组逗号合并成一个查无的词缀键
- 灵化武器等短文本：`browse.wf/warframe-public-export-plus/dict.en.json` × `dict.zh.json` 完整反向索引；缓存 7 天
- 1999 挑战：`ExportChallenges.json` 提供语言键与 `requiredCount`，中文标题/说明从 Public Export 词典读取并替换 `|COUNT|`
- 午夜电波挑战：主源有标题时使用 `ExportChallenges.json × dict.en/dict.zh`；DE 官方备用世界状态只有 `/Seasons/Weekly|WeeklyHard/<key>` 路径尾段时，直接按同路径从 AlecaFrame `lang.json` 读取官方简中名称。该路径级兜底覆盖刚换季、Public Export 挑战清单尚未收录的新 key
- 午夜电波挑战的 `requiredCount` 没有 DE 官方来源：官方 worldState 的 `SeasonInfo.ActiveChallenges` 只含路径、Daily/Elite 标志与激活/过期时间。唯一可审计的计数来源是 `ExportChallenges.json`（browse.wf 的 warframe-public-export-plus 导出），周报自动核销依赖它，刷新 TTL 24 小时；key 尚未收录或刷新失败时显示未知、不猜数量、不自动核销（2026-08-17 实测：RadioLegionIntermission16 当前 10 条活跃挑战 10/10 已收录）
- 1999 奖励：优先使用官方 `KnownCalendarSeasons.Days[].events[].reward` StoreItem 路径反查中文（lang.json 路径 → 目录父子关系 → Public Export 语言键尾段 → 日历状态中文表），不依赖解析器英文显示名；静态表只兜底个别别名（如 `ResourceDropChance3DayStoreItem`＝3 天资源掉落几率加成）
- 平台路径：`pc / ps4 / xb1 / swi`；mobile 世界状态不支持
- PC 实测顶层字段包括 `timestamp`、`fissures`、`alerts`、`invasions`、`voidTraders`、开放世界周期、`nightwave`、`arbitration`、`steelPath`、`archonHunt` 与 `duviriCycle`
- 静态资料：`GET /warframes|weapons|items/search/{query}`；实测 `gauss` 和 `ignis` 成功
- 普通参考请求使用 20 秒超时；Market 主查询采用两次 8 秒的总预算内分类重试，PC worldstate 主源采用 6 秒快速探测并配合持久健康退避。搜索仍需区分“无匹配”与网络或 HTTP 失败
- 该服务为社区数据源，实时答案必须显示 `timestamp`，不能把缓存知识冒充实时状态
- 周报只缓存同一周内通过完整性校验的世界状态（LAB/HEX 各至少三关且未过期）；顶层响应漏科研字段时补取子端点，Cloudflare/接口临时失败时仅回退本周可靠缓存，不跨周复用
- PC worldstate 主源 403 首次即打开 15 分钟端点熔断；网络/超时连续失败使用 30 秒起的指数退避（最高 5 分钟）。退避状态写入本地 `endpoint-health.v1.json`，跨短命令进程生效；官方源规范化后须通过裂缝、警报、入侵、活动、商人、赏金、科研、突击/执刑官、电波、回廊和 1999 日历字段合同
- 科研词缀优先使用 Oracle 世界状态专用中英词典（显示名 + 路径尾段双索引）；在线刷新失败时退陈旧词典缓存，再退 `weekly-static.json`，无需逐周手工补表
- 1999 日历按官方路径逐事件对齐奖励/增益，挑战行同时显示官方标题、具体要求量和可用的个人进度
- 1999 日历增益：DE 官方语言键与公开导出均不含增益名（实测 2026-08-18：`/Lotus/Upgrades/Calendar/*` 在 dict.en/dict.zh、lang.json、ExportUpgrades 全部查无）。周报改用社区维护状态中文表自动吸收——`KingPrimes/DataSource`（MIT）`warframe/state_translation.json`（按 uniqueName 索引的中文名+说明）＋ 内置 warframe-info-api（MIT）补充表（`MeleeAttackSpeed`＝绝不留情等），上游覆盖同键补充表，缓存 7 天，失败退陈旧缓存；`weekly-static.json` 的 `calendarUpgradeZhByPath` 既有手订译名仍优先。个别上游未收录的新增益（如 EnergyWavesOnCombo）保持诚实占位，上游补录后随缓存刷新自动生效，不再要求每周手工改表

## Warframe.Market v2

请求头：

```text
Accept: application/json
Platform: pc | ps4 | xbox | switch | mobile
Crossplay: true | false
Language: zh-hans
```

- `GET /v2/items`：实测 `apiVersion=0.25.0`、3837 项；`i18n` 同时含 `en` 与 `zh-hans`
- `GET /v2/item/{slug}`：实测 `wukong_prime_set` 成功，提供杜卡德金币、交易税、段位需求等详情
- `GET /v2/orders/item/{slug}/top`：`data.sell` 与 `data.buy` 各最多 5 条，已按最佳订单排序；脚本必须保持 API 顺序
- `/v2/orders/item/{slug}/top?rank=N` 支持按确切等级筛选，`N` 范围为 0 到物品 `maxRank`；订单对象的 `rank` 字段必须保留到输出和卡片
- `tradingTax` 对满级传说赋能返回满级合成件总税额；按较低等级查询时，使用 `(rank+1)(rank+2)/2` 的所需数量换算税额。稀有赋能等不随等级递增的物品不得套用该公式
- v2 当前没有价格历史端点；成交统计只读使用 v1 `GET /v1/items/{slug}/statistics` 的 `statistics_closed`。`48hours` 为小时桶、`90days` 为日桶；非 `wm` 估值按等级过滤后，今日至少 10 笔成交时直接取今日加权中位，5~9 笔且与 90 日中位偏差不超过 30% 时也取今日中位，其余回退 90 天加权中位，并以 90 天总成交量/90 显示日均成交量。不得把在线挂单伪装成成交价
- v1 已弃用；MVP 不使用身份验证，也不执行任何市场写操作
- Market v2 目录/详情/订单与 v1 只读统计分别维护端点健康；连接异常、超时、429、5xx 和坏响应可有限重试，其他 4xx 不重试。连续故障短期熔断，成功探测自动关闭；失败结果只返回脱敏的端点、类别、次数、HTTP 状态与退避截止时间

## 遗物数据

- 指定遗物：`GET https://api.warframestat.us/items/search/{English relic code}`，选取精炼等级 `Intact`
- 反向搜索：WFCD `warframe-items` 的 `data/json/Relics.json`，仅选取 `Intact` 后按奖励的 Market slug 去重
- 遗物图标：`https://cdn.warframestat.us/img/{imageName}`
- 中文奖励名、杜卡德与实时在线挂单由 Warframe.Market v2 补全
- 纪元映射：古纪=Lith，前纪=Meso，中纪=Neo，后纪=Axi；不得把“前纪 X1”误写成 Lith X1

## 入侵/警报奖励译名兜底链

世界状态里的入侵奖励是内部路径尾段（如 `GrineerCombatKnifeHeatsink`）。翻译顺序：拆词 → 别名归一（`grineer combat knife`→`sheev`、`sheev sortie blueprint`→`sheev blueprint` 等，灰机wiki 口径，见 `scripts/reward-zh-fallback.mjs`；配方尾段夹带的 `Sortie` 是 DE 路径词，不归一就无法与 Market 的 `Sheev Blueprint` 整词对上）→ Market v2 zh-hans 整词 → 官方词典（bounty maps）→ 学习词典（`.cache/warframe-data/reward-zh-fallback.json`，种子：希芙及部件含蓝图）→ 组件词元（亡魂/破坏者/枪机/散热片…）。全链查无才落「未收录奖励」；别名+词元组合出的译名会自动写回学习词典。别名新增必须有灰机wiki/官方词典依据，禁止凭猜测加泛词。官方源有时已把奖励预翻译成中文（如「异融 Alad V 导航坐标」），输入本身含中文且仅残留官方简中刻意保留的拉丁专名（Alad V/Forma）时直接放行，不落占位也不进 inbox。仍查无的内部名自动进入 `.cache/warframe-data/reward-zh-inbox.json`，由每日 AI 定时任务查证 Market/灰机wiki 后按同键回填学习词典（`learn`）或 `dismiss`；AI 只回填有据译名，不参与热路径。

## 名称解析

- 对 slug、英文名、简体中文官方名进行小写并移除空格、下划线、连字符后匹配
- 先替换社区昵称，再将中文“套装”或“一套”转换为 `set`
- 顺序：精确匹配 → Prime/set 推断 → 子串匹配
- 去重后只有一个子串候选时自动采用；多个候选时返回列表
- 验收：`悟空 Prime 套装`、`悟空prime`、`Wukong Prime Set` 都必须解析为 `wukong_prime_set`

## 常用术语

| 英文 | 中文 |
|---|---|
| Fissure | 虚空裂隙 |
| Lith / Meso / Neo / Axi | 古纪 / 前纪 / 中纪 / 后纪 |
| Sortie | 突击 |
| Arbitration | 仲裁 |
| Archon Hunt | 执刑官猎杀 |
| Steel Path | 钢铁之路 |
| Void Trader | 虚空商人 |
| Nightwave | 午夜电波 |
| Platinum / Ducats | 白金 / 杜卡德金币 |

## 限制

- 仅支持 Digital Extremes 国际服；WeGame 国服没有本技能可用的公开 API
- 截图识别由当前配置的图片模型处理，不属于脚本能力，结果需标注置信度

## AlecaFrame 本机账号快照

- AlecaFrame 通过 Overwolf 在登录和加载场景期间更新账号库存；本机快照位于 `%LOCALAPPDATA%\AlecaFrame\lastData.dat`
- 只读适配器使用 AlecaFrame 客户端自身公开可检查的 AES-CBC 格式解封快照，不读取 `WFMarketToken.tk`，不修改 AlecaFrame 或游戏文件
- 快照外层的 `InventoryJson` 包含库存、装备、段位、货币、遗物、MOD、赋能及若干个人进度字段；输出前只抽取白名单字段，不得回显账号 ID、实例 ID、原始 JSON 或令牌
- 中文名称优先使用 `%LOCALAPPDATA%\AlecaFrame\cachedData\json\lang.json` 的 `zh.name`；战甲名称保持英文，标准部件名称使用本地中文映射
- 可靠个人查询：段位、货币余额、剩余交易、物品数量、遗物精炼与数量、赋能等级与数量
- 周常字段只按证据强度展示：`DescentRewards` 可显示沉沦之地层数；`EntratiVaultCountLastPeriod` 明确属于上一周期；最近突击/执刑官奖励和午夜电波历史没有可靠周期归属时不得自动标记本周完成
- 快照不是实时 API。所有结果必须显示 `LastInventorySync` 对应时间，并提示进入任务、中继站或道场后才可能刷新
