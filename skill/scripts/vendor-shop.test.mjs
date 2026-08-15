import assert from 'node:assert/strict';
import test from 'node:test';

import { itemZh } from './vendor-shop.mjs';
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
