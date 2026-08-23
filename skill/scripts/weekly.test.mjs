import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { archimedeaResearchProgress, calendarChallengeLine, calendarRewardZh, calendarUpgradeZh, evaluateAutoCheck, hasCompleteArchimedeas, localizeArchimedeaModifier, nextReset, nightwaveChallengeZh, remindWeekly, weekStart } from './weekly.mjs';
import { labsSection } from './weekly-mega-card.mjs';

const calendarDays = [
  { events: [{ type: 'To Do' }] },
  { events: [{ type: 'Big Prize!' }] },
  { events: [] },
  { events: [{ type: 'Override' }] },
];

function fixture({ lastIdx = 3, season = 'CST_SPRING', iteration = 21 } = {}) {
  return {
    inventory: {
      CalendarProgress: {
        Iteration: iteration,
        SeasonProgress: { SeasonType: season, LastCompletedDayIdx: lastIdx },
      },
    },
    worldState: {
      calendar: { season: 'Spring', yearIteration: 21, days: calendarDays },
    },
  };
}

test('1999 日历完成指针到达本期最后有效节点时自动核销', () => {
  const { inventory, worldState } = fixture();
  const result = evaluateAutoCheck(inventory, worldState);
  assert.equal(result.progress['calendar-1999'], '已推进 3/3 节点');
  assert.equal(result.auto['calendar-1999'], true);
});

test('1999 日历尚有有效节点未完成时不自动核销', () => {
  const { inventory, worldState } = fixture({ lastIdx: 1 });
  const result = evaluateAutoCheck(inventory, worldState);
  assert.equal(result.progress['calendar-1999'], '已推进 2/3 节点');
  assert.equal(result.auto['calendar-1999'], undefined);
});

test('1999 日历季节不一致时拒绝使用陈旧快照', () => {
  const { inventory, worldState } = fixture({ season: 'CST_WINTER' });
  const result = evaluateAutoCheck(inventory, worldState);
  assert.equal(result.progress['calendar-1999'], undefined);
  assert.equal(result.auto['calendar-1999'], undefined);
});

test('1999 日历轮次不一致时拒绝使用陈旧快照', () => {
  const { inventory, worldState } = fixture({ iteration: 20 });
  const result = evaluateAutoCheck(inventory, worldState);
  assert.equal(result.progress['calendar-1999'], undefined);
  assert.equal(result.auto['calendar-1999'], undefined);
});

function conquestFixture({ now = Date.UTC(2026, 7, 12, 4), score = 21, tokens = null, resetAt = null } = {}) {
  const inventory = { EntratiLabConquestUnlocked: 1, EntratiLabConquestCacheScoreMission: score };
  if (tokens) inventory.EchoesHexConquestBonusTokensGiven = tokens;
  if (resetAt != null) inventory.EntratiVaultCountResetDate = { $date: { $numberLong: String(resetAt) } };
  const previousWeek = weekStart(new Date(now - 7 * 86400000));
  const syncedAt = new Date(now - 60_000).toISOString();
  return {
    now,
    syncedAt,
    inventory,
    previousWeek,
    samples: (extra = {}) => [{ kind: 'EntratiLab', weekStart: previousWeek, score: extra.score ?? score, tokens: extra.tokens ?? null, syncedAt, at: new Date(now - 86400000).toISOString() }],
  };
}

test('深层科研 21 点 + 分数较上周变化时自动核销', () => {
  const { now, syncedAt, inventory, samples } = conquestFixture({ score: 21 });
  const result = evaluateAutoCheck(inventory, null, now, null, syncedAt, { conquestSamples: samples({ score: 18 }) });
  assert.equal(result.auto['deep-archimedea'], true);
  assert.match(result.progress['deep-archimedea'], /三关已完成.*距精英解锁 4 点/u);
});

test('深层科研分数与上周相同时不核销（快照携带上周遗留分）', () => {
  const { now, syncedAt, inventory, samples } = conquestFixture({ score: 21 });
  const result = evaluateAutoCheck(inventory, null, now, null, syncedAt, { conquestSamples: samples({ score: 21 }) });
  assert.equal(result.auto['deep-archimedea'], undefined);
  assert.match(result.progress['deep-archimedea'], /尚未确认本周完成/u);
});

test('科研重置日期已推进到下一周界时，同分也能证明属于本周', () => {
  const now = Date.UTC(2026, 7, 12, 4);
  const resetAt = Date.parse(nextReset(new Date(now)));
  const { syncedAt, inventory, samples } = conquestFixture({ now, score: 21, resetAt });
  const result = evaluateAutoCheck(inventory, null, now, null, syncedAt, { conquestSamples: samples({ score: 21 }) });
  assert.equal(result.auto['deep-archimedea'], true);
  assert.match(result.progress['deep-archimedea'], /三关已完成/u);
});

