#!/usr/bin/env node
// 一次性构建工具：生成 baro-static.json
// 奸商商品的 tradingTax/description 是不变信息 → 收录成本地清单，
// 运行时不再对每个商品打 /v2/item/{slug} 详情（仅清单外商品在线兜底）。
// 用法：在仓库根目录运行 node tools/build-baro-static.mjs
// 输出 skill/scripts/baro-static.json。
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://api.warframe.market';
const HEADERS = { Platform: 'pc', Crossplay: 'true', Language: 'zh-hans' };

const catalogRes = await fetch(`${BASE}/v2/items`, { headers: HEADERS });
const catalog = (await catalogRes.json())?.data ?? [];
const slugs = new Set(catalog.filter((item) => item.slug?.startsWith('primed_')).map((item) => item.slug));
// 历次 Baro 货单常见武器/普通 Mod（无 primed_ 前缀）
for (const slug of [
  'machete_wraith', 'fusion_dual_cleavers', 'crimson_storm', 'heavy_impact', 'tectonic_force',
  'telos_prova', 'mara_detonator', 'twin_basolk', 'prova_vandal', 'gorgon_wraith',
]) slugs.add(slug);

const list = [...slugs].sort();
const results = {};
let ok = 0, missing = 0, failed = 0;
let cursor = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchOne = async (slug) => {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${BASE}/v2/item/${slug}`, { headers: HEADERS });
      if (res.status === 404) return 'missing';
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * attempt); continue; }
      if (!res.ok) return 'failed';
      const data = (await res.json())?.data;
      const tax = Number(data?.tradingTax);
      const desc = data?.i18n?.['zh-hans']?.description ?? null;
      results[slug] = { tax: Number.isFinite(tax) && tax > 0 ? tax : null, desc };
      return 'ok';
    } catch {
      await sleep(1000 * attempt);
    }
  }
  return 'failed';
};
const workers = Array.from({ length: 3 }, async () => {
  while (cursor < list.length) {
    const slug = list[cursor++];
    const outcome = await fetchOne(slug);
    if (outcome === 'ok') ok++;
    else if (outcome === 'missing') missing++;
    else failed++;
  }
});
await Promise.all(workers);
const out = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: 'Warframe.Market /v2/item/{slug} (i18n zh-hans description + tradingTax), one-time build',
  items: results,
};
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(repoRoot, 'skill', 'scripts', 'baro-static.json');
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`slugs=${list.length} ok=${ok} missing404=${missing} failed=${failed}`);
console.log('written:', target);
