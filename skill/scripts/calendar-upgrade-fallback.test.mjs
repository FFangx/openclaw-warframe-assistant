import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// 1999 日历增益译名兜底层（2026-08-27）：未知路径/缺效果 inbox + AI 查证学习词典。
// 隔离缓存目录：模块在 import 时解析 WARFRAME_DATA_CACHE_DIR，必须先设再动态导入。
const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'calendar-upgrade-fallback-'));
process.env.WARFRAME_DATA_CACHE_DIR = cacheDir;
const {
  CALENDAR_UPGRADE_SEEDS, clearPendingCalendarUpgrades, flushCalendarQueues,
  getLearnedCalendarUpgradeEntries, learnCalendarUpgradeVerified, queuePendingCalendarUpgrade,
  readPendingCalendarUpgrades, removePendingCalendarUpgrade, resolveCalendarCoverage,
} = await import('./calendar-upgrade-fallback.mjs');

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('./calendar-upgrade-fallback.mjs', import.meta.url));
const cliEnv = { ...process.env, WARFRAME_DATA_CACHE_DIR: cacheDir };
async function runCli(...args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { env: cliEnv, encoding: 'utf8' });
    return { exitCode: 0, result: JSON.parse(stdout) };
  } catch (error) {
    return { exitCode: error.code, result: JSON.parse(String(error.stdout || '')) };
  }
}
const inboxFile = path.join(cacheDir, 'calendar-upgrade-inbox.json');
const learnFile = path.join(cacheDir, 'calendar-upgrade-zh.json');
const SEED_PATH = '/Lotus/Upgrades/Calendar/Armor';
const UNKNOWN_PATH = '/Lotus/Upgrades/Calendar/BrandNewCalendarPath';

test.after(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

test('种子表来自 weekly-static.json 灰机wiki 核验条目（含 PunchToPrimary/人多势众 等新增路径）', () => {
  assert.equal(CALENDAR_UPGRADE_SEEDS['/lotus/upgrades/calendar/punchtoprimary'].name, '打孔纸带');
  assert.equal(CALENDAR_UPGRADE_SEEDS['/lotus/upgrades/calendar/punchtoprimary'].desc, '主要武器穿透增加1.5米');
  assert.equal(CALENDAR_UPGRADE_SEEDS['/lotus/upgrades/calendar/companionsbuffnearbyplayer'].name, '人多势众');
  assert.equal(CALENDAR_UPGRADE_SEEDS['/lotus/upgrades/calendar/companionsbuffnearbyplayer'].desc, '20米内每名非Tenno友军增加5%近战攻击速度和20%射速');
  assert.equal(CALENDAR_UPGRADE_SEEDS['/lotus/upgrades/calendar/armor'].name, '硬化装甲');
  assert.equal(CALENDAR_UPGRADE_SEEDS['/lotus/upgrades/calendar/energyrestoration'].name, '特浓咖啡');
  assert.equal(CALENDAR_UPGRADE_SEEDS['/lotus/upgrades/calendar/magnetstatuspull'].name, '吸引力');
  assert.equal(CALENDAR_UPGRADE_SEEDS['/lotus/upgrades/calendar/generateomniorbsonweakkill'].name, '强制输血');
});

test('未知日历增益路径进 inbox：去重累计、非路径键不入队、learn 同键回填 {name, desc, source} 并出队', async () => {
  await clearPendingCalendarUpgrades();
  await queuePendingCalendarUpgrade(UNKNOWN_PATH);
  await queuePendingCalendarUpgrade(' /lotus/upgrades/calendar/brandnewcalendarpath ');
  await queuePendingCalendarUpgrade('不是路径键'); // 纯中文/非路径键不入队
  await flushCalendarQueues();
  const pending = await readPendingCalendarUpgrades();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].path, '/lotus/upgrades/calendar/brandnewcalendarpath');
  assert.equal(pending[0].count, 2);
  assert.ok(pending[0].firstAt <= pending[0].lastAt);
  // learn 回填：双语名 + 效果 + 来源，按 inbox 同键写词典 + 出 inbox；重复 learn 幂等
  const first = await learnCalendarUpgradeVerified(UNKNOWN_PATH, '新历增益', '合成的效果说明。', '灰机wiki 1999日历');
  assert.equal(first.ok, true);
  assert.equal(first.outcome, 'written');
  assert.equal(first.removedFromInbox, true);
  const stored = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(stored.entries['/lotus/upgrades/calendar/brandnewcalendarpath'].name, '新历增益');
  assert.equal(stored.entries['/lotus/upgrades/calendar/brandnewcalendarpath'].desc, '合成的效果说明。');
  assert.equal(stored.entries['/lotus/upgrades/calendar/brandnewcalendarpath'].source, '灰机wiki 1999日历');
  assert.deepEqual(await getLearnedCalendarUpgradeEntries(), new Map([
    ['/lotus/upgrades/calendar/brandnewcalendarpath', { name: '新历增益', desc: '合成的效果说明。', source: '灰机wiki 1999日历' }],
  ]));
  const second = await learnCalendarUpgradeVerified(UNKNOWN_PATH, '新历增益', '合成的效果说明。', '灰机wiki 1999日历');
  assert.equal(second.ok, true);
  assert.equal(second.outcome, 'exists-same');
  assert.equal(second.removedFromInbox, false); // 已不在 inbox，静默幂等
  await clearPendingCalendarUpgrades();
  await flushCalendarQueues();
});

