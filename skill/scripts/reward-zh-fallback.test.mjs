import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// 隔离缓存目录：模块在 import 时解析 WARFRAME_DATA_CACHE_DIR，必须先设再动态导入
const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'reward-zh-fallback-'));
process.env.WARFRAME_DATA_CACHE_DIR = cacheDir;
const { applyRewardAliases, getLearnedRewardTranslations, learnReward, learnRewardVerified, mergeLearnedRewards, queuePendingReward, readPendingRewards, removePendingReward, clearPendingRewards, flushRewardQueues } = await import('./reward-zh-fallback.mjs');
const { translateRewardName } = await import('./subscriptions.mjs');

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('./reward-zh-fallback.mjs', import.meta.url));
const cliEnv = { ...process.env, WARFRAME_DATA_CACHE_DIR: cacheDir };
async function runCli(...args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { env: cliEnv, encoding: 'utf8' });
    return { exitCode: 0, result: JSON.parse(stdout) };
  } catch (error) {
    return { exitCode: error.code, result: JSON.parse(String(error.stdout || '')) };
  }
}
const inboxFile = path.join(cacheDir, 'reward-zh-inbox.json');
const learnFile = path.join(cacheDir, 'reward-zh-fallback.json');

test.after(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

test('别名归一：Grineer Combat Knife → Sheev（灰机wiki 口径）', () => {
  assert.equal(applyRewardAliases('grineer combat knife heatsink'), 'sheev heatsink');
  assert.equal(applyRewardAliases('  Grineer   Combat Knife '), 'sheev');
  assert.equal(applyRewardAliases('strun wraith stock'), 'strun wraith stock');
});

test('别名归一：希芙蓝图配方尾段去掉 Sortie 路径词', () => {
  assert.equal(applyRewardAliases('grineer combat knife sortie blueprint'), 'sheev blueprint');
  assert.equal(applyRewardAliases('sheev sortie blueprint'), 'sheev blueprint');
  assert.equal(applyRewardAliases('sheev blueprint'), 'sheev blueprint');
});

test('世界状态压缩尾段 + 别名 + 词典整词命中', () => {
  const dict = new Map([['sheev heatsink', '希芙散热片']]);
  assert.equal(translateRewardName('GrineerCombatKnifeHeatsink', dict), '希芙散热片');
  // 2026-08-19 火卫一 Gulliver 入侵实拍：希芙蓝图配方尾段带 Sortie 路径词，归一后整词命中 Market
  const blueprintDict = new Map([['sheev blueprint', '希芙 蓝图']]);
  assert.equal(translateRewardName('GrineerCombatKnifeSortieBlueprint', blueprintDict), '希芙 蓝图');
});

test('无词典时别名+组件词元兜底，不落未收录奖励', () => {
  assert.equal(translateRewardName('GrineerCombatKnifeHeatsink', new Map()), '希芙 散热片');
  assert.equal(translateRewardName('GrineerCombatKnifeBlade', new Map()), '希芙 刀刃');
  assert.equal(translateRewardName('GrineerCombatKnifeSortieBlueprint', new Map()), '希芙 蓝图');
});

test('组合译名会写入学习词典并可供整词直达', async () => {
  assert.equal(translateRewardName('TwinVipersBarrel', new Map()), '双子蝰蛇 枪管');
  await learnReward('twin vipers barrel', '双子蝰蛇 枪管'); // 等持久化队列落盘
  const learned = await getLearnedRewardTranslations();
  assert.equal(learned.get('twin vipers barrel'), '双子蝰蛇 枪管');
  // 整词直达：词典里已有学习条目时优先命中
  assert.equal(translateRewardName('TwinVipersBarrel', new Map()), '双子蝰蛇 枪管');
});

test('学习词典只补缺、不覆盖已有译名', async () => {
  const target = new Map([['sheev heatsink', 'Market版译名']]);
  const added = await mergeLearnedRewards(target);
  assert.ok(added >= 0);
  assert.equal(target.get('sheev heatsink'), 'Market版译名');
});

test('真正未知的奖励保持诚实占位', () => {
  assert.equal(translateRewardName('TotallyUnknownXyzThing', new Map()), '未收录奖励');
});

test('既有拆词回归：StrunWraithStock 仍整词命中', () => {
  const dict = new Map([['strun wraith stock', '斯特朗亡魂枪托']]);
  assert.equal(translateRewardName('StrunWraithStock', dict), '斯特朗亡魂枪托');
});

test('未知奖励进 inbox：去重累计、中文不入队、learn 同键回填并出队', async () => {
  await clearPendingRewards();
  await queuePendingReward('Grineer Combat Knife Sortie Blueprint');
  await queuePendingReward('  GRINEER Combat Knife Sortie Blueprint ');
  await queuePendingReward('电磁力场装置'); // 纯中文不入队
  let pending = await readPendingRewards();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].english, 'grineer combat knife sortie blueprint');
  assert.equal(pending[0].count, 2);
  assert.ok(pending[0].firstAt <= pending[0].lastAt);
  // learn 回填：按 inbox 同键写词典 + 出 inbox；重复 learn 幂等
  const first = await learnRewardVerified('grineer combat knife sortie blueprint', '希芙 蓝图', '灰机wiki');
  assert.equal(first.ok, true);
  assert.equal(first.removedFromInbox, true);
  // 学习文件落盘校验（词典缓存模块级，直接读文件验证）
  const { readFile } = await import('node:fs/promises');
  const learnFile = path.join(cacheDir, 'reward-zh-fallback.json');
  const stored = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(stored.entries['grineer combat knife sortie blueprint'].zh, '希芙 蓝图');
  assert.equal(stored.entries['grineer combat knife sortie blueprint'].source, '灰机wiki');
  // 词典里已有该键后，翻译链路直接命中，不再落占位
  assert.equal(translateRewardName('GrineerCombatKnifeSortieBlueprint', new Map()), '希芙 蓝图');
  pending = await readPendingRewards();
  assert.equal(pending.length, 0);
  const second = await learnRewardVerified('grineer combat knife sortie blueprint', '希芙 蓝图', '灰机wiki');
  assert.equal(second.ok, true);
  assert.equal(second.removedFromInbox, false); // 已不在 inbox，静默幂等
  await flushRewardQueues();
});

