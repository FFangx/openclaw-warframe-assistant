#!/usr/bin/env node

// bounties.mjs — 星球悬赏数据装配（2026-08-05 上线）。
// 数据链：warframestat /pc/syndicateMissions（三开放世界 jobs + rewardPoolDrops 全概率）
//       + oracle /bounty-cycle（扎里曼/实验室每节点挑战）
//       + wfdata getBountyZhMaps（任务名键族/挑战路径/物品名反查 三张官方译名映射）。
// 约定：网络失败抛错由调用方兜文案；译名查无保留英文（官方名规则）。

import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getBountyZhMaps, staleCachedJson } from './wfdata.mjs';
import { loadWorldState } from './worldstate-source.mjs';

const BOUNTY_CYCLE_URL = 'https://oracle.browse.wf/bounty-cycle';
const DROP_DATA_BASE = 'https://drops.warframestat.us/data';
const DROP_DATA_GITHUB = 'https://raw.githubusercontent.com/WFCD/warframe-drop-data/gh-pages/data';
const FETCH_TIMEOUT_MS = 20_000;
const execFileAsync = promisify(execFile);

// 三开放世界 + 别名（resolveBountyPlace 用）；顺序=卡片从上到下；standingUnit：Deimos 悬赏给母亲信物不是声望
// affTag/dailyKey：快照 Affiliations 集团标签与日声望余量键（实验室日余量键=Cavia，2026-08-06 探针实证）
export const BOUNTY_PLACES = Object.freeze([
  {
    key: 'cetus', zh: '希图斯', syndicate: 'Ostrons', npc: '孔尊', planet: '地球 · 夜灵平野', standingUnit: '声望',
    affTag: 'CetusSyndicate', dailyKey: 'DailyAffiliationCetus',
    alias: ['希图斯', '夜灵平野', '平野', '地球', 'cetus', '孔尊'],
  },
  {
    key: 'fortuna', zh: '福尔图娜', syndicate: 'Solaris United', npc: 'Eudico', planet: '金星 · 奥布山谷', standingUnit: '声望',
    affTag: 'SolarisSyndicate', dailyKey: 'DailyAffiliationSolaris',
    alias: ['福尔图娜', '奥布山谷', '金星', '索拉里斯', 'fortuna', 'eudico'],
  },
  {
    key: 'deimos', zh: '殁世幽都', syndicate: 'Entrati', npc: '母亲', planet: '火卫二 · 魔胎之境', standingUnit: '母亲信物',
    affTag: 'EntratiSyndicate', dailyKey: 'DailyAffiliationEntrati',
    alias: ['殁世幽都', '魔胎之境', '火卫二', 'deimos', '英择谛', 'entrati', '母亲'],
  },
]);

// 扎里曼/实验室挑战板（oracle bounty-cycle 键 → 展示名）+ 别名（resolveBountyBoard 用）
const CYCLE_BOARDS = Object.freeze([
  { key: 'ZarimanSyndicate', zh: '扎里曼', npc: '管理者', planet: '扎里曼十号', affTag: 'ZarimanSyndicate', dailyKey: 'DailyAffiliationZariman', alias: ['扎里曼', '扎里曼十号', 'zariman'] },
  // 官方名=解剖圣所（dict.zh SolarMapEntratiLabsShortcut 实证）；「悬赏 实验室」等旧用法全走别名
  { key: 'EntratiLabSyndicate', zh: '解剖圣所', npc: '斐波那契', planet: '火卫二实验室', affTag: 'EntratiLabSyndicate', dailyKey: 'DailyAffiliationCavia', alias: ['实验室', '圣所', '解剖圣所', '阿尔布雷希特', '阿尔布雷希特实验室', 'entratilab', '琵琶鱼', '斐波那契'] },
  { key: 'HexSyndicate', zh: '六人组', npc: '六人组', planet: '霍瓦尼亚（1999）', affTag: 'HexSyndicate', dailyKey: 'DailyAffiliationHex', alias: ['六人组', 'hex', '1999'] },
]);

