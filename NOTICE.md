# NOTICE — 数据源与素材归属

本项目代码按 MIT 发布，但以下数据与素材**不属于** MIT 授权范围，归属各自权利人。

## 游戏素材

Warframe 及其全部游戏内素材（物品图标、图片、名称、文本）版权归 **Digital Extremes Ltd.**。
本项目按 fan 项目惯例使用，与 Digital Extremes 无关联、未获其背书。
DE 的粉丝内容政策：https://www.warframe.com/community/fankit

仓库内置素材（skill/assets/）来源：
- 货币/UI/遗物/源力石图标：AlecaFrame 应用资源与 DE 游戏纹理（版权 DE）
- 世界状态类型图标、集团徽记：WFCD genesis-assets（https://github.com/WFCD/genesis-assets，社区维护的 DE 素材集）
- 运行时按需下载的物品图：warframe.market 静态资源、browse.wf 直出的 DE 游戏纹理、AlecaFrame CDN

## 数据源

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

## 算法参考声明

商店轮换复现算法（vendor-rotation.mjs 中 SRng/种子混合逻辑）参考了 OpenWF 社区对游戏客户端行为的公开逆向研究成果，
由本项目**独立实现**；未复制 SpaceNinjaServer（AGPL + Commons Clause）任何代码。

## AlecaFrame

AlecaFrame 是第三方 Overwolf 应用（https://alecaframe.com）。本项目只读其落盘的本机数据文件，
不读取其 warframe.market 登录令牌、不修改其任何文件、不上传原始快照。AlecaFrame 名称归其作者所有。

## 移除请求

任何权利人认为本项目的使用不当，请提 issue，将及时移除对应内容。
