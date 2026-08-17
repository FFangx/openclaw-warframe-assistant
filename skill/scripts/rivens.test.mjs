import assert from 'node:assert/strict';
import test from 'node:test';

import { appraiseAgainstMarket, appraiseAttr, appraiseFingerprint, gradeOf, isGodRoll, rivenName } from './rivens.mjs';

const MAX_ROLL = 0x40000000;
const stats = { dmg: { baseValue: 1.5, shortString: 'Damage', prefixTag: 'hera', suffixTag: 'do' }, cc: { baseValue: 2.0, shortString: 'CriticalChance', prefixTag: 'vexi', suffixTag: 'ra' } };
const table = {
  dataByRivenInternalID: {
    '/Lotus/Riven/X': { fusionLimit: 8, rivenStats: stats },
    '/Lotus/Riven/Y': { fusionLimit: 6, rivenStats: { dmg: stats.dmg } },
  },
  weaponStats: { compatX: { name: 'Synthetic Weapon', omegaAtt: 1.1 } },
  modifiersBasedOnTraitCount: [
    { goodModifiersCount: 2, badModifiersCount: 0, goodModifierMultiplier: 0.9, badModifierMultiplier: 0.5 },
    { goodModifiersCount: 1, badModifiersCount: 1, goodModifierMultiplier: 0.8, badModifierMultiplier: 0.6 },
    { goodModifiersCount: 2, badModifiersCount: 1, goodModifierMultiplier: 0.7, badModifierMultiplier: 0.4 },
  ],
};

// —— 单词条复算：区间=[base, base×11/9]，roll 线性映射 ——

test('appraiseAttr 满 roll 落在区间上缘、零 roll 落在下缘', () => {
  const max = appraiseAttr('dmg', MAX_ROLL, { stats, omegaAtt: 1, traitMult: 1, rank: 8 });
  const base = 1.5 * 100 * 1 * 1 * 9; // baseValue×100×omegaAtt×traitMult×(rank+1)
  assert.equal(max.min, 1350);
  assert.ok(Math.abs(max.max - 1650) < 1e-9); // 1350×(11/9)
  assert.ok(Math.abs(max.value - 1650) < 1e-9);
  assert.equal(max.rollPct, 100);
  assert.equal(max.short, 'Damage');
  const min = appraiseAttr('dmg', 0, { stats, omegaAtt: 1, traitMult: 1, rank: 8 });
  assert.equal(min.value, base);
  assert.equal(min.rollPct, 0);
});

test('appraiseAttr 缺表词条或上下文缺数值时降级 null 值段', () => {
  assert.deepEqual(appraiseAttr('missing', MAX_ROLL, { stats, omegaAtt: 1, traitMult: 1, rank: 8 }), { tag: 'missing', value: null });
  assert.deepEqual(appraiseAttr('dmg', MAX_ROLL, { stats, omegaAtt: Number.NaN, traitMult: 1, rank: 8 }), { tag: 'dmg', value: null });
});

// —— 字母评级：洗练位置分档，负词条反转 ——

test('gradeOf 分档边界与正负号', () => {
  assert.equal(gradeOf(100), 'S');
  assert.equal(gradeOf(93), 'S');
  assert.equal(gradeOf(91.9), 'A+');
  assert.equal(gradeOf(80), 'A');
  assert.equal(gradeOf(74), 'A-');
  assert.equal(gradeOf(70), 'A-');
  assert.equal(gradeOf(42), 'B-');
  assert.equal(gradeOf(5), 'F');
  assert.equal(gradeOf(0), 'F');
});

test('gradeOf 负词条反转：毛病越轻评级越高', () => {
  assert.equal(gradeOf(2, true), 'S'); // p = 98
  assert.equal(gradeOf(30, true), 'A-'); // p = 70
  assert.equal(gradeOf(95, true), 'F'); // p = 5
});

// —— 神卡判定：mandatory ⊆ buffs ⊆ mandatory∪optional，负词条全在可接受表 ——

const goodRolls = { goodAttrs: [{ mandatory: ['dmg', 'cc'], optional: ['ms'] }], acceptedBadAttrs: ['zoom'] };

