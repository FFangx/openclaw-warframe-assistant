#!/usr/bin/env node

// Read-only adapter for the local AlecaFrame snapshot.
// It never reads AlecaFrame's Warframe.Market token and never sends raw account data.

import { createDecipheriv } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAccountSnapshotCard, buildInventorySnapshotCard, renderWarframeCard } from './warframe-cards.mjs';
import { stripDataUriReplacer } from './wfdata.mjs';

const SNAPSHOT_KEY = Buffer.from([76, 69, 79, 45, 65, 76, 69, 67, 9, 69, 79, 45, 65, 76, 69, 67]);
const SNAPSHOT_IV = Buffer.from([49, 50, 70, 71, 66, 51, 54, 45, 76, 69, 51, 45, 113, 61, 57, 0]);
const ERA_ZH = { Lith: '古纪', Meso: '前纪', Neo: '中纪', Axi: '后纪', Requiem: '安魂' };
const REFINEMENT_ZH = { Intact: '完整', Exceptional: '优良', Flawless: '无瑕', Radiant: '光辉' };
const COMPONENT_ZH = {
  Blueprint: '蓝图', Chassis: '机体蓝图', Neuroptics: '头部神经光元蓝图', Systems: '系统蓝图',
  Barrel: '枪管', Receiver: '枪机', Stock: '枪托', Blade: '刀刃', Handle: '握柄', Hilt: '剑柄',
  Grip: '握柄', Link: '连接器', Ornament: '饰物', String: '弓弦', UpperLimb: '上弓臂', LowerLimb: '下弓臂',
  Head: '头部', Gauntlet: '拳套', Disc: '圆盘', Stars: '星镖', Chain: '锁链', Boot: '靴部',
  // 双持武器部件复数形态（drops.mjs 同款表已补，两表保持同步）
  Barrels: '枪管', Receivers: '枪机', Links: '连接器', Blades: '刀刃', Handles: '握柄',
};
const QUERY_ALIASES = {
  悟空: 'wukong', 猴子: 'wukong', 猴哥: 'wukong', 奶妈: 'trinity', 三位一体: 'trinity',
  电男: 'volt', 伏特: 'volt', 冰男: 'frost', 火女: 'ember', 毒妈: 'saryn', 犀牛: 'rhino',
  女枪: 'mesa', 高斯: 'gauss', 夜灵: 'revenant', 血妈: 'garuda', 猫甲: 'khora', 玻璃: 'gara',
  龙甲: 'chroma', 磁力: 'mag', 圣剑: 'excalibur', 咖喱: 'excalibur', 洛基: 'loki', 摸尸: 'nekros',
  水男: 'hydroid', 鸟姐: 'zephyr', 蛋男: 'limbo', 小丑: 'mirage', 妮瓦: 'nova', 诺娃: 'nova',
  妈甲: 'hildryn', 音甲: 'octavia', 音妈: 'octavia', 瓦喵: 'valkyr', 瓦尔基里: 'valkyr',
  女武神: 'valkyr', 蛆甲: 'nidus', 哪吒: 'nezha', 沙甲: 'inaros', 妖精: 'titania', 蝴蝶: 'titania',
  工程: 'vauban', 剑圣: 'ash', 充沛: 'arcane energize', 充沛赋能: 'arcane energize',
};

const ACCOUNT_GROUPS = [
  'MiscItems', 'Recipes', 'Consumables', 'RawUpgrades', 'FusionTreasures', 'FlavourItems',
  'SpecialItems', 'DataKnives', 'LongGuns', 'Pistols', 'Melee', 'Suits', 'Sentinels',
  'SentinelWeapons', 'SpaceGuns', 'SpaceMelee', 'SpaceSuits', 'OperatorAmps', 'OperatorSuits',
  'CrewShipWeapons', 'DrifterMelee', 'Horses', 'Motorcycles', 'KubrowPets',
];
const CATALOG_FILES = [
  'Arcanes.json', 'Mods.json', 'Misc.json', 'Resources.json', 'Gear.json', 'Primary.json',
  'Secondary.json', 'Melee.json', 'Warframes.json', 'Sentinels.json', 'SentinelWeapons.json',
  'Arch-Gun.json', 'Arch-Melee.json', 'Archwing.json', 'Pets.json', 'Railjack.json',
];

const out = (value) => process.stdout.write(`${JSON.stringify(value, stripDataUriReplacer, 2)}\n`);
const normalize = (value) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
const compact = (value) => normalize(value).toLowerCase().replace(/[\s_\-:：·•()（）【】\[\]]+/gu, '');

function defaultAlecaDir() {
  return process.env.ALECAFRAME_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AlecaFrame');
}

// 目录 json：本地优先，缺失走 wfdata 在线兑底（无 AlecaFrame 时公开功能不降级）
async function readCatalogJson(alecaDir, filename) {
  const { readAlecaJson } = await import('./wfdata.mjs');
  return readAlecaJson(`json/${filename}`, { alecaDir });
}