test('learn 回填拒绝夹带英文的译名，dismiss 干净出队', async () => {
  await clearPendingRewards();
  await queuePendingReward('Totally Unknown Xyz Thing');
  const rejected = await learnRewardVerified('totally unknown xyz thing', 'Totally 未知', '灰机wiki');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /纯中文/);
  assert.equal((await readPendingRewards()).length, 1);
  assert.equal(await removePendingReward('totally unknown xyz thing'), true);
  assert.equal((await readPendingRewards()).length, 0);
  assert.equal(await removePendingReward('totally unknown xyz thing'), false);
  await flushRewardQueues();
});

test('100 项上限：满员且是新名时挤掉最久未见的一条', async () => {
  await clearPendingRewards();
  const items = {};
  for (let index = 0; index < 100; index += 1) {
    const key = `cap item ${String(index).padStart(2, '0')}`;
    items[key] = { firstAt: 1_000_000 + index * 1000, lastAt: 1_000_000 + index * 1000, count: 1 };
  }
  await writeFile(inboxFile, JSON.stringify({ version: 1, items }), 'utf8');
  await queuePendingReward('Brand New Cap Item');
  let pending = await readPendingRewards();
  assert.equal(pending.length, 100);
  assert.ok(pending.some((item) => item.english === 'brand new cap item'));
  assert.ok(!pending.some((item) => item.english === 'cap item 00'), '最久未见的一条应被挤出');
  // 已有键重复出现不挤占名额，只累计计数
  await queuePendingReward('cap item 50');
  pending = await readPendingRewards();
  assert.equal(pending.length, 100);
  assert.equal(pending.find((item) => item.english === 'cap item 50').count, 2);
  await clearPendingRewards();
});

