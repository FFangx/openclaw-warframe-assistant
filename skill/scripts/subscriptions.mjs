#!/usr/bin/env node

// Persistent, deterministic Warframe subscriptions for OpenClaw/QQ.
// The command path only edits a local JSON ledger. The monitor path reads the
// public PC world-state endpoint and prints NO_REPLY or one MEDIA directive.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildArbitrationQueryCard,
  buildIncursionCard,
  buildIntelCard,
  buildSortieCard,
  renderWarframeCard,
} from './warframe-cards.mjs';
import { nextReset as weeklyNextReset, renderWeeklyDetailCardFor, weekStart as weeklyWeekStart } from './weekly.mjs';
import { getArbyTiers, getBountyZhMaps, getOracleEventMap, stripDataUriReplacer } from './wfdata.mjs';

const WORLD_STATE_URL = 'https://api.warframestat.us/pc';
const MARKET_ITEMS_URL = 'https://api.warframe.market/v2/items';
const ARBITRATION_SCHEDULE_URL = 'https://browse.wf/arbys.txt';
// 钢铁之路侵袭排期（OpenWF 从 WorldSeed 逆推的预算表，每行 epoch;六节点，00:00 UTC 轮换）
const SP_INCURSIONS_URL = 'https://browse.wf/sp-incursions.txt';
const ARBITRATION_REGIONS_URL = 'https://browse.wf/warframe-public-export-plus/ExportRegions.json';
const ARBITRATION_DICT_URL = 'https://browse.wf/warframe-public-export-plus/dict.zh.json';
const ARBITRATION_DICT_EN_URL = 'https://browse.wf/warframe-public-export-plus/dict.en.json';
const DEFAULT_STATE = path.resolve(process.cwd(), 'warframe-subscriptions.json');
const FETCH_TIMEOUT_MS = 20_000;
const UNPREDICTABLE_INTERVAL_MS = 15 * 60 * 1000;
// warframestat.us occasionally lags behind a scheduled Baro transition.  Do
// not turn that short data delay into a six-hour sleep (and a missed notice).
const TRADER_SOURCE_STALE_MS = 10 * 60 * 1000;
const TRADER_TRANSITION_RETRY_MS = 2 * 60 * 1000;
const TRADER_TRANSITION_GRACE_MS = 5 * 60 * 1000;
const TRADER_SCHEDULE_POLICY_VERSION = 2;

const REWARD_ZH = Object.freeze({
  'Fieldron': '电磁力场装置',
  'Detonite Injector': '爆燃喷射器',
  'Mutagen Mass': '突变原聚合物',
  'Mutalist Alad V Nav Coordinate': '异融 Alad V 导航坐标',
  'Mutalist Alad V Coordinates': '异融 Alad V 导航坐标',
  'Orokin Catalyst': '奥罗金催化剂',
  'Orokin Catalyst Blueprint': '奥罗金催化剂蓝图',
  'Orokin Reactor': '奥罗金反应堆',
  'Orokin Reactor Blueprint': '奥罗金反应堆蓝图',
  'Forma': 'Forma',
  'Forma Blueprint': 'Forma 蓝图',
  'Exilus Adapter': '特殊功能槽连接器',
  'Exilus Warframe Adapter': '战甲特殊功能槽连接器',
  'Exilus Warframe Adapter Blueprint': '战甲特殊功能槽连接器蓝图',
  'Exilus Weapon Adapter': '武器特殊功能槽连接器',
  'Exilus Weapon Adapter Blueprint': '武器特殊功能槽连接器蓝图',
  'Nitain Extract': '泥炭萃取物',
  'Kuva': '赤毒',
  'Endo': '内融核心',
  'Riven Mod': '裂罅 Mod',
  'Orokin Cell': '奥罗金电池',
  'Argon Crystal': '氩结晶',
  'Tellurium': '碲',
  'Neural Sensors': '神经传感器',
  'Neurodes': '神经元',
  'Gallium': '镓',
  'Morphics': '非晶态合金',
  'Control Module': '控制模块',
  'Alloy Plate': '合金板',
  'Ferrite': '铁氧体',
  'Rubedo': '红化结晶',
  'Plastids': '生物质',
  'Polymer Bundle': '聚合物束',
  'Nano Spores': '纳米孢子',
  'Salvage': '回收金属',
  'Circuits': '电路',
  'Cryotic': '永冻晶矿',
  'Oxium': '奥席金属',
  'Hexenon': '六醇燃剂',
  'Ayatan Amber Star': '阿耶檀识琥珀星',
  'Ayatan Cyan Star': '阿耶檀识青蓝星',
});
const REWARD_TOKEN_ZH = Object.freeze({
  'Wraith': '亡魂', 'Vandal': '破坏者', 'Blueprint': '蓝图', 'Receiver': '枪机',
  'Barrel': '枪管', 'Stock': '枪托', 'Blade': '刀刃', 'Handle': '握柄',
  'Chassis': '机体', 'Systems': '系统', 'Neuroptics': '头部神经光元',
  'Credits': '现金', 'Credit': '现金', 'Alad V': 'Alad V',
});
const rewardNameTranslations = new Map(Object.entries(REWARD_ZH).map(([english, chinese]) => [english.toLowerCase(), chinese]));
const rewardTokenPattern = new RegExp(`\\b(${Object.keys(REWARD_TOKEN_ZH).sort((a, b) => b.length - a.length).map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'giu');
let rewardTranslationsPromise = null;
// oracle 活动名词典：入口处 await primeOracleEventMap() 后生效；失败保持空 Map 静默降级
let oracleEventZh = new Map();
async function primeOracleEventMap() {
  try { oracleEventZh = await getOracleEventMap(); } catch { /* 静态表兜底 */ }
  return oracleEventZh;
}

const MISSION_ZH = {
  Extermination: '歼灭', Capture: '捕获', Sabotage: '破坏', Rescue: '救援', Spy: '间谍',
  Defense: '防御', 'Mobile Defense': '移动防御', Interception: '拦截', Survival: '生存',
  Assassination: '刺杀',
  Excavation: '挖掘', Disruption: '中断', 'Void Cascade': '虚空覆涌', 'Void Flood': '虚空洪流',
  'Void Armageddon': '虚空决战', Orphix: '奥菲克斯', Assault: '强袭', Defection: '叛逃',
  'Infested Salvage': '疫变回收', Volatile: '反应堆破坏', Alchemy: '炼金术', Crossfire: '歼灭',
  Skirmish: '前哨战', Hijack: '劫持', Pursuit: '追击', Rush: '突袭',
  MT_SURVIVAL: '生存', MT_DEFENSE: '防御', MT_TERRITORY: '拦截', MT_EXCAVATE: '挖掘',
  MT_PURIFY: '中断', MT_EVACUATION: '叛逃', MT_ARTIFACT: '移动防御', MT_CORRUPTION: '生存',
  MT_VOID_CASCADE: '虚空覆涌', MT_ARMAGEDDON: '虚空决战', MT_ALCHEMY: '炼金术',
};
const FACTION_ZH = {
  Grineer: 'Grineer', Corpus: 'Corpus', Infested: 'Infestation', Orokin: '奥罗金', Corrupted: '堕落者',
  Sentient: 'Sentient', Murmur: '低语者', 'The Murmur': '低语者', Crossfire: '混战', Tenno: 'Tenno',
};
const TIER_ZH = { Lith: '古纪', Meso: '前纪', Neo: '中纪', Axi: '后纪', Requiem: '安魂', Omnia: '全能' };
const PLANET_ZH = {
  Mercury: '水星', Venus: '金星', Earth: '地球', Lua: '月球', Mars: '火星', Deimos: '火卫二',
  Phobos: '火卫一', Ceres: '谷神星', Jupiter: '木星', Europa: '欧罗巴', Saturn: '土星',
  Uranus: '天王星', Neptune: '海王星', Pluto: '冥王星', Eris: '阋神星', Sedna: '赛德娜',
  Void: '虚空', Zariman: '扎里曼', 'Kuva Fortress': '赤毒要塞', Duviri: '双衍王境',
  'Earth Proxima': '地球比邻星', 'Venus Proxima': '金星比邻星', 'Saturn Proxima': '土星比邻星',
  'Neptune Proxima': '海王星比邻星', 'Pluto Proxima': '冥王星比邻星', 'Veil Proxima': '面纱比邻星', Veil: '面纱比邻星',
};
const TYPE_LABEL = {
  fissure: '裂缝', arbitration: '仲裁', alert: '警报', invasion: '稀有入侵', event: '活动', trader: '虚空商人', drops: '掉落', weekly: '周常刷新', sortie: '突击', incursion: '钢铁侵袭',
  shop: '商店周货', 'vendor-item': '商品上架', bounty: '赏金', rotation: '轮换提醒',
};
const FAST_FISSURE_MISSIONS = new Set(['Capture', 'Extermination', 'Rescue']);
const ARBITRATION_FACTION_ZH = {
  FC_GRINEER: 'Grineer', FC_CORPUS: 'Corpus', FC_INFESTATION: 'Infestation', FC_OROKIN: '奥罗金', FC_MITW: '低语者',
  // ExportRegions 全集另有 5 个（2026-08-04 探明）：Sentient/Tenno 官方保留英文，Scaldra/Techrot 为社区名
  FC_SENTIENT: 'Sentient', FC_TENNO: 'Tenno', FC_DUVIRI: '双衍王境', FC_SCALDRA: '斯卡德拉', FC_TECHROT: '科技腐殖',
};
const EVENT_ZH = Object.freeze({
  'Ghoul Purge': '食尸鬼清剿',
  'Razorback Armada': '利刃豺狼舰队',
  'Balor Fomorian': '巴洛尔巨人战舰',
  'Thermia Fractures': '热美亚裂缝',
  'Plague Star': '瘟疫之星',
  Acolytes: '追随者',
  Acolyte: '追随者',
  'Tactical Alert': '战术警报',
  // 灰机词典 2026-08-04：季节性活动
  'Dog Days': '三伏天',
  'Star Days': '星日',
  'Naberus': '纳贝流士之夜',
});
const EVENT_DETAIL_ZH = Object.freeze({
  'Help Konzu rid the plains of Grineer Ghouls': '帮助孔祝清除夜灵平野上的 Grineer 食尸鬼',
});

// 突击 boss/词缀译名：灰机词典 + wiki「突击」页状态表（2026-08-04 全量生成，work/gen-sortie-tables.mjs 可复跑）
const SORTIE_BOSS_ZH = Object.freeze({
  'Hyena Pack': '鬣狗群',
  'Captain Vor': '沃尔上尉',
  'General Sargas Ruk': 'Sargas Ruk将军',
  'Councilor Vay Hek': '韦·海克委员',
  'Lech Kril': 'Lech Kril中尉',
  'Tyl Regor': '泰尔·雷工',
  'Jackal': '豺狼',
  'Nef Anyo': '奈富·安尤',
  'Raptor': '猛禽',
  'Lephantis': '雷凡魔像',
  'Mutalist Alad V': '异融Alad V',
  'Corrupted Vor': '堕落的沃尔',
  'Archon Boreal': '执刑官诡文枭主',
  'Archon Amar': '执刑官欺谋狼主',
  'Archon Nira': '执刑官混沌蛇主',
});
const SORTIE_MODIFIER_ZH = Object.freeze({
  'Energy Reduction': '能量上限减少',
  'Enemy Physical Enhancement: Impact': '敌人物理强化：冲击',
  'Enemy Physical Enhancement: Slash': '敌人物理强化：切割',
  'Enemy Physical Enhancement: Puncture': '敌人物理强化：穿刺',
  'Eximus Stronghold': '卓越者大本营',
  'Enemy Elemental Enhancement: Magnetic': '敌人元素强化：磁力',
  'Enemy Elemental Enhancement: Corrosive': '敌人元素强化：腐蚀',
  'Enemy Elemental Enhancement: Viral': '敌人元素强化：病毒',
  'Enemy Elemental Enhancement: Electricity': '敌人元素强化：电击',
  'Enemy Elemental Enhancement: Radiation': '敌人元素强化：辐射',
  'Enemy Elemental Enhancement: Gas': '敌人元素强化：毒气',
  'Enemy Elemental Enhancement: Heat': '敌人元素强化：火焰',
  'Enemy Elemental Enhancement: Blast': '敌人元素强化：爆炸',
  'Enemy Elemental Enhancement: Cold': '敌人元素强化：冰冻',
  'Enemy Elemental Enhancement: Toxin': '敌人元素强化：毒素',
  'Environmental Hazard: Radiation Pockets': '辐射灾害',
  'Environmental Hazard: Electromagnetic Anomalies': '电磁异常',
  'Environmental Hazard: Dense Fog': '浓雾',
  'Environmental Hazard: Fire': '火灾',
  'Environmental Effect: Cryogenic Leakage': '冷却液泄漏',
  'Environmental Effect: Extreme Cold': '极度寒冷',
  'Augmented Enemy Armor': '敌人护甲强化',
  'Enhanced Enemy Shields': '敌人护盾强化',
  'Weapon Restriction: Pistol Only': '仅限次要武器',
  'Weapon Restriction: Shotgun Only': '仅限霰弹枪',
  'Weapon Restriction: Sniper Only': '仅限狙击枪',
  'Weapon Restriction: Assault Rifle Only': '仅限突击步枪',
  'Weapon Restriction: Melee Only': '仅限近战',
  'Weapon Restriction: Bow Only': '仅限弓箭/弩',
});

function normalize(value) {
  return String(value || '').normalize('NFKC').replace(/[\u3000\s]+/gu, ' ').trim();
}

function normalizeFilter(value) {
  return normalize(value).toLowerCase();
}

function translatedOrChinese(dictionary, value, fallback) {
  const raw = normalize(value);
  if (!raw) return fallback;
  return dictionary[raw] || (/[A-Za-z]{2,}/u.test(raw) ? fallback : raw);
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) result._.push(token);
    else {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next != null && !next.startsWith('--')) { result[key] = next; index += 1; }
      else result[key] = true;
    }
  }
  return result;
}

function emptyLedger() {
  return { version: 1, updatedAt: new Date().toISOString(), subscriptions: [], schedules: {} };
}

async function readLedger(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    const subscriptions = (Array.isArray(parsed.subscriptions) ? parsed.subscriptions : []).map((item) => ({
      ...item,
      // 存量数据可能混有大写 openid，读入时归一化，避免同一会话被拆成两份
      target: String(item.target || '').toLowerCase(),
      ownerId: String(item.ownerId || '').toLowerCase(),
    }));
    return {
      version: 1,
      updatedAt: parsed.updatedAt || null,
      subscriptions,
      schedules: parsed.schedules && typeof parsed.schedules === 'object' ? parsed.schedules : {},
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyLedger();
    throw error;
  }
}

async function writeLedger(statePath, ledger) {
  await mkdir(path.dirname(statePath), { recursive: true });
  ledger.updatedAt = new Date().toISOString();
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await rename(tempPath, statePath);
}

async function withLedgerLock(statePath, operation) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  let handle = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { handle = await open(lockPath, 'wx'); break; }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!handle) throw new Error('订阅状态正忙，请稍后重试。');
  try { return await operation(); }
  finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

function makeId(target, ownerId, type, filter) {
  return createHash('sha1').update(`${target}|${ownerId}|${type}|${normalizeFilter(filter)}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 10);
}