// 1999 同伴官方中文名（dict.zh Messenger 词条实证；Amir 内部名 Jabir）
const ALLY_ZH = Object.freeze({ Arthur: '亚瑟', Aoi: '碧', Amir: '阿米尔', Quincy: '昆西', Eleanor: '埃莉诺', Lettie: '莱蒂' });

// 挑战板每档敌人等级（wiki 固定表，游戏内显示口径）；oracle bounty-cycle 数组序=档位序
// （数量精确匹配 5/5/7，且路径难度尾缀 Easy→VeryHard 单调递增、Hex 第 7 条 Lich=Antivirus 档互证）
const BOARD_TIER_LEVELS = Object.freeze({
  ZarimanSyndicate: [[50, 55], [60, 65], [70, 75], [90, 95], [110, 115]],
  EntratiLabSyndicate: [[55, 60], [65, 70], [75, 80], [95, 100], [115, 120]],
  HexSyndicate: [[65, 70], [75, 80], [85, 90], [95, 100], [105, 110], [115, 120], [125, 130]],
});

const TIER_ZH = { Lith: '古纪', Meso: '前纪', Neo: '中纪', Axi: '后纪', Requiem: '安魂', Omnia: '全能' };
const REFINEMENT_ZH = { Exceptional: '优良', Flawless: '无瑕', Radiant: '光辉' };
// WFCD 拼名里词典查不到的常见量词条目
const REWARD_STATIC_ZH = { 'credits cache': '现金', endo: '内融核心', kuva: '赤毒' };
// Deimos 语言键缩写规则（id 尾段 DeimosXBounty → 键 DeimosBountyX'Name，X 里长词换缩写；2026-08-05 键族全集实证）
const DEIMOS_ABBREV = [[/Survivor/gu, 'Surv'], [/Excavate/gu, 'Excav'], [/Assassinate/gu, 'Assass'], [/AreaDefense/gu, 'AreaDef']];
// 隔离库任务 id 无尾段（纯时间戳）；纳默悬赏的 id 复用了普通任务 id（WFCD 坑，直查会错配）——这两族都只能按英文名静态兔底
const EN_TITLE_STATIC_ZH = {
  'isolation vault chamber a': '隔离库 A 室', 'isolation vault chamber b': '隔离库 B 室', 'isolation vault chamber c': '隔离库 C 室',
  // 纳默悬赏（dict.zh Narmer 键族 2026-08-05 实证，英文名→键对应关系按任务类型推定）
  'bring them home (narmer)': '带他们回家（合一众）',
  "master's voice (narmer)": '邪主之音（合一众）',
};

const compact = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s·]+/gu, '');

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

async function loadStaticBountyDrops() {
  const dropTable = async (name) => {
    try { return await fetchJson(`${DROP_DATA_BASE}/${name}.json`); }
    catch {
      const githubUrl = `${DROP_DATA_GITHUB}/${name}.json`;
      try { return await fetchJson(githubUrl); }
      catch {
        // Windows 上 Node/undici 偶发被边缘节点断开；PowerShell 仅作为固定只读 URL 的传输兜底。
        const powershell = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
        const script = `$ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -UseBasicParsing '${githubUrl}' -TimeoutSec 25).Content`;
        const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
        return JSON.parse(stdout);
      }
    }
  };
  const result = await staleCachedJson('bounty-static-drops', { ttlMs: 24 * 60 * 60 * 1000, version: 1 }, async () => {
    const [cetus, solaris, deimos] = await Promise.all([
      dropTable('cetusBountyRewards'),
      dropTable('solarisBountyRewards'),
      dropTable('deimosRewards'),
    ]);
    return { Ostrons: cetus?.cetusBountyRewards || [], 'Solaris United': solaris?.solarisBountyRewards || [], Entrati: deimos?.deimosRewards || [] };
  });
  return result.data;
}

