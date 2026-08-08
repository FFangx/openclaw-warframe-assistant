# Warframe 数据源实测备忘（2026-08-02）

## 简体中文术语来源优先级

1. 优先采用《Warframe》简体中文官网：`https://www.warframe.com/zh-hans`
2. 官网未本地化或检索不到的新内容，采用非官方 Warframe 中文维基：`https://warframe.huijiwiki.com/wiki/Mainpage`
3. 两处都没有可靠译名时使用清楚的中文释义，并避免在用户可见卡片中直接显示英文内部名称

用户可见翻译边界：太阳系具体节点名和战甲名称保留英文；星球、任务、阵营、纪元、周期、活动、首领、奖励、武器与部件全部中文化。Market 国际服私聊模板因实际交易用途保留必要英文。未命中翻译时显示中文占位说明，不回显英文原文。

已核对：Deep Archimedea＝深层科研，Temporal Archimedea＝时光科研，Netracells＝衰退室，The Descendia＝沉沦之地。

## 世界状态与静态资料

- 世界状态：`GET https://api.warframestat.us/{platform}`
- 平台路径：`pc / ps4 / xb1 / swi`；mobile 世界状态不支持
- PC 实测顶层字段包括 `timestamp`、`fissures`、`alerts`、`invasions`、`voidTraders`、开放世界周期、`nightwave`、`arbitration`、`steelPath`、`archonHunt` 与 `duviriCycle`
- 静态资料：`GET /warframes|weapons|items/search/{query}`；实测 `gauss` 和 `ignis` 成功
- 所有网络请求统一使用 20 秒超时；搜索需区分“无匹配”与网络或 HTTP 失败
- 该服务为社区数据源，实时答案必须显示 `timestamp`，不能把缓存知识冒充实时状态

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

## 遗物数据

- 指定遗物：`GET https://api.warframestat.us/items/search/{English relic code}`，选取精炼等级 `Intact`
- 反向搜索：WFCD `warframe-items` 的 `data/json/Relics.json`，仅选取 `Intact` 后按奖励的 Market slug 去重
- 遗物图标：`https://cdn.warframestat.us/img/{imageName}`
- 中文奖励名、杜卡德与实时在线挂单由 Warframe.Market v2 补全
- 纪元映射：古纪=Lith，前纪=Meso，中纪=Neo，后纪=Axi；不得把“前纪 X1”误写成 Lith X1

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
