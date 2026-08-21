# LICENSES — 第三方许可证全文与来源说明

本目录按 Apache-2.0 §4(a) 的要求，为从 **WFCD genesis-assets** 派生的内置图标保留许可证全文与来源说明。

## 文件清单

| 文件 | 内容 |
|---|---|
| `Apache-2.0.txt` | WFCD genesis-assets 仓库根目录 `LICENSE` 的**逐字节副本**（202 行标准 Apache License 2.0 全文，2026-08-21 从上游 `master@730ff1a9211b249b3774dd7cc75fe353fd0b792a` 原样拉取，未做任何改写） |
| `genesis-assets.md` | 本文件：来源、核对记录、覆盖范围与注意事项 |

## 上游核对记录（2026-08-21）

- 上游仓库：<https://github.com/WFCD/genesis-assets>（默认分支 `master`）。
- GitHub API 元数据（`repos/WFCD/genesis-assets`）显示 `license = Apache-2.0`，仓库未归档。
- 根目录存在 `LICENSE` 文件，内容为标准 Apache License 2.0（与本目录 `Apache-2.0.txt` 一致）。
- **上游没有 NOTICE 文件**：对 `master` 全量递归树（1316 个 blob）按 `notice/copying/license/legal/third` 等关键字扫描，
  仅命中根目录 `LICENSE`。因此按 Apache-2.0 §4(d) 无需保留 NOTICE，此处记录该核对结论。

## 覆盖范围（本仓库从 genesis-assets 派生的文件）

本地文件是上游 PNG 的**缩小/优化副本**（如 `sortie.png`：本地 96×96，上游 `img/sortie.png` 128×128，
已视觉比对确认为同一图案；其余文件未逐字节核对）。逐文件对照：

### `skill/assets/worldstate/`

| 本地文件 | 上游对应路径（master@730ff1a9） | 核对方式 |
|---|---|---|
| `alert.png` | `img/alert.png` | 文件名一致 |
| `arbitration.png` | `img/arbitrations.png` | 文件名一致 |
| `baro.png` | `img/baro.png` | 文件名一致 |
| `darvo.png` | `img/darvo-sm.png` / `img/darvo-md.png` | 同名家族，未逐字节核对 |
| `event.png` | 上游未找到同名文件 | 见注意事项 |
| `fissure.png` | `img/fissure-sm.png` | 文件名一致 |
| `incursion.png` | 上游未找到同名文件 | 见注意事项 |
| `invasion.png` | `img/invasion.png` | 文件名一致 |
| `sortie.png` | `img/sortie.png` | 文件名一致 + 视觉比对 |
| `syndicate.png` | `img/syndicate.png` | 文件名一致 |

### `skill/assets/syndicates/`

| 本地文件 | 上游对应路径（master@730ff1a9） | 核对方式 |
|---|---|---|
| `cetus.png` | `img/menu/CetusElder.png`（上游另有 `img/sigils/Ostron/CetusLevel*.png` 家族） | 文件名一致 |
| `deimos.png` | 上游未找到同名文件（相关家族：`img/menu/Entrati.png`） | 见注意事项 |
| `fortuna.png` | 上游未找到同名文件（相关家族：`img/menu/Solaris.png`、`img/sigils/Solaris United/*`、`img/sigils/Vox Solaris/*`） | 见注意事项 |
| `HexSyndicate.png` | `img/the_hex.png` | 文件名一致 |
| `ZarimanSyndicate.png` | 上游未找到同名文件（相关家族：`img/sigils/The Holdfasts/*`） | 见注意事项 |

## 注意事项（诚实边界）

1. 上表「文件名一致」仅表示名称可与上游对应、属于同一批 DE 游戏图标；本地为缩放副本，
   未对全部文件做逐字节/逐像素核对。
2. `event.png`、`incursion.png`、`deimos.png`、`fortuna.png`、`ZarimanSyndicate.png` 五个文件
   在 genesis-assets 中**未找到同名上游文件**：不把它们主张为 genesis-assets 的 Apache-2.0 覆盖范围，
   仅按 DE 游戏素材分类（DE Content Policy 非商业粉丝内容条件，见 `ASSET-LICENSES.md` §0）。
3. 图标底层美术版权归 **Digital Extremes Ltd.**：genesis-assets 是社区对 DE 素材的再分发仓库，
   Apache-2.0 覆盖其仓库打包/分发行为，不改变素材本身的 DE 版权归属；
   本仓库对 DE 素材的使用始终限于 DE Content Policy 的非商业、非官方、未获背书范围
   （<https://www.warframe.com/contentpolicy>），与 [NOTICE.md](../NOTICE.md)、
   [ASSET-LICENSES.md](../ASSET-LICENSES.md) 声明一致。
