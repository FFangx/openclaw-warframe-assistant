# 公开仓库转换：风险核对清单与维护方式

> 本文档说明把本仓库从私有/本机状态转为**公开仓库**之前必须核对的风险，以及公开后的维护方式。
> **本文件本身不执行任何转换**（不改 GitHub 设置、不推送公开、不清理历史）；转换由仓库所有者人工决策并执行。

## 0. 转换前必须人工核对的事项

公开 = 任何人均可克隆。以下每一项都可能把不该公开的东西带出去：

### 0.1 Git 历史与工作树

- [ ] `git log` 全文扫描：历史提交中不得出现 API Key、QQ openid、Market Token、AlecaFrame 解密密钥、
      个人账号标识、本机绝对路径（`C:\Users\<名字>\...`）或个人快照内容。
      若历史已含敏感信息，**不要**只靠删当前文件解决——需要改写历史（filter-repo 等），
      或保留私有并把公开仓库重新初始化（二选一，人工决策）。
- [ ] 检查未跟踪文件与 `.gitignore`：`tests/cn-reward-result.json` 这类本机测试输出不得入库；
      `work/`、`.cache/`、`.resilience-smoke-cache/` 等本地产物不得入库。
- [ ] 确认没有把 `openclaw.json`（含 `ownerOpenId`）或任何真实配置快照入库。

### 0.2 素材与截图

- [x] 内置 DE 游戏素材（货币/遗物/源力石/未开封紫卡）按 [ASSET-LICENSES.md](ASSET-LICENSES.md) 第 0 节的
      DE Content Policy 非商业、非官方、未获背书条件保留；取得渠道（AlecaFrame 应用资源）如实记录，
      不主张 AlecaFrame 授权；本轮复核未发现非 DE 素材证据，**不再列为阻塞**。
- [x] genesis-assets 派生图标（世界状态/集团徽记）：Apache-2.0 全文与来源/核对说明保留在 `LICENSES/`；
      底层美术版权 DE，按 DE 政策附注使用。
- [ ] `img/` 四张截图：**所有者接受并延后处理的已知隐私/展示风险**（画面含 DE 素材，部分可能含本机账号数据，
      如杜卡德余额）。本轮不修改 `img/`，也不作为本次公开转换的阻塞项；延后期间是否随公开仓库分发由
      所有者决策，若分发建议先人工复核画面脱敏与 DE 政策标注。

### 0.3 法律与政策

- [ ] DE 素材分发仅限**非商业粉丝内容**（DE Content Policy：<https://www.warframe.com/contentpolicy>），
      仓库不得用于任何商业化（打赏/订阅付费/出售周边等）。
- [ ] 仓库 README/NOTICE 必须保留「非官方、未获背书」声明（已内置）。
- [ ] genesis-assets 派生图标随仓库分发时保留 `LICENSES/Apache-2.0.txt` 与 `LICENSES/genesis-assets.md`（已内置）。
- [ ] WFInfo 配套版是独立 Apache-2.0 组件：公开仓库只保留安装器与哈希清单，
      不并入其二进制或源码（现状即如此，转换时不要顺手改变）。

## 1. 公开后的维护方式

- **发布**：`release.ps1`（门禁：干净工作树、`main == origin/main`、`verify.ps1 -SourceOnly`、tag 不存在）。
- **CI**：`.github/workflows/ci.yml` 在 push/PR/tag 时于 Node 20/24 跑 `verify.ps1 -SourceOnly`；
  action 固定 SHA、权限最小化；CI 零凭据、零真实账号接触。
- **依赖更新**：Dependabot 每周检查 `skill/` npm 依赖与 GitHub Actions（见 `.github/dependabot.yml`）；
  合并 PR 前必须重跑 `verify.ps1 -SourceOnly`。
- **安全**：启用 GitHub 私有漏洞报告（Security → Private vulnerability reporting）后，
  报告入口在 [SECURITY.md](SECURITY.md)；未启用前维护者应在 issue 中引导走该流程。
- **issue/PR**：模板见 `.github/ISSUE_TEMPLATE/` 与 `.github/PULL_REQUEST_TEMPLATE.md`；
  个人项目无 SLA，响应不保证时限（[SUPPORT.md](SUPPORT.md)）。
- **素材变更**：新增任何图片/图标前先读 [ASSET-LICENSES.md](ASSET-LICENSES.md)；
  来源无法证实的素材一律不入库（改运行时下载）。

## 2. 转换执行清单（由所有者执行，本文件不代执行）

1. 完成 §0 全部核对项；
2. 决定敏感历史的处理方式（改写/重新初始化）；
3. 在 GitHub 设置里把仓库改为 public（或推送到新的公开仓库）；
4. 确认仓库 Settings → Security 已开启 private vulnerability reporting；
5. 在 README 顶部去掉「私有」相关措辞（如有），重新跑一遍 `verify.ps1 -SourceOnly`。

## 3. 修订记录

- 2026-08-21：创建本文档（与 ASSET-LICENSES.md 同批的发布准备）。
- 2026-08-21（Codex 复核后修订）：内置 DE 游戏素材（货币/遗物/源力石/未开封紫卡）按 DE Content Policy
  非商业条件保留、不再因 AlecaFrame 渠道阻塞；genesis-assets 派生图标补充 `LICENSES/` 全文保留；
  `img/` 改记为所有者接受并延后处理的已知风险（不构成本次转换阻塞）。