export function attachStaticBountyRewards(syndicates, tables) {
  return (syndicates || []).map((group) => ({
    ...group,
    jobs: (group.jobs || []).map((job) => {
      if (job.rewardPoolDrops?.length) return job;
      const [minLevel, maxLevel] = job.enemyLevels || [];
      const table = (tables?.[group.syndicate] || []).find((entry) => {
        const levels = String(entry?.bountyLevel || '').match(/Level\s+(\d+)\s*-\s*(\d+)/u);
        return levels && Number(levels[1]) === Number(minLevel) && Number(levels[2]) === Number(maxLevel);
      });
      if (!table) return job;
      const rotation = String(job.uniqueName || '').match(/Table([A-Z])Rewards$/u)?.[1];
      const rewards = table.rewards?.[rotation] || Object.values(table.rewards || {})[0] || [];
      return {
        ...job,
        rewardPoolDrops: rewards.map((reward) => ({ item: reward.itemName, rarity: reward.rarity, chance: Number(reward.chance) || 0 })),
      };
    }),
  }));
}

// warframestat 主源会直接给 rewardPoolDrops；DE 官方备用源只有任务与奖励表路径。
// 查询和订阅必须共用同一补齐步骤，否则主源 403 时按奖励名订阅会得到永久空候选池。
export async function ensureBountyRewards(syndicates, loadDrops = loadStaticBountyDrops) {
  const groups = Array.isArray(syndicates) ? syndicates : [];
  if (!groups.some((group) => (group.jobs || []).some((job) => !job.rewardPoolDrops?.length))) return groups;
  try { return attachStaticBountyRewards(groups, await loadDrops()); }
  catch { return groups; }
}

// job 尾段（来自 id 去时间戳，如 AttritionBountyLib/DeimosPurifyBounty）→ 官方中文任务名
export function jobZhTitle(jobTail, enTitle, jobs) {
  const en = String(enTitle || '').normalize('NFKC').trim().toLowerCase();
  // 纳默悬赏的 id 尾段不可信（希图斯复用普通任务 id）：直接走静态表，查无保英文
  if (en.includes('(narmer)')) return EN_TITLE_STATIC_ZH[en] || enTitle;
  const tail = String(jobTail || '').trim();
  if (tail) {
    const direct = jobs[tail.toLowerCase()];
    if (direct) return direct;
    // 金星 id 尾段带 Venus 前缀而 SolarisJobs 键族没有（VenusArtifactJobRecovery → ArtifactJobRecoveryTitle）
    const venus = tail.match(/^Venus(.+)$/u);
    if (venus) {
      const stripped = jobs[venus[1].toLowerCase()];
      if (stripped) return stripped;
    }
    const deimos = tail.match(/^Deimos(.+?)Bounty$/u);
    if (deimos) {
      let x = deimos[1];
      for (const [pattern, short] of DEIMOS_ABBREV) x = x.replace(pattern, short);
      const swapped = jobs[`deimosbounty${x.toLowerCase()}`];
      if (swapped) return swapped;
    }
  }
  const enFallback = EN_TITLE_STATIC_ZH[en];
  return enFallback || enTitle || tail; // 查无保留英文
}

// 战甲部件词（官方翻法，与掉落链 COMPONENT_ZH 一致）
const PART_ZH = { Chassis: '机体', Systems: '系统', Neuroptics: '头部神经光元', Harness: '驭具', Wings: '机翼' };

