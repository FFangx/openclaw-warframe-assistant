// 商人轮换货单本地复现 —— 行为对齐游戏客户端的种子算法（参考 OpenWF SpaceNinjaServer 的公开行为描述，代码独立实现）
// 原理：货单不是服务器私有状态，而是 种子(商人类型名哈希) × 周期号(时间) 的确定性函数，可复现也可预测未来。
// ⚠ 本模块所有 RNG 消费顺序都必须与游戏一致（目标数量→选品→逐件价格），改动任何一处都会从该点起全部错位。

const DEFAULT_CYCLE_OFFSET = 1734307200_000; // 游戏全局轮换锚点（2024-12-16 00:00 UTC）
const HOUR = 3600_000;
const WEEK = 168 * HOUR;

// FNV1a-32 变体：全程截断在 2^31 内（与游戏端一致；乘法在 JS double 下的精度行为也是协议的一部分，不可"修正"）
export function catBreadHash(name) {
  let hash = 2166136261;
  for (let i = 0; i !== name.length; ++i) {
    hash = (hash ^ name.charCodeAt(i)) & 0x7fffffff;
    hash = (hash * 16777619) & 0x7fffffff;
  }
  return hash;
}

// 两个 32 位种子混合（xorshift；JS 的 << 35 实际是 << 3，这个"怪癖"同样是协议的一部分）
export function mixSeeds(seed1, seed2) {
  let seed = seed1 ^ seed2;
  seed ^= seed >>> 21;
  seed ^= seed << 35;
  seed ^= seed >>> 4;
  return seed >>> 0;
}

// 与游戏客户端逐位一致的 LCG（Knuth 常数，64 位状态）
export class SRng {
  constructor(seed) { this.state = BigInt(seed); }
  #next() { this.state = (0x5851f42d4c957f2dn * this.state + 0x14057b7ef767814fn) & 0xffffffffffffffffn; }
  randomInt(min, max) {
    const diff = max - min;
    if (diff !== 0) {
      this.#next();
      min += (Number(this.state >> 32n) & 0x3fffffff) % (diff + 1);
    }
    return min;
  }
  randomFloat() {
    this.#next();
    return (Number(this.state >> 38n) & 0xffffff) * 0.000000059604645;
  }
  randomElement(arr) { return arr[this.randomInt(0, arr.length - 1)]; }
  randomReward(pool) {
    // 加权抽取：randomFloat 定位在累计概率轴上
    if (!pool.length) return undefined;
    const total = pool.reduce((sum, item) => sum + item.probability, 0);
    const target = this.randomFloat() * total;
    let cumulative = 0;
    for (const item of pool) {
      cumulative += item.probability;
      if (target <= cumulative) return item;
    }
    return pool[pool.length - 1];
  }
}

const toRange = (value) => (typeof value === 'number' ? { minValue: value, maxValue: value } : value);
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// 轮换周期 = 非常驻条目 durationHours 的最大公约数；range 型（时长本身随机）直接判 1 小时
export function cycleDurationOf(manifest) {
  let dur = 0;
  for (const item of manifest.items) {
    if (item.alwaysOffered) continue;
    const hours = item.rotatedWeekly ? 168 : item.durationHours;
    if (typeof hours !== 'number') { dur = 1; break; }
    if (dur !== hours) dur = gcd(dur, hours);
  }
  return dur * HOUR;
}

// 条目身份键：容量约束按它去重
const offerId = (item) => {
  let id = `${item.storeItem}x${item.quantity}`;
  if (item.itemPrices?.length) id += `:${item.itemPrices[0].ItemType}`;
  return id;
};

/**
 * 重放式生成商人当前货单。
 * 语义：从(最长时长-1)小时前开始，逐小时推进虚拟时钟——删过期条目、用当轮种子补齐空位——直到库存的最早过期时间越过真实 now。
 * @returns {{ offers: Array, generatedAt: number }} offers 含 expiry(ms)/价格；顺序与游戏内一致
 */