test('learn 拒绝夹带英文的译名与英文为主的效果说明，dismiss 干净出队', async () => {
  await clearPendingCalendarUpgrades();
  const validationPath = '/Lotus/Upgrades/Calendar/ValidationRejectPath';
  await queuePendingCalendarUpgrade(validationPath);
  const badName = await learnCalendarUpgradeVerified(validationPath, '新历 Buff 名', '效果说明。');
  assert.equal(badName.ok, false);
  assert.match(badName.error, /纯中文/);
  const badDesc = await learnCalendarUpgradeVerified(validationPath, '新历增益', 'This is an English description');
  assert.equal(badDesc.ok, false);
  assert.match(badDesc.error, /中文/);
  const latinDominant = await learnCalendarUpgradeVerified(validationPath, '新历增益', 'Tenno Prime Forma Kuva Endo Aya Mod 全程英文混排完全大于中文数量');
  assert.equal(latinDominant.ok, false);
  // 官方简中保留的拉丁专名（Tenno 等）允许出现在中文说明里
  const allowed = await learnCalendarUpgradeVerified(validationPath, '人多势众', '20米内每名非Tenno友军增加5%近战攻击速度和20%射速', '灰机wiki 1999日历');
  assert.equal(allowed.ok, true);
  assert.equal((await readPendingCalendarUpgrades()).length, 0);
  assert.equal(await removePendingCalendarUpgrade(validationPath), false);
  await clearPendingCalendarUpgrades();
  await flushCalendarQueues();
});

test('100 项上限：满员且是新路径时挤掉最久未见的一条', async () => {
  await clearPendingCalendarUpgrades();
  const items = {};
  for (let index = 0; index < 100; index += 1) {
    const key = `/lotus/upgrades/calendar/capitem${String(index).padStart(2, '0')}`;
    items[key] = { firstAt: 1_000_000 + index * 1000, lastAt: 1_000_000 + index * 1000, count: 1 };
  }
  await writeFile(inboxFile, JSON.stringify({ version: 1, items }), 'utf8');
  await queuePendingCalendarUpgrade('/Lotus/Upgrades/Calendar/BrandNewCapItem');
  let pending = await readPendingCalendarUpgrades();
  assert.equal(pending.length, 100);
  assert.ok(pending.some((item) => item.path === '/lotus/upgrades/calendar/brandnewcapitem'));
  assert.ok(!pending.some((item) => item.path === '/lotus/upgrades/calendar/capitem00'), '最久未见的一条应被挤出');
  await queuePendingCalendarUpgrade('/Lotus/Upgrades/Calendar/CapItem50');
  pending = await readPendingCalendarUpgrades();
  assert.equal(pending.length, 100);
  assert.equal(pending.find((item) => item.path === '/lotus/upgrades/calendar/capitem50').count, 2);
  await clearPendingCalendarUpgrades();
});

