// 只读查询：监控列表、某一期各地区价格、单个商品的价格走势、改价/活动事件。供 mcp.mjs 使用。
// 价格口径：listPrice 标价、display 页面展示价、real 剔除新人补贴后的参考价（推导值）。
// 买家号是新号；运费、税费、购买数量等条件没有采集，所以这些都是「参考商品价」，不是到手价。

export const PRICE_NOTE = '价格是速卖通搜索页给店铺买家号看到的参考商品价：list_price 标价、display_price 页面展示价、'
  + 'real_price 剔除新人补贴后的参考价（推导值）。买家号是新号；运费、税费、购买数量等条件没有采集，不能当到手价。'
  + 'sold 是页面显示的销量（估算）。图搜结果每次会变，某个商品没出现不等于下架。';

export const EVENT_TYPES = ['price-change', 'list-raise', 'activity-start', 'activity-end', 'activity-change', 'early-bird'];

const DAY = 86_400_000;
const SORTS = new Set(['rank', 'price', 'sold']);

export class QueryError extends Error {}

// 北京时间，便于业务员阅读；同时保留毫秒时间戳方便再查。
export const localTime = (ts) => (ts ? new Date(ts).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : null);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const v = sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  return Math.round(v * 100) / 100;
}

function itemView(item) {
  return {
    rank: item.rank ?? null,
    product_id: String(item.productId ?? ''),
    sku_id: item.skuId ? String(item.skuId) : null,
    title: typeof item.title === 'string' ? item.title.slice(0, 120) : '',
    url: item.url || null,
    currency: item.currency || null,
    list_price: num(item.listPrice),
    display_price: num(item.display),
    real_price: num(item.real),
    activity_pct: num(item.activityPct) ?? 0,
    new_user_subsidy: num(item.newUserSubsidy),
    choice: Boolean(item.isChoice),
    sold: num(item.sold),
    star: num(item.star),
    tax_mode: item.taxMode || null,
  };
}

function regionStats(items) {
  const prices = items.map((i) => num(i.real)).filter((v) => v !== null && v > 0).sort((a, b) => a - b);
  return {
    items: items.length,
    currency: items.find((i) => i.currency)?.currency ?? null,
    real_price: { min: quantile(prices, 0), p25: quantile(prices, 0.25), median: quantile(prices, 0.5), p75: quantile(prices, 0.75), max: quantile(prices, 1) },
    with_activity: items.filter((i) => (num(i.activityPct) ?? 0) > 0).length,
    choice: items.filter((i) => i.isChoice).length,
  };
}

const SORTERS = {
  rank: (a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9),
  price: (a, b) => (num(a.real) ?? 1e12) - (num(b.real) ?? 1e12),
  sold: (a, b) => (num(b.sold) ?? -1) - (num(a.sold) ?? -1),
};

/** 各地区的价格分布 + 排在前面的商品；图搜工具和 ae_latest 共用 */
export function summarizeRegions(results, { regions = Object.keys(results), limit = 10, sort = 'rank' } = {}) {
  if (!SORTS.has(sort)) throw new QueryError('sort 只能是 rank、price 或 sold。');
  const out = {};
  for (const code of regions) {
    const items = results[code]?.items ?? [];
    out[code] = { ...regionStats(items), top: [...items].sort(SORTERS[sort]).slice(0, limit).map(itemView) };
  }
  return out;
}

export async function listWatches(store) {
  const watches = await store.listWatches();
  return Promise.all(watches.map(async (w) => {
    const index = await store.listSnapshots(w.id);
    const last = index.at(-1);
    return {
      id: w.id, name: w.name, store_id: w.storeId, regions: w.regions, interval_min: w.intervalMin, enabled: Boolean(w.enabled),
      last_run: localTime(w.lastRunAt), last_status: w.lastStatus || null, last_error: w.lastError || null,
      snapshots_kept: index.length,
      latest_snapshot: last ? { ts: last.ts, time: localTime(last.ts), regions_captured: Object.keys(last.summary ?? {}) } : null,
    };
  }));
}

// 按 ID 或名称找监控；只有一个监控时可以不填。
export async function resolveWatch(store, ref) {
  const watches = await store.listWatches();
  if (!watches.length) throw new QueryError('还没有任何监控任务。');
  if (!ref) {
    if (watches.length === 1) return watches[0];
    throw new QueryError(`有 ${watches.length} 个监控，请用 watch 参数指定：${watches.map((w) => `${w.name}（${w.id}）`).join('、')}`);
  }
  const found = watches.find((w) => w.id === ref) ?? watches.find((w) => w.name === ref);
  if (!found) throw new QueryError(`没有找到监控「${ref}」；现有：${watches.map((w) => `${w.name}（${w.id}）`).join('、')}`);
  return found;
}

// 快照文件超过 300 份会被轮换删除：读不到时返回 null，由调用方决定跳过还是报错。
async function readSnapshot(store, id, ts) {
  try {
    return await store.loadSnapshot(id, ts);
  } catch {
    return null;
  }
}