test('科研重置日期已推进到下一周界时，无历史样本也能确认本周分数', () => {
  const now = Date.UTC(2026, 7, 12, 4);
  const resetAt = Date.parse(nextReset(new Date(now)));
  const { syncedAt, inventory } = conquestFixture({ now, score: 21, resetAt });
  const result = evaluateAutoCheck(inventory, null, now, null, syncedAt, { conquestSamples: [] });
  assert.equal(result.auto['deep-archimedea'], true);
});

test('科研重置日期过期或未对齐下一周界时不采信同分', () => {
  const now = Date.UTC(2026, 7, 12, 4);
  for (const resetAt of [now - 1, now + 2 * 86400000]) {
    const { syncedAt, inventory, samples } = conquestFixture({ now, score: 21, resetAt });
    const result = evaluateAutoCheck(inventory, null, now, null, syncedAt, { conquestSamples: samples({ score: 21 }) });
    assert.equal(result.auto['deep-archimedea'], undefined);
    assert.match(result.progress['deep-archimedea'], /尚未确认本周完成/u);
  }
});

test('深层科研没有历史样本时不核销，只显示诚实进度', () => {
  const { now, syncedAt, inventory } = conquestFixture({ score: 21 });
  const result = evaluateAutoCheck(inventory, null, now, null, syncedAt, { conquestSamples: [] });
  assert.equal(result.auto['deep-archimedea'], undefined);
  assert.match(result.progress['deep-archimedea'], /尚未确认本周完成/u);
});

test('本周电波征服挑战完成时，即使分数与上周相同也核销', () => {
  const { now, syncedAt, samples } = conquestFixture({ score: 21 });
  const inventory = {
    EntratiLabConquestUnlocked: 1,
    EntratiLabConquestCacheScoreMission: 21,
    ChallengeProgress: [{ Name: 'SeasonWeeklyHardCompleteConquest', Progress: 1 }],
  };
  const worldState = { nightwave: { activeChallenges: [{ id: '1786924800000seasonweeklyhardcompleteconquest', isDaily: false, isElite: true }] } };
  const result = evaluateAutoCheck(inventory, worldState, now, { seasonweeklyhardcompleteconquest: 1 }, syncedAt, { conquestSamples: samples({ score: 21 }) });
  assert.equal(result.auto['deep-archimedea'], true);
});

test('科研 18 点及以下不能证明三关全通', () => {
  const now = Date.UTC(2026, 7, 12, 4);
  const syncedAt = new Date(now - 60_000).toISOString();
  const inventory = { EntratiLabConquestUnlocked: 1, EntratiLabConquestCacheScoreMission: 18 };
  const result = evaluateAutoCheck(inventory, null, now, null, syncedAt);
  assert.equal(result.auto['deep-archimedea'], undefined);
  assert.match(result.progress['deep-archimedea'], /尚不能确认三关全通/u);
});

test('科研分数不跨周用于自动核销', () => {
  const now = Date.UTC(2026, 7, 12, 4);
  const staleSync = new Date(Date.UTC(2026, 7, 9, 12)).toISOString();
  const inventory = { EntratiLabConquestUnlocked: 1, EntratiLabConquestCacheScoreMission: 27 };
  const result = evaluateAutoCheck(inventory, null, now, null, staleSync);
  assert.equal(result.progress['deep-archimedea'], undefined);
  assert.equal(result.auto['deep-archimedea'], undefined);
});

function archimedeaFixture(now = Date.now()) {
  const entry = (type) => ({
    type,
    activation: new Date(now - 86400000).toISOString(),
    expiry: new Date(now + 6 * 86400000).toISOString(),
    missions: Array.from({ length: 3 }, () => ({ missionType: 'Defense' })),
    personalModifiers: [{ key: 'Armorless' }],
  });
  return [entry('CT_LAB'), entry('CT_HEX')];
}

test('科研轮换只有两套本周完整记录时才可写入可靠缓存', () => {
  const now = Date.now();
  assert.equal(hasCompleteArchimedeas(archimedeaFixture(now), now), true);
  assert.equal(hasCompleteArchimedeas(archimedeaFixture(now).slice(0, 1), now), false);
  const incomplete = archimedeaFixture(now);
  incomplete[1].missions = [];
  assert.equal(hasCompleteArchimedeas(incomplete, now), false);
  const expired = archimedeaFixture(now);
  expired.forEach((entry) => { entry.expiry = new Date(now - 1).toISOString(); });
  assert.equal(hasCompleteArchimedeas(expired, now), false);
});

