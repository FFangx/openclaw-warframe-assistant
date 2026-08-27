import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// 每日「奖励译名 AI 查证 + 1999 日历增益查证」任务端到端模拟（2026-08-21 首版，2026-08-27 扩展）。
//
// 真实任务是一条 agent 型 cron（declarationKey warframe-assistant:reward-zh-ai:default，
// 定义见仓库 config/cron/reward-zh-ai.job.json，由 install.ps1 安装/修复）：
//   1. node reward-zh-fallback.mjs inbox 读奖励待查证清单；再读 calendar-upgrade-fallback.mjs inbox
//      （1999 日历增益未知路径）；两个清单都为 0 才只回 NO_REPLY
//   2. 逐键用 Market/灰机wiki（日历增益只认灰机wiki「1999日历」页）查证（真实任务靠模型联网搜索）
//   3. 有据 → learn（奖励：--english/--zh；日历：--path/--name/--desc/--source）；
//      查无实据 → dismiss；日历 learn 返回 conflict/seed/covered → 按合同 dismiss（已被完整权威条目覆盖），
//      effect-missing 或 error 含「写入失败」→ 保留该键待下轮重试
//   4. 输出逐项简报
// 本测试用「静态证据表」替换第 2 步的联网+模型判断（零联网、零模型），其余步骤
// 全部走真实 CLI 子进程，验证 inbox→learn→词典命中→出队 与 inbox→dismiss→出队 全链。
// 缓存目录隔离在临时目录，绝不触碰运行时/仓库缓存。

const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'wf-daily-task-'));
process.env.WARFRAME_DATA_CACHE_DIR = cacheDir;
const { translateRewardName } = await import('./subscriptions.mjs');
const { queuePendingReward, clearPendingRewards, flushRewardQueues, readPendingRewards } = await import('./reward-zh-fallback.mjs');
const { queuePendingCalendarUpgrade, clearPendingCalendarUpgrades, flushCalendarQueues, readPendingCalendarUpgrades } = await import('./calendar-upgrade-fallback.mjs');

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('./reward-zh-fallback.mjs', import.meta.url));
const calendarCliPath = fileURLToPath(new URL('./calendar-upgrade-fallback.mjs', import.meta.url));
const cliEnv = { ...process.env, WARFRAME_DATA_CACHE_DIR: cacheDir };
const inboxFile = path.join(cacheDir, 'reward-zh-inbox.json');
const learnFile = path.join(cacheDir, 'reward-zh-fallback.json');
const calendarLearnFile = path.join(cacheDir, 'calendar-upgrade-zh.json');

async function runCli(...args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { env: cliEnv, encoding: 'utf8' });
    return { exitCode: 0, result: JSON.parse(stdout) };
  } catch (error) {
    return { exitCode: error.code, result: JSON.parse(String(error.stdout || '')) };
  }
}

async function runCalendarCli(...args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [calendarCliPath, ...args], { env: cliEnv, encoding: 'utf8' });
    return { exitCode: 0, result: JSON.parse(stdout) };
  } catch (error) {
    return { exitCode: error.code, result: JSON.parse(String(error.stdout || '')) };
  }
}

// 静态证据表：模拟「模型联网查证后的判断」。learn 条目必须有据（灰机wiki/Market 口径），
// 查无实据的键对应 null → dismiss。禁止凭猜测翻译与真实任务同口径。
const EVIDENCE = new Map([
  ['grineer combat knife sortie blueprint', { zh: '希芙 蓝图', source: '灰机wiki' }],
  ['mystery widget alpha', null], // 查无实据 → dismiss，保持诚实占位
  ['twin vipers barrel', { zh: '双子蝰蛇 枪管', source: '灰机wiki' }],
]);

// 日历增益证据表：只认灰机wiki「1999日历」页六人组覆写表。armor 是静态种子权威条目：
// 即使模型查到不同译名，learn 也必得 outcome=seed 然后按合同 dismiss。
const CALENDAR_EVIDENCE = new Map([
  ['/lotus/upgrades/calendar/brandnewcalendarpath', { name: '新历增益', desc: '合成的效果说明。', source: '灰机wiki 1999日历' }],
  ['/lotus/upgrades/calendar/armor', { name: '硬化装甲（模型误传）', desc: '错误效果', source: '灰机wiki 1999日历' }],
  ['/lotus/upgrades/calendar/mysterycalendarpath', null], // 查无实据 → dismiss，保持诚实占位
]);