function expandQuery(value) {
  let query = normalize(value).toLowerCase();
  for (const [alias, canonical] of Object.entries(QUERY_ALIASES).sort((a, b) => b[0].length - a[0].length)) {
    query = query.split(alias).join(canonical);
  }
  query = query.replace(/([\p{L}\p{N}])p(?=$|[\u4e00-\u9fff])/giu, '$1 prime ');
  return normalize(query.replace(/赋能[·・]?/gu, 'arcane '));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readSnapshot(alecaDir = defaultAlecaDir()) {
  const file = path.join(alecaDir, 'lastData.dat');
  await access(file);
  const encrypted = await readFile(file);
  let text;
  if (encrypted[0] === 0x7b) {
    text = encrypted.toString('utf8');
  } else {
    const decipher = createDecipheriv('aes-128-cbc', SNAPSHOT_KEY, SNAPSHOT_IV);
    text = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
  const envelope = JSON.parse(text.replace(/\0+$/gu, ''));
  // 两种格式：旧版包 InventoryJson 信封；新版（2026-08 起）顶层直接就是库存对象
  const inventoryText = envelope.InventoryJson || envelope.InventoryJSON;
  const inventory = inventoryText
    ? (typeof inventoryText === 'string' ? JSON.parse(inventoryText) : inventoryText)
    : (envelope.MiscItems || envelope.RawUpgrades ? envelope : null);
  if (!inventory) throw new Error('账号快照中没有库存数据，请先启动 AlecaFrame 和游戏完成一次加载。');
  const fileStat = await stat(file);
  const oid = inventory.LastInventorySync?.$oid || inventory.LastInventorySync?.oid || '';
  const oidSeconds = /^[0-9a-f]{24}$/iu.test(oid) ? Number.parseInt(oid.slice(0, 8), 16) : 0;
  const syncedAt = oidSeconds > 0 ? new Date(oidSeconds * 1000).toISOString() : fileStat.mtime.toISOString();
  return { inventory, envelope, syncedAt, fileMtime: fileStat.mtime.toISOString(), alecaDir };
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function localizeRelicName(value) {
  const match = String(value || '').match(/^(Lith|Meso|Neo|Axi|Requiem)\s+([A-Z0-9]+)\s+(Intact|Exceptional|Flawless|Radiant)$/iu);
  if (!match) return '未收录遗物';
  const era = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  const refinement = match[3][0].toUpperCase() + match[3].slice(1).toLowerCase();
  return `${ERA_ZH[era] || '未知纪元'} ${match[2].toUpperCase()} · ${REFINEMENT_ZH[refinement] || '未知精炼'}`;
}

function normalizeRelicQuery(value) {
  let query = normalize(value).replace(/遗物/gu, '');
  const aliases = [
    [/^(?:古纪|古)(?=\s*[a-z]\d)/iu, 'Lith '], [/^(?:前纪|前)(?=\s*[a-z]\d)/iu, 'Meso '],
    [/^(?:中纪|中)(?=\s*[a-z]\d)/iu, 'Neo '], [/^(?:后纪|后)(?=\s*[a-z]\d)/iu, 'Axi '],
    [/^(?:安魂)(?=\s*[a-z]\d)/iu, 'Requiem '],
  ];
  for (const [pattern, replacement] of aliases) {
    if (pattern.test(query)) { query = query.replace(pattern, replacement); break; }
  }
  return normalize(query);
}

async function loadLanguage(alecaDir) {
  const { getLangTable } = await import('./wfdata.mjs');
  const data = await getLangTable({ alecaDir });
  return (uniqueName) => data?.[uniqueName]?.zh?.name || null;
}

async function loadCatalog(alecaDir, localize) {
  const byUniqueName = new Map();
  for (const filename of CATALOG_FILES) {
    const items = await readCatalogJson(alecaDir, filename);
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item?.uniqueName) continue;
      const isWarframe = filename === 'Warframes.json' || String(item.uniqueName).includes('/Powersuits/');
      const zhName = localize(item.uniqueName);
      byUniqueName.set(item.uniqueName, {
        uniqueName: item.uniqueName,
        englishName: item.name || '',
        displayName: isWarframe ? (item.name || zhName || '未收录战甲') : (zhName || '未收录物品'),
        type: filename.replace(/\.json$/iu, ''),
      });
      for (const component of item.components || []) {
        if (!component?.uniqueName) continue;
        const suffix = COMPONENT_ZH[component.name] || localize(component.uniqueName);
        const parent = isWarframe ? item.name : (zhName || '未收录物品');
        // 战甲部件的 Component 键=已铸造成品（不可交易）；蓝图键=…Blueprint（可交易，wm 上卖的形态）
        // 不标注会把成品当蓝图给出错误交易建议（2026-08-05 Zephyr Prime 实锤）
        const crafted = /\/WarframeRecipes\/[^/]*Component$/u.test(component.uniqueName);
        // COMPONENT_ZH 按掉落语境自带「蓝图」尾巴（Chassis→机体蓝图），成品形态要剥掉再标
        const craftedSuffix = suffix ? `${suffix.replace(/\s*蓝图$/u, '')}（成品·不可交易）` : null;
        byUniqueName.set(component.uniqueName, {
          uniqueName: component.uniqueName,
          englishName: `${item.name || ''} ${component.name || ''}`.trim(),
          displayName: suffix ? `${parent} ${crafted ? craftedSuffix : suffix}` : '未收录部件',
          type: '部件',
        });
        // 蓝图形态别名（仓库 Recipes 组的 …Blueprint 键；drops.mjs 同款键错位修法）
        const blueprintAlias = component.uniqueName.replace(/Component$/u, 'Blueprint');
        if (blueprintAlias !== component.uniqueName && !byUniqueName.has(blueprintAlias)) {
          const blueprintSuffix = suffix ? (/蓝图$/u.test(suffix) ? suffix : `${suffix}蓝图`) : null;
          byUniqueName.set(blueprintAlias, {
            uniqueName: blueprintAlias,
            englishName: `${item.name || ''} ${component.name || ''} Blueprint`.trim(),
            displayName: blueprintSuffix ? `${parent} ${blueprintSuffix}` : '未收录部件',
            type: '部件蓝图',
          });
        }
      }
    }
  }
  return byUniqueName;
}

function collectOwned(inventory) {
  const rows = [];
  for (const group of ACCOUNT_GROUPS) {
    const values = Array.isArray(inventory[group]) ? inventory[group] : [];
    for (const value of values) {
      if (!value?.ItemType) continue;
      const isCounted = value.ItemCount != null;
      rows.push({
        uniqueName: value.ItemType,
        count: isCounted ? safeNumber(value.ItemCount) : 1,
        rank: null,
        group,
      });
    }
  }
  for (const value of inventory.Upgrades || []) {
    if (!value?.ItemType) continue;
    let rank = 0;
    try { rank = safeNumber(JSON.parse(value.UpgradeFingerprint || '{}').lvl); } catch { rank = 0; }
    rows.push({ uniqueName: value.ItemType, count: 1, rank, group: 'Upgrades' });
  }
  return rows;
}

function aggregateRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const current = grouped.get(row.uniqueName) || { uniqueName: row.uniqueName, total: 0, ranks: new Map(), groups: new Set() };
    current.total += row.count;
    current.groups.add(row.group);
    if (row.rank != null) current.ranks.set(row.rank, (current.ranks.get(row.rank) || 0) + row.count);
    grouped.set(row.uniqueName, current);
  }
  return [...grouped.values()];
}

function rankText(ranks) {
  if (!ranks?.size) return '';
  return [...ranks.entries()].sort((a, b) => a[0] - b[0]).map(([rank, count]) => `${rank}级×${count}`).join('、');
}

async function accountSummary(snapshot) {
  const { inventory, syncedAt } = snapshot;
  const miscCount = (uniqueName) => safeNumber((inventory.MiscItems || []).find((item) => item.ItemType === uniqueName)?.ItemCount);
  const ducats = miscCount('/Lotus/Types/Items/MiscItems/PrimeBucks');
  const relics = await loadRelics(snapshot);
  const arcanes = await loadArcanes(snapshot);
  // 热门商店货币（2026-08-06 用户点名）：赤毒/钢铁精华/裂罅碎块/存货储备/双衍天赋×2/电波代币
  // 图标=游戏原图（browse.wf）→ AlecaFrame CDN（imageName）兜底；拉不到无图降级
  const { gameIconDataUri, imageDataUri } = await import('./wfdata.mjs');
  const iconOf = async (uniqueName, cdnImage = null) => (await gameIconDataUri(uniqueName))
    || (cdnImage ? await imageDataUri(`https://cdn.alecaframe.com/warframeData/img/${cdnImage}`) : null);
  // 电波商店代币每赛季换 uniqueName（NoraIntermissionFifteenCreds…），按前缀模糊找当季那条
  const noraEntry = (inventory.MiscItems || []).find((item) => /\/MiscItems\/Nora\w*Creds$/u.test(String(item.ItemType)));
  const language = await loadLanguage(snapshot.alecaDir).catch(() => ({}));
  const noraZh = noraEntry ? (language[noraEntry.ItemType]?.zh?.name || '电波商店代币') : null;
  const SHOP_CURRENCIES = [
    { label: '赤毒', uniqueName: '/Lotus/Types/Items/MiscItems/Kuva', color: '#d64541' },
    { label: '苦栓', uniqueName: '/Lotus/Types/Gameplay/Duviri/Resource/DuviriDragonDropItem', color: '#e0a458' },
    { label: '钢铁精华', uniqueName: '/Lotus/Types/Items/MiscItems/SteelEssence', color: '#c96a4a' },
    { label: '裂罅碎块', uniqueName: '/Lotus/Types/Items/MiscItems/RivenFragment', color: '#c98add' },
    { label: '存货储备', uniqueName: '/Lotus/Types/Items/MiscItems/KahlCreds', color: '#d8b26e' },
    { label: '翠绿天赋', uniqueName: '/Lotus/Types/JadeShadowsPart2Mission/Gameplay/Resources/AshFavor', cdnImage: 'SiriusCoinResource.png', color: '#7ede9e' },
    { label: '猩红天赋', uniqueName: '/Lotus/Types/JadeShadowsPart2Mission/Gameplay/Resources/GarudaFavor', cdnImage: 'OrionCoinResource.png', color: '#ff7d88' },
    ...(noraEntry ? [{ label: noraZh, uniqueName: String(noraEntry.ItemType), color: '#4FC3F7' }] : []),
  ];
  const shopMetrics = await Promise.all(SHOP_CURRENCIES.map(async (entry) => ({
    label: entry.label,
    value: miscCount(entry.uniqueName).toLocaleString('zh-CN'),
    color: entry.color,
    iconDataUri: await iconOf(entry.uniqueName, entry.cdnImage).catch(() => null),
  })));
  const data = {
    kind: 'account',
    title: '我的账号状态',
    syncedAt,
    metrics: [
      { label: '段位', value: safeNumber(inventory.PlayerLevel) },
      { label: '剩余交易', value: safeNumber(inventory.TradesRemaining) },
      { label: '现金', value: safeNumber(inventory.RegularCredits).toLocaleString('zh-CN'), currencyKind: 'credit' },
      { label: '内融核心', value: safeNumber(inventory.FusionPoints).toLocaleString('zh-CN'), currencyKind: 'endo' },
      { label: '杜卡德金币', value: ducats.toLocaleString('zh-CN'), currencyKind: 'ducat' },
      { label: '白金', value: (safeNumber(inventory.PremiumCredits) + safeNumber(inventory.PremiumCreditsFree)).toLocaleString('zh-CN'), currencyKind: 'plat' },
      ...shopMetrics,
    ],
    footnote: `遗物 ${relics.reduce((sum, item) => sum + item.count, 0)} 个 · 满级赋能 ${arcanes.filter((item) => item.rank === item.maxRank).reduce((sum, item) => sum + item.count, 0)} 个`,
  };
  return { data, text: formatAccount(data) };
}

