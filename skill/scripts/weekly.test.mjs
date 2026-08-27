import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ARCHIMEDEA_UNRESOLVED_DESC_ZH, archimedeaResearchProgress, calendarChallengeLine, calendarRewardZh, calendarUpgradeEntry, calendarUpgradeZh, evaluateAutoCheck, hasCompleteArchimedeas, localizeArchimedeaModifier, nextReset, nightwaveChallengeZh, remindWeekly, weekStart } from './weekly.mjs';
import { calendarSection, labsSection } from './weekly-mega-card.mjs';

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
    'VoidEnergyOverload', 'TimeDilation',
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

// —— 未解析占位符保护（2026-08 实况修复）：DE 官方 worldState Conquests 的 Variables 只给
// 个人修正键（TimeDilation 实锤），不带数值；Oracle 简中说明「技能持续时间减少 |val|%。」
// 此前会原样上卡。Update 36.0 起该效果为 50%（Hotfix 36.1.6 修正说明），静态表已按此审核收录。

function timeDilationOracleFixture() {
  const candidate = [{
    key: '/Lotus/Language/Conquest/PersonalMod_TimeDilation',
    name: '缩短技能',
    descEn: 'Ability durations reduced by |val|%.',
    desc: '技能持续时间减少 |val|%。',
  }];
  return {
    byName: new Map([['Abbreviated Abilities', candidate]]),
    byTail: new Map([['timedilation', candidate]]),
  };
}

test('TimeDilation（官方备用源只给键、无数值）：未解析 |val| 采用同键完整审核静态说明，显示「缩短技能：技能持续时间减少 50%」', () => {
  const staticData = JSON.parse(readFileSync(new URL('./weekly-static.json', import.meta.url), 'utf8'));
  const { byTail } = timeDilationOracleFixture();
  // 与 buildMegaData 真实调用同形：worldstate-source.mjs normalizeConquests 把
  // Variables 归一成 { key, name: key, description: '' }，tailMap 尾段直查命中。
  const result = localizeArchimedeaModifier(
    { key: 'TimeDilation', name: 'TimeDilation', description: '' },
    new Map(), staticData.archimedeaZh, { tailMap: byTail, kind: 'LAB' },
  );
  assert.deepEqual(result, { name: '缩短技能', desc: '技能持续时间减少 50%' });
  // 静态表缺该键时也必须诚实降级，不得把 |val| 原文送上卡
  const withoutStatic = localizeArchimedeaModifier(
    { key: 'TimeDilation', name: 'TimeDilation', description: '' },
    new Map(), {}, { tailMap: byTail, kind: 'LAB' },
  );
  assert.equal(withoutStatic.name, '缩短技能');
  assert.equal(withoutStatic.desc, ARCHIMEDEA_UNRESOLVED_DESC_ZH);
  assert.ok(!withoutStatic.desc.includes('|'));
});

test('TimeDilation 走 warframestat 数值路径时同样得到 50% 口径（Update 36.0 / Hotfix 36.1.6）', () => {
  const staticData = JSON.parse(readFileSync(new URL('./weekly-static.json', import.meta.url), 'utf8'));
  const { byName } = timeDilationOracleFixture();
  const result = localizeArchimedeaModifier(
    { key: 'TimeDilation', name: 'Abbreviated Abilities', description: 'Ability durations reduced by 50%.' },
    byName, staticData.archimedeaZh,
  );
  assert.equal(result.name, '缩短技能');
  assert.match(result.desc, /技能持续时间减少 50%/u);
  assert.ok(!result.desc.includes('|'));
});

test('未知词缀的 Oracle 说明残留 |val| 时安全降级为诚实中文缺数值提示，绝不直接上卡', () => {
  const oracle = new Map([['Brand New Mod', [{
    name: '全新词缀',
    descEn: 'Movement speed increased by |val|%.',
    desc: '移动速度提高 |val|%。',
  }]]]);
  const result = localizeArchimedeaModifier(
    { key: 'BrandNewMod', name: 'Brand New Mod', description: '' },
    oracle, {},
  );
  assert.equal(result.name, '全新词缀');
  assert.equal(result.desc, ARCHIMEDEA_UNRESOLVED_DESC_ZH);
  assert.ok(!result.desc.includes('|'));
});