function parseSubscriptionSpec(raw) {
  const text = normalize(raw);
  const entries = [
    [/^(?:虚空)?裂缝(?:\s+|$)(.*)$/iu, 'fissure'],
    // 「仲裁推荐」无空格形态也要接（lookahead 放行 仲裁推荐/仲裁推荐 生存）
    [/^仲裁(?:\s+|$|(?=推荐))(.*)$/iu, 'arbitration'],
    [/^警报(?:\s+|$)(.*)$/iu, 'alert'],
    [/^(?:稀有)?入侵(?:\s+|$)(.*)$/iu, 'invasion'],
    [/^(?:特殊)?活动(?:\s+|$)(.*)$/iu, 'event'],
    [/^(?:虚空商人|奸商|baro)(?:\s+|$)(.*)$/iu, 'trader'],
    [/^突击(?:\s+|$)(.*)$/iu, 'sortie'],
    [/^(?:钢铁(?:之路)?)?侵袭(?:\s+|$)(.*)$/iu, 'incursion'],
    // 悬赏：无筛选=每轮全推会吵（2.5h 一轮），manage 层要求必须带物品/任务词
    [/^(?:悬赏|赏金)(?:\s+|$)(.*)$/u, 'bounty'],
    // 轮换提醒（一次性）：回廊战甲/灵化武器/泰辛精选/瓦奇娅复刻，到点推一次自动取消
    [/^(?:轮换|复刻|回廊)(?:\s+|$)(.*)$/u, 'rotation'],
    [/^(?:掉落|新掉落|入库)(?:\s+|$)(.*)$/iu, 'drops'],
    [/^(?:周常|周常刷新|周常清单)$/iu, 'weekly'],
    // 商店周货：默认泰辛；商品上架：必须带物品名（manage 层再做 enrich 与校验）
    [/^商店(?:\s+|$)(.*)$/u, 'shop'],
    [/^商品(?:\s+|$)(.*)$/u, 'vendor-item'],
  ];
  for (const [pattern, type] of entries) {
    const match = text.match(pattern);
    if (match) return { type, filter: normalize(match[1] || '') };
  }
  if (/^(?:重要|全部)情报$/u.test(text)) {
    return { bundle: ['alert', 'invasion', 'event', 'trader'] };
  }
  return null;
}

function subscriptionLabel(subscription) {
  const label = TYPE_LABEL[subscription.type] || subscription.type;
  const base = subscription.filter ? `${label} · ${subscription.filter}` : label;
  // 一次性订阅：命中推送后自动删除，列表里标明避免用户以为持续蹲守
  return subscription.meta?.once ? `${base}（⏱ 一次性）` : base;
}

function helpText() {
  return [
    '星际战甲订阅命令：',
    '订阅 裂缝 钢铁 全能 生存',
    '订阅 仲裁 生存',
    '订阅 仲裁推荐（只推社区评级 S/A 的好场地，可再加任务词：订阅 仲裁推荐 生存）',
    '订阅 警报 反应堆（也可写“土豆”，匹配奥罗金反应堆/催化剂）',
    '订阅 入侵 Forma（也可写“福马”）',
    '订阅 活动',
    '订阅 虚空商人',
    '订阅 突击｜订阅 钢铁侵袭（每日刷新后推当天内容，可加任务/星球筛选词）',
    '订阅 赏金 阿耶精华（「悬赏」同义；必须带物品/任务词，奖池 2.5 小时轮换，轮到含目标的赏金就推）',
    '订阅 轮换 Saryn｜订阅 复刻 Revenant（一次性：回廊/泰辛/瓦奇娅排期到点提醒一次后自动取消）',
    '订阅 重要情报（警报＋稀有入侵＋活动＋虚空商人）',
    '订阅 周常（每周一刷新后自动发本周详细清单）',
    '订阅 商店｜订阅 商店 圣言者（每周新货推送＋轮换前 24h 未购提醒；仅用户私聊）',
    '订阅 商品 Umbra Forma 蓝图（可算商人提前预告上架；Baro/瓦奇娅到货对账提醒）',
    '订阅 掉落（仅用户私聊；默认只报 Prime 部件、赋能和稀有 MOD）',
    '订阅 掉落 全部｜订阅 掉落 悟空（也可以按物品名筛选）',
    '我的订阅｜暂停订阅 1｜恢复订阅 1｜取消订阅 1',
    '编号以“我的订阅”当前显示为准。提醒发送到创建订阅的当前会话。',
  ].join('\n');
}

