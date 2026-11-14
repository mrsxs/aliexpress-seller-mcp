// 市场数据（生意参谋·市场分析 / 搜索分析）：类目大盘、子类目和国家构成、类目热搜词。
// 这些是整个类目的数据（指数化），不是本店数据；任何速卖通店铺都能看。
import { PAGES, round } from './store-data.mjs';

const CATEGORY_TTL_MS = 6 * 3600_000;
let categoryCache = null; // { at, list }

/** /api/public/categories 返回 [[parentId, cateId, name, level], ...] */
export function parseCategories(result) {
  return (Array.isArray(result) ? result : [])
    .filter((r) => Array.isArray(r) && r.length >= 4)
    .map(([parentId, id, name, level]) => ({ id: Number(id), parent_id: Number(parentId), name: String(name), level: Number(level) }));
}

export async function loadCategories(call, ctx, now = Date.now()) {
  if (categoryCache && now - categoryCache.at < CATEGORY_TTL_MS) return categoryCache.list;
  const d = await call({
    api: 'mtop.aliexpress.dps.queryhttp', page: PAGES.market,
    data: { channelId: ctx.channelId, serviceKey: '/api/public/categories', method: 'get', params: JSON.stringify({ lang: 'zh-CN' }) },
  });
  const list = parseCategories(d?.result);
  if (!list.length) throw new Error('生意参谋没有返回类目列表');
  categoryCache = { at: now, list };
  return list;
}

/** 按 ID 找类目，带上完整路径 */
export function findCategory(list, id) {
  const byId = new Map(list.map((c) => [c.id, c]));
  const cat = byId.get(Number(id));
  if (!cat) return null;
  const path = [];
  for (let c = cat; c; c = c.parent_id ? byId.get(c.parent_id) : null) path.unshift(c.name);
  return { ...cat, path: path.join(' / ') };
}

/** 按名称搜类目（包含关系），或列出某个类目的子类目；不带条件时列一级类目 */
export function searchCategories(list, { query, parentId, limit = 50 } = {}) {
  let hits;
  if (query) {
    const q = String(query).toLowerCase();
    hits = list.filter((c) => c.name.toLowerCase().includes(q));
  } else if (parentId !== undefined) hits = list.filter((c) => c.parent_id === Number(parentId));
  else hits = list.filter((c) => c.level === 1);
  return { total: hits.length, categories: hits.slice(0, limit).map((c) => findCategory(list, c.id)) };
}

// 指标值形如 { value, cycleCrc }；cycleCrc = 较上一周期变化
const metric = (v) => (v && typeof v === 'object' && 'value' in v ? (v.cycleCrc !== undefined ? { value: round(v.value), change: round(v.cycleCrc) } : round(v.value)) : v);
export function flattenMetrics(obj, skip = ['statDate']) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !skip.includes(k)).map(([k, v]) => [k, metric(v)]));
}

export const MARKET_LABELS = {
  uvIndex: '访客指数', seUvIndex: '搜索指数', noriskPayAmtIndex: '交易指数', payPerBuyerAmt: '客单价（USD）',
  supplyDemandIndex: '供需指数', visitedItemCnt: '被访问商品数', vstItemPercent: '被访问商品占比',
  itemAddCartBuyerCnt: '加购人数', wishlistBuyerCnt: '收藏人数', onlineSellerPercent: '在线商家占比', payAmtParentCatePercent: '支付金额占父类目比例',
};

function catePayload(cat, range, country) {
  const dateRange = `${range.start}|${range.end}`;
  const cate = JSON.stringify({ parentId: cat.parent_id, cateId: cat.id, cateName: cat.name, cateFlag: cat.level });
  const common = { dateType: range.period, dateRange, dtUpdateTime: true, country, platform: 'ALL', cateId: cat.id, cateLevel: cat.level, parentCateId: cat.level === 1 ? -9999 : cat.parent_id };
  return { outer: { dateRange, dateType: range.period, cate, country, platform: 'ALL' }, common };
}

