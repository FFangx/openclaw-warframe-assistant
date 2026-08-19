import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 隔离缓存目录：模块在 import 时解析 WARFRAME_DATA_CACHE_DIR，必须先设再动态导入
const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'reward-zh-fallback-'));
process.env.WARFRAME_DATA_CACHE_DIR = cacheDir;
const { applyRewardAliases, getLearnedRewardTranslations, learnReward, learnRewardVerified, mergeLearnedRewards, queuePendingReward, readPendingRewards, removePendingReward, clearPendingRewards, flushRewardQueues } = await import('./reward-zh-fallback.mjs');
const { translateRewardName } = await import('./subscriptions.mjs');

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