test('科研数据缺失时使用紧凑提示，不保留三关任务的空白高度', () => {
  const labs = ['深层科研', '时光科研'].map((title, index) => ({
    number: index + 2,
    done: false,
    skipped: false,
    title,
    place: index ? '霍瓦尼亚 · 1999' : '墓志之地 · 死灵中枢',
    accent: index ? '#F0B429' : '#9B7EDE',
    missions: [],
    personal: [],
    rewardLine: '测试奖励',
  }));
  const section = labsSection({ labs });
  assert.match(section.html, /轮换数据暂不可用/u);
  assert.equal(section.h, 508);
});

test('本周科研接口出现的全部词缀键都有中文映射', () => {
  const staticData = JSON.parse(readFileSync(new URL('./weekly-static.json', import.meta.url), 'utf8'));
  const currentKeys = [
    'LostInTranslation', 'Voidburst', 'AntiMaterialWeapons', 'AlchemicalShields',
    'ShieldedFoes', 'RegeneratingEnemies', 'GrowingIncursion', 'EMPBlackHole',
    'Quicksand', 'EnergyStarved', 'OverSensitive', 'Armorless', 'Knifestep',
    'TechrotConjunction', 'EfervonFog', 'DoubleTroubleLegacyte', 'FortifiedFoes',
    'MurmurIncursion', 'MiasmiteHive', 'ShieldDelay', 'AbilityLockout',
    'VoidEnergyOverload',
  ];
  assert.deepEqual(currentKeys.filter((key) => !staticData.archimedeaZh[key]), []);
});

test('科研词缀会用接口数值替换 Oracle 说明里的参数占位符', () => {
  const oracle = new Map([['Lethargic Shields', [{
    name: '嗜睡护盾',
    descEn: 'Shield recharge delay increased |val|%.',
    desc: '护盾充能延迟增加 |val|%。',
  }]]]);
  const result = localizeArchimedeaModifier({
    key: 'ShieldDelay',
    name: 'Lethargic Shields',
    description: 'Shield recharge delay increased 500%.',
  }, oracle, {});
  assert.deepEqual(result, { name: '嗜睡护盾', desc: '护盾充能延迟增加 500%。' });
});

test('1999 挑战同时显示官方标题和带数量的具体要求', () => {
  const line = calendarChallengeLine(
    { title: 'Demonstration of power', description: 'Kill 150 Enemies with Abilities' },
    { zh: '力量展现', desc: '使用技能击杀 |COUNT| 名敌人', required: 150 },
    { cur: 37, required: 150 },
  );
  assert.equal(line, '力量展现：使用技能击杀 150 名敌人（37/150）');
});

test('午夜电波官方备用源只有路径尾段时仍按本地官方词典翻译', () => {
  const names = {
    nightwaveZhOf: (key, elite) => ({
      'seasonweeklypickupmedallion:false': '狩猎开始',
      'seasonweeklyhardeternalguardian:true': '永恒守卫',
    })[`${key}:${elite}`] || null,
  };
  assert.equal(nightwaveChallengeZh({ id: '1786924800000seasonweeklypickupmedallion', isElite: false }, names), '狩猎开始');
  assert.equal(nightwaveChallengeZh({ id: '1786924800000seasonweeklyhardeternalguardian', isElite: true }, names), '永恒守卫');
});

test('1999 奖励优先使用官方 StoreItem 路径而不是英文显示名', () => {
  const path = '/Lotus/StoreItems/Types/Items/MiscItems/UtilityUnlocker';
  const names = { zhOf: (value) => value === '/Lotus/Types/Items/MiscItems/UtilityUnlocker' ? '特殊功能槽连接器' : null };
  assert.equal(calendarRewardZh('Exilus Adapter', path, names, new Map()), '特殊功能槽连接器');
});

test('1999 增益使用官方日历路径映射，开发占位项不再显示未收录', () => {
  assert.match(calendarUpgradeZh(
    { title: 'Radial Javelin On Heavy' },
    '/Lotus/Upgrades/Calendar/RadialJavelinOnHeavy',
  ), /上游数据仍为占位说明/u);
});

// —— 名称自动化：科研词缀尾段索引 / 日历状态中文表 / 官方语言键尾段 ——