test('并发入队：Promise.all 去重累计、落盘文件始终是合法 JSON（原子持久化）', async () => {
  await clearPendingRewards();
  const tasks = [];
  for (let index = 0; index < 40; index += 1) tasks.push(queuePendingReward('Dup Concurrency Key'));
  for (let index = 0; index < 60; index += 1) tasks.push(queuePendingReward(`Unique Key ${index}`));
  await Promise.all(tasks);
  await flushRewardQueues();
  const pending = await readPendingRewards();
  assert.equal(pending.length, 61);
  assert.equal(pending.find((item) => item.english === 'dup concurrency key').count, 40);
  // 直接重读文件：结构完整、无残留临时文件
  const { readFile, readdir } = await import('node:fs/promises');
  const stored = JSON.parse(await readFile(inboxFile, 'utf8'));
  assert.equal(Object.keys(stored.items).length, 61);
  const leftovers = (await readdir(cacheDir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  await clearPendingRewards();
});

test('先入队后 dismiss 串行化：排队中的写入不会复活已出队条目', async () => {
  await clearPendingRewards();
  const queued = queuePendingReward('Race Condition Key'); // 不 await，让它排队
  const removed = await removePendingReward('race condition key'); // 紧随其后的出队
  await Promise.all([queued, removed]);
  await flushRewardQueues();
  const pending = await readPendingRewards();
  assert.ok(!pending.some((item) => item.english === 'race condition key'), 'dismiss 后条目不得被排队中的入队写回复活');
  assert.equal(removed, true);
  await clearPendingRewards();
});

test('学习词典种子不可被 learn 覆盖，也不落盘种子键', async () => {
  await learnReward('sheev', '希芙（篡改）'); // 种子键拒绝写入
  await learnReward('sheev heatsink', '希芙散热片（篡改）');
  await flushRewardQueues();
  const learned = await getLearnedRewardTranslations();
  assert.equal(learned.get('sheev'), '希芙');
  assert.equal(learned.get('sheev heatsink'), '希芙散热片');
  const { readFile } = await import('node:fs/promises');
  const stored = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(stored.entries['sheev'], undefined);
  assert.equal(stored.entries['sheev heatsink'], undefined);
});

test('学习词典只补缺：Market/官方已有译名不被覆盖（含翻译链路整词命中）', async () => {
  const dict = new Map([['sheev heatsink', 'Market版译名']]);
  await mergeLearnedRewards(dict);
  assert.equal(dict.get('sheev heatsink'), 'Market版译名');
  assert.equal(translateRewardName('GrineerCombatKnifeHeatsink', dict), 'Market版译名');
  // 学习条目只出现在 Market/官方都没有的键上
  const gap = new Map();
  await mergeLearnedRewards(gap);
  assert.equal(gap.get('sheev blueprint'), '希芙蓝图');
  assert.equal(translateRewardName('GrineerCombatKnifeSortieBlueprint', gap), '希芙蓝图');
});

test('CLI 闭环：inbox→learn→词典命中→出队，inbox→dismiss→出队（合成 fixture 子进程）', async () => {
  await clearPendingRewards();
  await writeFile(inboxFile, JSON.stringify({ version: 1, items: {
    'fixture learn key': { firstAt: 1, lastAt: 2, count: 3 },
    'fixture dismiss key': { firstAt: 1, lastAt: 3, count: 1 },
  } }), 'utf8');
  // inbox 列出两条
  const listed = await runCli('inbox');
  assert.equal(listed.exitCode, 0);
  assert.equal(listed.result.ok, true);
  assert.equal(listed.result.count, 2);
  assert.deepEqual(listed.result.items.map((item) => item.english).sort(), ['fixture dismiss key', 'fixture learn key']);
  // learn 回填 + 出队
  const learned = await runCli('learn', '--english', 'fixture learn key', '--zh', '合成测试译名', '--source', '灰机wiki');
  assert.equal(learned.exitCode, 0);
  assert.equal(learned.result.ok, true);
  assert.equal(learned.result.removedFromInbox, true);
  // 词典命中：学习文件里能整词查到，翻译链路直接命中（不再落占位）
  const { readFile } = await import('node:fs/promises');
  const stored = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(stored.entries['fixture learn key'].zh, '合成测试译名');
  const freshDict = new Map(Object.entries(stored.entries).map(([english, entry]) => [english, entry.zh]));
  assert.equal(translateRewardName('FixtureLearnKey', freshDict), '合成测试译名');
  // dismiss 出队
  const dismissed = await runCli('dismiss', '--english', 'fixture dismiss key', '--reason', '查无实据');
  assert.equal(dismissed.exitCode, 0);
  assert.equal(dismissed.result.ok, true);
  assert.equal(dismissed.result.removed, true);
  // inbox 清空
  const empty = await runCli('inbox');
  assert.equal(empty.result.count, 0);
  assert.deepEqual(empty.result.items, []);
  // learn 拒绝夹带英文的译名：CLI 退出码 1 且不写词典
  const rejected = await runCli('learn', '--english', 'fixture learn key', '--zh', 'Bad English 译名');
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.result.ok, false);
  assert.match(rejected.result.error, /纯中文/);
  const afterReject = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(afterReject.entries['fixture learn key'].zh, '合成测试译名');
  // learn 对不在 inbox 的键仍幂等成功（回填词典、removedFromInbox=false）
  const idle = await runCli('learn', '--english', 'fixture dismiss key', '--zh', '无据占位名');
  assert.equal(idle.exitCode, 0);
  assert.equal(idle.result.ok, true);
  assert.equal(idle.result.removedFromInbox, false);
  await clearPendingRewards();
});

// ————————————————————————————————————————————————
// 合成故障注入：修复 Codex 复核发现的「静默吞持久化失败仍出队」。
// 合同：learnRewardVerified / CLI learn 只有在确认「词典（含种子）已存在同键同译名」
// （outcome=exists-same）或「本次原子落盘成功」（outcome=written）后才出 inbox；
// 写入失败 / conflict / seed 一律 ok:false 且 inbox 条目保留未出队。
// ————————————————————————————————————————————————

test('合成故障注入：学习词典原子落盘失败时 learn 不出队、热路径 learnReward 静默', async () => {
  await clearPendingRewards();
  await queuePendingReward('Fault Injected Key');
  await flushRewardQueues();
  assert.equal((await readPendingRewards()).length, 1);
  const { mkdir, readFile, readdir, rm } = await import('node:fs/promises');
  // 用「词典文件路径被同名目录占用」制造原子落盘失败：writeFile 临时文件成功，
  // rename 到目录必然抛错 → persistLearnedEntryInner 抛出 → learnRewardVerified 报错不出队
  await rm(learnFile, { force: true });
  await mkdir(learnFile, { recursive: true });
  const outcome = await learnRewardVerified('fault injected key', '故障注入译名');
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /写入失败/);
  // inbox 条目原样保留：绝不先出队后写
  let pending = await readPendingRewards();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].english, 'fault injected key');
  // 热路径 learnReward 仍静默吞错、不 reject、不影响主流程
  await learnReward('fault injected key', '故障注入译名');
  await flushRewardQueues();
  pending = await readPendingRewards();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].english, 'fault injected key');
  // 无残留临时文件（atomicWriteJson 的失败清理）
  const leftovers = (await readdir(cacheDir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  // 恢复现场：移除占位目录后同一键可正常学习并出队
  await rm(learnFile, { recursive: true, force: true });
  const recovered = await learnRewardVerified('fault injected key', '故障注入译名');
  assert.equal(recovered.ok, true);
  assert.equal(recovered.outcome, 'written');
  assert.equal(recovered.removedFromInbox, true);
  pending = await readPendingRewards();
  assert.equal(pending.length, 0);
  const stored = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(stored.entries['fault injected key'].zh, '故障注入译名');
  await clearPendingRewards();
});