const http = (call, ctx, page, serviceKey, params, outer) => call({
  api: 'mtop.aliexpress.dps.queryhttp', page,
  data: { channelId: ctx.channelId, serviceKey, method: 'get', params: JSON.stringify(params), ...outer },
});

export async function marketOverview(call, ctx, range, cat, { country = 'ALL', limit = 10 } = {}) {
  const { outer, common } = catePayload(cat, range, country);
  const list = { pageSize: limit, page: 1, order: 'desc' };
  const [core, sub, countries] = await Promise.all([
    http(call, ctx, PAGES.market, '/api/market-dashboard/core-indicators', common, outer),
    http(call, ctx, PAGES.market, '/api/market-dashboard/category-constitute/core-indicators', {
      ...common, ...list, orderBy: 'seUvIndex', indexCode: 'seUvIndex,noriskPayAmtIndex,onlineSellerPercent,supplyDemandIndex,payAmtParentCatePercent,payPerBuyerAmt',
    }, outer),
    country === 'ALL'
      ? http(call, ctx, PAGES.market, '/api/market-dashboard/country-constitute/core-indicators', {
        ...common, ...list, orderBy: 'uvIndex', indexCode: 'uvIndex,visitedItemCnt,vstItemPercent,supplyDemandIndex,payPerBuyerAmt,itemAddCartBuyerCnt,wishlistBuyerCnt',
      }, outer)
      : null,
  ]);
  const rowsOf = (d) => (Array.isArray(d?.result?.data) ? d.result.data : []);
  return {
    core: flattenMetrics(core?.result),
    sub_categories: rowsOf(sub).map((r) => {
      const m = flattenMetrics(r, ['statDate', 'cateDesc', 'cateId']);
      return { category_id: r.cateId?.value ?? null, name: r.cateDesc?.value ?? null, ...m };
    }),
    countries: countries ? rowsOf(countries).map((r) => ({ country: r.country?.value ?? null, ...flattenMetrics(r, ['statDate', 'country', 'cateId']) })) : undefined,
    labels: MARKET_LABELS,
  };
}

export const WORD_ORDER = { searches: 'searchCnt', searchers: 'searchCookieCnt', click_rate: 'clickRate', conv_rate: 'transRate', supply_demand: 'splyDemRate' };

export function parseWord(r) {
  const v = (k) => round(r?.[k]?.value);
  return {
    keyword: r.keyword?.value ?? null,
    is_brand: r.isBrandWord?.value === 'Y',
    searches: v('searchCnt'),
    searchers: v('searchCookieCnt'),
    searches_change: v('searchCntRiseIndex'),
    click_rate: v('clickRate'),
    conv_rate: v('transRate'),
    pay_orders: v('payOrderCnt'),
    supply_demand: v('splyDemRate'),
    exposed_products: v('exposeProdCnt'),
    exposed_sellers: v('exposeSellerCnt'),
    top_countries: r.top3Country?.value ? String(r.top3Country.value).split(',') : [],
  };
}

export async function searchWords(call, ctx, range, cat, { country = 'ALL', orderBy = 'searches', page = 1, pageSize = 20 } = {}) {
  const { outer } = catePayload(cat, range, country);
  const d = await http(call, ctx, PAGES.search, '/api/search-analysis/hot-words', {
    dateType: range.period, pageSize, page, order: 'desc', orderBy: WORD_ORDER[orderBy], dtUpdateTime: true, country, categoryId: cat.id,
    statDate: range.end, indexCode: 'searchCookieCnt,searchCnt,clickRate,transRate,splyDemRate',
  }, { dateRange: outer.dateRange, dateType: range.period, cate: outer.cate, country });
  const rows = Array.isArray(d?.result?.data) ? d.result.data : [];
  return { total: d?.result?.total ?? d?.result?.recordCount ?? null, words: rows.map(parseWord) };
}
