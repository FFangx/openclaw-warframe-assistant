#!/usr/bin/env node
// Warframe assistant CLI. Node >= 18; no dependencies.
// Query commands are read-only. The monitor command writes only its deduplication state file.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildFissureAlertCard, buildIntelCard, renderWarframeCard } from './warframe-cards.mjs';
import { applyRewardAliases } from './reward-zh-fallback.mjs';
import { loadWorldState } from './worldstate-source.mjs';

const WS_BASE = 'https://api.warframestat.us';
const MKT_BASE = 'https://api.warframe.market';
const PLATFORMS = new Set(['pc', 'ps4', 'xbox', 'switch', 'mobile']);
const WS_PLATFORM = { pc: 'pc', ps4: 'ps4', xbox: 'xb1', switch: 'swi', mobile: null };
const TIMEOUT_MS = 20000;

const out = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
const fail = (stage, err, extra = {}) => {
  out({ ok: false, stage, error: String(err?.message || err), fetchedAt: new Date().toISOString(), ...extra });
  process.exit(1);
};

async function getJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const apiError = body?.error ? JSON.stringify(body.error) : '';
      throw new Error(`HTTP ${response.status} ${apiError} (${url})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) fail('args', `参数缺少值：--${key}`);
    args[key] = next;
    i++;
  }
  return args;
}

function sanitizeQuery(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('查询内容不能为空');
  if (!/^[\w\s\-'\u4e00-\u9fff]{1,80}$/u.test(value)) throw new Error('查询内容含有不支持的字符');
  return value.trim();
}

function checkPlatform(platform) {
  if (!PLATFORMS.has(platform)) throw new Error(`不支持的平台：${platform}（可用 pc/ps4/xbox/switch/mobile）`);
  return platform;
}

function requirePlatform(args, command) {
  if (args.platform === undefined) {
    fail('args', `命令 ${command} 必须指定 --platform（pc/ps4/xbox/switch/mobile）`);
  }
  return checkPlatform(String(args.platform).toLowerCase());
}

function parseCrossplay(args) {
  if (args.crossplay === undefined) return true;
  const value = String(args.crossplay).toLowerCase();
  if (!['true', 'false'].includes(value)) fail('args', '--crossplay 只能设为 true 或 false');
  return value === 'true';
}

function parseType(args) {
  if (args.type === undefined) return '';
  const type = String(args.type).toLowerCase();
  if (!['warframe', 'weapon', 'item'].includes(type)) fail('args', '--type 只能设为 warframe、weapon 或 item');
  return type;
}

function parseBoolean(args, key, fallback = false) {
  if (args[key] === undefined) return fallback;
  const value = String(args[key]).toLowerCase();
  if (!['true', 'false'].includes(value)) fail('args', `--${key} 只能设为 true 或 false`);
  return value === 'true';
}

function parseMonitorMode(args) {
  const mode = String(args.mode || 'all').toLowerCase();
  if (!['all', 'unpredictable', 'scheduled', 'fissure'].includes(mode)) {
    fail('args', '--mode 只能设为 all、unpredictable、scheduled 或 fissure');
  }
  return mode;
}

const ZH_MISSION = {
  Extermination: '歼灭', Capture: '捕获', Sabotage: '破坏', Rescue: '救援', Spy: '间谍',
  Defense: '防御', 'Mobile Defense': '移动防御', Interception: '拦截', Survival: '生存',
  Excavation: '挖掘', Disruption: '中断', 'Void Cascade': '虚空覆涌', 'Void Flood': '虚空洪流',
  'Void Armageddon': '虚空决战', Orphix: '奥菲克斯', Assault: '强袭', Defection: '叛逃',
  'Infested Salvage': '疫变回收', Volatile: '反应堆破坏', Alchemy: '炼金术', Crossfire: '歼灭',
  Skirmish: '前哨战', Hijack: '劫持', Pursuit: '追击', Rush: '突袭', Assassination: '刺杀',
};
const ZH_FACTION = {
  Grineer: 'Grineer', Corpus: 'Corpus', Infested: 'Infested', Orokin: '奥罗金',
  Corrupted: '堕落者', Sentient: 'Sentient', Murmur: '低语者', 'The Murmur': '低语者', Tenno: 'Tenno', Narmer: '合一众',
};
const ZH_TIER = { Lith: '古纪', Meso: '前纪', Neo: '中纪', Axi: '后纪', Requiem: '安魂', Omnia: '全能' };
const zh = (map, key, fallback = '未知') => map[key] || fallback;

// 活动、星球与奖励中文化；具体节点名按用户要求保留英文。
const ZH_EVENT = {
  'Razorback Armada': '利刃豺狼舰队', 'Ghoul Purge': '食尸鬼清剿',
  'Balor Fomorian': '巴洛尔巨人战舰', 'Thermia Fractures': '热美亚裂缝',
  'Plague Star': '瘟疫之星', Acolytes: '追随者', Acolyte: '追随者',
  'Tactical Alert': '战术警报', 'Pago Rush': '帕戈突袭',
};
const ZH_PLANET = {
  Mercury: '水星', Venus: '金星', Earth: '地球', Mars: '火星', Phobos: '火卫一', Deimos: '火卫二',
  Ceres: '谷神星', Jupiter: '木星', Europa: '欧罗巴', Saturn: '土星', Uranus: '天王星',
  Neptune: '海王星', Pluto: '冥王星', Eris: '阋神星', Sedna: '赛德娜', Lua: '月球', Void: '虚空',
  'Kuva Fortress': '赤毒要塞', Zariman: '扎里曼', 'Zariman Ten Zero': '扎里曼10-0号',
  'Earth Proxima': '地球比邻星', 'Venus Proxima': '金星比邻星', 'Saturn Proxima': '土星比邻星',
  'Neptune Proxima': '海王星比邻星', 'Pluto Proxima': '冥王星比邻星', 'Veil Proxima': '面纱比邻星', Veil: '面纱比邻星',
};
const ZH_NODE = {
  'Operation Gate Crash': '破门行动',
};
const ZH_ITEM = {
  'Orokin Catalyst': '奥罗金催化剂', 'Orokin Reactor': '奥罗金反应堆',
  'Exilus Adapter': '特殊功能槽适配器', 'Nitain Extract': '泥炭萃取物',
  'Kubrow Egg': '库狛蛋', 'Riven Mod': '裂罅 Mod', 'Forma Blueprint': 'Forma 蓝图',
  'Mutalist Alad V Nav Coordinate': '异融 Alad V 导航坐标',
};
const ZH_ITEM_TOKENS = {
  Wraith: '亡魂', Vandal: '破坏者', Blueprint: '蓝图', Receiver: '枪机', Blade: '刀刃',
  Barrel: '枪管', Stock: '枪托', Handle: '握柄', Neuroptics: '头部神经光元', Chassis: '机体',
  Systems: '系统', Sheev: '希芙', Heatsink: '散热片', Hilt: '刀柄', Dera: '德拉', Karak: '卡拉克', Snipetron: '狙击特昂',
  Latron: '拉特昂', Strun: '斯特朗', Brakk: '布拉克', Detron: '德特昂', 'Twin Vipers': '双子蝰蛇',
  Marelok: '玛瑞火枪', Gorgon: '蛇发女妖', Credits: '现金', Forma: 'Forma', Endo: '内融核心',
  'Orokin Cell': '奥罗金电池', 'Argon Crystal': '氩结晶', Tellurium: '碲',
};
const ZH_ITEM_TOKEN_PATTERN = new RegExp(`\\b(${Object.keys(ZH_ITEM_TOKENS).sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})\\b`, 'gi');
function zhItem(value) {
  const str = String(value ?? '').trim();
  if (ZH_ITEM[str]) return ZH_ITEM[str];
  // 压缩路径尾段先拆词再别名归一（grineer combat knife → sheev），词元表才能命中
  const spaced = applyRewardAliases(str
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/gu, '$1 $2'));
  const translated = spaced.replace(ZH_ITEM_TOKEN_PATTERN, (match) => ZH_ITEM_TOKENS[Object.keys(ZH_ITEM_TOKENS).find((k) => k.toLowerCase() === match.replace(/\s+/g, ' ').toLowerCase())] || match);
  return /[A-Za-z]{2,}/u.test(translated) ? '未收录物品' : translated;
}
function zhNode(value) {
  const str = String(value ?? '');
  const match = str.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (match) return `${match[1].trim()}（${zh(ZH_PLANET, match[2].trim(), '未知星区')}）`;
  return str || '未知节点';
}
const zhEvent = (value) => zh(ZH_EVENT, String(value ?? ''), '特殊活动');

const ZH_CATEGORY = {
  Warframes: '战甲', Primary: '主武器', Secondary: '副武器', Melee: '近战武器', Archwing: '飞翼',
  Misc: '杂项', Mods: 'Mod', Resources: '资源', Gear: '携带道具', Sentinels: '守护', Pets: '同伴',
};
const ZH_POLARITY = {
  madurai: 'Madurai', vazarin: 'Vazarin', naramon: 'Naramon', zenurik: 'Zenurik', unairu: 'Unairu',
  penjaga: '彭贾加', umbra: '暗影', universal: '通用', any: '任意',
};
function visibleLocalizedText(value, allowedTerms = []) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const translated = raw.replace(ZH_ITEM_TOKEN_PATTERN, (match) => ZH_ITEM_TOKENS[Object.keys(ZH_ITEM_TOKENS).find((k) => k.toLowerCase() === match.replace(/\s+/g, ' ').toLowerCase())] || match);
  let residue = translated;
  for (const term of allowedTerms.filter(Boolean)) {
    const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    residue = residue.replace(new RegExp(escaped, 'giu'), '');
  }
  return /[A-Za-z]{2,}/u.test(residue) ? '中文资料暂未完整收录。' : translated;
}

const ZH_BOSS = {
  Jackal: '豺狼', Raptor: '猛禽', 'The Sergeant': '军士', 'Kela De Thaym': '凯拉·德赛姆',
  'General Sargas Ruk': '萨加斯·鲁克将军', 'Alad V': 'Alad V', Ambulas: '安布拉斯',
  'Lech Kril': '莱克·克里尔', 'Vay Hek': '维·黑克', 'Tyl Regor': '泰尔·雷格',
};
const ZH_ARCHON = {
  'Archon Amar': '执刑官欺谋狼主', 'Archon Boreal': '执刑官诡文枭主', 'Archon Nira': '执刑官混沌蛇主',
};
const ZH_STEEL_REWARD = {
  'Umbra Forma Blueprint': '暗影 Forma 蓝图', '50,000 Kuva': '50,000 赤毒',
  'Kitgun Riven Mod': '组合枪裂罅 Mod', '3x Forma': '3 个 Forma', '3 x Forma': '3 个 Forma',
  'Zaw Riven Mod': 'Zaw 裂罅 Mod', '30,000 Endo': '30,000 内融核心',
  'Rifle Riven Mod': '步枪裂罅 Mod', 'Shotgun Riven Mod': '霰弹枪裂罅 Mod',
  'Pistol Riven Mod': '手枪裂罅 Mod',
};
const ZH_CYCLE = { day: '白昼', night: '夜晚', warm: '温暖', cold: '寒冷', fass: 'Fass', vome: 'Vome', joy: '喜悦', anger: '愤怒', envy: '嫉妒', sorrow: '悲伤', fear: '恐惧' };
function zhDuration(value) {
  return String(value || '').replace(/(\d+)d\b/giu, '$1天').replace(/(\d+)h\b/giu, '$1小时').replace(/(\d+)m\b/giu, '$1分钟').replace(/(\d+)s\b/giu, '$1秒');
}

function rewardText(reward) {
  if (!reward) return null;
  const parts = [];
  for (const item of reward.countedItems || []) {
    const name = item.type || item.key;
    if (name) parts.push(`${item.count || 1}× ${zhItem(name)}`);
  }
  for (const item of reward.items || []) {
    if (typeof item === 'string' && item.trim()) parts.push(zhItem(item.trim()));
    else if (item?.type || item?.key) parts.push(`${item.count || 1}× ${zhItem(item.type || item.key)}`);
  }
  if (Number(reward.credits) > 0) parts.push(`${Number(reward.credits).toLocaleString('zh-CN')} 现金`);
  if (!parts.length && typeof reward.asString === 'string' && reward.asString.trim()) {
    const raw = reward.asString.trim();
    const credits = raw.match(/^([\d,.]+)\s*Credits?$/iu);
    const counted = raw.match(/^([\d,.]+)\s*[x×]\s*(.+)$/iu);
    if (credits) parts.push(`${Number(credits[1].replace(/,/g, '')).toLocaleString('zh-CN')} 现金`);
    else if (counted) parts.push(`${counted[1]}× ${zhItem(counted[2])}`);
    else parts.push(zhItem(raw));
  }
  return parts.length ? parts.join('＋') : null;
}

async function cmdStatus(platform) {
  const worldStatePlatform = WS_PLATFORM[platform];
  if (!worldStatePlatform) {
    fail('status', `世界状态暂不支持平台：${platform}`);
  }
  const state = await loadWorldState(worldStatePlatform);
  const active = (values) => Array.isArray(values) ? values.filter((value) => !value.expired) : [];
  const cycle = (value) => value ? { state: ZH_CYCLE[value.state] || '未知状态', timeLeft: zhDuration(value.timeLeft), expiry: value.expiry } : null;
  const trader = state.voidTrader || (Array.isArray(state.voidTraders) ? state.voidTraders[0] : null);

  out({
    ok: true,
    kind: 'status',
    platform,
    fetchedAt: new Date().toISOString(),
    sourceTimestamp: state.timestamp || null,
    fissures: active(state.fissures)
      .sort((a, b) => (a.tierNum - b.tierNum) || String(a.expiry).localeCompare(String(b.expiry)))
      .map((fissure) => ({
        node: zhNode(fissure.node),
        mission: zh(ZH_MISSION, fissure.missionType),
        faction: zh(ZH_FACTION, fissure.enemy),
        tier: zh(ZH_TIER, fissure.tier),
        expiry: fissure.expiry,
        storm: Boolean(fissure.isStorm),
        hard: Boolean(fissure.isHard),
      })),
    alerts: active(state.alerts).map((alert) => ({
      node: zhNode(alert.mission?.node),
      mission: zh(ZH_MISSION, alert.mission?.type),
      faction: zh(ZH_FACTION, alert.mission?.faction),
      reward: rewardText(alert.mission?.reward),
      expiry: alert.expiry,
    })),
    invasions: active(state.invasions).map((invasion) => ({
      node: zhNode(invasion.node),
      attacker: zh(ZH_FACTION, invasion.attackingFaction || invasion.attacker?.faction, '未知阵营'),
      defender: zh(ZH_FACTION, invasion.defendingFaction || invasion.defender?.faction, '未知阵营'),
      attackerReward: rewardText(invasion.attacker?.reward),
      defenderReward: rewardText(invasion.defender?.reward),
      completion: invasion.completion,
    })),
    sortie: state.sortie ? {
      boss: ZH_BOSS[state.sortie.boss] || '突击首领',
      faction: zh(ZH_FACTION, state.sortie.faction),
      missions: (state.sortie.variants || []).map((variant) => zh(ZH_MISSION, variant.missionType)),
      expiry: state.sortie.expiry,
    } : null,
    archonHunt: state.archonHunt ? { boss: ZH_ARCHON[state.archonHunt.boss] || '执刑官猎杀', expiry: state.archonHunt.expiry } : null,
    arbitration: state.arbitration && !state.arbitration.expired ? {
      node: zhNode(state.arbitration.node),
      type: zh(ZH_MISSION, state.arbitration.type, '未知任务'),
      expiry: state.arbitration.expiry,
    } : null,
    cycles: {
      cetus: cycle(state.cetusCycle),
      vallis: cycle(state.vallisCycle),
      cambion: cycle(state.cambionCycle),
      duviri: cycle(state.duviriCycle),
      earth: cycle(state.earthCycle),
    },
    voidTrader: trader ? {
      active: Boolean(trader.active),
      location: trader.location ? zhNode(trader.location) : null,
      activation: trader.activation,
      expiry: trader.expiry,
    } : null,
    steelPath: state.steelPath ? { rotation: ZH_STEEL_REWARD[state.steelPath.currentReward?.name] || '轮换奖励', expiry: state.steelPath.expiry } : null,
    nightwave: state.nightwave ? {
      season: state.nightwave.season,
      expiry: state.nightwave.expiry,
      activeChallenges: active(state.nightwave.activeChallenges).length,
    } : null,
    events: active(state.events).map((event) => ({ description: zhEvent(event.description), expiry: event.expiry })),
    flashSales: active(state.flashSales).map((sale) => {
      const translated = zhItem(sale.item);
      return { item: translated === '未收录物品' ? '商城限时商品' : translated, discount: sale.discount, expiry: sale.expiry };
    }),
  });
}

const NOTEWORTHY_INVASION_TYPES = new Set([
  'potato', 'forma', 'exilus', 'weapon', 'wraith', 'vandal', 'mutalist alad v',
]);
const PLANET_ZH = {
  Mercury: '水星', Venus: '金星', Earth: '地球', Lua: '月球', Mars: '火星', Deimos: '火卫二',
  Phobos: '火卫一', Ceres: '谷神星', Jupiter: '木星', Europa: '欧罗巴', Saturn: '土星',
  Uranus: '天王星', Neptune: '海王星', Pluto: '冥王星', Eris: '阋神星', Sedna: '赛德娜',
  Void: '虚空', Zariman: '扎里曼', 'Kuva Fortress': '赤毒要塞', Duviri: '双衍王境',
  'Earth Proxima': '地球比邻星', 'Venus Proxima': '金星比邻星', 'Saturn Proxima': '土星比邻星',
  'Neptune Proxima': '海王星比邻星', 'Pluto Proxima': '冥王星比邻星', 'Veil Proxima': '面纱比邻星', Veil: '面纱比邻星',
};
const FAST_FISSURE_MISSIONS = new Set(['Capture', 'Extermination', 'Rescue']);

function fissureSubscriptionCandidates(state, rawFilter) {
  const filter = String(rawFilter || '钢铁 全能 生存').normalize('NFKC').toLowerCase();
  const hardOnly = /钢铁|steel/iu.test(filter);
  const normalOnly = /普通|normal/iu.test(filter);
  const stormOnly = /九重天|航道星舰|storm/iu.test(filter);
  const tier = Object.entries(ZH_TIER).find(([english, chinese]) => filter.includes(english.toLowerCase()) || filter.includes(chinese))?.[0] || null;
  const missionTypes = Object.entries(ZH_MISSION).filter(([english, chinese]) => filter.includes(english.toLowerCase()) || filter.includes(chinese)).map(([english]) => english);
  return (Array.isArray(state.fissures) ? state.fissures : [])
    .filter((item) => !item.expired)
    .filter((item) => !hardOnly || item.isHard)
    .filter((item) => !normalOnly || !item.isHard)
    .filter((item) => !stormOnly || item.isStorm)
    .filter((item) => !tier || item.tier === tier)
    .filter((item) => !missionTypes.length || missionTypes.includes(item.missionType))
    .map((item) => {
      const match = String(item.node || '').match(/^(.*?)\s*\(([^)]+)\)\s*$/u);
      return {
        id: `fissure:${item.id || `${item.node}:${item.tier}:${item.expiry}`}`,
        type: 'fissure',
        node: match?.[1] || item.node || '未知节点',
        planet: PLANET_ZH[match?.[2]] || match?.[2] || '未知星区',
        mission: zh(ZH_MISSION, item.missionType),
        faction: zh(ZH_FACTION, item.enemy),
        tier: item.tier,
        expiry: item.expiry,
        hard: Boolean(item.isHard),
        storm: Boolean(item.isStorm),
        recommended: FAST_FISSURE_MISSIONS.has(item.missionType),
        text: `裂缝订阅命中：${zh(ZH_TIER, item.tier)} ${zh(ZH_MISSION, item.missionType)} · ${zhNode(item.node)} · 截止 ${formatLocalTime(item.expiry)}`,
      };
    });
}

function monitorCandidates(state, mode = 'all', args = {}) {
  const active = (values) => Array.isArray(values) ? values.filter((value) => !value.expired) : [];
  const candidates = [];

  if (mode === 'fissure') return fissureSubscriptionCandidates(state, args.filter);

  if (mode === 'all' || mode === 'unpredictable') {
    for (const alert of active(state.alerts)) {
      const reward = rewardText(alert.mission?.reward) || '未知奖励';
      candidates.push({
        id: `alert:${alert.id || `${alert.mission?.node}:${alert.expiry}`}`,
        type: 'alert',
        node: zhNode(alert.mission?.node || '未知节点'),
        mission: zh(ZH_MISSION, alert.mission?.type),
        reward,
        expiry: alert.expiry,
        text: `新警报：${zhNode(alert.mission?.node || '未知节点')} · ${zh(ZH_MISSION, alert.mission?.type)} · ${reward} · 截止 ${formatLocalTime(alert.expiry)}`,
      });
    }

    for (const invasion of active(state.invasions)) {
      const types = (invasion.rewardTypes || []).map((value) => String(value).toLowerCase());
      const attackerReward = rewardText(invasion.attacker?.reward);
      const defenderReward = rewardText(invasion.defender?.reward);
      const rewardHaystack = `${types.join(' ')} ${attackerReward || ''} ${defenderReward || ''}`.toLowerCase();
      const noteworthy = types.some((type) => NOTEWORTHY_INVASION_TYPES.has(type))
        || /(orokin catalyst|orokin reactor|forma|exilus|wraith|vandal|mutalist alad|武器|反应堆|催化剂|亡魂|破坏者|福马|适配器)/i.test(rewardHaystack);
      if (!noteworthy) continue;
      candidates.push({
        id: `invasion:${invasion.id || `${invasion.node}:${invasion.activation}`}`,
        type: 'invasion',
        node: zhNode(invasion.node || '未知节点'),
        description: `进攻方 ${attackerReward || '无'} / 防守方 ${defenderReward || '无'}`,
        completion: Math.round(Number(invasion.completion) || 0),
        text: `稀有入侵：${zhNode(invasion.node || '未知节点')} · 进攻方 ${attackerReward || '无'} / 防守方 ${defenderReward || '无'} · 进度 ${Math.round(Number(invasion.completion) || 0)}%`,
      });
    }

    for (const event of active(state.events)) {
      candidates.push({
        id: `event:${event.id || `${event.description}:${event.expiry}`}`,
        type: 'event',
        description: zhEvent(event.description || '未命名活动'),
        expiry: event.expiry,
        text: `特殊活动：${zhEvent(event.description || '未命名活动')} · 截止 ${formatLocalTime(event.expiry)}`,
      });
    }
  }

  if (mode === 'all' || mode === 'scheduled') {
    const trader = state.voidTrader || (Array.isArray(state.voidTraders) ? state.voidTraders[0] : null);
    if (trader?.active) {
      candidates.push({
        id: `trader:${trader.id || trader.activation || trader.expiry}`,
        type: 'trader',
        location: trader.location ? zhNode(trader.location) : '未知中继站',
        activation: trader.activation,
        expiry: trader.expiry,
        text: `虚空商人已到访：${trader.location ? zhNode(trader.location) : '未知中继站'} · 离开 ${formatLocalTime(trader.expiry)}`,
      });
    }
  }

  return candidates;
}

function nextScheduledCheck(state, nowMs = Date.now()) {
  const trader = state.voidTrader || (Array.isArray(state.voidTraders) ? state.voidTraders[0] : null);
  if (!trader) return new Date(nowMs + 6 * 60 * 60 * 1000).toISOString();

  const activationMs = Date.parse(trader.activation);
  const expiryMs = Date.parse(trader.expiry);
  if (trader.active && Number.isFinite(expiryMs) && expiryMs > nowMs) {
    return new Date(expiryMs + 10_000).toISOString();
  }
  if (!trader.active && Number.isFinite(activationMs) && activationMs > nowMs) {
    return new Date(activationMs + 10_000).toISOString();
  }
  if (!trader.active && Number.isFinite(expiryMs) && expiryMs > nowMs) {
    // The advertised arrival time has passed but the upstream state has not flipped yet.
    return new Date(nowMs + 2 * 60 * 1000).toISOString();
  }
  return new Date(nowMs + 6 * 60 * 60 * 1000).toISOString();
}

function nextFissureCheck(state, nowMs = Date.now()) {
  const expiries = (Array.isArray(state.fissures) ? state.fissures : [])
    .filter((item) => !item.expired)
    .map((item) => Date.parse(item.expiry))
    .filter((value) => Number.isFinite(value) && value > nowMs)
    .sort((a, b) => a - b);
  return new Date((expiries[0] || nowMs + 5 * 60 * 1000) + 10_000).toISOString();
}

function formatLocalTime(value) {
  if (!value) return '未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Europe/Berlin', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function fissureFilterLabel(value) {
  const normalized = String(value || '钢铁 全能 生存').trim();
  return normalized
    .replace(/steel/giu, '钢铁')
    .replace(/omnia/giu, '全能')
    .replace(/survival/giu, '生存')
    .replace(/capture/giu, '捕获')
    .replace(/extermination/giu, '歼灭')
    .split(/\s+/u).filter(Boolean).join(' + ');
}

async function readMonitorState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    return {
      initialized: Boolean(parsed.initialized),
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
      nextCheckAt: typeof parsed.nextCheckAt === 'string' ? parsed.nextCheckAt : null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { initialized: false, seen: [], nextCheckAt: null };
    throw new Error(`cannot read monitor state: ${error.message}`);
  }
}

async function writeMonitorState(statePath, seen, extra = {}) {
  await mkdir(dirname(statePath), { recursive: true });
  const payload = {
    version: 2,
    initialized: true,
    updatedAt: new Date().toISOString(),
    seen: seen.slice(-500),
    ...extra,
  };
  await writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function cmdMonitor(platform, args) {
  const worldStatePlatform = WS_PLATFORM[platform];
  if (!worldStatePlatform) fail('monitor', `世界状态暂不支持平台：${platform}`);
  const statePath = resolve(String(args.state || './warframe-monitor-state.json'));
  const dryRun = parseBoolean(args, 'dry-run', false);
  const mode = parseMonitorMode(args);
  const previous = await readMonitorState(statePath);

  if (!dryRun && (mode === 'scheduled' || mode === 'fissure') && previous.nextCheckAt) {
    const nextCheckMs = Date.parse(previous.nextCheckAt);
    if (Number.isFinite(nextCheckMs) && Date.now() < nextCheckMs) {
      process.stdout.write('NO_REPLY\n');
      return;
    }
  }

  const state = await loadWorldState(worldStatePlatform);
  const candidates = monitorCandidates(state, mode, args);
  const nextCheckAt = mode === 'scheduled' ? nextScheduledCheck(state)
    : mode === 'fissure' ? nextFissureCheck(state) : null;

  if (dryRun) {
    let mediaUrl = null;
    let renderError = null;
    if (args['card-dir'] && candidates.length) {
      try {
        const card = mode === 'fissure'
          ? buildFissureAlertCard(candidates[0], fissureFilterLabel(args.filter), state.timestamp)
          : buildIntelCard({ items: candidates, fetchedAt: state.timestamp || new Date().toISOString() });
        mediaUrl = await renderWarframeCard(card, resolve(String(args['card-dir'])));
      } catch (error) {
        renderError = String(error?.message || error);
      }
    }
    out({ ok: true, kind: 'monitor', dryRun: true, mode, platform, candidates, nextCheckAt, mediaUrl, renderError, fetchedAt: new Date().toISOString() });
    return;
  }

  const currentIds = candidates.map((item) => item.id);
  const combinedSeen = [...new Set([...previous.seen, ...currentIds])];
  await writeMonitorState(statePath, combinedSeen, { mode, nextCheckAt });

  if (!previous.initialized) {
    process.stdout.write('NO_REPLY\n');
    return;
  }

  const seen = new Set(previous.seen);
  const fresh = candidates.filter((item) => !seen.has(item.id));
  if (!fresh.length) {
    process.stdout.write('NO_REPLY\n');
    return;
  }

  if (args['card-dir']) {
    try {
      const card = mode === 'fissure'
        ? buildFissureAlertCard(fresh[0], fissureFilterLabel(args.filter), state.timestamp)
        : buildIntelCard({ items: fresh, fetchedAt: state.timestamp || new Date().toISOString() });
      const mediaUrl = await renderWarframeCard(card, resolve(String(args['card-dir'])));
      if (mediaUrl) {
        process.stdout.write(`MEDIA:${mediaUrl}\n`);
        return;
      }
    } catch { /* Fall back to the text alert below. */ }
  }

  const lines = [
    mode === 'fissure' ? '🎯 星际战甲裂缝订阅命中' : '🎮 星际战甲重要情报',
    ...fresh.map((item) => `• ${item.text}`),
    `数据时间：${formatLocalTime(state.timestamp || new Date().toISOString())}`,
    '来源：世界状态',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function marketHeaders(platform, crossplay) {
  return { Platform: platform, Crossplay: String(crossplay), Language: 'zh-hans' };
}

async function fetchMarketItems(platform, crossplay) {
  const response = await getJson(`${MKT_BASE}/v2/items`, marketHeaders(platform, crossplay));
  return (response.data || []).map((item) => ({
    slug: item.slug,
    name: item.i18n?.en?.name || item.slug,
    zhName: item.i18n?.['zh-hans']?.name || null,
    tags: item.tags || [],
  }));
}

const ZH_ALIAS = {
  悟空: 'wukong', 猴子: 'wukong', 奶妈: 'trinity', 电男: 'volt', 伏特: 'volt', 冰男: 'frost',
  火女: 'ember', 毒妈: 'saryn', 牛牛: 'rhino', 女枪: 'mesa', 高斯: 'gauss', 夜灵: 'revenant',
  血妈: 'garuda', 猫甲: 'khora', 玻璃: 'gara', 龙甲: 'chroma', 磁力: 'mag', 圣剑: 'excalibur', 洛基: 'loki',
  瓦喵: 'valkyr', 瓦尔基里: 'valkyr', 女武神: 'valkyr', 蛆甲: 'nidus',
};
const norm = (value) => String(value).toLowerCase().replace(/[\s_\-]+/g, '');
const dedupe = (items) => [...new Map(items.map((item) => [item.slug, item])).values()];

function stripSetSuffix(normalizedSlug) {
  for (const suffix of ['primeset', 'set']) {
    if (normalizedSlug.endsWith(suffix) && normalizedSlug.length > suffix.length) {
      return normalizedSlug.slice(0, -suffix.length);
    }
  }
  return null;
}

function resolveItem(items, query) {
  const variants = new Set([query.trim()]);
  let aliased = query.trim();
  for (const [nickname, canonical] of Object.entries(ZH_ALIAS)) {
    aliased = aliased.split(nickname).join(canonical);
  }
  variants.add(aliased);
  variants.add(aliased.replace(/套装/g, ' set').replace(/一套/g, ' set'));
  const normalizedQueries = [...variants].map(norm);

  const exact = dedupe(items.filter((item) =>
    normalizedQueries.includes(norm(item.slug)) ||
    normalizedQueries.includes(norm(item.name)) ||
    (item.zhName && normalizedQueries.includes(norm(item.zhName)))
  ));
  if (exact.length === 1) return { match: exact[0], candidates: [] };
  if (exact.length > 1) return { match: null, candidates: exact.slice(0, 10) };

  const bases = new Set(normalizedQueries);
  for (const normalizedQuery of normalizedQueries) {
    if (normalizedQuery.endsWith('prime')) bases.add(normalizedQuery.slice(0, -5));
  }
  const setMatches = dedupe(items.filter((item) => {
    const base = stripSetSuffix(norm(item.slug));
    return base !== null && bases.has(base);
  }));
  if (setMatches.length === 1) return { match: setMatches[0], candidates: [] };
  if (setMatches.length > 1) return { match: null, candidates: setMatches.slice(0, 10) };

  const candidates = dedupe(items.filter((item) => normalizedQueries.some((normalizedQuery) =>
    norm(item.slug).includes(normalizedQuery) ||
    norm(item.name).includes(normalizedQuery) ||
    (item.zhName && norm(item.zhName).includes(normalizedQuery))
  )));
  if (candidates.length === 1) return { match: candidates[0], candidates: [] };
  return { match: null, candidates: candidates.slice(0, 10) };
}

async function cmdPrice(query, platform, crossplay) {
  const items = await fetchMarketItems(platform, crossplay);
  const { match, candidates } = resolveItem(items, query);
  if (!match) {
    out({
      ok: false,
      kind: 'price',
      platform,
      crossplay,
      error: candidates.length ? 'ambiguous item; see candidates' : 'item not found',
      candidates,
      fetchedAt: new Date().toISOString(),
    });
    process.exit(candidates.length ? 2 : 1);
  }

  const headers = marketHeaders(platform, crossplay);
  const [detailResponse, topResponse] = await Promise.all([
    getJson(`${MKT_BASE}/v2/item/${match.slug}`, headers),
    getJson(`${MKT_BASE}/v2/orders/item/${match.slug}/top`, headers),
  ]);
  const detail = detailResponse.data || {};
  // ⚠ wm /top 列表不按价格排序，sell 升序 / buy 降序后再截取
  const pick = (orders, direction = 'sell') => (orders || [])
    .filter((order) => order.visible !== false)
    .toSorted((a, b) => (direction === 'buy' ? Number(b.platinum) - Number(a.platinum) : Number(a.platinum) - Number(b.platinum)))
    .slice(0, 5)
    .map((order) => ({
      platinum: order.platinum,
      quantity: order.quantity,
      user: order.user?.ingameName,
      status: order.user?.status,
      platform: order.user?.platform,
      crossplay: order.user?.crossplay ?? null,
      updatedAt: order.updatedAt,
    }));

  out({
    ok: true,
    kind: 'price',
    platform,
    crossplay,
    fetchedAt: new Date().toISOString(),
    item: {
      slug: match.slug,
      name: detail.i18n?.en?.name || match.name,
      zhName: detail.i18n?.['zh-hans']?.name || match.zhName,
      tags: detail.tags || match.tags,
      ducats: detail.ducats ?? null,
      tradingTax: detail.tradingTax ?? null,
      reqMasteryRank: detail.reqMasteryRank ?? null,
      setParts: Array.isArray(detail.setParts) ? detail.setParts.length : null,
    },
    sell: pick(topResponse.data?.sell),
    buy: pick(topResponse.data?.buy, 'buy'),
    note: '仅显示当前靠前挂单并保持接口原始顺序，不代表历史成交价',
  });
}

async function cmdSearch(query, type) {
  const endpoints = type === 'warframe' ? ['warframes'] :
    type === 'weapon' ? ['weapons'] :
      type === 'item' ? ['items'] : ['warframes', 'weapons', 'items'];
  const encodedQuery = encodeURIComponent(query);
  let successfulResponses = 0;
  let lastError = null;

  const localSearch = async (endpoint) => {
    const { getLangTable, readAlecaJson } = await import('./wfdata.mjs');
    const files = endpoint === 'warframes' ? ['Warframes.json']
      : endpoint === 'weapons' ? ['Primary.json', 'Secondary.json', 'Melee.json', 'Arch-Gun.json', 'Arch-Melee.json', 'SentinelWeapons.json']
        : ['Arcanes.json', 'Gear.json', 'Misc.json', 'Mods.json', 'Resources.json', 'Relics.json', 'Pets.json', 'Sentinels.json', 'Archwing.json'];
    const [groups, lang] = await Promise.all([
      Promise.all(files.map((file) => readAlecaJson(`json/${file}`).catch(() => []))),
      getLangTable().catch(() => ({})),
    ]);
    const needle = String(query).normalize('NFKC').toLowerCase().replace(/[\s_-]+/gu, '');
    return groups.flat().filter((item) => {
      const zhName = lang[item?.uniqueName]?.zh?.name || '';
      return [item?.name, zhName].some((value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s_-]+/gu, '').includes(needle));
    }).map((item) => ({ ...item, localizedName: lang[item?.uniqueName]?.zh?.name || null })).slice(0, 20);
  };

  for (const endpoint of endpoints) {
    try {
      let results;
      let dataSource = 'api.warframestat.us';
      try { results = await getJson(`${WS_BASE}/${endpoint}/search/${encodedQuery}?language=zh`); }
      catch { results = await localSearch(endpoint); dataSource = 'AlecaFrame/WFCD 本地资料'; }
      successfulResponses++;
      if (!Array.isArray(results) || results.length === 0) continue;
      const result = results[0];
      const allowedTerms = endpoint === 'warframes' ? [result.name] : [];
      const localizedName = result.localizedName || (endpoint === 'warframes' ? result.name : zhItem(result.name));
      out({
        ok: true,
        kind: 'search',
        type: endpoint,
        platformIndependent: true,
        source: dataSource,
        fetchedAt: new Date().toISOString(),
        resultCount: results.length,
        result: {
          name: localizedName || '中文名称暂未收录',
          category: ZH_CATEGORY[result.category] || ZH_CATEGORY[result.type] || '未分类',
          description: visibleLocalizedText(result.description, allowedTerms),
          masteryReq: result.masteryReq ?? null,
          isPrime: result.isPrime ?? null,
          tradable: result.tradable ?? null,
          stats: {
            health: result.health,
            shield: result.shield,
            armor: result.armor,
            energy: result.power,
            sprintSpeed: result.sprintSpeed,
          },
          abilities: (result.abilities || []).map((ability, index) => ({
            name: `技能 ${index + 1}`,
            description: visibleLocalizedText(ability.description, allowedTerms),
          })),
          polarities: Array.isArray(result.polarities)
            ? result.polarities.map((polarity) => ZH_POLARITY[String(polarity).toLowerCase()] || '未知极性')
            : null,
          aura: result.aura ? (ZH_POLARITY[String(result.aura).toLowerCase()] || '未知极性') : null,
          damage: result.damage || result.totalDamage || null,
          criticalChance: result.criticalChance ?? null,
          criticalMultiplier: result.criticalMultiplier ?? null,
          statusChance: result.procChance ?? result.statusChance ?? null,
          fireRate: result.fireRate ?? null,
          releaseDate: result.releaseDate || null,
          wikiaUrl: result.wikiaUrl || null,
        },
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (successfulResponses === 0 && lastError) {
    fail('search', `资料查询全部失败：${lastError.message}`, { query, platformIndependent: true });
  }
  out({
    ok: false,
    kind: 'search',
    platformIndependent: true,
    error: '没有找到匹配的资料，请尝试正式中文名、常用别名或战甲英文名',
    query,
    fetchedAt: new Date().toISOString(),
  });
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    if (command === 'status') {
      await cmdStatus(requirePlatform(args, command));
    } else if (command === 'price') {
      await cmdPrice(sanitizeQuery(args._.slice(1).join(' ')), requirePlatform(args, command), parseCrossplay(args));
    } else if (command === 'search') {
      await cmdSearch(sanitizeQuery(args._.slice(1).join(' ')), parseType(args));
    } else if (command === 'monitor') {
      await cmdMonitor(requirePlatform(args, command), args);
    } else {
      fail('args', '用法：status、price、search 或 monitor；请按技能说明提供对应参数');
    }
  } catch (error) {
    fail('runtime', error);
  }
}

main();