test('合成故障注入：词典已有同键同译名时 learn 幂等确认并出队（不重写词典）', async () => {
  await clearPendingRewards();
  // 先经热路径写入条目，记录落盘时间戳
  await learnReward('idempotent confirm key', '幂等确认译名');
  await flushRewardQueues();
  const { readFile } = await import('node:fs/promises');
  const before = JSON.parse(await readFile(learnFile, 'utf8')).entries['idempotent confirm key'];
  // inbox 里出现同键 → verified learn 必须幂等确认并出队
  await queuePendingReward('Idempotent Confirm Key');
  await flushRewardQueues();
  const first = await learnRewardVerified('idempotent confirm key', '幂等确认译名');
  assert.equal(first.ok, true);
  assert.equal(first.outcome, 'exists-same');
  assert.equal(first.removedFromInbox, true);
  assert.equal((await readPendingRewards()).length, 0);
  // 词典未被重写：条目 at 时间戳保持不变（幂等不写盘）
  const after = JSON.parse(await readFile(learnFile, 'utf8')).entries['idempotent confirm key'];
  assert.equal(after.at, before.at);
  // 不在 inbox 时同键同译名依旧幂等成功
  const second = await learnRewardVerified('idempotent confirm key', '幂等确认译名');
  assert.equal(second.ok, true);
  assert.equal(second.outcome, 'exists-same');
  assert.equal(second.removedFromInbox, false);
  await clearPendingRewards();
});

