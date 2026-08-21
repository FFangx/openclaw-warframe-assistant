# NOTICE — 授权范围与素材/数据归属

本仓库代码（`skill/`、`extension/`、`config/`、安装与发布脚本、文档）按根目录 `LICENSE`（MIT）发布。
**以下内容不属于 MIT 授权范围**，归属各自权利人；详细逐项清单见 [ASSET-LICENSES.md](ASSET-LICENSES.md)。

## Warframe / Digital Extremes

- Warframe 及其游戏内素材（物品图标、图片、名称、文本、世界状态数据）版权归 **Digital Extremes Ltd.** 所有。
- 本项目是**非官方**粉丝项目：与 Digital Extremes **无关联、未获其背书、未经其批准**。
- 仓库内对 DE 素材的任何分发仅主张 DE 官方 Content Policy 允许的范围：**非商业使用**
  （"Use of Warframe assets must be non-commercial"）——见
  <https://www.warframe.com/contentpolicy> 与 <https://www.warframe.com/community/fankit>。
  未经 Digital Extremes 书面同意，不得使用 Warframe / Digital Extremes 徽标。
- 使用风险自负；本项目与 Digital Extremes 无关。

## 仓库内置素材（skill/assets/）

逐项来源、权利人与可验证授权状态见 [ASSET-LICENSES.md](ASSET-LICENSES.md)。
要点：

- 世界状态类型图标、集团徽记：来自 WFCD [genesis-assets](https://github.com/WFCD/genesis-assets)
  （该仓库以 Apache-2.0 发布；许可证全文与上游核对记录保留在 [LICENSES/](LICENSES/genesis-assets.md)。
  底层素材版权仍归 DE，受上述 DE 政策约束）。
- 货币/遗物/源力石/未开封紫卡图标：按代码注释与既有 NOTICE 记录均为 **DE 游戏素材**
  （`warframe-cards.mjs`「官方素材」、`weekly-mega-card.mjs`「源力石官方图标」、`rivens.mjs` 未开封紫卡图标；
  本轮复核未发现任何非 DE 素材的证据）。部分副本经 **AlecaFrame 应用资源渠道**取得——
  取得渠道如实记录，但**不代表 AlecaFrame 创作或授权这些素材**，本仓库也不对 AlecaFrame 主张任何授权；
  这些图标按上述 DE Content Policy 的非商业、非官方、未获背书条件保留。

## 数据源（运行时访问，不入库分发）

| 来源 | 用途 | 说明 |
|---|---|---|
| api.warframestat.us (WFCD) | 世界状态、掉落表、中文物品名 | 社区公益 API |
| api.warframe.market | 实时价格、拍卖、物品目录 | 官方公开 API，遵守其调用礼仪（限频、UA） |
| browse.wf / oracle.browse.wf (OpenWF) | 官方导出数据、词典、仲裁/侵袭排期 | 社区镜像 |
| content.warframe.com / api.warframe.com | DE 官方 worldState | 官方公开端点 |
| cdn.alecaframe.com | 目录数据在线兜底 | AlecaFrame 分发源 |
| relics.run | 每日价格行情快照 | 社区公益 |
| 灰机 wiki (warframe.huijiwiki.com) | 别名表与译名考证 | CC BY-SA 3.0，已注明出处 |
| 仲裁场地评级表、紫卡神卡表（44bananas） | 社区评级参考 | 卡面已标注来源 |

运行时按需下载的物品图来自 warframe.market 静态资源、browse.wf 直出的 DE 游戏纹理与 AlecaFrame CDN；
这些是用户机器直接访问公开端点，不构成仓库再分发。

## 算法参考声明

商店轮换复现算法（`vendor-rotation.mjs` 中 SRng/种子混合逻辑）参考了 OpenWF 社区对游戏客户端行为的公开逆向研究成果，
由本项目**独立实现**；未复制 SpaceNinjaServer（AGPL + Commons Clause）任何代码。

## AlecaFrame

AlecaFrame 是第三方 Overwolf 应用（<https://alecaframe.com>）。本项目只读其落盘的本机数据文件，
不读取其 warframe.market 登录令牌、不修改其任何文件、不上传原始快照。AlecaFrame 名称归其作者所有；
从 AlecaFrame 应用资源提取并内置入库的图标均为 **DE 游戏素材**（详见 ASSET-LICENSES.md），
本仓库仅如实记录取得渠道，**不主张 AlecaFrame 对再分发给予任何授权**。

## WFInfo 配套版

`install-wfinfo.ps1` 从 `FFangx/WFinfo` 的固定发布下载经 OpenClaw 适配的 WFInfo。该程序是独立安装、独立发布的
**Apache License 2.0 组件**，不属于本仓库 MIT 授权范围，也未把 WFInfo 源码或二进制并入本仓库。
发布包内保留 `LICENSE.txt`、修改说明和第三方许可证；对应源码与发布见 <https://github.com/FFangx/WFinfo>。

## 移除请求

任何权利人认为本项目的使用不当，请提 issue（涉及安全细节请走 SECURITY.md 的私有渠道），将及时移除对应内容。