test('isGodRoll 正反例完整判定', () => {
  assert.equal(isGodRoll({ buffs: [{ Tag: 'dmg' }, { Tag: 'cc' }], curses: [{ Tag: 'zoom' }] }, { goodRolls }), true);
  assert.equal(isGodRoll({ buffs: [{ Tag: 'dmg' }, { Tag: 'cc' }, { Tag: 'ms' }], curses: [] }, { goodRolls }), true);
  assert.equal(isGodRoll({ buffs: [{ Tag: 'dmg' }], curses: [] }, { goodRolls }), false); // 缺 mandatory
  assert.equal(isGodRoll({ buffs: [{ Tag: 'dmg' }, { Tag: 'cc' }, { Tag: 'elec' }], curses: [] }, { goodRolls }), false); // 组外 buff
  assert.equal(isGodRoll({ buffs: [{ Tag: 'dmg' }, { Tag: 'cc' }], curses: [{ Tag: 'recoil' }] }, { goodRolls }), false); // 不接受负词条
  assert.equal(isGodRoll({ buffs: [{ Tag: 'dmg' }], curses: [] }, {}), false); // 无社区表
});

// —— 紫卡名重建：buffs 按 Value 降序，前缀+…+末位后缀 ——

test('rivenName 按价值降序重组单词与连字名', () => {
  const fp = { buffs: [{ Tag: 'dmg', Value: 10 }, { Tag: 'cc', Value: 20 }] };
  assert.equal(rivenName(fp, '/Lotus/Riven/X', table), 'Vexido'); // cc(20) 前：vexi + do
  const three = { buffs: [{ Tag: 'dmg', Value: 1 }, { Tag: 'cc', Value: 2 }, { Tag: 'dmg', Value: 3 }] };
  assert.equal(rivenName(three, '/Lotus/Riven/X', table), 'Hera-vexido'); // 排序后 dmg(3),cc(2),dmg(1) → 前缀+前缀+后缀
  assert.equal(rivenName({ buffs: [{ Tag: 'dmg', Value: 1 }] }, '/Lotus/Riven/X', table), null); // 少于 2 条
  assert.equal(rivenName({ buffs: [{ Tag: 'dmg', Value: 1 }, { Tag: 'cc', Value: 2 }] }, '/Lotus/Riven/Unknown', table), null); // 无表
  assert.equal(rivenName({ buffs: [{ Tag: 'dmg', Value: 1 }, { Tag: 'noprefix', Value: 2 }] }, '/Lotus/Riven/Y', table), null); // 缺前缀
});

// —— 指纹整卡复算：武器/omegaAtt/等级/trait 乘法器 ——

test('appraiseFingerprint 复算满级口径并标注 curse', () => {
  const fp = { compat: 'compatX', buffs: [{ Tag: 'dmg', Value: MAX_ROLL / 2 }, { Tag: 'cc', Value: MAX_ROLL / 2 }], curses: [{ Tag: 'zoom', Value: MAX_ROLL / 4 }] };
  const out = appraiseFingerprint(fp, '/Lotus/Riven/X', table);
  assert.equal(out.weaponEn, 'Synthetic Weapon');
  assert.equal(out.omegaAtt, 1.1);
  assert.equal(out.rank, 8);
  assert.equal(out.buffs.length, 2);
  assert.equal(out.curses.length, 1);
  assert.equal(out.curses[0].curse, true);
  assert.ok(out.buffs.every((buff) => buff.value >= buff.min && buff.value <= buff.max));
  // trait 乘法器来自 (2 buff, 1 curse) 组合：good 0.7
  const expectedBase = 1.5 * 100 * 1.1 * 0.7 * 9;
  assert.ok(Math.abs(out.buffs[0].min - expectedBase) < 1e-9);
});

test('appraiseFingerprint 未装备武器仍给出词条数值（omegaAtt 缺省不抛）', () => {
  const fp = { buffs: [{ Tag: 'dmg', Value: 0 }], curses: [] };
  const out = appraiseFingerprint(fp, '/Lotus/Riven/X', table);
  assert.equal(out.weaponEn, null);
  assert.equal(out.omegaAtt, null);
  assert.equal(out.buffs.length, 1);
  assert.equal(out.buffs[0].value, null); // omegaAtt 非有限 → 数值不可复算
});

// —— 市场对照估价：同词条组统计 + 保守样本门 ——

