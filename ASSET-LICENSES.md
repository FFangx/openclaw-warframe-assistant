# ASSET-LICENSES — 第三方素材来源与授权范围清单

> 本文件逐项说明仓库内**内置素材**（`skill/assets/`、`img/`）的来源、权利归属与再分发依据，
> 以及公开发布前的处置状态。代码与文档的授权见根目录 `LICENSE`（MIT）；数据源的归属见 `NOTICE.md`。
> 复核日期：2026-08-21（含 Codex 复核后修订）。本文件不构成法律意见；
> 凡标注「阻塞」或「待复核」的条目，在人工核实前不得视为已获授权。

## 0. 总原则

1. **DE 素材**：Warframe 及其游戏内素材版权归 Digital Extremes Ltd.。本项目与 DE **无关联、非官方、未获背书**。
   官方 Content Policy（<https://www.warframe.com/contentpolicy>，2026-08-21 复核）明确：**Warframe 素材的使用必须非商业**
   （"Use of Warframe assets must be non-commercial"）；未经书面同意不得使用 Warframe / Digital Extremes 徽标。
   因此本仓库对 DE 素材的分发仅主张「非商业粉丝内容」这一范围。
2. **取得渠道 ≠ 权利来源**：副本「经某应用/某仓库取得」只说明文件怎么到手，不构成、也不替代授权。
   对 DE 游戏素材，再分发依据始终是 DE Content Policy 的非商业粉丝内容条件；
   渠道（如 AlecaFrame 应用资源）如实记录，**不主张渠道方创作或授权了这些素材**。
3. **可证实性**：内置素材必须能证实为 DE 游戏素材或已获授权的第三方素材，才标注「可分发」；
   来源无法证实的条目一律标注「阻塞」或「待复核」，修复路径为「替换为可证实来源」或「改为运行时下载（不入库）」。
4. **运行时下载不算再分发**：脚本运行时从公开端点（warframe.market 静态资源、browse.wf、AlecaFrame CDN、
   relics.run 等）拉取的图片只存在于用户本机，不随仓库分发，不适用本清单的入库判定。

## 1. 内置素材逐项清单（skill/assets/）

