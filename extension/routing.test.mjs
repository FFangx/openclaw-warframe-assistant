import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMMAND_REGISTRY, isPersonalAccountCommand, isShortcut, isSubscriptionCommand, isWeeklyCommand } from './routing.mjs';

async function readInstalledOrSourceSkill() {
  const candidates = [
    new URL('../skill/SKILL.md', import.meta.url),
    new URL('../../../skills/warframe-assistant/SKILL.md', import.meta.url),
  ];
  for (const candidate of candidates) {
    try { return await readFile(candidate, 'utf8'); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('SKILL.md was not found in the source or managed-runtime layout');
}

async function readInstalledOrSourceDispatch() {
  const candidates = [
    new URL('../skill/scripts/dispatch.mjs', import.meta.url),
    new URL('../../../skills/warframe-assistant/scripts/dispatch.mjs', import.meta.url),
  ];
  for (const candidate of candidates) {
    try { return await readFile(candidate, 'utf8'); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('dispatch.mjs was not found in the source or managed-runtime layout');
}

test('plugin entry imports every routing helper it calls', async () => {
  const [entry, routing] = await Promise.all([
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    readFile(new URL('./routing.mjs', import.meta.url), 'utf8'),
  ]);
  const importClause = entry.match(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/routing\.mjs['"]/u)?.[1] || '';
  const imported = new Set(importClause.split(',').map((name) => name.trim()).filter(Boolean));
  const exportedHelpers = [...routing.matchAll(/export\s+function\s+(\w+)\s*\(/gu)].map((match) => match[1]);
  const missing = exportedHelpers.filter((name) => new RegExp(`\\b${name}\\s*\\(`, 'u').test(entry) && !imported.has(name));
  assert.deepEqual(missing, []);
});

test('订阅 cron 使用脚本直投 QQ 原图并关闭 runner announce 压缩链路', async () => {
  const entry = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(entry, /subscriptionScript, 'deliver'/u);
  assert.match(entry, /'--no-deliver'/u);
  const subscriptionBlock = entry.slice(entry.indexOf('async function ensureSubscriptionCron'), entry.indexOf('async function removeSubscriptionCron'));
  assert.doesNotMatch(subscriptionBlock, /'--announce'/u);
  assert.match(subscriptionBlock, /'--timeout-seconds', '120'/u);
});

test('愿望裸入口与两条模型工具路径只保留共享用例编排', async () => {
  const [entry, dispatch] = await Promise.all([
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    readInstalledOrSourceDispatch(),
  ]);
  assert.match(entry, /import \{ executeWishlistUseCase, wishlistNeedsImmediateInspection \} from '\.\/wishlist-usecase\.mjs'/u);
  assert.match(entry, /source:\s*`tool-\$\{operation\}`/u);
  assert.match(entry, /runWishlistIngressUseCase\(api, ingressEvent, ctx, 'before_dispatch'\)/u);
  assert.match(entry, /runWishlistIngressUseCase\(api, event, event, 'inbound_claim'\)/u);
  assert.match(entry, /runWishlistIngressUseCase\(api, ingressEvent, ctx, 'before_agent_reply'\)/u);
  assert.equal((entry.match(/return runWishlistToolUseCase\(query, operation\)/gu) || []).length, 2,
    'operation=command 与兼容 operation=subscription 必须共用同一愿望用例');
  assert.doesNotMatch(entry, /wishlistNeedsImmediateCalibration/u);
  assert.doesNotMatch(entry, /async function executeWishlistTool/u);
  assert.doesNotMatch(dispatch, /manageWishlist/u);
  assert.match(dispatch, /当前入口不会修改愿望单/u);
});

test('strict documented commands stay on the deterministic fast path', () => {
  for (const input of [
    'wm 高压电流', '遗物 Axi A22', '获取 Caliban p', '普通裂缝', '赏金 尖刃弹头', '购买 诡文枭主',
    '我的库存 延几草', '我的遗物 A22', '我的紫卡 伯斯顿', '周报', '完成 深层科研',
    '仲裁', '警报', '入侵', '活动', '虚空商人', '突击', '钢铁侵袭',
  ]) assert.equal(isShortcut(input), true, input);
  assert.equal(isSubscriptionCommand('订阅 赏金 尖刃弹头'), true);
});

test('natural language and contextual follow-ups reach the model tool router', () => {
  for (const input of [
    '我有多少延几草、瑶丛',
    '我有这些遗物吗',
    '毒囊双枪灵化需要什么材料，去哪里拿',
    '诡文枭主在哪里买', '哪里买 诡文枭主',
    '诡文枭主在哪换', '在哪换 诡文枭主', '诡文枭主哪里换', '哪里换 诡文枭主',
    '怎么买 诡文枭主', '诡文枭主怎么买', '去哪买 诡文枭主',
    'Caliban p哪里刷', '哪里刷 Caliban p', '怎么刷 Caliban p', '获取路线 Caliban p',
    '这周还有哪些没做',
    '帮我订阅一下尖刃弹头赏金',
    '奸商这周有什么值得买的',
    '现在有什么好裂缝，按我的库存推荐一下',
  ]) {
    assert.equal(isShortcut(input), false, input);
    assert.equal(isSubscriptionCommand(input), false, input);
  }
});

test('口语获取问法不得被快捷入口截获：四个语族均放行给自然语言路由', () => {
  // 快捷硬拦截只认正式的「获取」「购买」前缀，口语问法一律是自然语言
  for (const input of ['获取 Caliban p', '购买 诡文枭主']) assert.equal(isShortcut(input), true, input);
  for (const input of [
    '哪里刷', '哪里刷 Caliban p', 'Caliban p哪里刷', '怎么刷', '怎么刷 Caliban p', 'Caliban p怎么刷',
    '哪里买', '哪里买 诡文枭主', '诡文枭主哪里买', '在哪换', '在哪换 诡文枭主', '诡文枭主在哪换',
  ]) {
    assert.equal(isShortcut(input), false, input);
    assert.equal(isSubscriptionCommand(input), false, input);
  }
});

test('SKILL.md 与插件工具说明把口语获取问法规范到正式短命令', async () => {
  const [entry, skill] = await Promise.all([
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    readInstalledOrSourceSkill(),
  ]);
  // SKILL.md：口语问法必须作为自然语言理解，规范为获取/购买，不得由快捷入口截获
  assert.match(skill, /获取`、`购买`是正式短命令/u);
  assert.match(skill, /哪里刷|怎么刷|哪里买|在哪换/u);
  assert.match(skill, /规范为`获取 X`、`购买 X`调用工具/u);
  assert.match(skill, /不能由快捷入口直接截获/u);
  // 插件工具描述：模型收到口语问法时改写为获取/购买规范命令
  assert.match(entry, /哪里刷|怎么刷|哪里买|在哪换/u);
  assert.match(entry, /改写为获取\/购买规范命令/u);
});

test('扩展路由从唯一注册表加载，且用户可见权限口径统一', async () => {
  const routing = await readFile(new URL('./routing.mjs', import.meta.url), 'utf8');
  const entry = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.ok(COMMAND_REGISTRY.some((item) => item.commandId === 'weekly'));
  assert.equal(isShortcut('周报'), true);
  assert.equal(isWeeklyCommand('完成 1 3'), true);
  assert.equal(isPersonalAccountCommand('我的库存 延几草'), true);
  assert.equal(isPersonalAccountCommand('我有这些遗物吗'), false);
  assert.match(entry, /if \(isWeeklyCommand\(event\.content\)\)/u);
  assert.match(entry, /周常数据只允许用户本人/u);
  assert.match(entry, /if \(isWeeklyCommand\(query\) && !personalAllowed\)/u);
  assert.doesNotMatch(entry, /周常\|当前周常\|周常清单/u);
  assert.match(routing, /createRequire\(import\.meta\.url\)\(registryPath\)/u);
  assert.doesNotMatch(routing, /await\s+import/u);
});

test('工具命令说明由注册表生成，不再手工复制命令清单', async () => {
  const entry = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  assert.match(entry, /commandToolSummary\(\)/u);
  assert.doesNotMatch(entry, /愿望 商品 价格、愿望单、已购\/改价\/暂停\/继续\/取消 短编号，以及 wm 物品/u);
});

test('plugin context bridge keys isolate group senders and authorized private chat', async () => {
  const entry = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
  // contextBridgeKey 把会话与发送者都编进 key：群聊按发送者隔离，私聊与群聊互不可见
  assert.match(entry, /\$\{session\}\|\$\{sender \|\| session\}/u);
  // 群聊缺少发送者时不落上下文；私聊与群聊会话不同 → key 不同 → 天然隔离
  assert.match(entry, /if \(!session \|\| \(group && !sender\)\) return null;/u);
  // 个人域信封只在确认用户私聊时入桥（群聊即使同发送者也不入桥）
  assert.match(entry, /envelope\.scope === 'personal' && !personalAllowed/u);
});