export function generateVendorOffers(typeName, manifest, { now = Date.now(), cycleOffset = DEFAULT_CYCLE_OFFSET } = {}) {
  const vendorSeed = catBreadHash(typeName);
  const cycleDuration = cycleDurationOf(manifest);
  if (!cycleDuration) throw new Error(`manifest 无轮换条目: ${typeName}`);

  // 起点回拨：条目时长不齐时（如 1~168h 混合），要从最长时长前开始重放才能还原尚未过期的旧条目
  const durRange = (() => {
    const res = { minValue: Number.MAX_SAFE_INTEGER, maxValue: 0 };
    for (const item of manifest.items) {
      if (!item.durationHours) continue;
      const r = toRange(item.durationHours);
      res.minValue = Math.min(res.minValue, r.minValue);
      res.maxValue = Math.max(res.maxValue, r.maxValue);
    }
    return res.maxValue ? res : undefined;
  })();
  let clock = now;
  if (durRange && durRange.minValue !== durRange.maxValue) clock -= (durRange.maxValue - 1) * HOUR;

  const live = []; // 当前货架 { raw, expiry, bin }
  let guard = 0;
  let soonestExpiry = 0;
  while (now >= soonestExpiry) {
    if (++guard > 20000) throw new Error('重放循环超出安全上限');
    // 1) 删过期
    for (let i = 0; i !== live.length;) {
      if (clock >= live[i].expiry) live.splice(i, 1);
      else ++i;
    }
    // 2) 当轮种子
    const cycleIndex = Math.trunc((clock - cycleOffset) / cycleDuration);
    const rng = new SRng(mixSeeds(vendorSeed, cycleIndex));
    const cycleStart = cycleOffset + cycleIndex * cycleDuration;
    // 3) 容量与 bin 需求（先扣除货架上已有的）
    const capacity = {};
    for (const item of manifest.items) capacity[offerId(item)] = 1 + (item.duplicates || 0);
    const missingPerBin = {};
    let needBinMatches = 0;
    if (manifest.numItemsPerBin) {
      manifest.numItemsPerBin.forEach((n, bin) => { missingPerBin[bin] = n; needBinMatches += n; });
    }
    for (const entry of live) {
      capacity[offerId(entry.raw)] -= 1;
      if (missingPerBin[entry.bin]) { missingPerBin[entry.bin] -= 1; needBinMatches -= 1; }
    }
    // 4) 常驻条目优先入位
    const toAdd = [];
    let insertAt = 0;
    let uncounted = 0, counted = 0;
    for (const item of manifest.items) {
      if (item.alwaysOffered || item.rotatedWeekly) {
        ++uncounted;
        const id = offerId(item);
        if (capacity[id] !== 0) { capacity[id] -= 1; toAdd.push(item); ++insertAt; }
        if (missingPerBin[item.bin]) { missingPerBin[item.bin] -= 1; needBinMatches -= 1; }
      } else {
        counted += 1 + (item.duplicates || 0);
      }
    }
    // 5) 随机条目补齐到目标数量（rng 消费点①：目标数量本身）
    const useRng = manifest.numItems
      && (manifest.numItems.minValue !== manifest.numItems.maxValue || manifest.numItems.minValue !== counted);
    const remainingCapacity = Object.values(capacity).reduce((a, b) => a + b, 0);
    const target = manifest.numItems
      ? uncounted + Math.min(remainingCapacity, useRng ? rng.randomInt(manifest.numItems.minValue, manifest.numItems.maxValue) : manifest.numItems.minValue)
      : manifest.items.length;
    const rollable = manifest.items.filter((item) => item.probability !== undefined);
    let seq = 0;
    while (live.length + toAdd.length < target) {
      if (++guard > 20000) throw new Error('选品循环超出安全上限');
      // rng 消费点②：每次抽取都消费，即使因容量/bin 不符被丢弃
      const item = useRng ? rng.randomReward(rollable) : rollable[seq++];
      const id = offerId(item);
      if (capacity[id] !== 0 && (needBinMatches === 0 || missingPerBin[item.bin])) {
        capacity[id] -= 1;
        if (missingPerBin[item.bin]) { missingPerBin[item.bin] -= 1; needBinMatches -= 1; }
        toAdd.splice(insertAt, 0, item); // 常驻之后倒序插入——顺序影响下面价格 rng 的消费次序
      }
      if (seq === rollable.length) seq = 0;
    }
    // 6) 逐件定过期与价格（rng 消费点③④⑤⑥，顺序不可变）
    for (const raw of toAdd) {
      const durHours = toRange(raw.durationHours ?? cycleDuration / HOUR);
      const expiry = raw.alwaysOffered
        ? 2051240400_000
        : cycleStart + (raw.rotatedWeekly ? WEEK : rng.randomInt(durHours.minValue, durHours.maxValue) * HOUR);
      rng.randomInt(0, 0xffff_ffff); // 条目 Id 低位——不需要值但必须消费
      const entry = { raw, bin: raw.bin, expiry, itemPrices: raw.itemPrices ? raw.itemPrices.map((p) => ({ ...p })) : undefined, credits: undefined, platinum: undefined };
      if (raw.numRandomItemPrices) {
        entry.itemPrices ??= [];
        for (let i = 0; i !== raw.numRandomItemPrices; ++i) {
          let price;
          do { price = rng.randomElement(manifest.randomItemPricesPerBin[raw.bin]); }
          while (entry.itemPrices.find((p) => p.ItemType === price.type));
          entry.itemPrices.push({ ItemType: price.type, ItemCount: rng.randomInt(price.count.minValue, price.count.maxValue) });
        }
      }
      if (raw.credits) {
        entry.credits = typeof raw.credits === 'number'
          ? raw.credits
          : rng.randomInt(raw.credits.minValue / raw.credits.step, raw.credits.maxValue / raw.credits.step) * raw.credits.step;
      }
      if (raw.platinum) {
        entry.platinum = typeof raw.platinum === 'number'
          ? raw.platinum
          : rng.randomInt(raw.platinum.minValue, raw.platinum.maxValue);
      }
      live.push(entry);
    }
    // 7) 货架最早过期时间 = 下一轮触发点；虚拟时钟推进 1 小时
    soonestExpiry = Number.MAX_SAFE_INTEGER;
    for (const entry of live) soonestExpiry = Math.min(soonestExpiry, entry.expiry);
    clock += HOUR;
  }

  return {
    offers: live.map((entry) => ({
      storeItem: entry.raw.storeItem,
      quantity: entry.raw.quantity,
      bin: entry.raw.bin,
      alwaysOffered: !!entry.raw.alwaysOffered,
      rotatedWeekly: !!entry.raw.rotatedWeekly,
      purchaseLimit: entry.raw.purchaseLimit,
      expiry: entry.expiry,
      itemPrices: entry.itemPrices,
      credits: entry.credits,
      platinum: entry.platinum,
    })),
    generatedAt: now,
  };
}
