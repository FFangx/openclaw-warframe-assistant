import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAccountSnapshotCard, buildDucatPlanCard, buildFissureQueryCard, buildIntelCard,
  buildWeeklyDetailCard, currency, documentShell, escapeHtml,
} from './warframe-cards.mjs';

const future = new Date(Date.now() + 3600_000).toISOString();
const fetchedAt = '2026-08-17T08:00:00.000Z';

// —— 共享原语 ——

test('documentShell 输出固定 UTF-8 深色文档壳', () => {
  const html = documentShell('<div>x</div>', 246, 600);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /charset="utf-8"/i);
  assert.match(html, /width:600px/);
  assert.match(html, /height:246px/);
  assert.ok(html.includes('background:#111419'));
});

test('escapeHtml 转义全部五种敏感字符', () => {
  assert.equal(escapeHtml(`<script>"x"&'y'</script>`), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');
});

test('currency 输出图标+数字（千分位），无素材时回退纯文字单位', () => {
  const out = currency('plat', 1234, { size: 14 });
  assert.ok(out.includes('1,234')); // toLocaleString('zh-CN') 千分位
  assert.ok(out.includes('data:image') || out.includes(' p')); // 图标或回退单位至少其一
  assert.ok(!out.includes('undefined'));
});

// —— 卡片结构回归：无英文装饰标题、用户内容全部转义、固定特征在卡 ——

function assertCardShape({ html, width = 600, forbidden = /VOID FISSURE|ARBITRATION|WARFRAME INTEL|NIGHTWAVE CARD/iu, contains = [] }) {
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('class="card"'));
  assert.ok(html.includes('class="footer"'));
  if (width === 600) assert.ok(!html.includes('width:800px'));
  assert.ok(!forbidden.test(html), `卡片不得出现英文装饰标题: ${html.match(forbidden)?.[0]}`);
  for (const text of contains) assert.ok(html.includes(text), `卡片应包含「${text}」`);
  return html;
}

test('裂缝查询卡：标题与内容转义、中文标签齐全', () => {
  const card = buildFissureQueryCard({
    title: '<script>alert(1)</script>',
    normal: [{ id: 'f1', tier: 'Lith', expiry: future, mission: '<img src=x>', faction: 'Grineer', planet: '地球', node: 'E Prime', tags: [], recommendation: null }],
    hard: [{ id: 'f2', tier: 'Axi', expiry: future, mission: '歼灭', faction: 'Corpus', planet: '火星', node: 'Paimon', tags: [], recommendation: null }],
    fetchedAt,
  });
  assertCardShape({ html: card.html, width: 800, contains: ['虚空裂缝', '普通虚空裂缝', '钢铁之路裂缝', '古纪', '后纪'] });
  assert.ok(!card.html.includes('<script>alert(1)'));
  assert.ok(!card.html.includes('<img src=x>'));
  assert.ok(card.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(card.html.includes('&lt;img src=x&gt;'));
  assert.ok(card.key.startsWith('fissure-'));
  assert.equal(card.width, 800);
});

test('周常一图流：800px 高清渲染、任务名转义、无英文标题', () => {
  const card = buildWeeklyDetailCard({
    tasks: [
      { number: 1, name: '<b>注入式</b>', done: true, detailLines: ['执刑官：<script>Nira</script>'] },
      { number: 2, name: '午夜电波挑战', done: false, detailLines: [] },
    ],
    nextReset: future,
    worldStateAvailable: true,
  });
  assertCardShape({ html: card.html, width: 800, contains: ['本周周常 · 轮换与进度', '✓ 已完成', '○ 待完成', '轮换：公共世界状态'] });
  assert.ok(card.html.includes('&lt;b&gt;注入式&lt;/b&gt;'));
  assert.ok(card.html.includes('&lt;script&gt;Nira&lt;/script&gt;'));
  assert.equal(card.width, 800);
  assert.equal(card.scale, 2);
});

test('账号快照卡：仅用户私聊标注 + 货币图标 + 快照时间', () => {
  const card = buildAccountSnapshotCard({
    title: '我的账号状态',
    syncedAt: fetchedAt,
    metrics: [
      { label: '白金', value: 42, currencyKind: 'plat' },
      { label: '现金', value: 1234567, currencyKind: 'credit' },
    ],
    footnote: '遗物 0 个 · 满级赋能 0 个',
  });
  assertCardShape({ html: card.html, contains: ['仅用户私聊', '来源：本机账号快照', '我的账号状态', '42'] });
  assert.ok(card.html.includes('data:image')); // 官方货币图标内嵌
});

test('杜卡德卡：目标金额、兑换列与机会成本结构', () => {
  const card = buildDucatPlanCard({
    mode: 'target', target: 600, totalDucats: 480, totalPlat: 42, shortfall: 120, complete: false,
    rows: [{ uniqueName: '/x', name: '合成 Prime 部件', owned: 3, reserve: 1, exchangeQty: 2, totalDucats: 90, unitPlat: 3, totalPlat: 6, dailyVolume: 12, marketBasis: 'today', reserveState: 'owned', reserveReason: '留1套' }],
    syncedAt: fetchedAt,
  });
  assertCardShape({ html: card.html, contains: ['目标', '杜卡德', '机会成本=可靠成交中位', '兑换', '留1套'] });
  assert.ok(card.html.includes('还差'));
  assert.ok(!card.html.includes('undefined'));
});

test('情报卡：情报雷达标题、构造进度条与空态降级', () => {
  const card = buildIntelCard({
    title: '重要情报 · 1 条更新',
    items: [{ id: 'e1', type: 'event', description: '可立鸡大量出没', detail: '<script>detail</script>', expiry: future }],
    construction: { fomorian: 46.2, razorback: 0 },
    fetchedAt,
  });
  assertCardShape({ html: card.html, contains: ['情报雷达', '特殊活动', '可立鸡大量出没', 'Grineer 巨人战舰', '46.2%'] });
  assert.ok(card.html.includes('&lt;script&gt;detail&lt;/script&gt;'));
  const empty = buildIntelCard({ title: '重要情报', items: [], construction: null, emptyText: '当前没有可显示的情报', fetchedAt });
  assert.ok(empty.html.includes('当前没有可显示的情报'));
});

// —— 英文装饰标题禁令覆盖（卡片全家族抽查） ——

test('抽查卡片族均不出现英文装饰标题', () => {
  const samples = [
    buildFissureQueryCard({ title: '裂缝', normal: [], hard: [], fetchedAt }).html,
    buildIntelCard({ title: '情报', items: [], fetchedAt }).html,
    buildWeeklyDetailCard({ tasks: [], nextReset: future, worldStateAvailable: false }).html,
    buildAccountSnapshotCard({ title: '账号', syncedAt: fetchedAt, metrics: [] }).html,
    buildDucatPlanCard({ mode: 'target', target: 0, totalDucats: 0, totalPlat: 0, shortfall: 0, complete: true, rows: [], syncedAt: fetchedAt }).html,
  ];
  for (const html of samples) {
    assert.ok(!/VOID FISSURE|ARBITRATION|WARFRAME INTEL/iu.test(html));
  }
});