test('appraiseAgainstMarket 同词条 ≥3 时给出保守估价区间', () => {
  const attr = (positive, url) => ({ positive, url_name: url });
  const auctions = [
    { closed: false, buyout_price: 100, item: { attributes: [attr(true, 'dmg'), attr(true, 'cc')], re_rolls: 0 }, owner: { status: 'ingame' } },
    { closed: false, buyout_price: 120, item: { attributes: [attr(true, 'dmg'), attr(true, 'cc')], re_rolls: 1 }, owner: { status: 'online' } },
    { closed: false, buyout_price: 140, item: { attributes: [attr(true, 'dmg'), attr(true, 'cc')], re_rolls: 2 }, owner: { status: 'ingame' } },
    { closed: false, starting_price: 90, item: { attributes: [attr(true, 'dmg'), attr(false, 'zoom')], re_rolls: 0 }, owner: { status: 'offline' } },
    { closed: true, buyout_price: 1, item: { attributes: [attr(true, 'dmg'), attr(true, 'cc')], re_rolls: 0 }, owner: { status: 'ingame' } },
  ];
  const out = appraiseAgainstMarket(['dmg', 'cc'], [], auctions);
  assert.equal(out.total, 4); // closed 单被剔除
  assert.equal(out.exact.n, 3);
  assert.equal(out.posSame.n, 3);
  assert.deepEqual(out.estimate, { low: 100, high: 120, basis: '正词条全同' }); // median 120
  assert.equal(out.topSimilar[0].price, 100);
  assert.deepEqual(out.topSimilar[0].attrs.filter((attr) => attr.positive && attr.shared).map((attr) => attr.slug), ['dmg', 'cc']);
});

test('appraiseAgainstMarket 样本不足与负词条差集', () => {
  const attr = (positive, url) => ({ positive, url_name: url });
  const auctions = [
    { closed: false, buyout_price: 300, item: { attributes: [attr(true, 'dmg'), attr(true, 'cc')], re_rolls: 0 }, owner: { status: 'ingame' } },
    { closed: false, buyout_price: 90, item: { attributes: [attr(true, 'dmg'), attr(false, 'zoom')], re_rolls: 0 }, owner: { status: 'ingame' } },
  ];
  const out = appraiseAgainstMarket(['dmg', 'cc'], ['zoom'], auctions);
  assert.equal(out.exact.n, 0); // 我方带负词条 zoom，两张都不完全同
  assert.equal(out.posSame.n, 1);
  assert.equal(out.estimate, null); // 样本 <3 不给结论（单张 300p 挂价孤立）
});

test('未开封紫卡统计行没有 mod_rank 也能给出成交中位估价', async () => {
  const { getVeiledPrices } = await import('./rivens.mjs');
  const prices = await getVeiledPrices(['Rifle Riven Mod'], async () => ({
    payload: { statistics_closed: {
      '48hours': [],
      '90days': [
        { datetime: '2026-08-10T00:00:00.000Z', median: 10, volume: 10 },
        { datetime: '2026-08-11T00:00:00.000Z', median: 12, volume: 10 },
      ],
    } },
  }));
  // wm v1 统计对未开封紫卡的所有行 mod_rank 均为空（实锤 177/177）；修复后不过滤 rank 仍能出价
  assert.equal(prices['Rifle Riven Mod'].platinum, 10);
  assert.equal(prices['Rifle Riven Mod'].basis, '90days');
  assert.equal(prices['Rifle Riven Mod'].dailyVolume, 0.2); // 20 笔 / 90 天
});

