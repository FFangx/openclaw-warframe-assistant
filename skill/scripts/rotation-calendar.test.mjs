import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRotationCalendar, CIRCUIT_EPOCH_MS, parseVarziaSchedule, resolveRotationTarget, __resetRotationTablesForTest } from './rotation-calendar.mjs';

const WEEK_MS = 604_800_000;
// 固定“现在”：第 3 周中间，避免测试随时钟漂移
const now = CIRCUIT_EPOCH_MS + 3 * WEEK_MS + 12 * 3600_000;
const expiry = (ms) => ({ Expiry: { $date: { $numberLong: String(ms) } } });

test.after(() => __resetRotationTablesForTest(undefined));

// —— 瓦奇娅排期：官方 ScheduleInfo → 升序档期链 ——

test('parseVarziaSchedule 解析复刻包名、过滤过期档并排序', () => {
  const worldState = {
    PrimeVaultTraders: [{
      ScheduleInfo: [
        { ...expiry(now + 2 * WEEK_MS), FeaturedItem: 'MPVEmberPrimeDualPack' },
        { ...expiry(now + 5 * WEEK_MS), FeaturedItem: 'MPVRhinoMesaPrimeDualPack', PreviewHiddenUntil: { $date: { $numberLong: String(now + 6 * WEEK_MS) } } },
        { ...expiry(now - WEEK_MS), FeaturedItem: 'MPVOldPrimeDualPack' },
      ],
    }],
  };
  const out = parseVarziaSchedule(worldState, now);
  assert.equal(out.length, 2); // 过期档被过滤
  assert.deepEqual(out[0].names, ['Ember']);
  assert.equal(out[0].startMs, null); // 当期在售
  assert.equal(out[0].hidden, false);
  assert.equal(out[0].label, 'Ember Prime 复刻');
  assert.deepEqual(out[1].names, ['Rhino', 'Mesa']);
  assert.equal(out[1].startMs, out[0].expiryMs); // 档期链：上一期 expiry 起
  assert.equal(out[1].hidden, true);
  assert.equal(out[1].label, '未公布');
});

test('parseVarziaSchedule 缺失或异常输入安全降级', () => {
  assert.deepEqual(parseVarziaSchedule(null, now), []);
  assert.deepEqual(parseVarziaSchedule({}, now), []);
  assert.deepEqual(parseVarziaSchedule({ PrimeVaultTraders: [] }, now), []);
});

// —— 8 周日历：周算术、已有标注、换期行 ——

test('buildRotationCalendar 生成 8 周行并标注持有与瓦奇娅换期', async () => {
  const frames = Array.from({ length: 11 }, () => [{ zh: '战甲A', en: 'FrameA' }, { zh: '战甲B', en: 'FrameB' }]);
  const weapons = Array.from({ length: 9 }, () => [{ zh: '武器X', en: 'WeaponX' }, { zh: '武器Y', en: 'WeaponY' }]);
  __resetRotationTablesForTest({ frames, weapons });
  const names = { uniqByName: new Map([['FrameA', '/Lotus/Powersuits/FrameA/FrameAPrime']]) };
  const inventory = { Suits: [{ ItemType: '/Lotus/Powersuits/FrameA/FrameAPrime' }] };
  // 瓦奇娅：当期 Ember，下期 Mesa 在第 5 周起点开卖（当前周=3）
  const mesaStart = CIRCUIT_EPOCH_MS + 5 * WEEK_MS;
  const worldState = {
    PrimeVaultTraders: [{
      ScheduleInfo: [
        { ...expiry(mesaStart), FeaturedItem: 'MPVEmberPrimeDualPack' },
        { ...expiry(mesaStart + 3 * WEEK_MS), FeaturedItem: 'MPVMesaPrimeSinglePack' },
      ],
    }],
  };
  const out = await buildRotationCalendar({ weeks: 8, inventory, names, worldState, now });
  assert.equal(out.rows.length, 8);
  assert.equal(out.rows[0].current, true);
  assert.equal(out.rows[0].week, 3);
  assert.equal(out.rows[0].frames[0].owned, true); // Suits 精确比对
  assert.equal(out.rows[0].frames[1].owned, false);
  const change = out.rows.find((row) => row.varzia);
  assert.ok(change, '第 5 周应有瓦奇娅换期');
  assert.equal(change.week, 5);
  assert.equal(change.varzia.label, 'Mesa Prime 复刻');
  assert.equal(change.varzia.atMs, mesaStart);
  assert.equal(out.varziaCurrent.label, 'Ember Prime 复刻');
});

test('buildRotationCalendar 无个人数据时降级无「已有」标', async () => {
  const frames = Array.from({ length: 11 }, () => [{ zh: '战甲A', en: 'FrameA' }]);
  const weapons = Array.from({ length: 9 }, () => [{ zh: '武器X', en: 'WeaponX' }]);
  __resetRotationTablesForTest({ frames, weapons });
  const out = await buildRotationCalendar({ weeks: 8, inventory: null, names: null, worldState: null, now });
  assert.equal(out.rows.length, 8);
  assert.equal(out.rows[0].frames[0].owned, false);
  assert.deepEqual(out.varziaCurrent, null);
});

// —— 订阅目标解析：回廊战甲/武器 → 泰辛 → 瓦奇娅 ——

test('resolveRotationTarget 定位未来轮换并给出当前/未来标记', async () => {
  const frames = Array.from({ length: 11 }, (_, week) => [{ zh: `战甲${week}`, en: `Frame${week}` }]);
  const weapons = Array.from({ length: 9 }, () => [{ zh: '武器X', en: 'WeaponX' }]);
  __resetRotationTablesForTest({ frames, weapons });
  const next = await resolveRotationTarget('Frame4', { now, worldState: null, horizonWeeks: 12 });
  assert.equal(next.source, 'circuit-frame');
  assert.equal(next.current, false);
  assert.equal(next.atMs, CIRCUIT_EPOCH_MS + 4 * WEEK_MS); // 下周起点
  const current = await resolveRotationTarget('战甲3', { now, worldState: null, horizonWeeks: 12 });
  assert.equal(current.source, 'circuit-frame');
  assert.equal(current.current, true);
  const weapon = await resolveRotationTarget('WeaponX', { now, worldState: null, horizonWeeks: 12 });
  assert.equal(weapon.source, 'circuit-weapon');
});

test('resolveRotationTarget 泰辛与瓦奇娅、未知目标与过短查询', async () => {
  const frames = Array.from({ length: 11 }, () => [{ zh: '战甲A', en: 'FrameA' }]);
  const weapons = Array.from({ length: 9 }, () => [{ zh: '武器X', en: 'WeaponX' }]);
  __resetRotationTablesForTest({ frames, weapons });
  const teshin = await resolveRotationTarget('Umbra Forma 蓝图', { now, worldState: null, horizonWeeks: 12 });
  assert.equal(teshin.source, 'teshin');
  assert.ok(teshin.label.includes('Umbra Forma'));
  const worldState = { PrimeVaultTraders: [{ ScheduleInfo: [{ ...expiry(now + 2 * WEEK_MS), FeaturedItem: 'MPVEmberPrimeDualPack' }] }] };
  const varzia = await resolveRotationTarget('Ember Prime', { now, worldState, horizonWeeks: 12 });
  assert.equal(varzia.source, 'varzia');
  assert.equal(varzia.current, true); // 当期在售
  assert.equal(await resolveRotationTarget('不存在的物品XYZ', { now, worldState, horizonWeeks: 12 }), null);
  assert.equal(await resolveRotationTarget('a', { now, worldState, horizonWeeks: 12 }), null);
});