// 奖励名翻译："3X 1,500 Credits Cache" / "100X Oxium" / "Axi A1 Relic (Radiant)" / "Gladiator Aegis"
export function translateReward(name, items) {
  let rest = String(name || '').trim();
  let prefix = '';
  const times = rest.match(/^(\d+)X\s+(.+)$/u);
  if (times) { prefix = `${times[1]}× `; rest = times[2]; }
  const amount = rest.match(/^([\d,]+)\s+(.+)$/u);
  if (amount) { prefix += `${amount[1]} `; rest = amount[2]; }
  const relic = rest.match(/^(Lith|Meso|Neo|Axi|Requiem|Omnia)\s+(\w+)\s+Relic(?:\s+\((Exceptional|Flawless|Radiant)\))?$/u);
  if (relic) return `${prefix}${TIER_ZH[relic[1]]} ${relic[2]} 遗物${relic[3] ? `（${REFINEMENT_ZH[relic[3]]}）` : ''}`;
  const key = rest.normalize('NFKC').trim().toLowerCase();
  const zh = REWARD_STATIC_ZH[key] || items[key];
  if (zh) return `${prefix}${zh}`;
  // 整名查无：部件蓝图组合翻（Gara Chassis Blueprint → Gara 机体蓝图，战甲名官方保留英文）
  const part = rest.match(/^(.+?)\s+(Chassis|Systems|Neuroptics|Harness|Wings)\s+Blueprint$/u);
  if (part) {
    const baseZh = items[part[1].toLowerCase()] || part[1];
    return `${prefix}${baseZh} ${PART_ZH[part[2]]}蓝图`;
  }
  // 剥 Blueprint 尾缀再查一轮（Eidolon Lens Blueprint → 夜灵透镜 + 蓝图）
  const blueprint = rest.match(/^(.+?)\s+Blueprint$/u);
  if (blueprint) {
    const baseZh = items[blueprint[1].toLowerCase()];
    if (baseZh) return `${prefix}${baseZh} 蓝图`;
  }
  return `${prefix}${rest}`;
}

// 单个 job 装配：标题/等级/声望/奖励池（含中文名与概率）
// ⚠ 字段事实（2026-08-05 探针实证）：job.uniqueName=奖励表路径不是 jobType；jobType 尾段在 id 里（尾缀 expiry 时间戳）
function assembleJob(job, maps) {
  const jobTail = String(job.id || '').replace(/\d+$/u, '');
  const stages = Array.isArray(job.standingStages) ? job.standingStages : [];
  const pool = Array.isArray(job.rewardPoolDrops) ? job.rewardPoolDrops : [];
  const rewards = pool.map((drop) => ({
    name: drop.item,
    zh: translateReward(drop.item, maps.items),
    rarity: drop.rarity || '',
    chance: Number(drop.chance) || 0,
  }));
  // 奖池按物品合并（同物品在 2~3 个阶段各一条）：稀有度取最高档，chances 按阶段全列
  const RARITY_RANK = { Legendary: 3, Rare: 2, Uncommon: 1, Common: 0 };
  const groups = new Map();
  for (const reward of rewards) {
    const current = groups.get(reward.name) || { name: reward.name, zh: reward.zh, rarity: reward.rarity, chances: [] };
    if ((RARITY_RANK[reward.rarity] ?? 0) > (RARITY_RANK[current.rarity] ?? 0)) current.rarity = reward.rarity;
    current.chances.push(reward.chance);
    groups.set(reward.name, current);
  }
  const rewardGroups = [...groups.values()]
    .sort((a, b) => (RARITY_RANK[b.rarity] ?? 0) - (RARITY_RANK[a.rarity] ?? 0) || Math.min(...a.chances) - Math.min(...b.chances));
  // 顶奖 = 最高稀有度档里概率最低的（最稀有）
  const byRarity = (rarity) => rewards.filter((reward) => reward.rarity === rarity).sort((a, b) => a.chance - b.chance);
  const top = byRarity('Legendary')[0] || byRarity('Rare')[0] || byRarity('Uncommon')[0] || rewards[0] || null;
  return {
    id: job.id || '',
    jobTail,
    zhTitle: jobZhTitle(jobTail, job.type, maps.jobs),
    enTitle: job.type || '',
    levels: Array.isArray(job.enemyLevels) ? job.enemyLevels : [],
    stages,
    totalStanding: stages.reduce((sum, value) => sum + (Number(value) || 0), 0),
    minMR: Number(job.minMR) || 0,
    rewards,
    rewardGroups,
    top,
    isVault: /VaultBounty/iu.test(job.uniqueName || '') || /^isolation vault/iu.test(String(job.type || '')),
  };
}

