import assert from 'node:assert/strict';
import test from 'node:test';

import { annotateParentOwnership, parseAlecaMessage, splitInventoryQueryList } from './alecaframe.mjs';

// —— 显式多物品库存查询（2026-08-13 实机修复：延凡草、瑶丛 不能被当成一个名称） ——

test('splitInventoryQueryList 按中文分隔符逐项拆分', () => {
  assert.deepEqual(splitInventoryQueryList('延凡草、瑶丛'), ['延凡草', '瑶丛']);
  assert.deepEqual(splitInventoryQueryList('业珀，溶灵尊'), ['业珀', '溶灵尊']);
  assert.deepEqual(splitInventoryQueryList('业珀,溶灵尊'), ['业珀', '溶灵尊']);
  assert.deepEqual(splitInventoryQueryList('业珀；溶灵尊'), ['业珀', '溶灵尊']);
  assert.deepEqual(splitInventoryQueryList('业珀 和 溶灵尊'), ['业珀', '溶灵尊']);
  assert.deepEqual(splitInventoryQueryList('业珀 以及 溶灵尊 与 瑶丛'), ['业珀', '溶灵尊', '瑶丛']);
});

test('splitInventoryQueryList 单品保留名称内空格，空输入返回空表', () => {
  assert.deepEqual(splitInventoryQueryList('Wukong Prime'), ['Wukong Prime']);
  assert.deepEqual(splitInventoryQueryList(''), []);
});

// —— 命令白名单：只有精确个人命令才走快照通道，其余交给模型 ——

test('parseAlecaMessage 识别全部白名单个人命令', () => {
  assert.deepEqual(parseAlecaMessage('我的账号'), { command: 'account', query: '' });
  assert.deepEqual(parseAlecaMessage('账号状态'), { command: 'account', query: '' });
  assert.deepEqual(parseAlecaMessage('开遗物 杜卡德 悟空p'), { command: 'recommend', query: '杜卡德 悟空p' });
  assert.deepEqual(parseAlecaMessage('精炼推荐'), { command: 'refine', query: '' });
  assert.deepEqual(parseAlecaMessage('奸商推荐'), { command: 'trader-shopping', query: '' });
  assert.equal(parseAlecaMessage('杜卡德 清仓 保留1套').command, 'ducat-plan');
  assert.deepEqual(parseAlecaMessage('轮换日历'), { command: 'rotation-calendar', query: '' });
  assert.deepEqual(parseAlecaMessage('商店 1'), { command: 'shop', query: '1' });
  assert.deepEqual(parseAlecaMessage('本周好货'), { command: 'weekly-deals', query: '' });
  assert.deepEqual(parseAlecaMessage('我的紫卡'), { command: 'rivens', query: '' });
  assert.deepEqual(parseAlecaMessage('我的紫卡 守望者'), { command: 'rivens', query: '守望者' });
  assert.deepEqual(parseAlecaMessage('我的遗物 前N11'), { command: 'relic', query: '前N11' });
  assert.deepEqual(parseAlecaMessage('我的赋能 充沛'), { command: 'arcane', query: '充沛' });
  assert.deepEqual(parseAlecaMessage('我的库存 悟空p'), { command: 'inventory', query: '悟空p' });
  assert.deepEqual(parseAlecaMessage('我有多少延凡草'), { command: 'inventory', query: '延凡草' });
  assert.deepEqual(parseAlecaMessage('我有悟空p吗'), { command: 'inventory', query: '悟空p' });
  assert.deepEqual(parseAlecaMessage('账号周常'), { command: 'weekly', query: '' });
  assert.deepEqual(parseAlecaMessage('刷新账号'), { command: 'refresh-help', query: '' });
});

test('parseAlecaMessage 前置斜杠与大小写空白容错', () => {
  assert.deepEqual(parseAlecaMessage('/我的账号'), { command: 'account', query: '' });
  assert.deepEqual(parseAlecaMessage('/商店  2'), { command: 'shop', query: '2' });
  assert.equal(parseAlecaMessage('  MY 账号  '), null); // 命令本身是中文白名单，不认英文
  assert.equal(parseAlecaMessage('/ 商店  2'), null); // 只剥紧贴命令的前导斜杠，斜杠后带空格不接管
});

test('parseAlecaMessage 非白名单输入返回 null 不拦截', () => {
  assert.equal(parseAlecaMessage('今天天气怎么样'), null);
  assert.equal(parseAlecaMessage('我的账号请查一下'), null); // 精确匹配，尾随内容不进入
  assert.equal(parseAlecaMessage('帮我看看库存'), null); // 非「我有/我有多少」前缀
  assert.equal(parseAlecaMessage('账号密码是多少'), null);
  assert.equal(parseAlecaMessage(''), null);
});

// —— 父成品持有标注：快照缺装备栏时保守返回 null，绝不误判“可以兑换” ——

test('annotateParentOwnership 装备栏完整时按 ItemType 判定父成品持有', () => {
  const entries = [
    { uniqueName: '/Lotus/Types/Recipes/WarframeRecipes/WukongPrimeBlueprint', parentUniqueName: '/Lotus/Powersuits/Wukong/WukongPrime' },
    { uniqueName: '/Lotus/Types/Recipes/Weapons/SomeGunPrimeBarrel', parentUniqueName: '/Lotus/Weapons/Tenno/LongGuns/SomeGun/SomeGunPrime' },
    { uniqueName: '/Lotus/Types/Items/MiscItems/PrimeBucks', parentUniqueName: null },
  ];
  const inventory = { Suits: [{ ItemType: '/Lotus/Powersuits/Wukong/WukongPrime' }] };
  const out = annotateParentOwnership(entries, inventory);
  assert.equal(out[0].parentOwned, true);
  assert.equal(out[1].parentOwned, false);
  assert.equal(out[2].parentOwned, null);
});

test('annotateParentOwnership 全部装备栏缺失时保守返回 null', () => {
  const out = annotateParentOwnership([{ parentUniqueName: '/Lotus/Powersuits/Wukong/WukongPrime' }], { MiscItems: [] });
  assert.equal(out[0].parentOwned, null);
});

test('annotateParentOwnership 空表与脏数据不抛异常', () => {
  assert.deepEqual(annotateParentOwnership(null, null), []);
  assert.deepEqual(annotateParentOwnership(undefined, { Suits: 'not-an-array' }), []);
});