// 与 cron 提示词完全一致的「agent 决策循环」：读清单 → 逐键查证 → learn/dismiss → 简报
async function runDailyAgentTurn() {
  const listed = await runCli('inbox');
  assert.equal(listed.exitCode, 0, 'inbox CLI 必须成功');
  const calListed = await runCalendarCli('inbox');
  assert.equal(calListed.exitCode, 0, 'calendar inbox CLI 必须成功');
  if ((listed.result.count === 0 || listed.result.items.length === 0)
    && (calListed.result.count === 0 || calListed.result.items.length === 0)) return 'NO_REPLY';
  const summary = [];
  for (const item of listed.result.items) {
    const evidence = EVIDENCE.get(item.english);
    if (evidence) {
      const outcome = await runCli('learn', '--english', item.english, '--zh', evidence.zh, '--source', evidence.source);
      summary.push(`${item.english} → ${outcome.result.ok ? '已学习' : '未处理'}（${evidence.source}）`);
    } else {
      const outcome = await runCli('dismiss', '--english', item.english, '--reason', '查无实据');
      summary.push(`${item.english} → ${outcome.result.ok ? '已驳回' : '未处理'}`);
    }
  }
  for (const item of calListed.result.items) {
    const evidence = CALENDAR_EVIDENCE.get(item.path);
    if (!evidence) {
      const outcome = await runCalendarCli('dismiss', '--path', item.path, '--reason', '查无实据');
      summary.push(`${item.path} → ${outcome.result.ok ? '已驳回' : '未处理'}`);
      continue;
    }
    const outcome = await runCalendarCli('learn', '--path', item.path, '--name', evidence.name, '--desc', evidence.desc, '--source', evidence.source);
    if (outcome.result.ok) {
      summary.push(`${item.path} → 已学习（${evidence.source}）`);
    } else if (['conflict', 'seed', 'covered'].includes(outcome.result.outcome)) {
      // 合同：词典/静态/社区已覆盖 → 安全处置 dismiss
      await runCalendarCli('dismiss', '--path', item.path, '--reason', '已被权威条目覆盖');
      summary.push(`${item.path} → 已驳回（${outcome.result.outcome}）`);
    } else {
      summary.push(`${item.path} → 未处理（${outcome.result.outcome || outcome.result.error}）`);
    }
  }
  return summary.join('\n');
}