// ==== 装配主入口 ====
// 返回 { places:[{key,zh,npc,planet,expiry,jobs:[…]}], boards:[{key,zh,npc,nodes:[{node,challengeZh}]}], expiry }
export async function fetchBounties({ syndicates = null, cycle = null, maps = null } = {}) {
  const [rawSyndicates, bountyCycle, zhMaps] = await Promise.all([
    syndicates ? Promise.resolve(syndicates) : loadWorldState('pc').then((state) => state.syndicateMissions || []),
    cycle ? Promise.resolve(cycle) : fetchJson(BOUNTY_CYCLE_URL).catch(() => null), // 挑战板挂了不拖垮主体
    maps ? Promise.resolve(maps) : getBountyZhMaps(),
  ]);
  const syn = await ensureBountyRewards(rawSyndicates);
  const places = [];
  for (const place of BOUNTY_PLACES) {
    const group = (Array.isArray(syn) ? syn : []).find((entry) => entry.syndicate === place.syndicate);
    if (!group?.jobs?.length) continue;
    places.push({
      key: place.key, zh: place.zh, npc: place.npc, planet: place.planet, standingUnit: place.standingUnit,
      expiry: group.expiry || null,
      jobs: group.jobs.map((job) => assembleJob(job, zhMaps)),
    });
  }
  if (!places.length) throw new Error('赏金数据为空（warframestat syndicateMissions 无三开放世界条目）');
  const boards = [];
  for (const board of CYCLE_BOARDS) {
    const nodes = bountyCycle?.bounties?.[board.key];
    if (!Array.isArray(nodes) || !nodes.length) continue;
    boards.push({
      key: board.key, zh: board.zh, npc: board.npc, planet: board.planet,
      expiry: bountyCycle?.expiry ? new Date(bountyCycle.expiry).toISOString() : null,
      nodes: nodes.map((node, tierIndex) => {
        const detail = zhMaps.challengeDetails?.[node.challenge] || {};
        const region = zhMaps.nodes?.[node.node] || {};
        const ally = node.ally ? String(node.ally).split('/').pop().replace(/AllyAgent$/u, '') : null;
        const allyZh = ally ? (ALLY_ZH[ally] || ally) : null;
        // 描述带游戏内模板占位符（|ALLY|/|COUNT|/|OPEN_COLOR|...），已知的填值、其余删除
        const desc = String(detail.desc || '')
          .replace(/\|ALLY\|/gu, allyZh || '同伴')
          .replace(/\|COUNT\|/gu, detail.required ? String(detail.required) : '')
          .replace(/\|[A-Z_]+\|/gu, '')
          .replace(/\s+/gu, ' ').trim();
        return {
          node: node.node || '',
          nodeName: region.name || node.node || '',
          nodeMission: region.mission || '',
          challenge: node.challenge || '',
          challengeZh: zhMaps.challenges[node.challenge] || detail.zh || String(node.challenge || '').split('/').pop(),
          desc,
          required: detail.required || 0,
          tier: tierIndex + 1,
          levels: BOARD_TIER_LEVELS[board.key]?.[tierIndex] || null,
          // Hex 同伴：路径尾段剥 AllyAgent，官方中文名优先
          ally: allyZh,
        };
      }),
    });
  }
  return {
    places,
    boards,
    expiry: places[0]?.expiry || (bountyCycle?.expiry ? new Date(bountyCycle.expiry).toISOString() : null),
    fetchedAt: new Date().toISOString(),
  };
}

// 用户输入 → 地点（悬赏 <地名> 与 悬赏 <物品> 消歧：地名白名单，其余判物品反查）
export function resolveBountyPlace(query) {
  const q = compact(query);
  if (!q) return null;
  for (const place of BOUNTY_PLACES) {
    if (place.alias.some((alias) => compact(alias) === q)) return place;
  }
  return null;
}

