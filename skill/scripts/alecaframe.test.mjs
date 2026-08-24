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

test('parseAlecaMessage 识别全部白名单个人命令及公开别名', () => {
  const cases = [
    [['我的账号', '账号状态', '我的状态'], { command: 'account', query: '' }],
    [['账号周常', '我的周常状态', '周常同步状态'], { command: 'weekly', query: '' }],
    [['刷新账号', '刷新库存'], { command: 'refresh-help', query: '' }],
    [['我的遗物'], { command: 'relic', query: '' }],
    [['我的遗物 前N11'], { command: 'relic', query: '前N11' }],
    [['我的赋能'], { command: 'arcane', query: '' }],
    [['我的赋能 充沛'], { command: 'arcane', query: '充沛' }],
    [['我的库存'], { command: 'inventory', query: '' }],
    [['我的库存 悟空p'], { command: 'inventory', query: '悟空p' }],
    [['我有多少延凡草', '我有多少个延凡草吗', '我有延凡草吗'], { command: 'inventory', query: '延凡草' }],
    [['开遗物 钢铁', '遗物推荐 钢铁', '开什么遗物 钢铁', '开什么 钢铁'], { command: 'recommend', query: '钢铁' }],
    [['精炼推荐', '遗物精炼', '值得精炼', '精炼什么'], { command: 'refine', query: '' }],
    [['精炼推荐 单人 杜卡德', '遗物精炼 单人 杜卡德'], { command: 'refine', query: '单人 杜卡德' }],
    [['杜卡德 清仓 保留1套'], { command: 'ducat-plan', query: '杜卡德 清仓 保留1套' }],
    [['杜卡德推荐 清仓 保留1套'], { command: 'ducat-plan', query: '杜卡德推荐 清仓 保留1套' }],
    [['杜卡德兑换 清仓 保留1套'], { command: 'ducat-plan', query: '杜卡德兑换 清仓 保留1套' }],
    [['奸商推荐', '奸商买什么', '奸商购物', '虚空商人推荐', '虚空商人买什么'], { command: 'trader-shopping', query: '' }],
    [['商店'], { command: 'shop', query: '' }],
    [['商店 泰辛'], { command: 'shop', query: '泰辛' }],
    [['本周好货', '好货', '好货清单'], { command: 'weekly-deals', query: '' }],
    [['轮换日历', '排期', '日历', '未来轮换'], { command: 'rotation-calendar', query: '' }],
    [['我的紫卡', '紫卡列表', '紫卡'], { command: 'rivens', query: '' }],
    [['我的紫卡 守望者', '紫卡 守望者'], { command: 'rivens', query: '守望者' }],
  ];
  for (const [inputs, expected] of cases) {
    for (const input of inputs) assert.deepEqual(parseAlecaMessage(input), expected, input);
  }
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
  assert.equal(parseAlecaMessage('紫卡列表 守望者'), null); // 列表别名不接受详情参数
  assert.equal(parseAlecaMessage('精炼推荐 单人 杜卡德 额外参数'), null);
  assert.equal(parseAlecaMessage('商店 泰辛 额外参数'), null);
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
