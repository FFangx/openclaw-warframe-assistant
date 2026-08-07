#!/usr/bin/env node

// 物品图预热：把 wm 全目录实际展示图一次性下载进磁盘缓存（item-images/）。
// 部件优先 subIcon；主蓝图的通用蓝图纸不采用，继续预热成品 thumb。
// 幂等：已缓存跳过；DE 更新出新物品后重跑即增量补齐。
// 用法：node prefetch-icons.mjs [--limit N]（--limit 用于小批量试跑）
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marketDisplayImagePath } from './drops.mjs';

const DATA_CACHE_DIR = process.env.WARFRAME_DATA_CACHE_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.cache', 'warframe-data');
const IMAGE_DIR = path.join(DATA_CACHE_DIR, 'item-images');
const CONCURRENCY = 4; // 静态 CDN 温和限流，别打狠

const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const items = (await (await fetch('https://api.warframe.market/v2/items', {
  headers: { Platform: 'pc', Crossplay: 'true' }, signal: AbortSignal.timeout(30_000),
})).json()).data || [];

await mkdir(IMAGE_DIR, { recursive: true });
const existing = new Set(await readdir(IMAGE_DIR));
const wanted = items
  .map((item) => marketDisplayImagePath(item?.i18n?.en))
  .filter(Boolean)
  .map((imagePath) => ({ imagePath, file: imagePath.split('/').at(-1).replace(/[^\w.-]/gu, '_').slice(-80) }))
  .filter(({ file }) => !existing.has(file))
  .slice(0, limit);

console.log(`目录 ${items.length} 项，已缓存 ${existing.size} 张，本次需下载 ${wanted.length} 张`);

let done = 0; let failed = 0; let bytes = 0; let index = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (index < wanted.length) {
    const { imagePath, file } = wanted[index]; index += 1;
    try {
      const response = await fetch(`https://warframe.market/static/assets/${imagePath}`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) { failed += 1; continue; }
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(path.join(IMAGE_DIR, file), buffer);
      bytes += buffer.length; done += 1;
      if (done % 200 === 0) console.log(`…${done}/${wanted.length}（${Math.round(bytes / 1048576)}MB）`);
    } catch { failed += 1; }
  }
}));
console.log(`完成：下载 ${done} 张（${Math.round(bytes / 1048576)}MB），失败 ${failed} 张（重跑可补）`);