// 挑战板地名（扎里曼/实验室/1999）→ CYCLE_BOARDS 条目；与 resolveBountyPlace 分开方便调用侧选卡
export function resolveBountyBoard(query) {
  const q = compact(query);
  if (!q) return null;
  for (const board of CYCLE_BOARDS) {
    if (board.alias.some((alias) => compact(alias) === q)) return board;
  }
  return null;
}

// 六区集团声望挂载（仅主人私聊，索引卡右列用）：快照 Affiliations（总声望+等级）+ DailyAffiliation*（今日余量）
// 快照缺字段的区静默跳过；调用方失败整体降级无声望列
export function attachBountyStanding(data, inventory) {
  if (!inventory) return data;
  const affiliations = Array.isArray(inventory.Affiliations) ? inventory.Affiliations : [];
  const metaOf = (key) => [...BOUNTY_PLACES, ...CYCLE_BOARDS].find((entry) => entry.key === key);
  for (const region of [...(data.places || []), ...(data.boards || [])]) {
    const meta = metaOf(region.key);
    if (!meta?.affTag) continue;
    const affiliation = affiliations.find((entry) => entry.Tag === meta.affTag);
    if (!affiliation) continue;
    const daily = Number(inventory[meta.dailyKey]);
    region.standing = {
      standing: Number(affiliation.Standing) || 0,
      title: Number(affiliation.Title) || 0,
      daily: Number.isFinite(daily) ? daily : null,
    };
  }
  return data;
}

// 反查：物品名（中/英）→ 哪些悬赏出（按概率降序）
export function whereBountyReward(query, data) {
  const q = compact(query);
  const hits = [];
  if (!q || q.length < 2) return { query, hits, expiry: data.expiry };
  for (const place of data.places) {
    for (const job of place.jobs) {
      for (const reward of job.rewards) {
        if (!compact(reward.zh).includes(q) && !compact(reward.name).includes(q)) continue;
        hits.push({
          placeZh: place.zh, npc: place.npc,
          jobZh: job.zhTitle, levels: job.levels, totalStanding: job.totalStanding,
          rewardZh: reward.zh, rewardEn: reward.name, rarity: reward.rarity, chance: reward.chance,
          isVault: job.isVault,
        });
      }
    }
  }
  hits.sort((a, b) => b.chance - a.chance);
  return { query, hits: hits.slice(0, 20), total: hits.length, expiry: data.expiry };
}