test('占位符多于可用数值（部分替换后仍有残留）同样触发未解析保护', () => {
  const oracle = new Map([['Two Token Mod', [{
    name: '双参数词缀',
    descEn: 'Gain |val| and |val|.',
    desc: '获得 |val| 与 |val|。',
  }]]]);
  const result = localizeArchimedeaModifier(
    { key: 'TwoTokenMod', name: 'Two Token Mod', description: 'Gain 10.' },
    oracle, {},
  );
  assert.equal(result.name, '双参数词缀');
  assert.equal(result.desc, ARCHIMEDEA_UNRESOLVED_DESC_ZH);
  assert.ok(!result.desc.includes('|'));
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

test('1999 增益使用用户核验的灰机wiki静态路径表，占位项已补齐真实译名', () => {
  const entry = calendarUpgradeEntry({ title: 'Radial Javelin On Heavy' }, '/Lotus/Upgrades/Calendar/RadialJavelinOnHeavy');
  assert.equal(entry.name, '重型标枪');
  assert.match(entry.desc, /近战重击会发射一枚范围为3米/u);
  // 字符串兼容 API 保持「名称：效果」格式
  assert.equal(calendarUpgradeZh({ title: 'Radial Javelin On Heavy' }, '/Lotus/Upgrades/Calendar/RadialJavelinOnHeavy'), '重型标枪：近战重击会发射一枚范围为3米、基础伤害为1000的广域标枪，并受到连击倍率加成');
});

test('1999 增益当前季节路径：灰机wiki 核验译名与效果成对命中（PunchToPrimary/人多势众/硬化装甲/特浓咖啡/吸引力/强制输血）', () => {
  const cases = [
    ['/Lotus/Upgrades/Calendar/PunchToPrimary', '打孔纸带', '主要武器穿透增加1.5米'],
    ['/Lotus/Upgrades/Calendar/CompanionsBuffNearbyPlayer', '人多势众', '20米内每名非Tenno友军增加5%近战攻击速度和20%射速'],
    ['/Lotus/Upgrades/Calendar/Armor', '硬化装甲', '增加250护甲'],
    ['/Lotus/Upgrades/Calendar/EnergyRestoration', '特浓咖啡', '增加每秒2能量恢复'],
    ['/Lotus/Upgrades/Calendar/MagnetStatusPull', '吸引力', '磁力异常状态会将1米范围内的敌人拉近'],
    ['/Lotus/Upgrades/Calendar/GenerateOmniOrbsOnWeakKill', '强制输血', '弱点击杀有25%的几率生成通用补给球'],
  ];
  for (const [upgradePath, name, descPart] of cases) {
    const entry = calendarUpgradeEntry({ title: upgradePath.split('/').pop() }, upgradePath);
    assert.equal(entry.name, name, upgradePath);
    assert.match(entry.desc, new RegExp(descPart.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), upgradePath);
  }
});

test('社区状态表行自带 {name, description}：entry 同时带出中文名与效果说明，不再丢弃说明', () => {
  const stateZh = {
    byPath: new Map([['/Lotus/Upgrades/Calendar/MagazineCapacity', { name: '社区名', description: '社区效果说明。' }]]),
    byTail: new Map(),
  };
  const entry = calendarUpgradeEntry({ title: 'MagazineCapacity' }, '/Lotus/Upgrades/Calendar/MagazineCapacity', stateZh);
  // 静态表（灰机wiki 核验）优先于社区表：重型弹匣 + 完整效果
  assert.equal(entry.name, '重型弹匣');
  assert.equal(entry.desc, '增加25%的弹匣容量');
  stateZh.byPath.set('/Lotus/Upgrades/Calendar/BrandNewCommunityPath', { name: '社区新增增益', description: '社区提供的效果说明。' });
  const communityEntry = calendarUpgradeEntry({ title: 'Brand New Community Path' }, '/Lotus/Upgrades/Calendar/BrandNewCommunityPath', stateZh);
  assert.deepEqual(communityEntry, { name: '社区新增增益', desc: '社区提供的效果说明。', source: '社区维护状态中文表' });
  // 社区表只有名字没有说明：名字命中、效果留空（不猜），由漂移分析记为 effectMissing
  stateZh.byPath.set('/Lotus/Upgrades/Calendar/NameOnlyPath', { name: '只名无说明', description: '' });
  const nameOnly = calendarUpgradeEntry({ title: 'NameOnlyPath' }, '/Lotus/Upgrades/Calendar/NameOnlyPath', stateZh);
  assert.deepEqual(nameOnly, { name: '只名无说明', desc: '', source: '社区维护状态中文表' });
  const learnedEffect = new Map([['/lotus/upgrades/calendar/nameonlypath', { name: '只名无说明', desc: '后来查证的完整效果。', source: '灰机wiki 1999日历' }]]);
  const completed = calendarUpgradeEntry({ title: 'NameOnlyPath' }, '/Lotus/Upgrades/Calendar/NameOnlyPath', stateZh, { learnedEntries: learnedEffect });
  assert.equal(completed.name, '只名无说明', '学习词典不得改社区已有名称');
  assert.equal(completed.desc, '后来查证的完整效果。', '学习词典应补齐社区缺失的效果');
  const conflictingLearned = new Map([['/lotus/upgrades/calendar/nameonlypath', { name: '冲突名称', desc: '不应采用。', source: '灰机wiki 1999日历' }]]);
  assert.equal(calendarUpgradeEntry({ title: 'NameOnlyPath' }, '/Lotus/Upgrades/Calendar/NameOnlyPath', stateZh, { learnedEntries: conflictingLearned }).desc, '', '名称冲突时不得合并效果');
});

test('学习词典只补缺口：静态表/社区表覆盖时不被学习条目覆盖，词典在静态表之后、题名表之前', () => {
  const learned = new Map([
    ['/lotus/upgrades/calendar/armor', { name: '学习者译名', desc: '学习者效果', source: '灰机wiki 1999日历' }],
    ['/lotus/upgrades/calendar/brandnewlearnedpath', { name: '学习译名', desc: '学习效果', source: '灰机wiki 1999日历' }],
  ]);
  // 静态权威在先：学习条目不能覆盖用户核验的静态表
  const armored = calendarUpgradeEntry({}, '/Lotus/Upgrades/Calendar/Armor', null, { learnedEntries: learned });
  assert.equal(armored.name, '硬化装甲');
  // 无静态/社区覆盖时学习条目生效（含效果与来源）
  const learnedHit = calendarUpgradeEntry({ title: 'Brand New Learned Path' }, '/Lotus/Upgrades/Calendar/BrandNewLearnedPath', null, { learnedEntries: learned });
  assert.deepEqual(learnedHit, { name: '学习译名', desc: '学习效果', source: '灰机wiki 1999日历' });
  // 题名表兜底在词典之后：无学习条目时走静态题名表
  const titleHit = calendarUpgradeEntry({ title: 'No Quarter' }, '/Lotus/Upgrades/Calendar/UnknownPathForTitleFallback', null, {});
  assert.equal(titleHit.name, '毫不留情');
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

test('1999 增益自动吸收社区状态中文表（完整路径与尾段均可，用户核验静态表优先）', () => {
  const stateZh = {
    byPath: new Map([['/Lotus/Upgrades/Calendar/MagazineCapacity', { name: '重型弹夹', description: '增加25% 的弹匣容量。' }]]),
    byTail: new Map([['energywavesoncombo', { name: '连击能量波', description: '' }]]),
  };
  // 静态表（灰机wiki 核验）优先于社区表：重型弹匣（社区表旧值「重型弹夹」不再覆盖）
  assert.equal(calendarUpgradeZh({ title: 'MagazineCapacity' }, '/Lotus/Upgrades/Calendar/MagazineCapacity', stateZh), '重型弹匣：增加25%的弹匣容量');
  assert.equal(calendarUpgradeZh({ title: 'Energy Waves On Combo' }, '/Lotus/Upgrades/Calendar/EnergyWavesOnCombo', stateZh), '连击能量波');
  // 静态表已有条目以灰机wiki 核验值优先于社区表/占位
  assert.match(calendarUpgradeZh({ title: 'OvershieldCap' }, '/Lotus/Upgrades/Calendar/OvershieldCap', stateZh), /^硬质化/u);
  assert.match(calendarUpgradeZh({ title: 'MeleeAttackSpeed' }, '/Lotus/Upgrades/Calendar/MeleeAttackSpeed', stateZh), /^毫不留情/u);
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

test('1999 奖励 Mod 掉落加成 3 天包按静态别名解析（不再落占位）', () => {
  // 当前赛季实拍路径（官方 worldState KnownCalendarSeasons）：Boosters 分段下的 ModDropChanceBooster3DayStoreItem
  assert.equal(
    calendarRewardZh('ModDropChanceBooster3DayStoreItem', '/Lotus/Types/StoreItems/Boosters/ModDropChanceBooster3DayStoreItem', null, new Map()),
    '3 天 Mod 掉落几率加成',
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

// —— 1999 日历卡：增益行同时显示中文名与效果说明，长效果换行不截断，高度安全估算 ——

function calendarSectionFixture(lines) {
  return calendarSection({
    calendar: {
      number: 11, done: false, skipped: false, prizeDayCount: 2, progress: null,
      schedule: [{ dateZh: '1月1日', state: 'current', type: 'override', lines }],
    },
  });
}

test('1999 日历卡增益行显示 {name, desc} 两行且无 ellipsis 截断，长效果使卡高安全增长', () => {
  const shortSection = calendarSectionFixture([{ name: '短增益', desc: '短效果说明', chosen: false }]);
  const longSection = calendarSectionFixture([{
    name: '重型标枪',
    desc: '近战重击会发射一枚范围为3米、基础伤害为1000的广域标枪，并受到连击倍率加成。'
      + '额外说明：每一层连击倍率都会进一步提升标枪伤害，最高可达65%。'
      + '这是一段专门用于验证换行高度估算的较长效果说明，必须完整展示而不能截断。',
    chosen: true,
  }]);
  for (const section of [shortSection, longSection]) {
    assert.ok(!section.html.includes('text-overflow'), '日历卡不得使用 ellipsis 截断');
    assert.ok(section.html.includes('white-space:normal'), '日历卡文案必须允许换行');
  }
  assert.ok(longSection.html.includes('重型标枪') && longSection.html.includes('必须完整展示而不能截断'));
  // 长效果说明额外占行：卡高比单行说明至少高 20px（一行效果说明的线高）
  assert.ok(longSection.h - shortSection.h >= 20, `长说明应使卡片更高（${longSection.h} vs ${shortSection.h}）`);
});

test('1999 日历卡兼容旧 {text, chosen} 行形态（字符串与对象均不崩）', () => {
  const mixed = calendarSectionFixture([{ name: '新形态', desc: '新效果', chosen: false }, { text: '旧形态', chosen: true }]);
  assert.ok(mixed.html.includes('新形态') && mixed.html.includes('新效果') && mixed.html.includes('旧形态'));
});