async function loadRelics(snapshot) {
  const [catalog, localize] = await Promise.all([
    readCatalogJson(snapshot.alecaDir, 'Relics.json').then((items) => (Array.isArray(items) ? items : [])),
    loadLanguage(snapshot.alecaDir),
  ]);
  const byUniqueName = new Map(catalog.map((item) => [item.uniqueName, item]));
  return (snapshot.inventory.MiscItems || []).flatMap((owned) => {
    const item = byUniqueName.get(owned.ItemType);
    if (!item) return [];
    const englishName = item.name || '';
    const baseName = englishName.replace(/\s+(Intact|Exceptional|Flawless|Radiant)$/iu, '');
    const refinement = englishName.match(/(Intact|Exceptional|Flawless|Radiant)$/iu)?.[1] || '';
    return [{
      uniqueName: owned.ItemType,
      englishName,
      baseName,
      refinement,
      name: localizeRelicName(englishName) === '未收录遗物' ? (localize(owned.ItemType) || '未收录遗物') : localizeRelicName(englishName),
      count: safeNumber(owned.ItemCount),
      vaulted: Boolean(item.vaulted),
    }];
  });
}

async function relicQuery(snapshot, rawQuery) {
  const all = await loadRelics(snapshot);
  const query = normalizeRelicQuery(rawQuery);
  let matches = all;
  if (query) {
    const key = compact(query);
    matches = all.filter((item) => [item.englishName, item.baseName, item.name].some((value) => compact(value).includes(key) || key.includes(compact(value))));
  }
  matches.sort((a, b) => b.count - a.count || a.englishName.localeCompare(b.englishName));
  const data = {
    kind: 'inventory', subtype: '遗物库存', title: query ? `我的遗物 · ${normalize(rawQuery)}` : '我的遗物',
    syncedAt: snapshot.syncedAt,
    // 入库状态配色对齐遗物反查卡：已入库=金褐（绝版更值钱）/ 当前可获取=绿
    rows: matches.slice(0, 14).map((item) => ({ name: item.name, value: `${item.count} 个`, detail: item.vaulted ? '已入库' : '当前可获取', detailColor: item.vaulted ? '#d7a46d' : '#8ee3ad', era: item.baseName.split(' ')[0] })),
    totalMatches: matches.length,
    totalCount: matches.reduce((sum, item) => sum + item.count, 0),
  };
  return { data, text: formatInventory(data, query ? `没有找到“${rawQuery}”的本地遗物记录。` : '本地没有遗物记录。') };
}

async function loadArcanes(snapshot) {
  const [catalog, localize] = await Promise.all([
    readCatalogJson(snapshot.alecaDir, 'Arcanes.json').then((items) => (Array.isArray(items) ? items : [])),
    loadLanguage(snapshot.alecaDir),
  ]);
  const byUniqueName = new Map(catalog.map((item) => [item.uniqueName, item]));
  const rows = [];
  for (const owned of snapshot.inventory.RawUpgrades || []) {
    const item = byUniqueName.get(owned.ItemType);
    if (!item) continue;
    rows.push({ uniqueName: owned.ItemType, englishName: item.name, name: localize(owned.ItemType) || '未收录赋能', rank: 0, maxRank: Math.max(0, (item.levelStats?.length || 1) - 1), count: safeNumber(owned.ItemCount) });
  }
  for (const owned of snapshot.inventory.Upgrades || []) {
    const item = byUniqueName.get(owned.ItemType);
    if (!item) continue;
    let rank = 0;
    try { rank = safeNumber(JSON.parse(owned.UpgradeFingerprint || '{}').lvl); } catch { rank = 0; }
    rows.push({ uniqueName: owned.ItemType, englishName: item.name, name: localize(owned.ItemType) || '未收录赋能', rank, maxRank: Math.max(0, (item.levelStats?.length || 1) - 1), count: 1 });
  }
  return rows;
}

async function arcaneQuery(snapshot, rawQuery) {
  const all = await loadArcanes(snapshot);
  const query = expandQuery(rawQuery);
  const key = compact(query).replace(/^arcane/u, '');
  let matches = key ? all.filter((item) => {
    const fields = [item.name, item.englishName, item.uniqueName.split('/').at(-1)];
    return fields.some((field) => compact(field).replace(/^arcane/u, '').includes(key) || key.includes(compact(field).replace(/^arcane/u, '')));
  }) : all;
  const grouped = new Map();
  for (const item of matches) {
    const current = grouped.get(item.uniqueName) || { ...item, total: 0, ranks: new Map() };
    current.total += item.count;
    current.ranks.set(item.rank, (current.ranks.get(item.rank) || 0) + item.count);
    grouped.set(item.uniqueName, current);
  }
  const rows = [...grouped.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-CN'));
  const data = {
    kind: 'inventory', subtype: '赋能库存', title: key ? `我的赋能 · ${normalize(rawQuery)}` : '我的赋能',
    syncedAt: snapshot.syncedAt,
    rows: rows.slice(0, 14).map((item) => ({ name: item.name, value: `${item.total} 个`, detail: rankText(item.ranks), uniqueName: item.uniqueName, englishName: item.englishName })),
    totalMatches: rows.length,
    totalCount: rows.reduce((sum, item) => sum + item.total, 0),
  };
  return { data, text: formatInventory(data, key ? `没有找到“${rawQuery}”的本地赋能记录。` : '本地没有赋能记录。') };
}

// —— 库存五分类估值（2026-08-06 用户定稿：MOD/遗物/赋能/部件/杂项，对齐 AlecaFrame 分页） ——
// 行粒度=物品+等级（遗物=物品+精炼度）；不可交易不展示不算价；价格=relics.run wm 全商品日行情
const INVENTORY_CATEGORIES = [
  { key: 'mod', zh: 'MOD', aliases: ['mod', 'mods', '模组', '模块'] },
  { key: 'relic', zh: '遗物', aliases: ['遗物', 'relic'] },
  { key: 'arcane', zh: '赋能', aliases: ['赋能', 'arcane'] },
  { key: 'part', zh: '部件', aliases: ['部件', 'parts', '组件'] },
  { key: 'misc', zh: '杂项', aliases: ['杂项', 'misc', '资源', '其他'] },
];

function resolveInventoryCategory(query) {
  const key = compact(query);
  if (!key) return null;
  return INVENTORY_CATEGORIES.find((category) => category.aliases.some((alias) => compact(alias) === key)) || null;
}

// drops 目录 category → 五分类键；装备本体（战甲/武器成品）不属库存分页，返回 null 不参与
function categoryKeyOf(meta) {
  if (!meta) return null;
  if (meta.category === 'Mods') return 'mod';
  if (meta.category === 'Arcanes') return 'arcane';
  if (meta.category === 'Relics') return 'relic';
  if (meta.category === 'Component') return 'part';
  if (['Misc', 'Resources', 'Gear', 'Railjack', 'Fish'].includes(meta.category)) return 'misc';
  return null;
}

// 全库存统一估值条目：[{catKey, uniqueName, name, englishName, count, rank, refinement, unit, total, ducats}]
// 价格分档：0 级/无档=p0；升过级的 MOD/赋能按满级档 pMax（wm 行情只有两档，非满级按满级算并在 detail 标注）
export async function assembleInventoryValuation(snapshot) {
  const [drops, { getMarketPriceIndex }] = await Promise.all([import('./drops.mjs'), import('./wfdata.mjs')]);
  const [catalog, priceIndex] = await Promise.all([drops.loadCatalog(snapshot.alecaDir), getMarketPriceIndex()]);
  const squash = (value) => String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, '');
  // 赋能升级=叠加同名张数：rank N 等价 0 级张数（市场可买 N 张自合，换算成立）；满级档行情封顶
  const ARCANE_COPIES = [1, 3, 6, 10, 15, 21];
  const priceOf = (meta, rank) => {
    const key = squash(meta.englishName);
    if (!key) return null;
    // 遗物 wm 商品名带 Relic 尾缀且不分精炼度；部件商品可能带 Blueprint 尾缀（双键老坑）
    const baseKey = meta.category === 'Relics' ? squash(meta.englishName.replace(/\s+(Intact|Exceptional|Flawless|Radiant)$/iu, ' Relic')) : key;
    const entry = priceIndex[baseKey] || priceIndex[`${baseKey}blueprint`] || null;
    if (!entry) return null;
    if (rank > 0) {
      // 满级按满级档；非满级赋能按等价张数换算；非满级 MOD 按 0 级价（升级花的 endo 卖不回来，宁低估不虚高）
      if (entry.maxRank != null && rank >= entry.maxRank && entry.pMax != null) return { price: entry.pMax, tier: '满级档' };
      if (meta.category === 'Arcanes' && entry.p0 != null) {
        const copies = ARCANE_COPIES[Math.min(rank, ARCANE_COPIES.length - 1)] ?? 1;
        const converted = entry.p0 * copies;
        return { price: entry.pMax != null ? Math.min(converted, entry.pMax) : converted, tier: `按 ${copies} 张 0 级换算` };
      }
      const price = entry.p0 ?? entry.pMax;
      return Number.isFinite(price) ? { price, tier: entry.p0 != null ? '按 0 级价' : '满级档' } : null;
    }
    const price = entry.p0 ?? entry.pMax;
    return Number.isFinite(price) ? { price, tier: '' } : null;
  };
  const grouped = new Map();
  const put = (uniqueName, count, rank) => {
    const meta = catalog.get(uniqueName);
    const catKey = categoryKeyOf(meta);
    if (!catKey || !meta.tradable) return; // 不可交易不展示不算价（用户定）
    const groupKey = `${uniqueName}#${rank}`;
    const current = grouped.get(groupKey);
    if (current) { current.count += count; return; }
    const refinement = meta.category === 'Relics' ? (meta.englishName.match(/(Intact|Exceptional|Flawless|Radiant)$/iu)?.[1] || '') : '';
    grouped.set(groupKey, {
      catKey, uniqueName, count, rank,
      refinement: REFINEMENT_ZH[refinement] || '',
      name: meta.displayName, englishName: meta.englishName,
      ducats: meta.ducats ?? null, meta,
      parentUniqueName: meta.parentUniqueName || null,
      parentEnglishName: meta.parentEnglishName || null,
      parentDisplayName: meta.parentDisplayName || null,
      setRequired: Math.max(1, Number(meta.setRequired) || 1),
    });
  };
  for (const group of ['MiscItems', 'Recipes', 'Consumables', 'RawUpgrades']) {
    for (const item of snapshot.inventory[group] || []) {
      if (item?.ItemType) put(item.ItemType, safeNumber(item.ItemCount) || 1, 0);
    }
  }
  for (const item of snapshot.inventory.Upgrades || []) {
    if (!item?.ItemType) continue;
    let rank = 0;
    try { rank = safeNumber(JSON.parse(item.UpgradeFingerprint || '{}').lvl); } catch { rank = 0; }
    put(item.ItemType, 1, rank);
  }
  const entries = [];
  for (const entry of grouped.values()) {
    const quote = priceOf(entry.meta, entry.rank);
    entries.push({
      ...entry, meta: undefined,
      unit: quote ? Math.round(quote.price * 10) / 10 : null,
      tierNote: quote?.tier || '',
      total: quote ? Math.round(quote.price * entry.count * 10) / 10 : 0,
    });
  }
  return entries;
}

