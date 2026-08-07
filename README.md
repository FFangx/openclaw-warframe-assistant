# OpenClaw Warframe 助手

Warframe 国际服 QQ 机器人助手，跑在 [OpenClaw](https://openclaw.ai) 上：短命令秒出图片卡，自然语言由 AI 路由到确定性脚本，数据不经模型编造。

## 能干什么

- **查价**：`wm 悟空p`、`wm 赋能充沛 满级`——warframe.market 实时卖单/买单、90 天成交中位、游戏私聊模板
- **遗物**：`遗物 前x1` 正查六奖励价格与精炼期望；`遗物 战刃` 反查哪个遗物出
- **世界状态**：裂缝（组合筛选）、仲裁（场地评级+预告）、警报、入侵、突击、钢铁侵袭、赏金（三开放世界+三挑战板）、虚空商人
- **订阅推送**：十三类事件按边界蹲守去重推送（裂缝/仲裁好场/警报/虚空商人/掉落/周常……），不轰炸
- **周常一图流**：11 项周常清单 + AlecaFrame 快照**自动打卡** + 回廊奖励轨道 + 电波赛季进度与满级预测
- **个人数据**（需 [AlecaFrame](https://alecaframe.com)）：库存估值五分类、掉落监测推送、紫卡数值复算与行情估价、裂缝/精炼/奸商购物推荐、商店已购对账、本周好货
- **自然语言**：「悟空p多少钱」「奸商来了吗」「这周还剩啥没做」——AI 只做意图路由和一两句点评，数字全部来自脚本

所有回答生成 600~800px 深色图片卡，官方中文译名，货币带游戏图标。

## 架构一句话

```
QQ 消息 → OpenClaw 插件（短命令硬拦截，不经模型）→ 脚本直出图
        ↘ 自然语言 → AI 按五级决策树路由 → dispatch.mjs / lookup.mjs → 同一批脚本
```

- `skill/`：22 个 Node 脚本（零 npm 强依赖，`sharp` 可选）+ SKILL.md（AI 行为契约）+ 素材
- `extension/`：OpenClaw 插件（`before_dispatch` 硬拦截 + 两段式注入）

数据源：api.warframestat.us、api.warframe.market v2、browse.wf（官方导出）、DE 官方 worldState、AlecaFrame 本机快照（只读）。详见 [NOTICE.md](NOTICE.md)。

## 快速开始

前置门槛请先读 [INSTALL.md](INSTALL.md)——**QQ 官方机器人申请是整个链路里最麻烦的一步**，不是本项目能简化的。

```bash
# 装好后自检环境，输出功能矩阵
node skill/scripts/doctor.mjs
```

## 三条实话（装之前必读）

1. **红线依赖模型自觉**：本项目禁止一切市场写操作与游戏自动化（见 SKILL.md「明确不做」）。实测**低思考档位的模型会钻规则字面空子**（曾在测试中写出自动挂单工具并反手删改规则文件）。请给主力模型开高思考档位（如 `thinking=high`），并定期检查规则文件没被改动。
2. **Windows 优先**：AlecaFrame 只有 Windows 版；不装它时个人功能全部不可用，公开查询功能正常（词典自动走在线兜底）。Linux/Mac 未测试。
3. **只读承诺**：不读游戏内存、不注入、不操作游戏进程；只读 AlecaFrame 落盘文件与公开 API。不碰 warframe.market 登录令牌。使用风险自负，与 Digital Extremes 无关。

## 文档

| 文档 | 内容 |
|---|---|
| [INSTALL.md](INSTALL.md) | 安装步骤与前置门槛 |
| [CONFIG.md](CONFIG.md) | 配置项（必填 1 项 + 可选环境变量） |
| [FAQ.md](FAQ.md) | 常见问题 |
| [NOTICE.md](NOTICE.md) | 数据源与素材归属 |
| skill/references/capabilities.md | 全部能力的完整行为说明与降级矩阵 |

## License

代码 MIT（见 [LICENSE](LICENSE)）。游戏素材版权归 Digital Extremes，社区数据源归属见 [NOTICE.md](NOTICE.md)。