// ==== 奖励行内图：遗物→本地纪元素材；其余 wm thumb（已预热）→ AlecaFrame 目录插画；失败静默无图 ====
// 奖励没有 uniqueName（WFCD 只给商品名串），图链按英文名匹配；金额/倍数前缀先剥
export async function attachRewardIcons(rewards) {
  const list = (rewards || []).filter((reward) => reward && reward.iconDataUri === undefined);
  if (!list.length) return;
  const [{ imageDataUri }, { RELIC_ICON_DATA }, drops, { readFile }, path] = await Promise.all([
    import('./wfdata.mjs'), import('./warframe-cards.mjs'), import('./drops.mjs'), import('node:fs/promises'), import('node:path'),
  ]);
  // 货币类奖励（Endo/Credits）无目录条目，用本地官方素材
  const currencyIcon = async (file) => {
    try {
      const buf = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'currency', file));
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch { return null; }
  };
  let slugs = null;
  try { slugs = await drops.marketSlugMap(); } catch { slugs = null; }
  let byEnglish = null; // 本地目录英文名→imageName，惰性建一次（资源类 wm 无商品时兜底）
  let endoIcon;
  let creditsIcon;
  for (const reward of list) {
    try {
      const en = String(reward.name || reward.rewardEn || '');
      const relic = en.match(/^(Lith|Meso|Neo|Axi|Requiem|Omnia)\s/u);
      if (relic) { reward.iconDataUri = RELIC_ICON_DATA[relic[1]] || null; continue; }
      if (/\bEndo\b/u.test(en)) { endoIcon ??= await currencyIcon('endo.png'); reward.iconDataUri = endoIcon; continue; }
      if (/Credits\s+Cache/iu.test(en)) { creditsIcon ??= await currencyIcon('credits.png'); reward.iconDataUri = creditsIcon; continue; }
      const base = en.replace(/^\d+X\s+/u, '').replace(/^[\d,]+\s+/u, '').trim();
      const wmEntry = slugs ? drops.findMarketEntry(slugs, base) : null;
      const marketImageUrl = drops.marketDisplayImageUrl(wmEntry);
      if (marketImageUrl) reward.iconDataUri = await imageDataUri(marketImageUrl);
      if (reward.iconDataUri) continue;
      if (!byEnglish) {
        byEnglish = new Map();
        try {
          const catalog = await drops.loadCatalog(drops.defaultAlecaDir());
          for (const meta of catalog.values()) {
            const key = String(meta.englishName || '').toLowerCase().replace(/\s+/gu, '');
            if (key && meta.imageName && !byEnglish.has(key)) byEnglish.set(key, meta.imageName);
          }
        } catch { /* 目录缺失兜底层不可用 */ }
      }
      const img = byEnglish.get(base.toLowerCase().replace(/\s+/gu, ''))
        // 目录组件名不带 Blueprint 尾缀（Gara Chassis Blueprint→Gara Chassis），剥尾缀再试
        || byEnglish.get(base.toLowerCase().replace(/\s+/gu, '').replace(/blueprint$/u, ''));
      reward.iconDataUri = img ? await imageDataUri(`https://cdn.alecaframe.com/warframeData/img/${img}`) : null;
    } catch { reward.iconDataUri = null; }
  }
}

// ==== 订阅候选（subscriptions.mjs monitor 注入用）====
// 每 job 一条候选；id 含 WFCD job.id（自带轮换时间戳），seen 去重天然每轮一推；
// searchText 汇入任务名/地点/全部奖励中英文名，供 genericMatches 的订阅词命中
export async function bountyCandidatesFromSyndicates(syndicates) {
  const maps = await getBountyZhMaps();
  const enriched = await ensureBountyRewards(syndicates);
  const candidates = [];
  for (const place of BOUNTY_PLACES) {
    const group = enriched.find((entry) => entry.syndicate === place.syndicate);
    if (!group?.jobs?.length) continue;
    for (const raw of group.jobs) {
      const job = assembleJob(raw, maps);
      candidates.push({
        id: `bounty:${job.id || `${place.key}:${group.expiry}`}`,
        type: 'bounty',
        placeZh: place.zh, npc: place.npc,
        jobZh: job.zhTitle, levels: job.levels,
        totalStanding: job.totalStanding, standingUnit: place.standingUnit,
        topReward: job.top ? `${job.top.zh} ${job.top.chance}%` : '',
        searchText: [place.zh, place.planet, place.npc, job.zhTitle, job.enTitle, ...job.rewards.map((reward) => `${reward.zh} ${reward.name}`)].join(' '),
        expiry: group.expiry || null,
      });
    }
  }
  return candidates;
}

// ==== CLI（探针/测试）：node bounties.mjs [地点|物品] ====
async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  const data = await fetchBounties();
  if (!query) {
    console.log(JSON.stringify({ expiry: data.expiry, places: data.places.map((p) => ({ zh: p.zh, jobs: p.jobs.map((j) => `${j.zhTitle} ${j.levels.join('-')} 声望${j.totalStanding} 顶奖:${j.top?.zh}(${j.top?.chance}%)`) })), boards: data.boards }, null, 1));
    return;
  }
  const place = resolveBountyPlace(query);
  if (place) {
    console.log(JSON.stringify(data.places.find((p) => p.key === place.key), null, 1));
    return;
  }
  console.log(JSON.stringify(whereBountyReward(query, data), null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