test('列表卡逐张估价：同武器只查一次拍卖，按词条相似度出区间', async () => {
  const { assembleRivens, attachRivenEstimates, buildRivenListCard } = await import('./rivens.mjs');
  const compatX = '/Lotus/Weapons/Rifle/LongGun/SyntheticRifle';
  const compatY = '/Lotus/Weapons/Pistol/DualPistol/SyntheticPistol';
  const stats = { dmg: { baseValue: 1.5, shortString: 'D', prefixTag: 'vex', suffixTag: 'ido' } };
  const table = {
    dataByRivenInternalID: { '/Lotus/Riven/X': { fusionLimit: 8, rivenStats: stats } },
    weaponStats: { [compatX]: { name: 'Synthetic Rifle', omegaAtt: 1 }, [compatY]: { name: 'Synthetic Pistol', omegaAtt: 1 } },
  };
  const fp = (compat, rerolls) => ({ compat, rerolls, pol: 'madurai', lvlReq: 8, buffs: [{ Tag: 'dmg', Value: 0 }] });
  const inventory = { Upgrades: [
    { ItemType: '/Lotus/Types/Riven/Weapons/Randomized/X', UpgradeFingerprint: JSON.stringify(fp(compatX, 0)) },
    { ItemType: '/Lotus/Types/Riven/Weapons/Randomized/X', UpgradeFingerprint: JSON.stringify(fp(compatX, 2)) },
    { ItemType: '/Lotus/Types/Riven/Weapons/Randomized/X', UpgradeFingerprint: JSON.stringify(fp(compatY, 0)) },
  ] };
  const data = await assembleRivens({ inventory, table });
  const weaponDir = { [compatX]: { slug: 'synthetic_rifle', thumb: null }, [compatY]: { slug: 'synthetic_pistol', thumb: null } };
  const attrSlug = { dmg: 'damage' };
  const attr = (positive, url) => ({ positive, url_name: url });
  const auctionsBySlug = {
    synthetic_rifle: [
      { closed: false, buyout_price: 100, item: { attributes: [attr(true, 'damage'), attr(true, 'cc')], re_rolls: 0 }, owner: { status: 'ingame' } },
      { closed: false, buyout_price: 120, item: { attributes: [attr(true, 'damage')], re_rolls: 0 }, owner: { status: 'ingame' } },
      { closed: false, buyout_price: 140, item: { attributes: [attr(true, 'damage')], re_rolls: 0 }, owner: { status: 'ingame' } },
    ],
    synthetic_pistol: [
      { closed: false, buyout_price: 50, item: { attributes: [attr(true, 'damage')], re_rolls: 0 }, owner: { status: 'ingame' } },
    ],
  };
  let calls = 0;
  const auctionFetcher = async (url) => {
    calls += 1;
    const slug = url.includes('synthetic_rifle') ? 'synthetic_rifle' : 'synthetic_pistol';
    return { payload: { auctions: auctionsBySlug[slug] } };
  };
  await attachRivenEstimates(data.opened, { weaponDir, attrSlug, auctionFetcher });
  assert.equal(calls, 2); // 同武器两张紫卡只查一次
  const rifle = data.opened.filter((r) => r.compat === compatX);
  assert.equal(rifle.length, 2);
  for (const r of rifle) assert.deepEqual(r.estimate, { low: 100, high: 120, basis: '共享词条' });
  assert.equal(data.opened.find((r) => r.compat === compatY).estimate, null); // 样本 1 <3 不给结论
  const card = buildRivenListCard({ ...data, veiled: [] });
  assert.match(card.html, /参考 100~120p/u);
  assert.match(card.html, /（共享词条）/u);
  assert.match(card.html, /相似样本不足/u);
  assert.match(card.html, /参考价=相似词条挂价区间/u);
});

test('拍卖拉取失败时列表卡标注行情不可用', async () => {
  const { assembleRivens, attachRivenEstimates, buildRivenListCard } = await import('./rivens.mjs');
  const compatX = '/Lotus/Weapons/Rifle/LongGun/SyntheticRifle';
  const stats = { dmg: { baseValue: 1.5, shortString: 'D', prefixTag: 'vex', suffixTag: 'ido' } };
  const table = {
    dataByRivenInternalID: { '/Lotus/Riven/X': { fusionLimit: 8, rivenStats: stats } },
    weaponStats: { [compatX]: { name: 'Synthetic Rifle', omegaAtt: 1 } },
  };
  const inventory = { Upgrades: [
    { ItemType: '/Lotus/Types/Riven/Weapons/Randomized/X', UpgradeFingerprint: JSON.stringify({ compat: compatX, rerolls: 0, pol: 'madurai', lvlReq: 8, buffs: [{ Tag: 'dmg', Value: 0 }] }) },
  ] };
  const data = await assembleRivens({ inventory, table });
  await attachRivenEstimates(data.opened, {
    weaponDir: { [compatX]: { slug: 'synthetic_rifle' } },
    attrSlug: { dmg: 'damage' },
    auctionFetcher: async () => ({ payload: { auctions: null } }),
  });
  assert.equal(data.opened[0].estimateFailed, true);
  const card = buildRivenListCard({ ...data, veiled: [] });
  assert.match(card.html, /行情不可用/u);
});