async function pickSnapshot(store, watch, ts) {
  const index = await store.listSnapshots(watch.id);
  if (!index.length) throw new QueryError(`监控「${watch.name}」还没有快照。`);
  const entry = ts ? index.find((s) => s.ts === ts) : index.at(-1);
  if (!entry) throw new QueryError(`监控「${watch.name}」没有时间戳为 ${ts} 的快照；可用最早 ${index[0].ts}、最新 ${index.at(-1).ts}。`);
  const results = await readSnapshot(store, watch.id, entry.ts);
  if (!results) throw new QueryError(`快照 ${entry.ts} 文件已被清理（每个监控只保留最近 300 份）。`);
  return { ts: entry.ts, results };
}

export async function latestPrices(store, watch, { region, limit = 10, sort = 'rank', snapshotTs } = {}) {
  if (!SORTS.has(sort)) throw new QueryError('sort 只能是 rank、price 或 sold。');
  const { ts, results } = await pickSnapshot(store, watch, snapshotTs);
  const captured = Object.keys(results);
  if (region && !captured.includes(region)) {
    throw new QueryError(`这一期没有采到 ${region}（采到的地区：${captured.join('、') || '无'}）。`);
  }
  const regions = summarizeRegions(results, { regions: region ? [region] : captured, limit, sort });
  return {
    watch: { id: watch.id, name: watch.name }, snapshot: { ts, time: localTime(ts) },
    regions_captured: captured, regions_configured_now: watch.regions, sorted_by: sort, regions, note: PRICE_NOTE,
  };
}

export async function priceHistory(store, watch, { productId, skuId, region, days = 30, now = Date.now() } = {}) {
  if (!productId) throw new QueryError('请提供 product_id。');
  const index = (await store.listSnapshots(watch.id)).filter((s) => s.ts >= now - days * DAY);
  if (!index.length) throw new QueryError(`监控「${watch.name}」最近 ${days} 天没有快照。`);
  const series = {};
  let found = false;
  for (const entry of index) {
    const results = await readSnapshot(store, watch.id, entry.ts);
    if (!results) continue;
    const codes = region ? [region] : [...new Set([...Object.keys(results), ...(watch.regions ?? [])])];
    for (const code of codes) {
      const point = { ts: entry.ts, time: localTime(entry.ts) };
      const items = results[code]?.items;
      if (!items) {
        (series[code] ??= []).push({ ...point, status: 'region_not_captured' });
        continue;
      }
      const hit = items.find((i) => String(i.productId) === String(productId) && (!skuId || String(i.skuId) === String(skuId)));
      if (!hit) {
        (series[code] ??= []).push({ ...point, status: 'not_observed' });
        continue;
      }
      found = true;
      const v = itemView(hit);
      (series[code] ??= []).push({ ...point, status: 'observed', rank: v.rank, sku_id: v.sku_id, currency: v.currency,
        list_price: v.list_price, display_price: v.display_price, real_price: v.real_price, activity_pct: v.activity_pct, sold: v.sold });
    }
  }
  const summary = {};
  for (const [code, points] of Object.entries(series)) {
    const seen = points.filter((p) => p.status === 'observed');
    const prices = seen.map((p) => p.real_price).filter((v) => v !== null);
    summary[code] = {
      observed: seen.length, not_observed: points.filter((p) => p.status === 'not_observed').length,
      region_not_captured: points.filter((p) => p.status === 'region_not_captured').length,
      first_real_price: prices[0] ?? null, last_real_price: prices.at(-1) ?? null,
      min_real_price: prices.length ? Math.min(...prices) : null, max_real_price: prices.length ? Math.max(...prices) : null,
      currency: seen[0]?.currency ?? null,
    };
  }
  return {
    watch: { id: watch.id, name: watch.name }, product_id: String(productId), sku_id: skuId ? String(skuId) : null,
    days, snapshots: index.length, found_in_any_snapshot: found, summary, series, note: PRICE_NOTE,
  };
}

export async function changeEvents(store, watch, { region, type, days = 7, limit = 50, now = Date.now() } = {}) {
  if (type && !EVENT_TYPES.includes(type)) throw new QueryError(`type 只能是：${EVENT_TYPES.join('、')}`);
  const events = (await store.loadEvents(watch.id))
    .filter((e) => e.ts >= now - days * DAY && (!region || e.region === region) && (!type || e.type === type))
    .sort((a, b) => b.ts - a.ts);
  return {
    watch: { id: watch.id, name: watch.name }, days, total: events.length,
    events: events.slice(0, limit).map((e) => ({
      time: localTime(e.ts), ts: e.ts, type: e.type, region: e.region, text: e.text,
      product_id: e.productId ? String(e.productId) : null, sku_id: e.skuId ? String(e.skuId) : null,
      title: typeof e.title === 'string' ? e.title.slice(0, 120) : null, before: e.before ?? null, after: e.after ?? null,
    })),
    note: '事件按上一期为基准比较得出；同一商品 30 天没再出现会重置基准。' + PRICE_NOTE,
  };
}