test('合成故障注入：词典已有同键不同译名时 learn 拒绝覆盖、inbox 保留（安全处置合同）', async () => {
  await clearPendingRewards();
  await learnReward('conflict key', '既有译名');
  await flushRewardQueues();
  await queuePendingReward('Conflict Key');
  await flushRewardQueues();
  const outcome = await learnRewardVerified('conflict key', '新来译名');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.outcome, 'conflict');
  assert.equal(outcome.existingZh, '既有译名');
  assert.match(outcome.error, /已有同键不同译名/);
  assert.match(outcome.error, /dismiss/);
  assert.equal(outcome.removedFromInbox, false);
  // inbox 条目原样保留
  let pending = await readPendingRewards();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].english, 'conflict key');
  // 词典条目未被覆盖
  const { readFile } = await import('node:fs/promises');
  const stored = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(stored.entries['conflict key'].zh, '既有译名');
  // 安全处置合同：现有译名有据 → dismiss 出队
  assert.equal(await removePendingReward('conflict key'), true);
  assert.equal((await readPendingRewards()).length, 0);
  await clearPendingRewards();
});

test('合成故障注入：种子权威键同译名可幂等出队、不同译名不可覆盖且 inbox 保留', async () => {
  await clearPendingRewards();
  await queuePendingReward('Sheev');
  await flushRewardQueues();
  // 同译名：种子已权威提供，幂等确认并出队（不写盘）
  const same = await learnRewardVerified('sheev', '希芙');
  assert.equal(same.ok, true);
  assert.equal(same.outcome, 'exists-same');
  assert.equal(same.removedFromInbox, true);
  assert.equal((await readPendingRewards()).length, 0);
  // 不同译名：种子权威键不可覆盖，inbox 条目保留
  await queuePendingReward('Sheev');
  await flushRewardQueues();
  const clash = await learnRewardVerified('sheev', '希芙（篡改）');
  assert.equal(clash.ok, false);
  assert.equal(clash.outcome, 'seed');
  assert.equal(clash.existingZh, '希芙');
  assert.match(clash.error, /种子权威/);
  assert.equal(clash.removedFromInbox, false);
  let pending = await readPendingRewards();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].english, 'sheev');
  // 词典文件从未落盘种子键（种子只在内存合并）
  const { readFile } = await import('node:fs/promises');
  let stored = { entries: {} };
  try { stored = JSON.parse(await readFile(learnFile, 'utf8')); } catch { /* 文件可能尚不存在 */ }
  assert.equal(stored.entries['sheev'], undefined);
  // 安全处置合同：同一物品按 dismiss 出队
  assert.equal(await removePendingReward('sheev'), true);
  assert.equal((await readPendingRewards()).length, 0);
  await clearPendingRewards();
});

test('CLI learn 对种子权威键返回 ok:false 退出码 1 且 inbox 保留（agent 侧合同）', async () => {
  await clearPendingRewards();
  await queuePendingReward('Sheev');
  await flushRewardQueues();
  const clash = await runCli('learn', '--english', 'sheev', '--zh', '希芙（篡改）');
  assert.equal(clash.exitCode, 1);
  assert.equal(clash.result.ok, false);
  assert.equal(clash.result.outcome, 'seed');
  assert.match(clash.result.error, /种子权威/);
  const pending = await readPendingRewards();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].english, 'sheev');
  // 安全处置：同一物品 dismiss 出队
  const dismissed = await runCli('dismiss', '--english', 'sheev', '--reason', '种子权威条目已覆盖');
  assert.equal(dismissed.exitCode, 0);
  assert.equal(dismissed.result.removed, true);
  assert.equal((await readPendingRewards()).length, 0);
  await clearPendingRewards();
});