test('并发入队：Promise.all 去重累计、落盘文件始终是合法 JSON（原子持久化）', async () => {
  await clearPendingCalendarUpgrades();
  const tasks = [];
  for (let index = 0; index < 40; index += 1) tasks.push(queuePendingCalendarUpgrade('/Lotus/Upgrades/Calendar/DupConcurrencyKey'));
  for (let index = 0; index < 60; index += 1) tasks.push(queuePendingCalendarUpgrade(`/Lotus/Upgrades/Calendar/UniqueKey${index}`));
  await Promise.all(tasks);
  await flushCalendarQueues();
  const pending = await readPendingCalendarUpgrades();
  assert.equal(pending.length, 61);
  assert.equal(pending.find((item) => item.path === '/lotus/upgrades/calendar/dupconcurrencykey').count, 40);
  const stored = JSON.parse(await readFile(inboxFile, 'utf8'));
  assert.equal(Object.keys(stored.items).length, 61);
  const leftovers = (await readdir(cacheDir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  await clearPendingCalendarUpgrades();
});

test('先入队后 dismiss 串行化：排队中的写入不会复活已出队条目', async () => {
  await clearPendingCalendarUpgrades();
  const queued = queuePendingCalendarUpgrade('/Lotus/Upgrades/Calendar/RaceConditionKey'); // 不 await，排队
  const removed = await removePendingCalendarUpgrade('/lotus/upgrades/calendar/raceconditionkey'); // 紧随其后的出队
  await Promise.all([queued, removed]);
  await flushCalendarQueues();
  const pending = await readPendingCalendarUpgrades();
  assert.ok(!pending.some((item) => item.path === '/lotus/upgrades/calendar/raceconditionkey'), 'dismiss 后条目不得被排队中的入队写回复活');
  assert.equal(removed, true);
  await clearPendingCalendarUpgrades();
});

test('学习词典种子不可被 learn 覆盖，也不落盘种子键', async () => {
  await queuePendingCalendarUpgrade(SEED_PATH);
  const clash = await learnCalendarUpgradeVerified(SEED_PATH, '硬化装甲（篡改）', '增加300护甲', '灰机wiki 1999日历');
  assert.equal(clash.ok, false);
  assert.equal(clash.outcome, 'seed');
  assert.equal(clash.existingName, '硬化装甲');
  assert.equal(clash.existingDesc, '增加250护甲');
  assert.equal(clash.removedFromInbox, false);
  assert.equal((await readPendingCalendarUpgrades()).length, 1);
  // 种子权威键同译名：幂等确认并出队（不写盘）
  const same = await learnCalendarUpgradeVerified(SEED_PATH, '硬化装甲', '增加250护甲', '灰机wiki 1999日历');
  assert.equal(same.ok, true);
  assert.equal(same.outcome, 'exists-same');
  assert.equal(same.removedFromInbox, true);
  const stored = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(stored.entries['/lotus/upgrades/calendar/armor'], undefined, '种子权威键永不落盘');
  await clearPendingCalendarUpgrades();
});

test('社区/静态已覆盖的路径不得 learn（covered/seed），inbox 保留，按合同 dismiss', async () => {
  await clearPendingCalendarUpgrades();
  // 预写社区状态表磁盘缓存（与 wfdata cachedBuild 同构，零联网）：社区覆盖的路径
  await writeFile(path.join(cacheDir, 'calendar-state-zh.json'), JSON.stringify({
    at: Date.now(), v: 1,
    data: [
      ['/Lotus/Upgrades/Calendar/CommunityFullPath', { name: '社区全量', description: '社区效果。' }],
      ['/Lotus/Upgrades/Calendar/CommunityNameOnlyPath', { name: '社区仅名称', description: '' }],
    ],
  }), 'utf8');
  const COMMUNITY_FULL = '/Lotus/Upgrades/Calendar/CommunityFullPath';
  // 同名同效果：社区表已权威提供 → 幂等确认并出队（不写词典）
  await queuePendingCalendarUpgrade(COMMUNITY_FULL);
  const same = await learnCalendarUpgradeVerified(COMMUNITY_FULL, '社区全量', '社区效果。', '灰机wiki 1999日历', { resolveCovered: resolveCalendarCoverage });
  assert.equal(same.ok, true);
  assert.equal(same.outcome, 'exists-same');
  assert.equal((await readPendingCalendarUpgrades()).length, 0);
  // 异名：community covered，ok:false 且 inbox 保留
  await queuePendingCalendarUpgrade(COMMUNITY_FULL);
  const clash = await learnCalendarUpgradeVerified(COMMUNITY_FULL, '社区全量（误传）', '别的效果', '灰机wiki 1999日历', { resolveCovered: resolveCalendarCoverage });
  assert.equal(clash.ok, false);
  assert.equal(clash.outcome, 'covered');
  assert.equal(clash.existingName, '社区全量');
  assert.equal(clash.existingDesc, '社区效果。');
  assert.equal(clash.removedFromInbox, false);
  assert.equal((await readPendingCalendarUpgrades()).length, 1);
  // 安全处置：已有译名有据 → dismiss 出队
  assert.equal(await removePendingCalendarUpgrade(COMMUNITY_FULL), true);
  assert.equal((await readPendingCalendarUpgrades()).length, 0);

  // 社区只有名称时不能当作完整覆盖：无效果的 learn 保留 inbox；同名有据效果允许补缺并出队。
  const COMMUNITY_NAME_ONLY = '/Lotus/Upgrades/Calendar/CommunityNameOnlyPath';
  await queuePendingCalendarUpgrade(COMMUNITY_NAME_ONLY);
  const stillMissing = await learnCalendarUpgradeVerified(COMMUNITY_NAME_ONLY, '社区仅名称', '', '灰机wiki 1999日历', { resolveCovered: resolveCalendarCoverage });
  assert.equal(stillMissing.ok, false);
  assert.equal(stillMissing.outcome, 'effect-missing');
  assert.equal((await readPendingCalendarUpgrades()).length, 1);
  const completed = await learnCalendarUpgradeVerified(COMMUNITY_NAME_ONLY, '社区仅名称', '后来查到的社区效果。', '灰机wiki 1999日历', { resolveCovered: resolveCalendarCoverage });
  assert.equal(completed.ok, true);
  assert.equal(completed.outcome, 'written');
  assert.equal(completed.removedFromInbox, true);
  const learned = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(learned.entries['/lotus/upgrades/calendar/communitynameonlypath'].desc, '后来查到的社区效果。');
  await clearPendingCalendarUpgrades();
});

test('词典已有同键不同译名/效果时 learn 拒绝覆盖、inbox 保留；同名缺效果允许补缺', async () => {
  await clearPendingCalendarUpgrades();
  const conflictPath = '/Lotus/Upgrades/Calendar/DictionaryConflictPath';
  const fillPath = '/Lotus/Upgrades/Calendar/NameOnlyLearnedPath';
  // ① 先写入一条完整条目
  await learnCalendarUpgradeVerified(conflictPath, '既有译名', '既有效果', '灰机wiki 1999日历');
  // ② 异名覆盖尝试：conflict，inbox 保留
  await queuePendingCalendarUpgrade(conflictPath);
  const clash = await learnCalendarUpgradeVerified(conflictPath, '新来译名', '新效果', '灰机wiki 1999日历');
  assert.equal(clash.ok, false);
  assert.equal(clash.outcome, 'conflict');
  assert.equal(clash.existingName, '既有译名');
  assert.match(clash.error, /dismiss/);
  assert.equal(clash.removedFromInbox, false);
  assert.equal((await readPendingCalendarUpgrades()).length, 1);
  const stored = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(stored.entries['/lotus/upgrades/calendar/dictionaryconflictpath'].name, '既有译名');
  // ③ 同名但效果不同：仍 conflict（有说明的条目视为已完整）
  const clashDesc = await learnCalendarUpgradeVerified(conflictPath, '既有译名', '另一个效果', '灰机wiki 1999日历');
  assert.equal(clashDesc.ok, false);
  assert.equal(clashDesc.outcome, 'conflict');
  // ④ 同名且原条目缺效果：允许补缺（updated，不是覆盖），并出队
  await removePendingCalendarUpgrade(conflictPath);
  await learnCalendarUpgradeVerified(fillPath, '有名无效果', '', '灰机wiki 1999日历');
  await queuePendingCalendarUpgrade(fillPath);
  const fill = await learnCalendarUpgradeVerified(fillPath, '有名无效果', '后来查到的效果', '灰机wiki 1999日历');
  assert.equal(fill.ok, true);
  assert.equal(fill.outcome, 'updated');
  assert.equal(fill.removedFromInbox, true);
  const fillStored = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(fillStored.entries['/lotus/upgrades/calendar/nameonlylearnedpath'].desc, '后来查到的效果');
  assert.equal((await readPendingCalendarUpgrades()).length, 0);
  await clearPendingCalendarUpgrades();
  await flushCalendarQueues();
});

test('合成故障注入：学习词典原子落盘失败时 learn 不出队、热路径 queue 静默', async () => {
  await clearPendingCalendarUpgrades();
  const faultPath = '/Lotus/Upgrades/Calendar/FaultInjectionPath';
  await queuePendingCalendarUpgrade(faultPath);
  await flushCalendarQueues();
  assert.equal((await readPendingCalendarUpgrades()).length, 1);
  // 用「词典文件路径被同名目录占用」制造原子落盘失败：rename 到目录必然抛错
  await rm(learnFile, { force: true });
  await mkdir(learnFile, { recursive: true });
  const outcome = await learnCalendarUpgradeVerified(faultPath, '故障注入译名', '故障注入效果', '灰机wiki 1999日历');
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /写入失败/);
  assert.equal((await readPendingCalendarUpgrades()).length, 1, 'inbox 条目原样保留：绝不先出队后写');
  // 热路径 queue 仍静默吞错、不 reject、不影响主流程
  await queuePendingCalendarUpgrade(faultPath);
  await flushCalendarQueues();
  assert.equal((await readPendingCalendarUpgrades())[0].count, 2);
  const leftovers = (await readdir(cacheDir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  // 恢复现场：移除占位目录后同一键可正常学习并出队
  await rm(learnFile, { recursive: true, force: true });
  const recovered = await learnCalendarUpgradeVerified(faultPath, '故障注入译名', '故障注入效果', '灰机wiki 1999日历');
  assert.equal(recovered.ok, true);
  assert.equal(recovered.outcome, 'written');
  assert.equal(recovered.removedFromInbox, true);
  assert.equal((await readPendingCalendarUpgrades()).length, 0);
  await clearPendingCalendarUpgrades();
});

test('CLI 闭环：inbox→learn（{name,desc,source}）→词典命中→出队，inbox→dismiss→出队（子进程零联网）', async () => {
  await clearPendingCalendarUpgrades();
  await writeFile(inboxFile, JSON.stringify({ version: 1, items: {
    '/lotus/upgrades/calendar/fixturelearn': { firstAt: 1, lastAt: 2, count: 3 },
    '/lotus/upgrades/calendar/fixturedismiss': { firstAt: 1, lastAt: 3, count: 1 },
  } }), 'utf8');
  const listed = await runCli('inbox');
  assert.equal(listed.exitCode, 0);
  assert.equal(listed.result.ok, true);
  assert.equal(listed.result.count, 2);
  assert.deepEqual(listed.result.items.map((item) => item.path).sort(), [
    '/lotus/upgrades/calendar/fixturedismiss', '/lotus/upgrades/calendar/fixturelearn',
  ]);
  const learned = await runCli('learn', '--path', '/lotus/upgrades/calendar/fixturelearn', '--name', '合成增益', '--desc', '合成效果。', '--source', '灰机wiki 1999日历');
  assert.equal(learned.exitCode, 0);
  assert.equal(learned.result.ok, true);
  assert.equal(learned.result.removedFromInbox, true);
  const stored = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(stored.entries['/lotus/upgrades/calendar/fixturelearn'].name, '合成增益');
  assert.equal(stored.entries['/lotus/upgrades/calendar/fixturelearn'].desc, '合成效果。');
  assert.equal(stored.entries['/lotus/upgrades/calendar/fixturelearn'].source, '灰机wiki 1999日历');
  const dismissed = await runCli('dismiss', '--path', '/lotus/upgrades/calendar/fixturedismiss', '--reason', '查无实据');
  assert.equal(dismissed.exitCode, 0);
  assert.equal(dismissed.result.ok, true);
  assert.equal(dismissed.result.removed, true);
  const empty = await runCli('inbox');
  assert.equal(empty.result.count, 0);
  assert.deepEqual(empty.result.items, []);
  // CLI learn 拒绝英文为主的译名/效果：退出码 1 且不写词典
  const rejectedName = await runCli('learn', '--path', '/lotus/upgrades/calendar/fixturelearn', '--name', 'Bad English 增益', '--desc', '合成效果。');
  assert.equal(rejectedName.exitCode, 1);
  assert.equal(rejectedName.result.ok, false);
  assert.match(rejectedName.result.error, /纯中文/);
  // CLI learn 对社区/静态已覆盖路径返回 ok:false（outcome=seed/covered），inbox 保留 → 按合同 dismiss
  await queuePendingCalendarUpgrade(SEED_PATH);
  await flushCalendarQueues();
  const seedClash = await runCli('learn', '--path', SEED_PATH, '--name', '硬化装甲（误传）', '--desc', '错误效果');
  assert.equal(seedClash.exitCode, 1);
  assert.equal(seedClash.result.ok, false);
  assert.equal(seedClash.result.outcome, 'seed');
  assert.equal(seedClash.result.removedFromInbox, false);
  assert.equal((await readPendingCalendarUpgrades()).length, 1);
  const seedDismiss = await runCli('dismiss', '--path', SEED_PATH, '--reason', '种子权威条目已覆盖');
  assert.equal(seedDismiss.result.removed, true);
  assert.equal((await readPendingCalendarUpgrades()).length, 0);
  await clearPendingCalendarUpgrades();
});