// 行显示名：等级/精炼度并入名字（用户定：等级也要显示）
function valuationRowName(entry) {
  if (entry.rank > 0) return `${entry.name} ${entry.rank}级`;
  return entry.name;
}

// 行明细：同物同级多个 → 单价×总价（用户定）；非满级标换算口径；部件类附杜卡德合计
function valuationRowDetail(entry) {
  const parts = [];
  if (entry.unit == null) parts.push(`${entry.count} 个 · 暂无行情`);
  else if (entry.count > 1) parts.push(`${entry.count} 个 × 单价 ${entry.unit}p`);
  else parts.push(`单价 ${entry.unit}p`);
  if (entry.tierNote && entry.tierNote !== '满级档') parts.push(entry.tierNote);
  if (entry.catKey === 'part' && entry.ducats) parts.push(`${entry.ducats * entry.count} 杜卡德`);
  return parts.join(' · ');
}

async function inventoryQuery(snapshot, rawQuery) {
  // 「我的库存 赋能/MOD/遗物/部件/杂项」= 分类明细（价值降序，模板同总览）
  const category = resolveInventoryCategory(rawQuery);
  if (category) {
    const entries = (await assembleInventoryValuation(snapshot)).filter((entry) => entry.catKey === category.key);
    entries.sort((a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
    const totalValue = entries.reduce((sum, entry) => sum + entry.total, 0);
    const data = {
      kind: 'inventory', subtype: `库存 · ${category.zh}`, title: `我的库存 · ${category.zh}`, syncedAt: snapshot.syncedAt,
      rows: entries.slice(0, 14).map((entry) => ({
        name: valuationRowName(entry),
        value: `${entry.count} 个`,
        plat: entry.total || null,
        detail: valuationRowDetail(entry),
        uniqueName: entry.uniqueName, englishName: entry.englishName,
        era: entry.catKey === 'relic' ? entry.englishName.split(' ')[0] : undefined,
      })),
      totalMatches: entries.length,
      totalPlat: Math.round(totalValue),
      totalCount: entries.reduce((sum, entry) => sum + entry.count, 0),
    };
    const note = entries.some((entry) => entry.tierNote && entry.tierNote !== '满级档') ? '非满级物品按 0 级行情/等价张数保守估算。' : '';
    return { data, text: `${formatInventory(data, `本地没有可交易的${category.zh}库存。`)}${note ? `\n${note}` : ''}` };
  }
  const query = expandQuery(rawQuery);
  if (!query) {
    // 总览 = 五分类模块行（条目数+估值）+ 全类别高价值 TOP10（2026-08-06 用户定稿，对齐 AlecaFrame 分页）
    let entries = [];
    try { entries = await assembleInventoryValuation(snapshot); } catch { entries = []; }
    const moduleRows = INVENTORY_CATEGORIES.map((category) => {
      const list = entries.filter((entry) => entry.catKey === category.key);
      const value = Math.round(list.reduce((sum, entry) => sum + entry.total, 0));
      return {
        name: category.zh,
        value: `${list.length} 项`,
        plat: value || null,
        detail: `发「我的库存 ${category.zh}」看明细`,
      };
    });
    const top = [...entries].sort((a, b) => b.total - a.total).slice(0, 10).map((entry) => ({
      name: valuationRowName(entry),
      value: `${entry.count} 个`,
      plat: entry.total || null,
      detail: `${INVENTORY_CATEGORIES.find((category) => category.key === entry.catKey)?.zh || ''} · ${valuationRowDetail(entry)}`,
      uniqueName: entry.uniqueName, englishName: entry.englishName,
      era: entry.catKey === 'relic' ? entry.englishName.split(' ')[0] : undefined,
    }));
    const totalValue = Math.round(entries.reduce((sum, entry) => sum + entry.total, 0));
    const data = {
      kind: 'inventory', subtype: '库存总览', syncedAt: snapshot.syncedAt,
      title: '我的库存 · 分类与高价值',
      rows: [...moduleRows, ...top],
      totalMatches: entries.length,
      totalPlat: totalValue,
      totalCount: entries.reduce((sum, entry) => sum + entry.count, 0),
    };
    const text = `${formatInventory(data, '')}\n估值=星际战甲市场近日成交均价，只计可交易且有行情的物品。`;
    return { data, text };
  }
  const [localize, catalog] = await Promise.all([
    loadLanguage(snapshot.alecaDir),
    (async () => {
      const localizeForCatalog = await loadLanguage(snapshot.alecaDir);
      return loadCatalog(snapshot.alecaDir, localizeForCatalog);
    })(),
  ]);
  const key = compact(query);
  const owned = aggregateRows(collectOwned(snapshot.inventory)).map((item) => {
    const metadata = catalog.get(item.uniqueName);
    const directName = localize(item.uniqueName);
    const displayName = metadata?.displayName || directName || '未收录物品';
    const fields = [displayName, metadata?.englishName].filter(Boolean);
    if (displayName.startsWith('未收录') && !metadata?.englishName) fields.push(item.uniqueName.split('/').at(-1));
    const score = fields.reduce((best, field) => {
      const candidate = compact(field);
      if (candidate === key) return Math.min(best, 0);
      if (candidate.includes(key) || key.includes(candidate)) return Math.min(best, 1 + Math.abs(candidate.length - key.length) / 100);
      return best;
    }, Number.POSITIVE_INFINITY);
    return { ...item, displayName, englishName: metadata?.englishName || '', score };
  }).filter((item) => Number.isFinite(item.score));
  owned.sort((a, b) => a.score - b.score || b.total - a.total || a.displayName.localeCompare(b.displayName, 'zh-CN'));
  const data = {
    kind: 'inventory', subtype: '库存查询', title: `我的库存 · ${normalize(rawQuery)}`, syncedAt: snapshot.syncedAt,
    rows: owned.slice(0, 14).map((item) => ({ name: item.displayName, value: `${item.total} 个`, detail: rankText(item.ranks) || '本机持有', uniqueName: item.uniqueName, englishName: item.englishName })),
    totalMatches: owned.length,
    totalCount: owned.reduce((sum, item) => sum + item.total, 0),
  };
  return { data, text: formatInventory(data, `没有找到“${rawQuery}”的本地库存记录。`) };
}

function bsonDate(value) {
  const milliseconds = Number(value?.$date?.$numberLong ?? value?.$date ?? value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

async function weeklyEvidence(snapshot) {
  const rewards = (snapshot.inventory.DescentRewards || []).map((item) => ({
    name: item.Category === 'DM_COH_HARD' ? '沉沦之地（钢铁）' : '沉沦之地（普通）',
    value: `${safeNumber(item.FloorClaimed)} 层`,
    detail: bsonDate(item.Expiry) ? `记录有效至 ${formatTime(bsonDate(item.Expiry))}` : '账号快照记录',
  }));
  const entratiCount = safeNumber(snapshot.inventory.EntratiVaultCountLastPeriod);
  const rows = [
    ...rewards,
    { name: '衰退室', value: `${entratiCount} 次`, detail: '字段标记为上一周期，仅作参考' },
    { name: '执刑官猎杀', value: snapshot.inventory.LastLiteSortieReward?.length ? '有最近奖励记录' : '未检测到记录', detail: '无法仅凭快照确认是否属于本周' },
    { name: '午夜电波', value: `${(snapshot.inventory.SeasonChallengeHistory || []).length} 条历史`, detail: '当前挑战完成状态暂不能可靠判定' },
  ];
  const data = { kind: 'inventory', subtype: '账号周常证据', title: '账号周常 · 可验证进度', syncedAt: snapshot.syncedAt, rows, totalMatches: rows.length, totalCount: rows.length, countUnit: '项' };
  return { data, text: `${formatInventory(data, '')}\n\n这些数据只用于辅助判断，不会自动把含糊项目勾成已完成。` };
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function formatAccount(data) {
  const lines = [`【${data.title}】`];
  for (const metric of data.metrics) lines.push(`${metric.label}：${metric.value}`);
  lines.push(data.footnote, `账号快照：${formatTime(data.syncedAt)}`, '进入任务、中继站或道场后，AlecaFrame 才可能刷新。');
  return lines.join('\n');
}

function formatInventory(data, emptyText) {
  if (!data.rows.length) return emptyText;
  const lines = [`【${data.title}】`];
  for (const row of data.rows) lines.push(`${row.name}｜${row.value}${row.detail ? `｜${row.detail}` : ''}`);
  if (data.totalMatches > data.rows.length) lines.push(`结果较多，显示前 ${data.rows.length}/${data.totalMatches} 项。`);
  lines.push(`账号快照：${formatTime(data.syncedAt)}`);
  return lines.join('\n');
}

export { readSnapshot };

// 模式词→队伍人数：单人/solo=1，N人=N（限 1~4），默认 4 人组队对齐 AlecaFrame
function parseSquad(query) {
  if (/单人|单排|solo/iu.test(query || '')) return 1;
  const n = String(query || '').match(/([1-4])\s*人/u);
  return n ? Number(n[1]) : 4;
}

export function parseAlecaMessage(message) {
  const text = normalize(message).replace(/^\//u, '');
  if (/^(?:我的账号|账号状态|我的状态)$/u.test(text)) return { command: 'account', query: '' };
  // 读库存做推荐 = 个人数据命令，走主人私聊判定通道；后缀可组合币种、队伍与任务偏好。
  const recommend = text.match(/^(?:裂缝推荐|推荐裂缝|开什么遗物|开什么)(?:\s+(.+))?$/u);
  if (recommend) return { command: 'recommend', query: (recommend[1] || '').trim() };
  // 精炼推荐：库存全扫哪些遗物值得花光体（同属个人数据通道）
  const refine = text.match(/^(?:精炼推荐|遗物精炼|值得精炼|精炼什么)(?:\s+(.+))?$/u);
  if (refine) return { command: 'refine', query: (refine[1] || '').trim() };
  // 奸商购物推荐：读库存+杜卡德余额，同属个人数据通道
  if (/^(?:奸商推荐|奸商买什么|奸商购物|虚空商人推荐|虚空商人买什么)$/u.test(text)) return { command: 'trader-shopping', query: '' };
  // 杜卡德兑换：统一短入口，支持目标/清仓/保留 N（套）
  const ducat = text.match(/^(?:杜卡德|杜卡德推荐|杜卡德兑换)(?:\s+.*)?$/u);
  if (ducat) return { command: 'ducat-plan', query: text };
  // 轮换日历：「已有」标读快照 = 个人数据通道（快照读失败降级无标照常出卡）
  if (/^(?:轮换日历|排期|日历|未来轮换)$/u.test(text)) return { command: 'rotation-calendar', query: '' };
  // 商店总览/单商人详情：已购标注读快照 = 个人数据通道（快照读失败降级为无已购标）
  const shop = text.match(/^商店(?:\s+(.+))?$/u);
  if (shop) return { command: 'shop', query: (shop[1] || '').trim() };
  // 本周好货直查（与周一订阅推送同一张卡）：已购标读快照 = 个人数据通道
  if (/^(?:本周好货|好货|好货清单)$/u.test(text)) return { command: 'weekly-deals', query: '' };
  // 我的紫卡：快照指纹 × AlecaFrame 本机计算表，离线复算数值/神卡标；带武器名=详情卡（wm 拍卖行情+估价）
  if (/^(?:我的紫卡|紫卡列表|紫卡)$/u.test(text)) return { command: 'rivens', query: '' };
  const rivenDetail = text.match(/^(?:我的紫卡|紫卡)\s+(.+)$/u);
  if (rivenDetail) return { command: 'rivens', query: rivenDetail[1].trim() };
  const relic = text.match(/^我的遗物(?:\s+|$)(.*)$/u);
  if (relic) return { command: 'relic', query: relic[1].trim() };
  const arcane = text.match(/^我的赋能(?:\s+|$)(.*)$/u);
  if (arcane) return { command: 'arcane', query: arcane[1].trim() };
  const inventory = text.match(/^我的库存(?:\s+|$)(.*)$/u);
  if (inventory) return { command: 'inventory', query: inventory[1].trim() };
  const owned = text.match(/^我(?:有多少|有)(.+)$/u);
  if (owned) {
    // 「我有几个X」→ X：剥量词前缀与尾部问语，否则整句当查询词 0 匹配
    const query = owned[1]
      .replace(/^(?:几个|几|多少个|多少)\s*/u, '')
      .replace(/[，,。]?\s*(?:推不推荐卖|要不要卖|该不该卖|值不值得卖|卖不卖)?\s*(?:吗|么|呢|？|\?)*$/u, '')
      .trim();
    return { command: 'inventory', query };
  }
  if (/^(?:账号周常|我的周常状态|周常同步状态)$/u.test(text)) return { command: 'weekly', query: '' };
  if (/^(?:刷新账号|刷新库存)$/u.test(text)) return { command: 'refresh-help', query: '' };
  return null;
}

export async function runAlecaMessage(message, options = {}) {
  const parsed = parseAlecaMessage(message);
  if (!parsed) return { handled: false };
  if (parsed.command === 'refresh-help') {
    return { handled: true, ok: true, command: parsed.command, text: '请确保 AlecaFrame 先于游戏启动，然后进入一次任务、中继站或道场并返回；加载完成后再发送“我的账号”。' };
  }
  if (parsed.command === 'rivens') {
    // 紫卡=纯个人数据：快照读失败直接报错（与其他账号命令一致）
    let snapshot;
    try { snapshot = await readSnapshot(options.alecaDir); } catch (error) {
      return { handled: true, ok: false, command: 'rivens', text: `读取本机快照失败（${String(error?.message || error)}）。请先启动 AlecaFrame 并过一次加载点。` };
    }
    const { loadRivenTable, getRivenAttrZh, getRivenWeaponDir, getRivenAttrSlug, getVeiledPrices, assembleRivens, assembleRivenDetail, buildRivenListCard, buildRivenDetailCard } = await import('./rivens.mjs');
    const { getLangTable } = await import('./wfdata.mjs');
    const lang = await getLangTable({ alecaDir: snapshot.alecaDir }).catch(() => null);
    const [table, attrZh] = await Promise.all([loadRivenTable(snapshot.alecaDir), getRivenAttrZh()]);
    if (parsed.query) {
      // 详情卡：我的该武器紫卡 × wm 拍卖行情
      const [weaponDir, attrSlug] = await Promise.all([getRivenWeaponDir(), getRivenAttrSlug()]);
      const detail = await assembleRivenDetail(parsed.query, { inventory: snapshot.inventory, table, attrZh, lang, weaponDir, attrSlug });
      if (!detail.found) {
        return { handled: true, ok: false, command: 'rivens', query: parsed.query, text: detail.reason || `库存里没有「${parsed.query}」的紫卡。发「我的紫卡」看列表，再用「紫卡 序号」（如 紫卡 3）或武器名看详情。` };
      }
      // 武器图：wm riven 目录 thumb（渲卡前解析，失败无图降级）
      try {
        if (detail.thumb) {
          const { imageDataUri } = await import('./wfdata.mjs');
          detail.iconDataUri = await imageDataUri(`https://warframe.market/static/assets/${detail.thumb}`);
        }
      } catch { /* 无图降级 */ }
      let mediaUrl = null;
      try { mediaUrl = await renderWarframeCard(buildRivenDetailCard(detail), options.cardDir || process.env.WARFRAME_CARD_DIR); } catch { mediaUrl = null; }
      const est = Array.isArray(detail.market) && detail.market[0]?.estimate ? `参考 ${detail.market[0].estimate.low}~${detail.market[0].estimate.high}p（挂价口径）` : '相似样本不足，未给估价';
      return {
        handled: true, ok: true, command: 'rivens', query: parsed.query, data: detail, mediaUrl,
        followupText: mediaUrl ? '估价为在售挂价口径，成交价通常更低。' : null,
        text: `${detail.weaponZh} 紫卡 ×${detail.rivens.length}；${est}`,
      };
    }
    const data = await assembleRivens({ inventory: snapshot.inventory, table, attrZh, lang });
    // 武器图：wm riven 目录 thumb 逐张解析（已预热本地缓存），拉挂静默无图
    try {
      const [weaponDir, { imageDataUri }] = await Promise.all([getRivenWeaponDir(), import('./wfdata.mjs')]);
      for (const riven of data.opened) {
        const thumb = weaponDir[riven.compat]?.thumb;
        riven.iconDataUri = thumb ? await imageDataUri(`https://warframe.market/static/assets/${thumb}`) : null;
      }
    } catch { /* 无图降级 */ }
    // 未开封价格：wm 普通市场最低在线卖单，拉挂静默无价
    try {
      const prices = await getVeiledPrices(data.veiled.map((v) => v.en));
      for (const v of data.veiled) if (prices[v.en] != null) v.price = prices[v.en];
    } catch { /* 降级无价 */ }
    if (!data.opened.length && !data.veiled.length) {
      return { handled: true, ok: true, command: 'rivens', text: '快照里没有紫卡。' };
    }
    let mediaUrl = null;
    try { mediaUrl = await renderWarframeCard(buildRivenListCard(data), options.cardDir || process.env.WARFRAME_CARD_DIR); } catch { mediaUrl = null; }
    const summary = data.opened.slice(0, 6).map((riven) => `${riven.weaponZh}${riven.god ? '★' : ''}：${riven.attrs.map((attr) => `${attr.zh}${attr.value === null ? '' : ` ${attr.value >= 0 ? '+' : ''}${attr.value.toFixed(1)}%`}`).join('、')}`);
    return {
      handled: true, ok: true, command: 'rivens', query: '', data, mediaUrl,
      followupText: mediaUrl ? '发「紫卡 序号」（如 紫卡 3）或「紫卡 武器名」看行情详情；★=社区神卡词条表命中。' : null,
      text: summary.join('\n') || '仅有未开封紫卡。',
    };
  }
  if (parsed.command === 'rotation-calendar') {
    // 卡主体是排期表；快照只用于「已有」标，读失败照样出卡
    let inventory = null;    try { inventory = (await readSnapshot(options.alecaDir)).inventory; } catch { inventory = null; }
    const { buildRotationCalendar, buildRotationCalendarCard } = await import('./rotation-calendar.mjs');
    const { loadOfficialWorldState } = await import('./vendor-shop.mjs');
    const { loadNameTables } = await import('./weekly.mjs');
    const [worldState, names] = await Promise.all([loadOfficialWorldState().catch(() => null), loadNameTables().catch(() => null)]);
    let data;
    try {
      data = await buildRotationCalendar({ inventory, names, worldState });
    } catch (error) {
      return { handled: true, ok: false, command: 'rotation-calendar', text: `轮换排期数据暂时拉取失败（${String(error?.message || error)}），请稍后重试。` };
    }
    // 回廊战甲小图：AlecaFrame 目录英文名→imageName→CDN（内容哈希缓存，重复战甲零重复下载）；失败无图降级
    try {
      const [{ loadCatalog, defaultAlecaDir }, { imageDataUri }] = await Promise.all([import('./drops.mjs'), import('./wfdata.mjs')]);
      const catalog = await loadCatalog(defaultAlecaDir());
      const byEnglish = new Map();
      for (const meta of catalog.values()) {
        const key = String(meta.englishName || '').toLowerCase().replace(/\s+/gu, '');
        if (key && meta.imageName && !byEnglish.has(key)) byEnglish.set(key, meta.imageName);
      }
      for (const row of data.rows || []) {
        for (const frame of row.frames || []) {
          if (frame.iconDataUri !== undefined) continue;
          const img = byEnglish.get(String(frame.en || '').toLowerCase().replace(/\s+/gu, ''));
          frame.iconDataUri = img ? await imageDataUri(`https://cdn.alecaframe.com/warframeData/img/${img}`) : null;
        }
      }
    } catch { /* 无图降级 */ }
    let mediaUrl = null;
    try { mediaUrl = await renderWarframeCard(buildRotationCalendarCard(data), options.cardDir || process.env.WARFRAME_CARD_DIR); } catch { mediaUrl = null; }
    const lines = data.rows.slice(0, 4).map((row) => `${new Date(row.startMs).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })}：回廊 ${row.frames.map((frame) => frame.zh).join('/')}｜泰辛 ${row.teshin}${row.varzia ? `｜瓦奇娅换期 ${row.varzia.label}` : ''}`);
    return {
      handled: true, ok: true, command: 'rotation-calendar', query: '', data, mediaUrl,
      followupText: mediaUrl ? '发「订阅 轮换 名字」到期提醒一次（自动取消）；战甲用英文名如 Saryn。' : null,
      text: lines.join('\n'),
    };
  }
  if (parsed.command === 'weekly-deals') {
    // 与周一订阅推送同一条装配链（buildWeeklyDeals）；快照只用于已购标，读失败降级无标照常出卡
    let inventory = null;
    try { inventory = (await readSnapshot(options.alecaDir)).inventory; } catch { inventory = null; }
    const shop = await import('./vendor-shop.mjs');
    const { buildWeeklyDealsCard } = await import('./vendor-shop-card.mjs');
    const context = await shop.loadShopContext({ inventory });
    const deals = await shop.buildWeeklyDeals(context);
    if (!deals.sections.length && !deals.varzia) {
      return { handled: true, ok: false, command: 'weekly-deals', query: '', text: '本周好货暂时装配不出来（数据源不可用），发「商店」看全商人总览。' };
    }
    let mediaUrl = null;
    try { mediaUrl = await renderWarframeCard(buildWeeklyDealsCard(deals), options.cardDir || process.env.WARFRAME_CARD_DIR); } catch { mediaUrl = null; }
    const lines = deals.sections.map((section) => `${section.vendorZh}：${section.rows.map((row) => `${row.tier === 'T0' ? '【必抢】' : ''}${row.name}${row.mark === 'bought' ? '（已购）' : ''}`).join('、')}`);
    if (deals.varzia) lines.push(`瓦奇娅当期：${deals.varzia.summary}`);
    return {
      handled: true, ok: true, command: 'weekly-deals', query: '', data: deals, mediaUrl,
      followupText: mediaUrl ? '发「商店 序号」看单家完整货单；「订阅 周常」每周一自动推这张卡。' : null,
      text: lines.join('\n'),
    };
  }
  if (parsed.command === 'shop') {
    // 商店卡主体是世界数据；快照只用于已购标注，读失败照样出卡（诚实降级：无已购标）
    let inventory = null;
    try { inventory = (await readSnapshot(options.alecaDir)).inventory; } catch { inventory = null; }
    const { loadShopContext, resolveVendorAlias, buildShopOverview, buildVendorDetail, buildVarziaDetail, buildDarvoDetail } = await import('./vendor-shop.mjs');
    const { buildShopOverviewCard, buildVendorDetailCard, buildVarziaCard, buildDarvoCard } = await import('./vendor-shop-card.mjs');
    const context = await loadShopContext();
    context.inventory = inventory;
    let card = null;
    let data = null;
    let text = '';
    if (parsed.query) {
      const alias = resolveVendorAlias(parsed.query);
      if (!alias) {
        return { handled: true, ok: false, command: 'shop', query: parsed.query, text: `没找到商人「${parsed.query}」。发「商店」看总览，再用「商店 序号」（如 商店 1）或商人名看详情。` };
      }
      if (alias.key === 'varzia') {
        data = buildVarziaDetail(context.worldState, context.names);
        card = data ? buildVarziaCard(data) : null;
        text = data ? `瓦奇娅当期 ${data.current.length} 件，下期：${data.next?.featured || '未知'}` : '瓦奇娅货单获取失败（可能在接档期）';
      } else if (alias.key === 'darvo') {
        data = buildDarvoDetail(context.worldState, context.names);
        card = data ? buildDarvoCard(data) : null;
        text = data ? `达尔沃特惠：${data.deals.map((deal) => `${deal.name} -${deal.discount}%`).join('、')}` : '达尔沃特惠获取失败';
      } else {
        data = await buildVendorDetail(alias.key, context);
        if (data) {
          // 行内物品图：三层链并发解析，失败无图降级
          const { attachRowIcons } = await import('./vendor-shop.mjs');
          try { await attachRowIcons([...data.rotating, ...data.evergreen, ...data.pool], { alecaDir: options.alecaDir }); } catch { /* 无图降级 */ }
        }
        card = data ? buildVendorDetailCard(data) : null;
        text = data ? `${data.zhName}：本期轮换 ${data.rotating.length} 件 / 常驻 ${data.evergreen.length} 件 / 候选池 ${data.pool.length} 件` : '货单获取失败';
      }
      if (!data) return { handled: true, ok: false, command: 'shop', query: parsed.query, text };
    } else {
      data = await buildShopOverview(context);
      card = buildShopOverviewCard(data);
      text = data.rows.map((row, index) => `${index + 1}. ${row.zhName}：${row.summary}${row.bought ? `（已购 ${row.bought.total} 件）` : ''}`).join('\n');
    }
    let mediaUrl = null;
    try { mediaUrl = await renderWarframeCard(card, options.cardDir || process.env.WARFRAME_CARD_DIR); } catch { mediaUrl = null; }
    return {
      handled: true, ok: true, command: 'shop', query: parsed.query, data, mediaUrl,
      followupText: mediaUrl && !parsed.query ? '发「商店 序号」（如 商店 1）或「商店 商人名」看完整货单；「哪里买 物品名」反查货源。' : null,
      text,
    };
  }
  const snapshot = await readSnapshot(options.alecaDir);
  if (parsed.command === 'ducat-plan') {
    const { parseDucatSpec, buildDucatPlan, formatDucatPlan } = await import('./ducat-planner.mjs');
    const spec = parseDucatSpec(parsed.query);
    const entries = await assembleInventoryValuation(snapshot);
    const data = await buildDucatPlan(entries, spec, { syncedAt: snapshot.syncedAt, ...(options.ducatOptions || {}) });
    // 行内物品图沿用库存卡三层链；只给实际方案行拉图，避免清仓扫描打爆素材源
    try {
      const [{ imageDataUri, gameIconDataUri, primeWarframePartIconDataUri }, drops] = await Promise.all([import('./wfdata.mjs'), import('./drops.mjs')]);
      let slugs = null;
      try { slugs = await drops.marketSlugMap(); } catch { slugs = null; }
      let catalog = null;
      for (const row of (data.rows || []).slice(0, 15)) {
        const wmEntry = slugs ? drops.findMarketEntry(slugs, row.englishName) : null;
        row.iconDataUri = await primeWarframePartIconDataUri(row.uniqueName, row.englishName);
        if (!row.iconDataUri && wmEntry?.thumb) row.iconDataUri = await imageDataUri(`https://warframe.market/static/assets/${wmEntry.thumb}`);
        if (!row.iconDataUri) row.iconDataUri = await gameIconDataUri(row.uniqueName);
        if (!row.iconDataUri) {
          catalog ??= await drops.loadCatalog(snapshot.alecaDir).catch(() => new Map());
          const meta = catalog.get(row.uniqueName);
          if (meta?.imageName) row.iconDataUri = await imageDataUri(`https://cdn.alecaframe.com/warframeData/img/${meta.imageName}`);
        }
      }
    } catch { /* 无图降级 */ }
    try {
      const { gameIconDataUri } = await import('./wfdata.mjs');
      data.glyphDataUri = await gameIconDataUri(snapshot.inventory.ActiveAvatarImageType) || null;
    } catch { data.glyphDataUri = null; }
    let mediaUrl = null;
    try {
      const { buildDucatPlanCard } = await import('./warframe-cards.mjs');
      mediaUrl = await renderWarframeCard(buildDucatPlanCard(data), options.cardDir || process.env.WARFRAME_CARD_DIR);
    } catch { mediaUrl = null; }
    return {
      handled: true, ok: data.ok, command: 'ducat-plan', query: parsed.query, data, mediaUrl,
      followupText: mediaUrl ? '按当前在线卖单优先、近日成交均价兜底估算；仅提供兑换建议，不会修改库存。' : null,
      text: formatDucatPlan(data),
    };
  }
  if (parsed.command === 'trader-shopping') {
    const { traderShopping, formatTraderShopping } = await import('./trader-shopping.mjs');
    let inventoryValuation = null;
    try { inventoryValuation = await assembleInventoryValuation(snapshot); } catch { inventoryValuation = null; }
    // 官方源只给路径无英文名：lang 表中文名兑付（读不到静默降级，wm 目录中文名仍可匹配）
    let zhOf = null;
    try {
      const { getLangTable } = await import('./wfdata.mjs');
      const lang = await getLangTable({ alecaDir: snapshot.alecaDir });
      zhOf = (uniq) => lang[uniq]?.zh?.name || null;
    } catch { zhOf = null; }
    const data = await traderShopping(snapshot.inventory, {
      alecaDir: snapshot.alecaDir,
      ...(inventoryValuation ? { inventoryValuation } : {}),
      ...(zhOf ? { zhOf } : {}),
      ...(options.traderOptions || {}),
    });
    // 未到货时购物建议无意义：回退虚空商人查询卡（到达时间+地点信息量更大；2026-08-06 用户拍板并入方案）
    if (data.ok && !data.arrived && !options.traderOptions) {
      try {
        const { queryIntel } = await import('./subscriptions.mjs');
        const intel = await queryIntel('trader', options.cardDir || process.env.WARFRAME_CARD_DIR);
        if (intel.ok && intel.mediaUrl) {
          return {
            handled: true, ok: true, command: 'trader-shopping', query: '', data: intel,
            mediaUrl: intel.mediaUrl,
            followupText: '奸商尚未到货；到货后同一命令会附购物建议。',
            text: intel.text,
          };
        }
      } catch { /* 回退失败继续走购物卡（未到货态） */ }
    }
    // 物品图降级链（用户定）：wm 素材 → browse.wf 游戏原图 → 本机目录插画；失败无图降级
    try {
      const [{ loadCatalog }, { imageDataUri, gameIconDataUri, primeWarframePartIconDataUri }] = await Promise.all([import('./drops.mjs'), import('./wfdata.mjs')]);
      const catalog = await loadCatalog(snapshot.alecaDir).catch(() => new Map());
      await Promise.all((data.rows || []).map(async (row) => {
        row.iconDataUri = await primeWarframePartIconDataUri(row.uniqueName, row.englishName);
        if (!row.iconDataUri && row.wmThumb) row.iconDataUri = await imageDataUri(`https://warframe.market/static/assets/${row.wmThumb}`);
        if (!row.iconDataUri) row.iconDataUri = await gameIconDataUri(row.uniqueName);
        const meta = catalog.get(row.uniqueName);
        if (!row.iconDataUri && meta?.imageName) row.iconDataUri = await imageDataUri(`https://cdn.alecaframe.com/warframeData/img/${meta.imageName}`);
      }));
    } catch { /* 无图降级 */ }
    let mediaUrl = null;
    try {
      const { buildTraderShoppingCard } = await import('./warframe-cards.mjs');
      mediaUrl = await renderWarframeCard(buildTraderShoppingCard(data), options.cardDir || process.env.WARFRAME_CARD_DIR);
    } catch { mediaUrl = null; }
    return {
      handled: true, ok: data.ok, command: 'trader-shopping', query: '', data, mediaUrl,
      followupText: mediaUrl ? '按当前杜卡德余额比较“补足杜卡德的部件机会成本＋奸商现金”与“0 级市场价＋准确交易税”；仅供参考。' : null,
      text: formatTraderShopping(data),
    };
  }
  if (parsed.command === 'recommend') {
    const { recommendFissures, formatRecommend, parseFissurePreference, FISSURE_PREFERENCES } = await import('./recommend.mjs');
    const relics = await loadRelics(snapshot);
    // 杜卡德/金币/ducat → 赚杜卡德；单人/solo → squad 1，默认 4 人组队（对齐 AlecaFrame）
    const mode = /杜卡德|金币|ducat/iu.test(parsed.query) ? 'ducat' : 'plat';
    const squad = parseSquad(parsed.query);
    const preference = parseFissurePreference(parsed.query);
    const data = await recommendFissures(relics, { mode, squad, preference, alecaDir: snapshot.alecaDir, ...(options.recommendOptions || {}) });
    let mediaUrl = null;
    try {
      const { buildFissureRecommendCard } = await import('./warframe-cards.mjs');
      mediaUrl = await renderWarframeCard(buildFissureRecommendCard(data), options.cardDir || process.env.WARFRAME_CARD_DIR);
    } catch { mediaUrl = null; }
    return {
      handled: true, ok: data.ok, command: 'recommend', query: parsed.query, data, mediaUrl,
      followupText: mediaUrl ? `当前为${mode === 'ducat' ? '赚杜卡德' : '赚白金'}·${FISSURE_PREFERENCES[preference].zh}·${squad > 1 ? `${squad}人组队` : '单人'}口径；可组合「裂缝推荐 杜卡德 速刷」「裂缝推荐 白金 舒适」「裂缝推荐 收益」。` : null,
      text: formatRecommend(data),
    };
  }
  if (parsed.command === 'refine') {
    const { recommendRefinement, formatRefineRecommend } = await import('./recommend.mjs');
    const relics = await loadRelics(snapshot);
    const mode = /杜卡德|金币|ducat/iu.test(parsed.query) ? 'ducat' : 'plat';
    const squad = parseSquad(parsed.query);
    const data = await recommendRefinement(relics, { mode, squad, alecaDir: snapshot.alecaDir, ...(options.refineOptions || {}) });
    let mediaUrl = null;
    try {
      const { buildRefineRecommendCard } = await import('./warframe-cards.mjs');
      mediaUrl = await renderWarframeCard(buildRefineRecommendCard(data), options.cardDir || process.env.WARFRAME_CARD_DIR);
    } catch { mediaUrl = null; }
    return {
      handled: true, ok: data.ok, command: 'refine', query: parsed.query, data, mediaUrl,
      followupText: mediaUrl ? `增益 = 光辉相对完整的期望提升（每 100 光体，${squad > 1 ? `${squad}人组队` : '单人'}口径）；可发「精炼推荐 单人」「精炼推荐 杜卡德」切换。` : null,
      text: formatRefineRecommend(data),
    };
  }
  const result = parsed.command === 'account' ? await accountSummary(snapshot)
    : parsed.command === 'relic' ? await relicQuery(snapshot, parsed.query)
      : parsed.command === 'arcane' ? await arcaneQuery(snapshot, parsed.query)
        : parsed.command === 'weekly' ? await weeklyEvidence(snapshot)
          : await inventoryQuery(snapshot, parsed.query);
  // 行内物品图：遗物行用本地纪元素材；其余走三层链 wm thumb → browse.wf → AlecaFrame 插画；失败无图降级
  try {
    const iconRows = (result.data.rows || []).filter((row) => row.era || row.uniqueName);
    if (result.data.kind === 'inventory' && iconRows.length) {
      const [{ RELIC_ICON_DATA }, { imageDataUri, gameIconDataUri, primeWarframePartIconDataUri }, drops] = await Promise.all([
        import('./warframe-cards.mjs'), import('./wfdata.mjs'), import('./drops.mjs'),
      ]);
      let slugs = null;
      try { slugs = await drops.marketSlugMap(); } catch { slugs = null; }
      let catalog = null;
      for (const row of iconRows) {
        if (row.era) { row.iconDataUri = RELIC_ICON_DATA[row.era] || null; continue; }
        const wmEntry = slugs ? drops.findMarketEntry(slugs, row.englishName) : null;
        row.iconDataUri = await primeWarframePartIconDataUri(row.uniqueName, row.englishName);
        if (!row.iconDataUri && wmEntry?.thumb) row.iconDataUri = await imageDataUri(`https://warframe.market/static/assets/${wmEntry.thumb}`);
        if (!row.iconDataUri) row.iconDataUri = await gameIconDataUri(row.uniqueName);
        if (!row.iconDataUri) {
          catalog ??= await drops.loadCatalog(snapshot.alecaDir).catch(() => new Map());
          const meta = catalog.get(row.uniqueName);
          if (meta?.imageName) row.iconDataUri = await imageDataUri(`https://cdn.alecaframe.com/warframeData/img/${meta.imageName}`);
        }
      }
    }
  } catch { /* 无图降级 */ }
  let mediaUrl = null;
  try {
    // 玩家浮印头图（glyph，2026-08-06 用户拍板三卡全接）：快照 ActiveAvatarImageType → browse.wf 游戏原图；失败退原 SVG
    try {
      const { gameIconDataUri } = await import('./wfdata.mjs');
      result.data.glyphDataUri = await gameIconDataUri(snapshot.inventory.ActiveAvatarImageType) || null;
    } catch { result.data.glyphDataUri = null; }
    const card = result.data.kind === 'account' ? buildAccountSnapshotCard(result.data) : buildInventorySnapshotCard(result.data);
    mediaUrl = await renderWarframeCard(card, options.cardDir || process.env.WARFRAME_CARD_DIR);
  } catch {
    mediaUrl = null;
  }
  return {
    handled: true,
    ok: true,
    command: parsed.command,
    query: parsed.query,
    data: result.data,
    mediaUrl,
    followupText: mediaUrl ? '数据来自本机账号快照；进入任务、中继站或道场后才会刷新。' : null,
    text: result.text,
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'parse') {
      out(await runAlecaMessage(rest.join(' ')));
      return;
    }
    out({ handled: false, ok: false, error: '用法：parse <我的账号|我的库存|我的遗物|我的赋能|杜卡德|奸商推荐|账号周常>' });
    process.exitCode = 1;
  } catch (error) {
    out({ handled: true, ok: false, error: String(error?.message || error), text: `账号快照读取失败：${String(error?.message || error)}` });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
