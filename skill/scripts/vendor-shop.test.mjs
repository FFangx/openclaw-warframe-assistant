import assert from 'node:assert/strict';
import test from 'node:test';

import { itemZh, purchasesForCycle } from './vendor-shop.mjs';
import { storeItemZh } from './weekly.mjs';

test('商店配方路径通过目录父子关系恢复中文名称', () => {
  const names = {
    zhOf: () => null,
    catalogZhOf: (path) => ({
      '/Lotus/Types/Recipes/WarframeRecipes/StyanaxSystemsBlueprint': 'Styanax 系统蓝图',
      '/Lotus/Types/Recipes/WarframeSkins/FootstepsPetalsBlueprint': '种生步伐幻纹 蓝图',
    })[path] || null,
    catalogTailZhOf: () => null,
    languageTailZhOf: () => null,
  };
  assert.equal(storeItemZh('/Lotus/StoreItems/Types/Recipes/WarframeRecipes/StyanaxSystemsBlueprint', names), 'Styanax 系统蓝图');
  assert.equal(itemZh('/Lotus/StoreItems/Types/Recipes/WarframeSkins/FootstepsPetalsBlueprint', names), '种生步伐幻纹 蓝图');
});

test('商店组合包通过唯一官方语言键尾段恢复中文名称', () => {
  const names = {
    zhOf: () => null,
    catalogZhOf: () => null,
    catalogTailZhOf: () => null,
    languageTailZhOf: (tail) => tail === 'MPVNecraloidBundle' ? '殁世械灵组合包' : null,
  };
  assert.equal(itemZh('/Lotus/Types/StoreItems/Packages/MegaPrimeVault/MPVNecraloidBundle', names), '殁世械灵组合包');
});

test('任何未解析商店路径都不再把内部类名直接上卡', () => {
  const names = { zhOf: () => null, catalogZhOf: () => null, catalogTailZhOf: () => null, languageTailZhOf: () => null };
  assert.equal(itemZh('/Lotus/StoreItems/Types/Keys/UnknownInternalKey', names), '游戏内商品（名称待词典同步）');
});

test('路径不共尾名的已核对商店商品使用官方名称覆盖', () => {
  const names = { zhOf: () => null, catalogZhOf: () => null, catalogTailZhOf: () => null, languageTailZhOf: () => null };
  assert.equal(itemZh('/Lotus/StoreItems/Types/Keys/GrendelKeyC', names), 'Grendel 系统定位装置');
  assert.equal(itemZh('/Lotus/Types/StoreItems/Packages/MegaPrimeVault/MPVAviaPrimeArmorSet', names), '飞空 Prime 护甲套装');
  assert.equal(itemZh('/Lotus/Types/StoreItems/Packages/MegaPrimeVault/MPVVetalaPrimeArmorSet', names), '维塔拉 Prime 护甲套装');
  assert.equal(itemZh('/Lotus/StoreItems/Types/JadeShadowsPart2Mission/CrewMembers/AshCrewedCaptainGenerator', names), '忍力（船员）');
});

test('泰辛本周计数只接纳本周 expiry，不把未来三周预写记录算成已购', () => {
  const thisWeekExpiry = Date.parse('2026-08-31T00:00:00.000Z');
  const thisWeekStart = Date.parse('2026-08-24T00:00:00.000Z');
  const purchases = [
    { expiryMs: thisWeekExpiry, createdMs: Date.parse('2026-08-24T02:00:00.000Z'), num: 2 },
    { expiryMs: Date.parse('2026-09-28T00:00:00.000Z'), createdMs: Date.parse('2025-12-10T16:00:53.000Z'), num: 1 },
    { expiryMs: Date.parse('2026-10-05T00:00:00.000Z'), createdMs: Date.parse('2025-12-10T16:00:53.000Z'), num: 1 },
    { expiryMs: Date.parse('2026-10-12T00:00:00.000Z'), createdMs: Date.parse('2025-12-10T16:00:53.000Z'), num: 1 },
  ];
  assert.deepEqual(purchasesForCycle(purchases, thisWeekExpiry, thisWeekStart), [purchases[0]]);
  assert.equal(purchasesForCycle(purchases, thisWeekExpiry, thisWeekStart).reduce((sum, row) => sum + row.num, 0), 2);
});

test('expiry 被服务端推进到本周的上周旧账仍不算本周购买', () => {
  const thisWeekStart = Date.parse('2026-08-24T00:00:00.000Z');
  const thisWeekExpiry = Date.parse('2026-08-31T00:00:00.000Z');
  const carried = { expiryMs: thisWeekExpiry, createdMs: Date.parse('2026-08-16T23:56:02.000Z'), num: 6 };
  assert.deepEqual(purchasesForCycle([carried], thisWeekExpiry, thisWeekStart), []);
});