test('官方备用源科研词缀路径尾段经 Oracle 语言键直查并按 LAB/HEX 消歧', () => {
  const tailMap = new Map([
    ['reinforcements', [
      { key: '/Lotus/Language/Conquest/MissionVariant_LabConquest_Reinforcements', name: '协调阵线', descEn: '', desc: '卓越者敌人出现并支援。' },
    ]],
    ['tankreinforcements', [
      { key: '/Lotus/Language/Conquest/MissionVariant_HexConquest_TankReinforcements', name: '支援', descEn: '', desc: '战斗过程中会有敌方援军抵达。' },
    ]],
  ]);
  assert.equal(
    localizeArchimedeaModifier({ key: 'Reinforcements', name: 'Reinforcements', description: '' }, new Map(), {}, { tailMap, kind: 'LAB' }).name,
    '协调阵线',
  );
  assert.equal(
    localizeArchimedeaModifier({ key: 'TankReinforcements', name: 'TankReinforcements', description: '' }, new Map(), {}, { tailMap, kind: 'HEX' }).name,
    '支援',
  );
});

test('官方备用源科研词缀尾段命中时同时带出官方中文说明', () => {
  const tailMap = new Map([['starvation', [
    { key: '/Lotus/Language/Conquest/PersonalMod_Starvation', name: '弹药亏空', descEn: '', desc: '通过掉落和道具恢复的弹药减少 75%。' },
  ]]]);
  const result = localizeArchimedeaModifier({ key: 'Starvation', name: 'Starvation', description: '' }, new Map(), {}, { tailMap, kind: 'LAB' });
  assert.equal(result.name, '弹药亏空');
  assert.match(result.desc, /弹药减少 75%/u);
});

test('科研词缀英文显示名路径仍按说明数字区分重名候选', () => {
  const oracle = new Map([['Sealed Armor', [
    { name: '密闭装甲', descEn: 'Enemies take 95% less damage.', desc: '非弱点伤害降低 95%。' },
    { name: '密闭装甲', descEn: 'Enemies take 90% less damage.', desc: '非弱点伤害降低 90%。' },
  ]]]);
  const result = localizeArchimedeaModifier({
    key: 'FortifiedFoes',
    name: 'Sealed Armor',
    description: 'Enemies take 90% less damage.',
  }, oracle, { FortifiedFoes: { name: '旧译名', desc: '旧说明' } });
  assert.deepEqual(result, { name: '密闭装甲', desc: '非弱点伤害降低 90%。' });
});

test('1999 增益自动吸收社区状态中文表（完整路径与尾段均可，静态表优先）', () => {
  const stateZh = {
    byPath: new Map([['/Lotus/Upgrades/Calendar/MagazineCapacity', { name: '重型弹夹', description: '增加25% 的弹匣容量。' }]]),
    byTail: new Map([['energywavesoncombo', { name: '连击能量波', description: '' }]]),
  };
  assert.equal(calendarUpgradeZh({ title: 'MagazineCapacity' }, '/Lotus/Upgrades/Calendar/MagazineCapacity', stateZh), '重型弹夹');
  assert.equal(calendarUpgradeZh({ title: 'Energy Waves On Combo' }, '/Lotus/Upgrades/Calendar/EnergyWavesOnCombo', stateZh), '连击能量波');
  // 静态表已有条目的既有译名优先于社区表
  assert.match(calendarUpgradeZh({ title: 'OvershieldCap' }, '/Lotus/Upgrades/Calendar/OvershieldCap', stateZh), /^强化超护盾/u);
  assert.match(calendarUpgradeZh({ title: 'MeleeAttackSpeed' }, '/Lotus/Upgrades/Calendar/MeleeAttackSpeed', stateZh), /新增日历增益/u);
});

test('1999 奖励按官方语言键尾段解析连接器类物品', () => {
  const names = {
    languageTailZhOf: (tail) => (String(tail).toLowerCase() === 'weaponmeleearcaneunlocker' ? '近战武器赋能槽连接器' : null),
    zhOf: () => null, catalogZhOf: () => null, catalogTailZhOf: () => null, frameByTail: new Map(),
  };
  const zh = calendarRewardZh(
    'WeaponMeleeArcaneUnlocker',
    '/Lotus/StoreItems/Types/Items/MiscItems/WeaponMeleeArcaneUnlocker',
    names,
    new Map(),
  );
  assert.equal(zh, '近战武器赋能槽连接器');
});

test('1999 奖励 3 天资源加成按静态别名解析', () => {
  assert.equal(
    calendarRewardZh('ResourceDropChance3DayStoreItem', '/Lotus/StoreItems/Types/Items/MiscItems/ResourceDropChance3DayStoreItem', null, new Map()),
    '3 天资源掉落几率加成',
  );
});