| 素材组 | 文件 | 来源 | 权利归属 | 再分发依据 | 公开发布状态 |
|---|---|---|---|---|---|
| 世界状态类型图标 | `assets/worldstate/*.png`（alert/arbitration/baro/darvo/event/fissure/incursion/invasion/sortie/syndicate） | 派生自 WFCD [genesis-assets](https://github.com/WFCD/genesis-assets)（缩小/优化副本；逐文件核对记录见 [LICENSES/genesis-assets.md](LICENSES/genesis-assets.md)） | 仓库以 Apache-2.0 发布（许可证全文保留在 [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)）；底层美术版权 DE | genesis-assets Apache-2.0 + DE 非商业粉丝内容政策 | ✅ 可分发（附条件：保留 Apache-2.0 全文与来源说明、DE 政策附注；`event/incursion` 两文件上游无同名文件，仅按 DE 素材分类） |
| 集团徽记 | `assets/syndicates/*.png`（cetus/deimos/fortuna/HexSyndicate/ZarimanSyndicate） | 派生自 WFCD genesis-assets（同上；`deimos/fortuna/ZarimanSyndicate` 上游无同名文件，仅按 DE 素材分类） | 同上 | 同上 | ✅ 可分发（附条件：同上） |
| 货币图标 | `assets/currency/*`（aya/credits/ducats/endo/platinum/regalAya/riftPlasm/SteelEssence） | DE 游戏素材（`warframe-cards.mjs` 注释「官方素材」；副本经 AlecaFrame 应用资源渠道取得，渠道如实记录、不主张 AlecaFrame 授权） | DE | DE 非商业粉丝内容政策 | ✅ 可分发（附条件：非商业、非官方、未获背书；渠道记录见 NOTICE.md） |
| 遗物图标 | `assets/relics/*`（axi/lith/meso/neo/omnia/requiem） | DE 游戏素材（原 NOTICE 记录「AlecaFrame 应用资源与 DE 游戏纹理」；渠道同上） | DE | DE 非商业粉丝内容政策 | ✅ 可分发（附条件：同上） |
| 源力石图标 | `assets/archon-shards/*.webp`（含 mythic 变体） | DE 官方图标纹理（`weekly-mega-card.mjs` 注释「源力石官方图标（AlecaFrame 素材已复制进 assets/archon-shards）」；渠道同上） | DE | DE 非商业粉丝内容政策 | ✅ 可分发（附条件：同上） |
| 未开封紫卡图标 | `assets/mod_riven.png` | DE 游戏内「未开封紫卡」物品图标（`rivens.mjs` 注释「AlecaFrame mod_riven.png 复制进 assets/」；渠道同上） | DE | DE 非商业粉丝内容政策 | ✅ 可分发（附条件：同上） |

复核结论：上述四组 DE 游戏素材（货币/遗物/源力石/未开封紫卡）的代码注释与既有 NOTICE 均指向 DE 游戏素材，
**未发现任何「非 DE 素材」的证据**；AlecaFrame 只是副本取得渠道，不再因该渠道列为阻塞。
若后续发现某文件并非 DE 游戏素材，才单独改标阻塞并报告。

## 2. 仓库自带渲染截图（img/）

| 文件 | 内容 | 状态 |
|---|---|---|
| `img/card-recommend.png`、`img/card-refine.png`、`img/card-market.png`、`img/card-fissure.png` | 本项目卡片渲染输出的截图，画面含 DE 游戏素材；部分卡片可能含本机账号数据（如杜卡德余额） | 📋 **所有者接受并延后处理的已知隐私/展示风险**（本轮不修改 `img/`，也不作为本次公开转换的阻塞项）。延后期间由所有者决定是否随公开仓库分发；若分发，建议先人工复核画面脱敏与 DE 政策标注 |

## 3. WFInfo 配套版（不入库）

`install.ps1 -WithWFInfo` / `install-wfinfo.ps1` 下载的 WFInfo OpenClaw 配套版是**独立 Apache-2.0 组件**，
发布包位于 `FFangx/WFinfo`（<https://github.com/FFangx/WFinfo>），包内含 `LICENSE.txt`、`OPENCLAW-NOTICE.txt`、
`MODIFICATIONS.md` 与第三方许可证清单；安装器强制校验这些文件存在。该组件不并入本仓库 MIT 授权范围，
本清单与 NOTICE.md 均不为其素材背书。

## 4. 公开发布前处置清单（供维护者逐项勾选）

- [x] genesis-assets 派生的世界状态/集团图标：Apache-2.0 全文（`LICENSES/Apache-2.0.txt`）与来源/核对说明
      （`LICENSES/genesis-assets.md`）已保留；NOTICE/本文件附 DE 政策注记。
- [x] DE 游戏素材（货币/遗物/源力石/未开封紫卡）：按 DE Content Policy 非商业、非官方、未获背书条件保留；
      取得渠道（AlecaFrame 应用资源）如实记录，不主张 AlecaFrame 授权；本轮复核未发现非 DE 素材证据。
- [ ] `img/`：所有者接受并延后处理的已知隐私/展示风险；延后期间随不随公开仓库分发由所有者决策。
- [ ] 新增任何内置素材前先读本文件：来源无法证实的素材一律不入库（改运行时下载）。
- [ ] 若任何权利人提出移除请求：按 NOTICE.md「移除请求」流程处理。

## 5. 修订记录

- 2026-08-21：创建本清单。复核依据：DE Content Policy（<https://www.warframe.com/contentpolicy> 在线正文）、
  WFCD genesis-assets GitHub 仓库元数据（Apache-2.0）与上游 `LICENSE` 全文、alecaframe GitHub 组织/仓库公开检索
  （无公开仓库，无法证实授权）、本仓库代码注释与既有 NOTICE.md 记录。
- 2026-08-21（Codex 复核后修订）：按「取得渠道 ≠ 权利来源」修正判定——货币/遗物/源力石/未开封紫卡四组
  经代码注释与既有记录证实为 **DE 游戏素材**，按 DE Content Policy 非商业条件保留，不再因 AlecaFrame 渠道阻塞；
  渠道如实保留且不主张 AlecaFrame 授权；genesis-assets 派生图标补充 `LICENSES/` 全文保留与逐文件核对记录；
  `img/` 改记为所有者接受并延后处理的已知风险（非本次转换阻塞项）。