function userSubscriptions(ledger, target, ownerId) {
  return ledger.subscriptions
    .filter((item) => item.target === target && item.ownerId === ownerId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function resolveSelection(items, selector) {
  const value = normalize(selector);
  if (/^(?:全部|all)$/iu.test(value)) return items;
  if (/^\d+$/u.test(value)) {
    const item = items[Number(value) - 1];
    return item ? [item] : [];
  }
  const idMatch = items.find((item) => item.id === value || item.id.startsWith(value));
  if (idMatch) return [idMatch];
  const spec = parseSubscriptionSpec(value);
  if (spec?.type) return items.filter((item) => item.type === spec.type && normalizeFilter(item.filter) === normalizeFilter(spec.filter));
  return [];
}

function resetTargetSchedule(ledger, target) {
  delete ledger.schedules[target];
}

function addOne(ledger, context, spec) {
  const existing = ledger.subscriptions.find((item) => item.target === context.target
    && item.ownerId === context.ownerId
    && item.type === spec.type
    && normalizeFilter(item.filter) === normalizeFilter(spec.filter));
  if (existing) {
    existing.enabled = true;
    existing.ownerName = context.ownerName || existing.ownerName;
    if (spec.meta) existing.meta = spec.meta;
    resetTargetSchedule(ledger, context.target);
    return { item: existing, created: false };
  }
  const item = {
    id: makeId(context.target, context.ownerId, spec.type, spec.filter),
    target: context.target,
    ownerId: context.ownerId,
    ownerName: context.ownerName || context.ownerId,
    type: spec.type,
    filter: normalize(spec.filter),
    enabled: true,
    initialized: false,
    seen: [],
    createdAt: new Date().toISOString(),
    ...(spec.meta ? { meta: spec.meta } : {}),
  };
  ledger.subscriptions.push(item);
  resetTargetSchedule(ledger, context.target);
  return { item, created: true };
}

async function manageCommand(message, context, statePath) {
  return withLedgerLock(statePath, async () => {
    const ledger = await readLedger(statePath);
    const text = normalize(message).replace(/^\//u, '');
    const mine = () => userSubscriptions(ledger, context.target, context.ownerId);
    let reply = '';
    let changed = false;

    if (/^(?:订阅帮助|提醒帮助|订阅|提醒)$/u.test(text)) {
      reply = helpText();
    } else if (/^(?:我的订阅|订阅列表|我的提醒)$/u.test(text)) {
      const items = mine();
      reply = items.length
        ? ['我的星际战甲订阅：', ...items.map((item, index) => `${index + 1}. ${item.enabled ? '✅' : '⏸'} ${subscriptionLabel(item)}`)].join('\n')
        : `你在当前会话还没有订阅。\n${helpText()}`;
    } else {
      const actionMatch = text.match(/^(取消订阅|取消提醒|暂停订阅|暂停提醒|恢复订阅|恢复提醒)(?:\s+|$)(.*)$/u);
      if (actionMatch) {
        const selector = normalize(actionMatch[2]);
        if (!selector) reply = `请写编号或条件，例如：${actionMatch[1]} 1`;
        else {
          const selected = resolveSelection(mine(), selector);
          if (!selected.length) reply = `没有找到“${selector}”。请先发送“我的订阅”查看编号。`;
          else if (actionMatch[1].startsWith('取消')) {
            const ids = new Set(selected.map((item) => item.id));
            ledger.subscriptions = ledger.subscriptions.filter((item) => !ids.has(item.id));
            reply = `已取消：${selected.map(subscriptionLabel).join('、')}`;
            changed = true;
          } else {
            const enabled = actionMatch[1].startsWith('恢复');
            selected.forEach((item) => { item.enabled = enabled; });
            reply = `${enabled ? '已恢复' : '已暂停'}：${selected.map(subscriptionLabel).join('、')}`;
            changed = true;
          }
          if (changed) resetTargetSchedule(ledger, context.target);
        }
      } else {
        const addMatch = text.match(/^(?:订阅|提醒)(?:\s+)?(.+)$/u);
        if (!addMatch) return { handled: false };
        const spec = parseSubscriptionSpec(addMatch[1]);
        if (!spec) reply = `暂不认识“${normalize(addMatch[1])}”。\n${helpText()}`;
        else if (spec.type === 'drops' && !context.personalAllowed) {
          // 掉落数据来自本机账号快照，属于个人数据，沿用个人账号命令的边界
          reply = '掉落订阅涉及个人账号数据，只允许用户本人在 QQ 私聊中创建。';
        } else if (spec.type === 'shop' && !context.personalAllowed) {
          // 未购提醒要读本机快照购买记录，同属个人数据边界
          reply = '商店订阅含未购提醒（读本机购买记录），只允许用户本人在 QQ 私聊中创建。';
        } else if (spec.type === 'shop' && spec.filter && !/^(?:泰辛|teshin|钢铁荣誉|钢铁商店|圣言者|palladino|帕拉迪诺)$/iu.test(normalize(spec.filter))) {
          // 只有周轮换可算商人的提醒有意义：真轮换家无法预知货单，每日限购家推送会吵
          reply = '商店订阅目前支持：泰辛（默认）、圣言者——两家周轮换可预测。其余商人发「商店 商人名」随时查。';
        } else if (spec.type === 'bounty' && !spec.filter) {
          // 悬赏 2.5h 一轮，无筛选=每轮全量推送必吵
          reply = '请带上要蹲的物品或任务词，例如：订阅 赏金 阿耶精华、订阅 赏金 隔离库。当前轮换发「赏金」随时查。';
        } else if (spec.type === 'rotation' && !spec.filter) {
          reply = '请带上要蹲的名字，例如：订阅 轮换 Saryn、订阅 复刻 Revenant。未来排期发「轮换日历」查看。';
        } else if (spec.type === 'rotation') {
          // 建立时就把目标时刻解析清楚；查无/当期已在均不建僵尸订阅
          let target = null;
          let sourceOk = true;
          try {
            const { resolveRotationTarget } = await import('./rotation-calendar.mjs');
            const { loadOfficialWorldState } = await import('./vendor-shop.mjs');
            target = await resolveRotationTarget(spec.filter, { worldState: await loadOfficialWorldState().catch(() => null) });
          } catch { sourceOk = false; }
          if (!sourceOk) {
            reply = '轮换排期数据暂时拉不到，请稍后重试。';
          } else if (!target) {
            reply = `「${normalize(spec.filter)}」不在未来 12 周的回廊/泰辛/瓦奇娅排期里（战甲用游戏内英文名，如 Saryn）。发「轮换日历」看排期。`;
          } else if (target.current) {
            reply = `「${normalize(spec.filter)}」现在就在：${target.label}，直接去玩吧，不用订阅。`;
          } else {
            const enriched = { ...spec, filter: normalize(spec.filter), meta: { once: true, at: target.atMs, source: target.source, label: target.label } };
            const result = addOne(ledger, context, enriched);
            const when = new Date(target.atMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            reply = [`${result.created ? '订阅成功' : '已存在并保持启用'}：${subscriptionLabel(result.item)}`, `${when} ${target.label}；到时提醒一次后自动取消。`].join('\n');
            changed = true;
          }
        } else if (spec.type === 'vendor-item' && !spec.filter) {
          reply = '请带上物品名，例如：订阅 商品 Umbra Forma 蓝图';
        } else if (spec.type === 'vendor-item') {
          // 商品订阅建立时就把货源解析清楚：常驻拒单、可算类给预告、查无转 Baro/瓦奇娅蹲守
          let resolved = null;
          try { resolved = await resolveVendorItemSpec(spec.filter); } catch { resolved = null; }
          if (!resolved) {
            reply = '商店数据源暂时拉不到，请稍后重试。';
          } else if (resolved.kind === 'evergreen') {
            reply = `「${resolved.hit.itemName}」是${resolved.hit.vendorZh}的常驻商品，随时可买，不需要订阅；发「哪里买 ${normalize(spec.filter)}」看详情。`;
          } else if (resolved.kind === 'every-cycle') {
            reply = `「${resolved.hit.itemName}」在${resolved.hit.vendorZh}每期都会上架（限购随轮换重置），不需要蹲；发「商店 ${resolved.hit.vendorZh.split('·')[0].replace(/\(.*\)/u, '').trim()}」看本期货单。`;
          } else if (resolved.kind === 'rotating-only') {
            reply = `「${resolved.hit.itemName}」在${resolved.hit.vendorZh}的随机货架上，官方随机不可预测，蹲不了上架；只能游戏内碰运气。`;
          } else {
            const enriched = { ...spec, filter: normalize(spec.filter), meta: resolved.kind === 'appear'
              ? { kind: 'appear', vendorKey: resolved.vendorKey, vendorZh: resolved.vendorZh, storeItem: resolved.storeItem, itemName: resolved.itemName, nextAt: resolved.nextAt }
              : { kind: 'watch' } };
            const result = addOne(ledger, context, enriched);
            const when = resolved.kind === 'appear'
              ? (resolved.current ? '本期正在上架！' : `预计下次上架：${new Date(resolved.nextAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}（${resolved.vendorZh}）`)
              : '商店货单里没查到这件，已转为 Baro/瓦奇娅到货对账蹲守（名称若有误可取消订阅）';
            reply = [`${result.created ? '订阅成功' : '已存在并保持启用'}：${subscriptionLabel(result.item)}`, when].join('\n');
            changed = true;
          }
        } else {
          const specs = spec.bundle ? spec.bundle.map((type) => ({ type, filter: '' })) : [spec];
          const results = specs.map((entry) => addOne(ledger, context, entry));
          const created = results.filter((entry) => entry.created).map((entry) => subscriptionLabel(entry.item));
          const restored = results.filter((entry) => !entry.created).map((entry) => subscriptionLabel(entry.item));
          reply = [
            created.length ? `订阅成功：${created.join('、')}` : '',
            restored.length ? `已存在并保持启用：${restored.join('、')}` : '',
            '首次监测只建立基线，不会把当前已有情报当成新提醒；后续命中仅推送一次。',
          ].filter(Boolean).join('\n');
          changed = true;
        }
      }
    }

    if (changed) await writeLedger(statePath, ledger);
    const enabledForTarget = ledger.subscriptions.filter((item) => item.target === context.target && item.enabled);
    // 世界状态 cron 与掉落 cron 分开管理：掉落只查本地文件，节奏与联网监测无关
    const worldActiveCount = enabledForTarget.filter((item) => item.type !== 'drops').length;
    const dropsActiveCount = enabledForTarget.filter((item) => item.type === 'drops').length;
    return {
      handled: true,
      ok: true,
      text: reply,
      target: context.target,
      ownerId: context.ownerId,
      targetActiveCount: enabledForTarget.length,
      cronAction: worldActiveCount > 0 ? 'ensure' : 'remove',
      dropsCronAction: dropsActiveCount > 0 ? 'ensure' : 'remove',
    };
  });
}

function parseNode(value) {
  const raw = String(value || '未知节点');
  const match = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/u);
  return { node: match?.[1] || raw, planet: PLANET_ZH[match?.[2]] || match?.[2] || '未知星区' };
}

// 「订阅 商品」建立时的货源解析：常驻/可算轮换/真随机/查无四态（只用缓存数据源，manage 15s 超时内可完成）
async function resolveVendorItemSpec(query) {
  const { loadShopContext, whereToBuy, nextAppearance, TESHIN_KEY } = await import('./vendor-shop.mjs');
  const context = await loadShopContext();
  const result = whereToBuy(query, context);
  if (result.hits.length) {
    if (result.hits[0].availability === '常驻') return { kind: 'evergreen', hit: result.hits[0] };
    // 泰辛周精选：8 周表可算未来上架周，是唯一真正值得蹲的可算商品
    const teshin = result.hits.find((hit) => hit.kind === 'teshin-featured');
    if (teshin) {
      const next = nextAppearance(TESHIN_KEY, context.vendors[TESHIN_KEY], teshin.storeItem);
      if (next?.evergreen) return { kind: 'evergreen', hit: teshin };
      if (next) return { kind: 'appear', vendorKey: TESHIN_KEY, vendorZh: teshin.vendorZh, storeItem: teshin.storeItem, itemName: teshin.itemName, nextAt: next.at, current: next.current };
    }
    const cyclic = result.hits.find((hit) => hit.kind === 'cyclic');
    if (cyclic) {
      // 全出类商人每期必上架（限购随轮换重置），订阅无意义
      return { kind: 'every-cycle', hit: cyclic };
    }
    return { kind: 'rotating-only', hit: result.hits[0] };
  }
  // 商店货单查无 → Baro/瓦奇娅到货对账蹲守（不需要预先解析 uniqueName，对账时拿货单名双向 compact 匹配）
  return { kind: 'watch' };
}

// 商店/商品订阅的候选生成：不进 allCandidates（per-subscription 逻辑），monitor 内联注入 candidates
// 候选带 searchText=订阅词，保证 genericMatches 必过（过滤已在本函数内完成）
async function appendShopCandidates(candidates, subscriptions, state) {
  const shopSubs = subscriptions.filter((item) => item.type === 'shop' && item.enabled);
  const itemSubs = subscriptions.filter((item) => item.type === 'vendor-item' && item.enabled);
  if (!shopSubs.length && !itemSubs.length) return;
  const { loadShopContext, buildVendorDetail, nextAppearance, resolveVendorAlias } = await import('./vendor-shop.mjs');
  const context = await loadShopContext();
  try {
    const { readSnapshot } = await import('./alecaframe.mjs');
    context.inventory = (await readSnapshot()).inventory;
  } catch { context.inventory = null; } // 快照读失败=当未购，宁多提醒
  candidates.shop = candidates.shop || [];
  candidates['vendor-item'] = candidates['vendor-item'] || [];
  const compactText = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s_\-:：·'’&（）()]+/gu, '');
  const detailCache = new Map();
  const detailOf = async (key) => {
    if (!detailCache.has(key)) detailCache.set(key, await buildVendorDetail(key, context));
    return detailCache.get(key);
  };
  for (const sub of shopSubs) {
    const alias = resolveVendorAlias(sub.filter || '泰辛');
    if (!alias || alias.key === 'varzia' || alias.key === 'darvo') continue;
    const detail = await detailOf(alias.key);
    if (!detail?.nextRotationAt) continue;
    const featured = detail.rotating.find((row) => row.featured) || detail.rotating[0];
    candidates.shop.push({
      id: `shop:${alias.key.split('/').pop()}:${detail.nextRotationAt}`,
      type: 'shop', vendorZh: detail.zhName,
      itemName: featured?.name || '本期货单',
      rotatingCount: detail.rotating.length,
      bought: detail.boughtTotal > 0,
      expiry: new Date(detail.nextRotationAt).toISOString(),
      searchText: sub.filter || '泰辛',
    });
  }
  for (const sub of itemSubs) {
    const meta = sub.meta || {};
    if (meta.kind === 'appear' && meta.vendorKey && meta.storeItem) {
      const manifest = context.vendors[meta.vendorKey];
      if (!manifest) continue;
      const next = nextAppearance(meta.vendorKey, manifest, meta.storeItem);
      if (next && !next.evergreen) {
        if (next.current) {
          candidates['vendor-item'].push({
            id: `vitem:${String(meta.storeItem).split('/').pop()}:${next.expiry}`,
            type: 'vendor-item', itemName: meta.itemName || sub.filter, vendorZh: meta.vendorZh || '',
            expiry: new Date(next.expiry).toISOString(), searchText: sub.filter,
          });
        }
        // 顺手刷新下次上架时刻供调度蹲点（ledger 稍后统一落盘）
        sub.meta = { ...meta, nextAt: next.at };
      }
    } else if (meta.kind === 'watch') {
      const q = compactText(sub.filter);
      if (!q) continue;
      const traders = Array.isArray(state.voidTraders) ? state.voidTraders : state.voidTrader ? [state.voidTrader] : [];
      for (const trader of traders.filter((entry) => entry?.active)) {
        for (const goods of trader.inventory || []) {
          const en = compactText(goods.item);
          const zh = compactText(context.names?.zhOf?.(String(goods.uniqueName || '').replace('/StoreItems/', '/')) || '');
          if ((en && en.includes(q)) || (zh && zh.includes(q))) {
            candidates['vendor-item'].push({
              id: `vitem:baro:${en || q}:${trader.expiry}`,
              type: 'vendor-item', itemName: goods.item || sub.filter, vendorZh: '虚空商人',
              note: `杜卡德 ${goods.ducats ?? '?'} + 现金 ${goods.credits ?? '?'}`,
              expiry: trader.expiry, searchText: sub.filter,
            });
          }
        }
      }
    }
  }
}

async function primeRewardTranslations() {
  if (rewardTranslationsPromise) return rewardTranslationsPromise;
  rewardTranslationsPromise = (async () => {
    try {
      const response = await fetch(MARKET_ITEMS_URL, {
        headers: { Platform: 'pc', Crossplay: 'true', Language: 'zh-hans' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const payload = await response.json();
      for (const item of payload?.data || []) {
        const english = normalize(item?.i18n?.en?.name);
        const chinese = normalize(item?.i18n?.['zh-hans']?.name);
        if (english && chinese && english.toLowerCase() !== chinese.toLowerCase() && !rewardNameTranslations.has(english.toLowerCase())) {
          rewardNameTranslations.set(english.toLowerCase(), chinese);
        }
      }
      return true;
    } catch {
      return false;
    } finally {
      // 官方词典兜底：wm 目录只覆盖可交易物，活动货币（Nakak Pearls=纳卡克珍珠）查无会兑成「未收录奖励」；
      // items 键已小写归一，wm 译名优先（交易场景更贴）词典只补缺
      try {
        const maps = await getBountyZhMaps();
        for (const [english, chinese] of Object.entries(maps?.items || {})) {
          if (!rewardNameTranslations.has(english)) rewardNameTranslations.set(english, chinese);
        }
      } catch { /* 词典拉不到保持原链路 */ }
    }
  })();
  return rewardTranslationsPromise;
}

function translateRewardName(value) {
  const raw = normalize(value);
  if (!raw) return '';
  const exact = rewardNameTranslations.get(raw.toLowerCase());
  if (exact) return exact;
  const translated = raw.replace(rewardTokenPattern, (match) => REWARD_TOKEN_ZH[Object.keys(REWARD_TOKEN_ZH).find((key) => key.toLowerCase() === match.toLowerCase())] || match);
  return /[A-Za-z]{2,}/u.test(translated) ? '未收录奖励' : translated;
}

function translateEventName(value) {
  const raw = normalize(value);
  if (EVENT_ZH[raw]) return EVENT_ZH[raw];
  // oracle 官方词典（227 条 worldstate 专用语言键）：静态表查无时优先于占位文案
  const oracleHit = oracleEventZh.get(raw);
  if (oracleHit) return oracleHit;
  // 「Tactical Alert: Dog Days」拆冒号逐段翻译；任一段查到就不至于整体兑成占位文案
  if (raw.includes(':')) {
    const parts = raw.split(':').map((part) => normalize(part));
    const translated = parts.map((part) => EVENT_ZH[part] || oracleEventZh.get(part) || null);
    if (translated.some(Boolean)) return translated.map((zh, i) => zh || parts[i]).join('：');
  }
  return EVENT_ZH[raw] || '特殊活动';
}

function translateEventDetail(value) {
  const raw = normalize(value);
  if (!raw) return '活动已经开始';
  return EVENT_DETAIL_ZH[raw] || (/^[^A-Za-z]*$/u.test(raw) ? raw : '活动详情请查看游戏内说明');
}

function translateRewardPhrase(value) {
  const raw = normalize(value);
  if (!raw) return '';
  return raw.split(/\s*\+\s*/u).map((part) => {
    const credits = part.match(/^([\d,.]+)\s*(?:cr|credits?)$/iu);
    if (credits) return `${credits[1]} 现金`;
    const counted = part.match(/^([\d,.]+)\s*[x×]\s*(.+)$/iu);
    if (counted) return `${counted[1]}× ${translateRewardName(counted[2])}`;
    return translateRewardName(part);
  }).filter(Boolean).join(' + ');
}

function rewardText(reward) {
  if (!reward) return '';
  const parts = [];
  if (reward.credits) parts.push(`${Number(reward.credits).toLocaleString('zh-CN')} 现金`);
  if (Array.isArray(reward.countedItems)) {
    for (const item of reward.countedItems) parts.push(`${item.count || 1}× ${translateRewardName(item.type || item.key || '物品')}`);
  }
  if (Array.isArray(reward.items)) {
    for (const item of reward.items) {
      if (typeof item === 'string') parts.push(translateRewardName(item));
      else if (item?.type || item?.key) parts.push(`${item.count || 1}× ${translateRewardName(item.type || item.key)}`);
    }
  }
  if (!parts.length && reward.itemString) parts.push(translateRewardPhrase(reward.itemString));
  if (!parts.length && reward.asString) parts.push(translateRewardPhrase(reward.asString));
  return [...new Set(parts.filter(Boolean))].join(' + ');
}

function traderWindow(trader, now = Date.now()) {
  const activation = Date.parse(trader?.activation);
  const expiry = Date.parse(trader?.expiry);
  return {
    activation,
    expiry,
    scheduledActive: Number.isFinite(activation) && Number.isFinite(expiry) && activation <= now && now < expiry,
  };
}

function worldStateIsStale(state, now = Date.now()) {
  const timestamp = Date.parse(state?.timestamp);
  return !Number.isFinite(timestamp) || now - timestamp > TRADER_SOURCE_STALE_MS;
}

function traderEffectivelyActive(trader, state, now = Date.now()) {
  if (trader?.active) return true;
  const window = traderWindow(trader, now);
  if (!window.scheduledActive) return false;
  // Prefer the upstream flag, but trust the published activation/expiry window
  // when the whole world-state snapshot is stale or the transition has been
  // inconsistent for more than a short grace period.
  return worldStateIsStale(state, now) || now - window.activation >= TRADER_TRANSITION_GRACE_MS;
}

function allCandidates(state) {
  const active = (items) => Array.isArray(items) ? items.filter((item) => !item.expired) : [];
  const result = { fissure: [], arbitration: [], alert: [], invasion: [], event: [], trader: [], sortie: [], incursion: [], bounty: [] };
  result.fissure = active(state.fissures).map((item) => {
    const place = parseNode(item.node);
    return {
      id: `fissure:${item.id || `${item.node}:${item.tier}:${item.expiry}`}`,
      type: 'fissure', node: place.node, planet: place.planet,
      missionType: item.missionType, mission: translatedOrChinese(MISSION_ZH, item.missionType, '未知任务'),
      faction: translatedOrChinese(FACTION_ZH, item.enemy, '未知阵营'), tier: item.tier,
      expiry: item.expiry, hard: Boolean(item.isHard), storm: Boolean(item.isStorm),
      recommended: FAST_FISSURE_MISSIONS.has(item.missionType),
    };
  });
  if (state.arbitration && !state.arbitration.expired) {
    const place = parseNode(state.arbitration.node);
    result.arbitration.push({
      id: `arbitration:${state.arbitration.id || `${state.arbitration.node}:${state.arbitration.type}:${state.arbitration.expiry}`}`,
      type: 'arbitration', node: place.node, planet: place.planet,
      missionType: state.arbitration.type, mission: translatedOrChinese(MISSION_ZH, state.arbitration.type, '未知任务'),
      enemy: translatedOrChinese(FACTION_ZH, state.arbitration.enemy, '未知阵营'), expiry: state.arbitration.expiry,
      source: state.arbitration.source || 'warframestat.us',
      ...(state.arbitration.arbyTier ? { arbyTier: state.arbitration.arbyTier } : {}),
    });
  }
  result.alert = active(state.alerts).map((item) => ({
    id: `alert:${item.id || `${item.mission?.node}:${item.expiry}`}`, type: 'alert',
    node: item.mission?.node || '未知节点', mission: translatedOrChinese(MISSION_ZH, item.mission?.type, '未知任务'),
    reward: rewardText(item.mission?.reward) || '未知奖励', expiry: item.expiry,
  }));
  result.invasion = active(state.invasions).map((item) => {
    const attacker = rewardText(item.attacker?.reward);
    const defender = rewardText(item.defender?.reward);
    const rewards = `${attacker} ${defender}`.trim();
    const rare = /(potato|forma|exilus|weapon|wraith|vandal|mutalist alad|反应堆|催化剂|福马|适配器|亡魂|破坏者|武器)/iu.test(`${(item.rewardTypes || []).join(' ')} ${rewards}`);
    return {
      id: `invasion:${item.id || `${item.node}:${item.activation}`}`, type: 'invasion', node: item.node || '未知节点',
      description: `进攻方 ${attacker || '无'} / 防守方 ${defender || '无'}`,
      rewardTypes: item.rewardTypes || [], rewards, rare,
      completion: Math.max(0, Math.min(100, Math.round(Number(item.completion) || 0))),
    };
  });
  result.event = active(state.events).map((item) => ({
    id: `event:${item.id || `${item.description}:${item.expiry}`}`, type: 'event',
    description: translateEventName(item.description), detail: translateEventDetail(item.tooltip || ''), node: item.node || '', expiry: item.expiry,
  }));
  // 突击：每日 16:00 UTC 轮换，单条三段任务；id 含当日 id，seen 去重天然每日只推一次
  if (state.sortie && !state.sortie.expired && Date.parse(state.sortie.expiry) > Date.now()) {
    const sortie = state.sortie;
    result.sortie.push({
      id: `sortie:${sortie.id || sortie.expiry}`, type: 'sortie',
      boss: SORTIE_BOSS_ZH[normalize(sortie.boss)] || normalize(sortie.boss) || '未知首领',
      faction: translatedOrChinese(FACTION_ZH, sortie.faction, '未知阵营'),
      variants: (sortie.variants || []).map((variant) => ({
        mission: translatedOrChinese(MISSION_ZH, variant.missionType, '未知任务'),
        node: variant.node || '未知节点',
        modifier: SORTIE_MODIFIER_ZH[normalize(variant.modifier)] || '未收录词缀',
      })),
      expiry: sortie.expiry,
    });
  }
  // 钢铁侵袭：worldstate 没有该数据，由 monitor/query 侧从排期缓存注入 state.steelIncursions；
  // 一天打包成一条（六节点同 sortie 的 variants 模式），id 含当日 epoch，seen 去重天然每日一推
  if (state.steelIncursions && Date.parse(state.steelIncursions.expiry) > Date.now()) {
    const incursion = state.steelIncursions;
    result.incursion.push({
      id: incursion.id, type: 'incursion',
      nodes: incursion.nodes || [],
      // 供 genericMatches 的筛选词命中（nodes 是对象数组，flat 后进不了 haystack）
      searchText: (incursion.nodes || []).map((node) => `${node.mission} ${node.planet} ${node.node} ${node.faction}`).join(' '),
      expiry: incursion.expiry,
    });
  }
  // 悬赏：monitor 侧预装配后注入（译名映射是异步的，同 steelIncursions 模式）
  if (Array.isArray(state.bountyCandidates)) {
    result.bounty = state.bountyCandidates.filter((item) => !item.expiry || Date.parse(item.expiry) > Date.now());
  }
  const traders = Array.isArray(state.voidTraders) ? state.voidTraders : state.voidTrader ? [state.voidTrader] : [];
  result.trader = traders.filter((item) => traderEffectivelyActive(item, state)).map((item) => {
    const rawLocation = item.location || '未知中继站';
    const place = parseNode(rawLocation);
    return {
      id: `trader:${item.id || item.activation || item.expiry}`, type: 'trader', active: true,
      location: rawLocation.includes('(') ? `${place.planet} · ${place.node}` : rawLocation,
      activation: item.activation, expiry: item.expiry,
    };
  });
  return result;
}

function filterWords(value) {
  return normalizeFilter(value).split(' ').filter(Boolean);
}

function fissureMatches(item, filter) {
  const value = normalizeFilter(filter);
  if (/钢铁|steel/iu.test(value) && !item.hard) return false;
  if (/普通|normal/iu.test(value) && item.hard) return false;
  if (/九重天|航道星舰|storm/iu.test(value) && !item.storm) return false;
  const tiers = [
    ['Lith', /古纪|lith/iu], ['Meso', /前纪|meso/iu], ['Neo', /中纪|neo/iu],
    ['Axi', /后纪|axi/iu], ['Requiem', /安魂|requiem/iu], ['Omnia', /全能|omnia/iu],
  ];
  const tier = tiers.find(([, pattern]) => pattern.test(value))?.[0];
  if (tier && item.tier !== tier) return false;
  const missions = Object.entries(MISSION_ZH).filter(([english, chinese]) => value.includes(english.toLowerCase()) || value.includes(chinese)).map(([english]) => english);
  if (missions.length && !missions.includes(item.missionType)) return false;
  if (/推荐|高效|速刷/iu.test(value) && !item.recommended) return false;
  return true;
}

function arbitrationMatches(item, filter) {
  let value = normalizeFilter(filter);
  // 「推荐」= 社区评级 S/A 场地（browse.wf arbyTiers，含 S+/A- 等带符号档）；评级缺失的节点不算推荐（宁漏不吵）
  if (/推荐|好场|好图/u.test(value)) {
    if (!/^[SA]/iu.test(String(item.arbyTier || ''))) return false;
    value = value.replace(/推荐|好场|好图/gu, ' ').trim();
  }
  const words = filterWords(value);
  if (!words.length) return true;
  const haystack = normalizeFilter(`${item.missionType} ${item.mission} ${item.node} ${item.planet} ${item.enemy}`);
  return words.every((word) => haystack.includes(word));
}

function invasionMatches(item, filter) {
  let value = normalizeFilter(filter);
  const haystack = normalizeFilter(`${item.rewardTypes.join(' ')} ${item.rewards} ${item.description}`);
  if (!value) return /(potato|forma|exilus|weapon|wraith|vandal|mutalist alad|反应堆|催化剂|福马|适配器|亡魂|破坏者|武器)/iu.test(haystack);
  value = value.replace(/土豆/gu, '反应堆 催化剂').replace(/福马|forma/giu, 'forma').replace(/奸商/gu, 'baro');
  return filterWords(value).some((word) => haystack.includes(word));
}

function genericMatches(item, filter) {
  const words = filterWords(filter);
  if (!words.length) return true;
  const haystack = normalizeFilter(Object.values(item).flat().join(' '));
  return words.every((word) => haystack.includes(word));
}

function matches(subscription, item) {
  if (subscription.type === 'fissure') return fissureMatches(item, subscription.filter);
  if (subscription.type === 'arbitration') return arbitrationMatches(item, subscription.filter);
  if (subscription.type === 'invasion') return invasionMatches(item, subscription.filter);
  // 轮换提醒候选由订阅自身到点生成，只匹配自己
  if (subscription.type === 'rotation') return item.subOnly === subscription.id;
  return genericMatches(item, subscription.filter);
}

function futureIso(values, fallbackMs) {
  const now = Date.now();
  // Some upstream objects use a far-future sentinel for a missing expiry.
  // Ignore anything beyond one year so adding the wake-up safety margin can
  // never exceed JavaScript's Date range.
  const latestUseful = now + 366 * 24 * 60 * 60 * 1000;
  const times = values.map((value) => Date.parse(value)).filter((value) => Number.isFinite(value) && value > now && value < latestUseful).sort((a, b) => a - b);
  return new Date((times[0] || now + fallbackMs) + 10_000).toISOString();
}

function updateSchedule(ledger, target, state, activeTypes) {
  const now = Date.now();
  const previous = ledger.schedules[target] || {};
  const next = { ...previous, lastFetchAt: new Date(now).toISOString() };
  if (activeTypes.has('fissure')) next.fissure = futureIso((state.fissures || []).map((item) => item.expiry), 5 * 60 * 1000);
  if (activeTypes.has('arbitration')) next.arbitration = futureIso([state.arbitration?.expiry], 60 * 60 * 1000);
  // 突击每日 16:00 UTC 刷新：蝻 expiry，兼容数据缺失时 6h 兄底
  if (activeTypes.has('sortie')) next.sortie = futureIso([state.sortie?.expiry], 6 * 60 * 60 * 1000);
  // 侵袭每日 00:00 UTC 轮换：蹲当日条目到期，数据缺失时 6h 兜底
  if (activeTypes.has('incursion')) next.incursion = futureIso([state.steelIncursions?.expiry], 6 * 60 * 60 * 1000);
  // 悬赏 2.5h 一轮：蹲候选到期，数据缺失时 30min 兜底
  if (activeTypes.has('bounty')) next.bounty = futureIso((state.bountyCandidates || []).map((item) => item.expiry), 30 * 60 * 1000);
  // 轮换提醒：蹲各一次性订阅的目标时刻
  if (activeTypes.has('rotation')) {
    const ats = ledger.subscriptions
      .filter((item) => item.target === target && item.enabled && item.type === 'rotation' && Number(item.meta?.at))
      .map((item) => new Date(Number(item.meta.at)).toISOString());
    next.rotation = futureIso(ats, 6 * 60 * 60 * 1000);
  }
  if (activeTypes.has('trader')) {
    const trader = state.voidTrader || state.voidTraders?.[0];
    const window = traderWindow(trader, now);
    const effectivelyActive = traderEffectivelyActive(trader, state, now);
    if (effectivelyActive) {
      // 商人在站时额外蹲一个「离开前 12 小时」检查点，支撑最后窗口播报
      const closingAtMs = window.expiry - CLOSING_TRADER_MS;
      const checkpoints = [trader?.expiry];
      if (Number.isFinite(closingAtMs)) checkpoints.push(new Date(closingAtMs).toISOString());
      next.trader = futureIso(checkpoints, 6 * 60 * 60 * 1000);
    } else if (window.scheduledActive) {
      // 激活时间已到、active 尚未翻转：短暂复查，绝不能直接睡六小时。
      next.trader = new Date(now + TRADER_TRANSITION_RETRY_MS).toISOString();
    } else {
      next.trader = futureIso([trader?.activation], 6 * 60 * 60 * 1000);
    }
    next.traderPolicyVersion = TRADER_SCHEDULE_POLICY_VERSION;
  }
  if ([...activeTypes].some((type) => ['alert', 'invasion', 'event'].includes(type))) {
    next.unpredictable = new Date(now + UNPREDICTABLE_INTERVAL_MS).toISOString();
  }
  if (activeTypes.has('weekly')) {
    // 本周清单还没推完就每分钟重试，推完后蹲下周一 00:00 UTC
    const weeklyId = `weekly:${weeklyWeekStart()}`;
    const pending = ledger.subscriptions.some((item) => item.target === target && item.enabled && item.type === 'weekly' && !(item.seen || []).includes(weeklyId));
    next.weekly = pending ? new Date(now + 60_000).toISOString() : new Date(Date.parse(weeklyNextReset()) + 10_000).toISOString();
  }
  if (activeTypes.has('shop')) {
    // 泰辛/圣言者都是周一 00:00 UTC 界：蹲周界（新货推送）+ 结束前 24h（未购提醒检查点）
    const weekEndMs = Date.parse(weeklyNextReset());
    const checkpoints = [weeklyNextReset()];
    if (weekEndMs - 24 * 3600_000 > now) checkpoints.push(new Date(weekEndMs - 24 * 3600_000).toISOString());
    next.shop = futureIso(checkpoints, 6 * 60 * 60 * 1000);
  }
  if (activeTypes.has('vendor-item')) {
    // 可算类：蹲各订阅预告的上架时刻；watch 类：跟 Baro 到/离边界对账
    const checkpoints = ledger.subscriptions
      .filter((item) => item.target === target && item.enabled && item.type === 'vendor-item')
      .map((item) => item.meta?.nextAt).filter(Boolean).map((ms) => new Date(ms).toISOString());
    const trader = state.voidTrader || state.voidTraders?.[0];
    if (trader?.activation) checkpoints.push(trader.activation);
    if (trader?.expiry) checkpoints.push(trader.expiry);
    next['vendor-item'] = futureIso(checkpoints, 6 * 60 * 60 * 1000);
  }
  ledger.schedules[target] = next;
}

function monitorIsDue(schedule, activeTypes) {
  const now = Date.now();
  const due = (key) => !schedule?.[key] || !Number.isFinite(Date.parse(schedule[key])) || now >= Date.parse(schedule[key]);
  if (activeTypes.has('fissure') && due('fissure')) return true;
  if (activeTypes.has('arbitration') && due('arbitration')) return true;
  if (activeTypes.has('sortie') && due('sortie')) return true;
  if (activeTypes.has('incursion') && due('incursion')) return true;
  if (activeTypes.has('bounty') && due('bounty')) return true;
  if (activeTypes.has('rotation') && due('rotation')) return true;
  // Force one immediate catch-up after this scheduling fix so ledgers that
  // already contain the old six-hour sleep are repaired without manual edits.
  if (activeTypes.has('trader') && schedule?.traderPolicyVersion !== TRADER_SCHEDULE_POLICY_VERSION) return true;
  if (activeTypes.has('trader') && due('trader')) return true;
  if (activeTypes.has('weekly') && due('weekly')) return true;
  if (activeTypes.has('shop') && due('shop')) return true;
  if (activeTypes.has('vendor-item') && due('vendor-item')) return true;
  if ([...activeTypes].some((type) => ['alert', 'invasion', 'event'].includes(type)) && due('unpredictable')) return true;
  return false;
}

async function fetchWorldState() {
  const response = await fetch(WORLD_STATE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`world state HTTP ${response.status}`);
  return response.json();
}

async function fetchChecked(url, kind = 'json') {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return kind === 'text' ? response.text() : response.json();
}

function arbitrationCachePath(statePath) {
  return path.join(path.dirname(statePath), 'warframe-arbitration-cache.json');
}

async function readArbitrationCache(statePath) {
  try {
    const parsed = JSON.parse(await readFile(arbitrationCachePath(statePath), 'utf8'));
    const fetchedAt = Date.parse(parsed.fetchedAt);
    const lastEpoch = Number(parsed.schedule?.at(-1)?.epoch || 0) * 1000;
    if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < 24 * 60 * 60 * 1000 && lastEpoch > Date.now() + 24 * 60 * 60 * 1000) return parsed;
  } catch { /* refresh below */ }
  return null;
}

async function refreshArbitrationCache(statePath) {
  const [rawSchedule, regions, dict, dictEn, arbyTiers] = await Promise.all([
    fetchChecked(ARBITRATION_SCHEDULE_URL, 'text'),
    fetchChecked(ARBITRATION_REGIONS_URL),
    fetchChecked(ARBITRATION_DICT_URL),
    fetchChecked(ARBITRATION_DICT_EN_URL),
    getArbyTiers(),
  ]);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const earliest = nowSeconds - 2 * 60 * 60;
  const latest = nowSeconds + 45 * 24 * 60 * 60;
  const schedule = String(rawSchedule).split(/\r?\n/u).map((line) => line.split(',')).filter((parts) => parts.length === 2).map(([epochRaw, codeRaw]) => ({ epoch: Number(epochRaw), code: normalize(codeRaw) })).filter((entry) => Number.isFinite(entry.epoch) && entry.epoch >= earliest && entry.epoch <= latest).map((entry) => {
    const region = regions?.[entry.code] || {};
    const missionType = region.missionType || 'UNKNOWN';
    const factionCode = region.faction || 'UNKNOWN';
    return {
      ...entry,
      node: dictEn?.[region.name] || region.name || entry.code,
      planet: dict?.[region.systemName] || region.systemName || '未知星区',
      missionType,
      mission: MISSION_ZH[missionType] || dict?.[region.missionName] || '未知任务',
      faction: ARBITRATION_FACTION_ZH[factionCode] || '未知阵营',
      // 社区场地评级（browse.wf arbyTiers，S~F）；表里查无的节点不显示
      ...(arbyTiers[entry.code] ? { tier: arbyTiers[entry.code] } : {}),
    };
  });
  if (!schedule.length) throw new Error('browse.wf 仲裁排期为空');
  const cache = { version: 1, fetchedAt: new Date().toISOString(), source: 'browse.wf', schedule };
  await writeFile(arbitrationCachePath(statePath), `${JSON.stringify(cache)}\n`, 'utf8');
  return cache;
}

async function scheduledArbitration(statePath) {
  const cache = await readArbitrationCache(statePath) || await refreshArbitrationCache(statePath);
  const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600;
  const entry = cache.schedule.find((item) => item.epoch === currentHour);
  if (!entry) throw new Error('browse.wf 仲裁排期缺少当前整点');
  return {
    id: `browse-wf:${entry.epoch}:${entry.code}`,
    node: `${entry.node} (${entry.planet})`,
    type: entry.missionType,
    enemy: entry.faction,
    activation: new Date(entry.epoch * 1000).toISOString(),
    expiry: new Date((entry.epoch + 3600) * 1000).toISOString(),
    expired: false,
    source: 'browse.wf',
    ...(entry.tier ? { arbyTier: entry.tier } : {}),
  };
}

// —— 钢铁之路侵袭：排期缓存与仲裁同款（browse.wf 排期表 + ExportRegions + 官方词典），TTL 24h ——
function incursionsCachePath(statePath) {
  return path.join(path.dirname(statePath), 'warframe-incursions-cache.json');
}

async function readIncursionsCache(statePath) {
  try {
    const parsed = JSON.parse(await readFile(incursionsCachePath(statePath), 'utf8'));
    if (parsed.version !== 2) return null; // v2 新增 levels 字段，旧缓存强制重建
    const fetchedAt = Date.parse(parsed.fetchedAt);
    const lastEpoch = Number(parsed.days?.at(-1)?.epoch || 0) * 1000;
    if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < 24 * 60 * 60 * 1000 && lastEpoch > Date.now() + 24 * 60 * 60 * 1000) return parsed;
  } catch { /* refresh below */ }
  return null;
}

async function refreshIncursionsCache(statePath) {
  const [rawSchedule, regions, dict, dictEn] = await Promise.all([
    fetchChecked(SP_INCURSIONS_URL, 'text'),
    fetchChecked(ARBITRATION_REGIONS_URL),
    fetchChecked(ARBITRATION_DICT_URL),
    fetchChecked(ARBITRATION_DICT_EN_URL),
  ]);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const earliest = nowSeconds - 2 * 24 * 60 * 60;
  const latest = nowSeconds + 45 * 24 * 60 * 60;
  const days = String(rawSchedule).split(/\r?\n/u)
    .map((line) => line.trim().split(';'))
    .filter((parts) => parts.length === 2)
    .map(([epochRaw, nodesRaw]) => ({ epoch: Number(epochRaw), codes: nodesRaw.split(',').map((code) => normalize(code)).filter(Boolean) }))
    .filter((entry) => Number.isFinite(entry.epoch) && entry.epoch >= earliest && entry.epoch <= latest)
    .map((entry) => ({
      epoch: entry.epoch,
      nodes: entry.codes.map((code) => {
        const region = regions?.[code] || {};
        // 钢铁之路敌人等级 = 星图基础等级 +100（与游戏内显示实证：6-11 → 106-111）
        const levels = region.minEnemyLevel != null ? `${Number(region.minEnemyLevel) + 100}-${Number(region.maxEnemyLevel) + 100}` : null;
        return {
          code,
          // 节点名保留英文（项目硬规则），星区/任务用官方中文
          node: dictEn?.[region.name] || region.name || code,
          planet: dict?.[region.systemName] || region.systemName || '未知星区',
          missionType: region.missionType || 'UNKNOWN',
          mission: MISSION_ZH[region.missionType] || dict?.[region.missionName] || '未知任务',
          faction: ARBITRATION_FACTION_ZH[region.faction] || '未知阵营',
          levels,
        };
      }),
    }));
  if (!days.length) throw new Error('browse.wf 侵袭排期为空');
  const cache = { version: 2, fetchedAt: new Date().toISOString(), source: 'browse.wf', days };
  await writeFile(incursionsCachePath(statePath), `${JSON.stringify(cache)}\n`, 'utf8');
  return cache;
}

async function scheduledIncursions(statePath) {
  const cache = await readIncursionsCache(statePath) || await refreshIncursionsCache(statePath);
  const dayEpoch = Math.floor(Date.now() / 86_400_000) * 86_400;
  const day = cache.days.find((item) => item.epoch === dayEpoch);
  if (!day) throw new Error('侵袭排期缺少当日条目');
  return {
    id: `incursion:${day.epoch}`,
    activation: new Date(day.epoch * 1000).toISOString(),
    expiry: new Date((day.epoch + 86_400) * 1000).toISOString(),
    nodes: day.nodes,
  };
}

// 当前整点的场地评级：缓存命中直读；缓存过期/缺失时可选刷新（推荐订阅靠评级判定，不刷新会永久静默）
async function currentArbitrationTier(statePath, { refreshIfStale = false } = {}) {
  try {
    const cache = await readArbitrationCache(statePath) || (refreshIfStale ? await refreshArbitrationCache(statePath) : null);
    const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600;
    return cache?.schedule?.find((item) => item.epoch === currentHour)?.tier || null;
  } catch {
    return null;
  }
}

// 未来仲裁预告：下一小时 + 未来第一个 S 或 A 级场地；缓存缺失返 {}，预告区降级不显示
// 门槛依据（2026-08-06 排期缓存 1082 条实测）：只认 S 平均要等 25h（p90 59h，卡上常年「3 天后」没参考价值）；
// S/A 合并后 p50 10h / p90 26h，评级表没有 B+/A- 细分档，B 档 21.8% 太滥不算高效
async function upcomingArbitrations(statePath) {
  try {
    const cache = await readArbitrationCache(statePath) || await refreshArbitrationCache(statePath);
    const currentHour = Math.floor(Date.now() / 3_600_000) * 3_600;
    const future = cache.schedule.filter((item) => item.epoch > currentHour).sort((a, b) => a.epoch - b.epoch);
    const shape = (entry) => entry ? {
      mission: entry.mission, node: entry.node, planet: entry.planet, tier: entry.tier || null,
      activation: new Date(entry.epoch * 1000).toISOString(),
    } : null;
    const nextTop = future.find((item) => /^[SA]/u.test(item.tier || ''));
    return { next: shape(future[0]), nextTop: shape(nextTop) };
  } catch {
    return {};
  }
}

async function queryArbitration(statePath, cardDir) {
  const fetchedAt = new Date().toISOString();
  const state = await fetchWorldState();
  if (!state.arbitration || state.arbitration.expired) {
    state.arbitration = await scheduledArbitration(statePath);
  } else if (!state.arbitration.arbyTier) {
    // WFCD 来源无评级：从本地排期缓存补（同一小时同一轮换，缺缓存则不显示）
    const tier = await currentArbitrationTier(statePath);
    if (tier) state.arbitration.arbyTier = tier;
  }
  const item = allCandidates(state).arbitration[0];
  if (!item) return { ok: false, text: '当前仲裁数据暂不可用，请稍后重试。', fetchedAt };
  // 预告区：下个仲裁/下个高效场地（排期缓存本地扫描，失败静默不显示）
  const upcoming = await upcomingArbitrations(statePath);
  if (upcoming.next) item.next = upcoming.next;
  if (upcoming.nextTop) item.nextTop = upcoming.nextTop;
  let mediaUrl = null;
  if (cardDir) {
    mediaUrl = await renderWarframeCard(buildArbitrationQueryCard(item, fetchedAt), cardDir);
  }
  return {
    ok: true,
    text: `当前仲裁：${item.mission} · ${item.planet} ${item.node}，${item.enemy || '未知阵营'}，剩余至 ${item.expiry}`,
    mediaUrl,
    fetchedAt,
    source: String(item.source || '').includes('browse.wf') ? '仲裁排期' : '世界状态',
    item: { ...item, source: String(item.source || '').includes('browse.wf') ? '仲裁排期' : '世界状态' },
  };
}

async function queryIntel(type, cardDir, statePath = DEFAULT_STATE) {
  // 钢铁侵袭不走 worldstate（数据只在排期表里），单独路径
  if (type === 'incursion') {
    const fetchedAt = new Date().toISOString();
    let incursion;
    try {
      incursion = await scheduledIncursions(statePath);
    } catch (error) {
      return { ok: false, text: `钢铁侵袭排期暂时拉取失败（${String(error?.message || error)}），请稍后重试。`, fetchedAt, type, count: 0, items: [] };
    }
    const item = { id: incursion.id, type: 'incursion', nodes: incursion.nodes, expiry: incursion.expiry };
    let mediaUrl = null;
    if (cardDir) mediaUrl = await renderWarframeCard(buildIncursionCard(item, fetchedAt), cardDir);
    return {
      ok: true,
      text: `今日钢铁侵袭：${item.nodes.map((node) => `${node.mission}(${node.planet} ${node.node})`).join('、')}，每节点 +5 钢铁精华，数据时间 ${fetchedAt}`,
      mediaUrl, fetchedAt, source: '侵袭排期', type, count: item.nodes.length, items: [item],
    };
  }
  const meta = {
    alert: { title: '当前警报', empty: '当前没有可用警报' },
    invasion: { title: '当前入侵', empty: '当前没有进行中的入侵' },
    event: { title: '当前活动', empty: '当前没有特殊活动' },
    trader: { title: '虚空商人', empty: '暂时没有虚空商人排期' },
    sortie: { title: '今日突击', empty: '突击数据暂不可用' },
  }[type];
  if (!meta) return { ok: false, text: `不支持的情报类型：${type || '空'}` };
  const fetchedAt = new Date().toISOString();
  const [state] = await Promise.all([
    fetchWorldState(),
    type === 'alert' || type === 'invasion' ? primeRewardTranslations() : Promise.resolve(false),
    type === 'event' ? primeOracleEventMap() : Promise.resolve(false),
  ]);
  let items = allCandidates(state)[type] || [];
  if (type === 'trader' && !items.length) {
    const traders = Array.isArray(state.voidTraders) ? state.voidTraders : state.voidTrader ? [state.voidTrader] : [];
    const trader = traders
      .filter(Boolean)
      .sort((left, right) => Date.parse(left.activation || left.expiry) - Date.parse(right.activation || right.expiry))[0];
    if (trader) {
      const rawLocation = trader.location || '未知中继站';
      const place = parseNode(rawLocation);
      items = [{
        id: `trader:${trader.id || trader.activation || trader.expiry}`,
        type: 'trader',
        active: Boolean(trader.active),
        location: rawLocation.includes('(') ? `${place.planet} · ${place.node}` : rawLocation,
        activation: trader.activation,
        expiry: trader.expiry,
      }];
    }
  }
  let mediaUrl = null;
  if (cardDir) {
    // 突击用专属三段卡；其余类型走通用情报卡；入侵附双舰建造进度（worldstate constructionProgress）
    const construction = type === 'invasion' && state.constructionProgress
      ? { fomorian: Number(state.constructionProgress.fomorianProgress) || 0, razorback: Number(state.constructionProgress.razorbackProgress) || 0 }
      : null;
    const card = type === 'sortie' && items[0]
      ? buildSortieCard(items[0], fetchedAt)
      : buildIntelCard({
        title: meta.title,
        items,
        emptyText: meta.empty,
        query: true,
        fetchedAt,
        source: 'warframestat.us',
        ...(construction ? { construction } : {}),
      });
    mediaUrl = await renderWarframeCard(card, cardDir);
  }
  return {
    ok: true,
    text: items.length ? `${meta.title}：共 ${items.length} 条，数据时间 ${fetchedAt}` : `${meta.empty}，数据时间 ${fetchedAt}`,
    mediaUrl,
    fetchedAt,
    source: '世界状态',
    type,
    count: items.length,
    // 自然语言两段式的点评素材：透传结构化条目（含地点/起止时间）
    items,
  };
}

function displayCondition(subscription) {
  return subscription.filter ? `${TYPE_LABEL[subscription.type]} · ${subscription.filter}` : TYPE_LABEL[subscription.type];
}

// 二段播报：窗口类事件除「出现」外再报一次「最后窗口」。
// 裂缝/仲裁是轮换制不参与；阈值按体验微调，不做成用户配置
const CLOSING_TRADER_MS = 12 * 60 * 60 * 1000;
const CLOSING_EVENT_MS = 24 * 60 * 60 * 1000;
const CLOSING_ALERT_MS = 60 * 60 * 1000;
const CLOSING_INVASION_COMPLETION = 90;
// 仅高价值警报值得报第二次（奖励文本已翻译，Forma 保留原文故用 /forma/i）
const VALUABLE_ALERT_PATTERN = /(反应堆|催化剂|forma|适配器|亡魂|破坏者)/iu;

function closingLabel(item) {
  const remainingMs = Date.parse(item.expiry) - Date.now();
  if (item.type === 'trader') {
    if (item.active !== false && remainingMs > 0 && remainingMs <= CLOSING_TRADER_MS) return '虚空商人即将离开';
    return null;
  }
  if (item.type === 'shop') {
    // 未购提醒：轮换前 24h 且本期没买过（bought 由 monitor 实时读快照判定，读失败=当未购宁多提醒）
    if (!item.bought && remainingMs > 0 && remainingMs <= 24 * 3600_000) return '周货即将轮换·本期还没买';
    return null;
  }
  if (item.type === 'event') {
    if (remainingMs > 0 && remainingMs <= CLOSING_EVENT_MS) return '活动即将结束';
    return null;
  }
  if (item.type === 'alert') {
    if (remainingMs > 0 && remainingMs <= CLOSING_ALERT_MS && VALUABLE_ALERT_PATTERN.test(item.reward || '')) return '高价值警报即将截止';
    return null;
  }
  if (item.type === 'invasion') {
    if (Number(item.completion) >= CLOSING_INVASION_COMPLETION) return '入侵争夺接近结束';
    return null;
  }
  return null;
}

async function monitorTarget(target, statePath, cardDir, dryRun = false) {
  return withLedgerLock(statePath, async () => {
    const ledger = await readLedger(statePath);
    // drops 由 drops.mjs 的本地监测器处理，这里只管联网类事件
    const subscriptions = ledger.subscriptions.filter((item) => item.target === target && item.enabled && item.type !== 'drops');
    if (!subscriptions.length) return { output: 'NO_REPLY\n', data: { ok: true, reason: 'no_subscriptions' } };
    const activeTypes = new Set(subscriptions.map((item) => item.type));
    if (!dryRun && !monitorIsDue(ledger.schedules[target], activeTypes)) {
      return { output: 'NO_REPLY\n', data: { ok: true, reason: 'not_due', schedule: ledger.schedules[target] } };
    }

    const [state] = await Promise.all([
      fetchWorldState(),
      activeTypes.has('alert') || activeTypes.has('invasion') ? primeRewardTranslations() : Promise.resolve(false),
      activeTypes.has('event') ? primeOracleEventMap() : Promise.resolve(false),
    ]);
    if (activeTypes.has('arbitration') && (!state.arbitration || state.arbitration.expired)) {
      state.arbitration = await scheduledArbitration(statePath);
    } else if (activeTypes.has('arbitration') && state.arbitration && !state.arbitration.arbyTier) {
      // 有推荐订阅时允许刷新过期缓存（评级是判定依据）；普通仲裁订阅仍只读缓存
      const needTier = subscriptions.some((item) => item.type === 'arbitration' && /推荐|好场|好图/u.test(normalizeFilter(item.filter)));
      const tier = await currentArbitrationTier(statePath, { refreshIfStale: needTier });
      if (tier) state.arbitration.arbyTier = tier;
    }
    if (activeTypes.has('incursion')) {
      // 拉挂了静默跳过本轮（调度 6h 兜底会再试），不拖垮其他订阅类型
      try { state.steelIncursions = await scheduledIncursions(statePath); } catch { /* skip this round */ }
    }
    if (activeTypes.has('bounty')) {
      // 译名映射拉挂了静默跳过本轮（syndicateMissions 已在 state 里，零额外请求）
      try {
        const { bountyCandidatesFromSyndicates } = await import('./bounties.mjs');
        state.bountyCandidates = await bountyCandidatesFromSyndicates(state.syndicateMissions);
      } catch { /* skip this round */ }
    }
    const candidates = allCandidates(state);
    if (activeTypes.has('shop') || activeTypes.has('vendor-item')) {
      // 商店数据源挂了静默跳过本轮，不拖垮其他订阅
      try { await appendShopCandidates(candidates, subscriptions, state); } catch { /* skip this round */ }
    }
    // 轮换提醒：到点的一次性订阅自生候选（subOnly 只匹配自己）
    if (activeTypes.has('rotation')) {
      candidates.rotation = subscriptions
        .filter((item) => item.type === 'rotation' && item.enabled && Number(item.meta?.at) && Date.now() >= Number(item.meta.at))
        .map((item) => ({
          id: `rotation:${item.id}:${item.meta.at}`,
          type: 'rotation',
          label: item.meta.label || item.filter,
          subOnly: item.id,
          expiry: new Date(Number(item.meta.at) + 7 * 86_400_000).toISOString(),
        }));
    }
    const freshById = new Map();
    const closingById = new Map();
    for (const subscription of subscriptions) {
      const current = (candidates[subscription.type] || []).filter((item) => matches(subscription, item));
      const seen = new Set(Array.isArray(subscription.seen) ? subscription.seen : []);
      const closingMarks = [];
      if (subscription.initialized) {
        for (const item of current) {
          if (!seen.has(item.id)) {
            const existing = freshById.get(item.id) || { ...item, matches: [] };
            existing.matches.push({
              subscriptionId: subscription.id,
              condition: displayCondition(subscription),
              ownerName: subscription.ownerName || subscription.ownerId,
            });
            freshById.set(item.id, existing);
          } else if (!seen.has(`${item.id}#closing`)) {
            // 已报过出现、未报过最后窗口：进入窗口则补报一次
            const label = closingLabel(item);
            if (label) {
              const existing = closingById.get(item.id) || { ...item, closing: label, matches: [] };
              existing.matches.push({
                subscriptionId: subscription.id,
                condition: displayCondition(subscription),
                ownerName: subscription.ownerName || subscription.ownerId,
              });
              closingById.set(item.id, existing);
              closingMarks.push(`${item.id}#closing`);
            }
          }
        }
      }
      subscription.initialized = true;
      subscription.seen = [...new Set([...(subscription.seen || []), ...current.map((item) => item.id), ...closingMarks])].slice(-600);
    }
    // 一次性订阅：本轮命中（进 fresh）即消费，同一事务内删除——即使后续渲染失败也有文字兜底发出
    const onceConsumed = new Set();
    for (const item of freshById.values()) for (const match of item.matches) onceConsumed.add(match.subscriptionId);
    if (onceConsumed.size) {
      ledger.subscriptions = ledger.subscriptions.filter((item) => !(item.meta?.once && onceConsumed.has(item.id)));
    }
    updateSchedule(ledger, target, state, activeTypes);
    await writeLedger(statePath, ledger);

    const fresh = [...freshById.values()];
    const closing = [...closingById.values()];
    if (dryRun) return { output: `${JSON.stringify({ ok: true, target, fresh, closing, schedule: ledger.schedules[target] }, null, 2)}\n`, data: { ok: true, fresh, closing } };
    if (!fresh.length && !closing.length) {
      // 周常推送优先级最低：只在本轮没有其他推送时进行，被挤占就下一分钟重试
      const weeklyId = `weekly:${weeklyWeekStart()}`;
      const pendingWeekly = subscriptions.filter((item) => item.type === 'weekly' && !(item.seen || []).includes(weeklyId));
      if (pendingWeekly.length) {
        const weeklyStatePath = path.join(path.dirname(statePath), 'warframe-weekly.json');
        const first = pendingWeekly[0];
        // 多人同会话只渲染一张（当前只服务私聊；群聊多人完成度拆分待后续需求）
        const { mediaUrl } = await renderWeeklyDetailCardFor(weeklyStatePath, { target, ownerId: first.ownerId, ownerName: first.ownerName }, state, cardDir);
        // 第二张：本周好货卡（2026-08-06 用户拍板周一双卡）。任一环节挂了都静默降级只发周报
        let dealsMediaUrl = null;
        if (cardDir) {
          try {
            const [{ readSnapshot }, shop, shopCard] = await Promise.all([
              import('./alecaframe.mjs'), import('./vendor-shop.mjs'), import('./vendor-shop-card.mjs'),
            ]);
            let inventory = null;
            try { ({ inventory } = await readSnapshot()); } catch { inventory = null; }
            const context = await shop.loadShopContext({ inventory });
            const deals = await shop.buildWeeklyDeals(context);
            if (deals.sections.length || deals.varzia) {
              dealsMediaUrl = await renderWarframeCard(shopCard.buildWeeklyDealsCard(deals), cardDir);
            }
          } catch { dealsMediaUrl = null; }
        }
        for (const item of pendingWeekly) item.seen = [...new Set([...(item.seen || []), weeklyId])].slice(-600);
        updateSchedule(ledger, target, state, activeTypes);
        await writeLedger(statePath, ledger);
        // 多行 MEDIA：运行时 MEDIA_TOKEN_RE 带 g 标志逐条捕获，两张图独立投递（源码实证）
        if (mediaUrl) return { output: `MEDIA:${mediaUrl}\n${dealsMediaUrl ? `MEDIA:${dealsMediaUrl}\n` : ''}`, data: { ok: true, weekly: weeklyId, mediaUrl, dealsMediaUrl } };
        return { output: '📅 本周周常已刷新，发送“周常”查看详细清单。\n', data: { ok: true, weekly: weeklyId } };
      }
      return { output: 'NO_REPLY\n', data: { ok: true, reason: 'no_fresh' } };
    }

    // 私聊只有一个订阅人，不显示名字；群聊里昵称缺失会回退成 openid，
    // 长 hex 一律不上卡片（不回显账号标识）
    const isPrivateChat = target.startsWith('qqbot:c2c:');
    const looksLikeRawId = (value) => /^[0-9a-f]{16,}$/iu.test(String(value || '').trim());
    const detailFor = (item, prefix) => [...new Set(item.matches.map((match) => {
      const name = !isPrivateChat && match.ownerName && !looksLikeRawId(match.ownerName) ? match.ownerName : '';
      const base = name ? `${name}：${match.condition}` : match.condition;
      return prefix ? `${prefix} · ${base}` : base;
    }))].join('；');
    for (const item of fresh) item.subscriptionDetail = detailFor(item, '');
    for (const item of closing) item.subscriptionDetail = detailFor(item, `⏰ ${item.closing}`);

    const all = [...fresh, ...closing];
    // 订阅推送统一情报雷达模板（2026-08-06 用户拍板）：单条专属 alert 卡全部废弃，
    // 类型差异由 intelPresentation 各分支承担；shop 的「等 N 件」在装配侧补进 itemName
    for (const item of all) {
      if (item.type === 'shop' && item.rotatingCount > 1 && !String(item.itemName || '').includes('等 ')) {
        item.itemName = `${item.itemName} 等 ${item.rotatingCount} 件`;
      }
    }
    const title = !fresh.length
      ? `订阅提醒 · 最后窗口 ${closing.length} 条`
      : `订阅命中 · ${all.length} 条更新`;
    const card = buildIntelCard({ title, items: all, fetchedAt: state.timestamp || new Date().toISOString(), source: activeTypes.has('arbitration') ? 'warframestat.us + browse.wf' : 'warframestat.us' });
    if (cardDir) {
      try {
        const mediaUrl = await renderWarframeCard(card, cardDir);
        if (mediaUrl) return { output: `MEDIA:${mediaUrl}\n`, data: { ok: true, fresh, closing, mediaUrl } };
      } catch { /* text fallback below */ }
    }
    const lines = ['🎯 星际战甲订阅提醒', ...all.map((item) => {
      if (item.type === 'fissure') return `• ${TIER_ZH[item.tier] || item.tier} ${item.mission} · ${item.planet} ${item.node} · ${item.subscriptionDetail}`;
      if (item.type === 'arbitration') return `• 仲裁 ${item.mission} · ${item.planet} ${item.node} · ${item.subscriptionDetail}`;
      if (item.type === 'sortie') return `• 突击 ${item.boss} · ${item.variants.map((variant) => variant.mission).join('→')} · ${item.subscriptionDetail}`;
      if (item.type === 'incursion') return `• 钢铁侵袭 ${(item.nodes || []).map((node) => node.mission).join('/')} · ${item.subscriptionDetail}`;
      if (item.type === 'bounty') return `• 赏金 ${item.placeZh} ${item.jobZh}（${item.topReward || ''}）· ${item.subscriptionDetail}`;
      if (item.type === 'rotation') return `• 轮换到点 ${item.label}（一次性提醒已自动取消）· ${item.subscriptionDetail}`;
      return `• ${TYPE_LABEL[item.type]} · ${item.description || item.reward || item.location || item.node || ''} · ${item.subscriptionDetail}`;
    }), `来源：${activeTypes.has('arbitration') ? '世界状态＋仲裁排期' : '世界状态'}`];
    return { output: `${lines.join('\n')}\n`, data: { ok: true, fresh, closing } };
  });
}

async function seedDefaults(context, statePath) {
  return withLedgerLock(statePath, async () => {
    const ledger = await readLedger(statePath);
    const results = ['alert', 'invasion', 'event', 'trader'].map((type) => addOne(ledger, context, { type, filter: '' }));
    await writeLedger(statePath, ledger);
    return { ok: true, added: results.filter((item) => item.created).map((item) => subscriptionLabel(item.item)), targetActiveCount: ledger.subscriptions.filter((item) => item.target === context.target && item.enabled).length };
  });
}

function outputJson(value) {
  process.stdout.write(`${JSON.stringify(value, stripDataUriReplacer)}\n`);
}

// openid 大小写不稳定，target/owner 一律小写归一化
const normalizeId = (value) => normalize(value).toLowerCase();

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const statePath = path.resolve(String(args.state || DEFAULT_STATE));
  if (command === 'manage') {
    outputJson(await manageCommand(args.message, {
      target: normalizeId(args.target), ownerId: normalizeId(args.owner), ownerName: normalize(args['owner-name']) || normalizeId(args.owner),
      personalAllowed: String(args['personal-allowed']).toLowerCase() === 'true',
    }, statePath));
    return;
  }
  if (command === 'monitor') {
    const result = await monitorTarget(normalizeId(args.target), statePath, args['card-dir'] ? path.resolve(String(args['card-dir'])) : null, String(args['dry-run']).toLowerCase() === 'true');
    process.stdout.write(result.output);
    return;
  }
  if (command === 'query-arbitration') {
    outputJson(await queryArbitration(statePath, args['card-dir'] ? path.resolve(String(args['card-dir'])) : null));
    return;
  }
  if (command === 'query-intel') {
    outputJson(await queryIntel(normalize(args.type), args['card-dir'] ? path.resolve(String(args['card-dir'])) : null, statePath));
    return;
  }
  if (command === 'seed') {
    outputJson(await seedDefaults({ target: normalize(args.target), ownerId: normalize(args.owner), ownerName: normalize(args['owner-name']) || normalize(args.owner) }, statePath));
    return;
  }
  outputJson({ ok: false, error: '用法：manage、monitor、query-arbitration、query-intel 或 seed；请按技能说明提供参数' });
  process.exitCode = 1;
}

export { manageCommand, monitorTarget, parseSubscriptionSpec, queryArbitration, queryIntel, seedDefaults, closingLabel, translateEventName, primeOracleEventMap, refreshArbitrationCache, refreshIncursionsCache, scheduledIncursions, arbitrationMatches, allCandidates, monitorIsDue, traderEffectivelyActive, traderWindow, updateSchedule, worldStateIsStale };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // monitor 的 stdout 会被 cron 直接投递到 QQ，异常绝不能漏裸 JSON
    if (process.argv[2] === 'monitor') process.stdout.write('NO_REPLY\n');
    else outputJson({ ok: false, error: String(error?.message || error) });
    process.exitCode = 1;
  });
}