// —— 电波 requiredCount 契约：官方世界状态不含计数，计数只来自 Public Export ——

function nightwaveFixture({ progress = 15, known = true, twoChallenges = false } = {}) {
  const challenge = { id: '1786924800000seasonweeklypermanentcompletemissions2', isDaily: false, isElite: false };
  return {
    inventory: {
      ChallengeProgress: [{ Name: 'SeasonWeeklyPermanentCompleteMissions2', Progress: progress }],
    },
    worldState: {
      nightwave: { activeChallenges: twoChallenges ? [challenge, { id: '1786924800000seasonweeklyplainsbounties', isDaily: false, isElite: false }] : [challenge] },
    },
    challengeRequired: known ? { seasonweeklypermanentcompletemissions2: 15, ...(twoChallenges ? {} : {}) } : {},
  };
}

test('电波 requiredCount 映射缺失时宁不核销也不编造进度', () => {
  const { inventory, worldState, challengeRequired } = nightwaveFixture({ known: false });
  const result = evaluateAutoCheck(inventory, worldState, Date.now(), challengeRequired);
  assert.equal(result.progress.nightwave, undefined);
  assert.equal(result.auto.nightwave, undefined);
});

test('电波挑战进度达到 requiredCount 时计入并可在全中时核销', () => {
  const { inventory, worldState, challengeRequired } = nightwaveFixture();
  const result = evaluateAutoCheck(inventory, worldState, Date.now(), challengeRequired);
  assert.equal(result.progress.nightwave, '周挑战 1/1');
  assert.equal(result.auto.nightwave, true);
});

test('电波部分挑战无 requiredCount 时只按已知项计数、不整体核销', () => {
  const { inventory, worldState, challengeRequired } = nightwaveFixture({ twoChallenges: true });
  const result = evaluateAutoCheck(inventory, worldState, Date.now(), challengeRequired);
  assert.equal(result.progress.nightwave, '周挑战 1/2'); // 已知 1 条命中
  assert.equal(result.auto.nightwave, undefined); // 另一条未知，不猜
});

// —— 周日收尾提醒：自动核销与保守降级（2026-08-23 实机「执刑官已打仍被提醒」）——

test('执刑官：快照 SortieId 与本周 archonHunt.id 一致才核销，对不上或无世界状态不猜', () => {
  const inventory = { LastLiteSortieReward: [{ SortieId: { $oid: 'abc123' }, StoreItem: '/Lotus/Powersuits/Test', Manifest: {} }] };
  const worldState = { archonHunt: { id: 'abc123', boss: 'Archon Amar' } };
  assert.equal(evaluateAutoCheck(inventory, worldState).auto.archon, true);
  assert.equal(evaluateAutoCheck(inventory, { archonHunt: { id: 'other' } }).auto.archon, undefined);
  assert.equal(evaluateAutoCheck(inventory, null).auto.archon, undefined);
});

function reminderFixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'wf-remind-'));
  const target = 'qqbot:c2c:test-owner';
  const statePath = join(dir, 'warframe-weekly.json');
  const ledgerPath = join(dir, 'ledger.json');
  writeFileSync(statePath, JSON.stringify({ version: 1, records: [{ target, ownerId: 'test-owner', ownerName: 'owner', weekStart: weekStart(), completed: [], dismissed: [] }], prefs: [], nightwaveSamples: [], conquestSamples: [] }));
  writeFileSync(ledgerPath, JSON.stringify({ subscriptions: [{ target, ownerId: 'test-owner', ownerName: 'owner', enabled: true, type: 'weekly' }] }));
  return { dir, target, statePath, ledgerPath };
}

test('收尾提醒：世界状态拉取失败时保守降级，执刑官仍列未完成', async () => {
  const { dir, target, statePath, ledgerPath } = reminderFixtures();
  try {
    const result = await remindWeekly(statePath, ledgerPath, target, { fetchWorldState: async () => ({ value: null, error: 'simulated failure' }) });
    assert.match(result.output, /周常收尾提醒/);
    assert.match(result.output, /执刑官猎杀/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('收尾提醒：对账 fetcher 抛异常也不吞掉提醒（仍保守列出未完成）', async () => {
  const { dir, target, statePath, ledgerPath } = reminderFixtures();
  try {
    const result = await remindWeekly(statePath, ledgerPath, target, { fetchWorldState: async () => { throw new Error('boom'); } });
    assert.match(result.output, /周常收尾提醒/);
    assert.match(result.output, /执刑官猎杀/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