test.after(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

test('每日任务模拟：inbox→learn→词典命中→出队 与 dismiss→出队 全链（CLI 子进程，无联网无模型）', async () => {
  await clearPendingRewards();
  await clearPendingCalendarUpgrades();
  // 合成 fixture：先经热路径语义（拆词后的未知名，空格分隔）入队，再跑每日任务
  await queuePendingReward('Grineer Combat Knife Sortie Blueprint');
  await queuePendingReward('Mystery Widget Alpha');
  await queuePendingReward('Twin Vipers Barrel');
  // 1999 日历增益未知路径：新增（可 learn）/ 静态种子权威（learn 拒改后 dismiss）/ 查无实据（dismiss）
  await queuePendingCalendarUpgrade('/Lotus/Upgrades/Calendar/BrandNewCalendarPath');
  await queuePendingCalendarUpgrade('/Lotus/Upgrades/Calendar/Armor');
  await queuePendingCalendarUpgrade('/Lotus/Upgrades/Calendar/MysteryCalendarPath');
  // 纯中文与官方预翻译混写名不得入队（含中文且仅残留官方保留拉丁专名 → 直接放行）
  assert.equal(translateRewardName('电磁力场装置', new Map()), '电磁力场装置');
  assert.equal(translateRewardName('异融 Alad V 导航坐标', new Map()), '异融 Alad V 导航坐标');
  assert.equal(translateRewardName('暗影 Forma 蓝图', new Map()), '暗影 Forma 蓝图');
  await flushRewardQueues();
  await flushCalendarQueues();
  let pending = await readPendingRewards();
  assert.deepEqual(pending.map((item) => item.english).sort(), [
    'grineer combat knife sortie blueprint', 'mystery widget alpha', 'twin vipers barrel',
  ]);
  const calPending = await readPendingCalendarUpgrades();
  assert.deepEqual(calPending.map((item) => item.path).sort(), [
    '/lotus/upgrades/calendar/armor',
    '/lotus/upgrades/calendar/brandnewcalendarpath',
    '/lotus/upgrades/calendar/mysterycalendarpath',
  ]);

  // —— 跑一轮每日任务 ——
  const report = await runDailyAgentTurn();
  assert.match(report, /grineer combat knife sortie blueprint → 已学习（灰机wiki）/);
  assert.match(report, /twin vipers barrel → 已学习（灰机wiki）/);
  assert.match(report, /mystery widget alpha → 已驳回/);
  assert.match(report, /brandnewcalendarpath → 已学习（灰机wiki 1999日历）/);
  assert.match(report, /armor → 已驳回（seed）/);
  assert.match(report, /mysterycalendarpath → 已驳回/);

  // 出队：两个 inbox 清空
  const after = await runCli('inbox');
  assert.equal(after.result.count, 0);
  assert.deepEqual(after.result.items, []);
  await flushCalendarQueues();
  assert.deepEqual(await readPendingCalendarUpgrades(), []);

  // 词典命中：learn 回填的学习文件整词可查，翻译链路直接命中，不再落占位
  const stored = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(stored.entries['grineer combat knife sortie blueprint'].zh, '希芙 蓝图');
  assert.equal(stored.entries['twin vipers barrel'].zh, '双子蝰蛇 枪管');
  assert.equal(stored.entries['mystery widget alpha'], undefined, '查无实据的键不得写词典');
  const freshDict = new Map(Object.entries(stored.entries).map(([english, entry]) => [english, entry.zh]));
  assert.equal(translateRewardName('GrineerCombatKnifeSortieBlueprint', freshDict), '希芙 蓝图');
  assert.equal(freshDict.has('mystery widget alpha'), false, 'dismiss 的键不得出现在学习词典');
  // 日历学习词典：{name, desc, source} 三件套成对落盘；种子/查无实据键从不写词典
  const calStored = JSON.parse(await readFile(calendarLearnFile, 'utf8'));
  assert.equal(calStored.entries['/lotus/upgrades/calendar/brandnewcalendarpath'].name, '新历增益');
  assert.equal(calStored.entries['/lotus/upgrades/calendar/brandnewcalendarpath'].desc, '合成的效果说明。');
  assert.equal(calStored.entries['/lotus/upgrades/calendar/brandnewcalendarpath'].source, '灰机wiki 1999日历');
  assert.equal(calStored.entries['/lotus/upgrades/calendar/armor'], undefined, '种子权威键不得落学习词典');
  assert.equal(calStored.entries['/lotus/upgrades/calendar/mysterycalendarpath'], undefined, '查无实据的键不得写词典');
  // dismiss 后翻译链路仍保持诚实占位（不再经过字典，也不得入队复活）
  await flushRewardQueues();
  assert.deepEqual((await readPendingRewards()).map((item) => item.english), []);
  await flushCalendarQueues();
  assert.deepEqual(await readPendingCalendarUpgrades(), []);
});

test('每日任务模拟：两个 inbox 都为空时只回 NO_REPLY', async () => {
  await clearPendingRewards();
  await clearPendingCalendarUpgrades();
  const report = await runDailyAgentTurn();
  assert.equal(report, 'NO_REPLY');
});

test('每日任务模拟：learn 拒绝夹带英文的译名时该键保持待查证，不误出队', async () => {
  await clearPendingRewards();
  await queuePendingReward('Mystery Widget Alpha'); // 热路径入队的是拆词后的显示名
  await flushRewardQueues();
  // 模拟 agent 拿到一个夹带英文的「译名」：CLI 必须拒绝且 inbox 原样保留
  const outcome = await runCli('learn', '--english', 'mystery widget alpha', '--zh', '神秘 Alpha 组件');
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.result.ok, false);
  const pending = await readPendingRewards();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].english, 'mystery widget alpha');
  // 正确处置：查无实据 → dismiss 出队
  const dismissed = await runCli('dismiss', '--english', 'mystery widget alpha', '--reason', '查无实据');
  assert.equal(dismissed.result.removed, true);
  assert.equal((await readPendingRewards()).length, 0);
  await clearPendingRewards();
});

test('每日任务模拟：learn 遇种子权威键（ok:false）时该键保持待查证，按合同 dismiss 出队', async () => {
  await clearPendingRewards();
  await queuePendingReward('Sheev');
  await flushRewardQueues();
  // agent 查到与种子不一致的译名 → learn 必须 ok:false（outcome=seed），该键保留
  const clash = await runCli('learn', '--english', 'sheev', '--zh', '希芙（篡改）');
  assert.equal(clash.exitCode, 1);
  assert.equal(clash.result.ok, false);
  assert.equal(clash.result.outcome, 'seed');
  assert.equal(clash.result.removedFromInbox, false);
  let pending = await readPendingRewards();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].english, 'sheev');
  // 词典文件不受影响（种子权威键永不落盘）
  const stored = JSON.parse(await readFile(learnFile, 'utf8'));
  assert.equal(stored.entries['sheev'], undefined);
  // 安全处置合同：该键已由种子权威覆盖 → dismiss 出队，任务清空
  const dismissed = await runCli('dismiss', '--english', 'sheev', '--reason', '种子权威条目已覆盖');
  assert.equal(dismissed.result.removed, true);
  pending = await readPendingRewards();
  assert.equal(pending.length, 0);
  await clearPendingRewards();
});
