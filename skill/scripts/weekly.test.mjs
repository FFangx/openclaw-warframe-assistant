import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { calendarChallengeLine, calendarRewardZh, calendarUpgradeZh, evaluateAutoCheck, hasCompleteArchimedeas, localizeArchimedeaModifier } from './weekly.mjs';
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

test('科研词缀优先使用 Oracle 正式中文并按英文说明区分重名候选', () => {
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
