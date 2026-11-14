// 店铺经营数据（生意参谋）：核心指标、每日走势、今日实时、流量来源、商品排行、单品分析。
// 每个函数第一个参数是 lib/seller.mjs 的 call；解析函数单独导出便于测试。
import { compactDate, rankTimes } from './seller.mjs';

export const PAGES = {
  home: '/m_apps/home',
  sycm: '/m_apps/sycm/HomeNew',
  flows: '/m_apps/sycm/flows',
  rank: '/m_apps/csp-sycm-new/productRank',
  product: (id) => `/m_apps/sycm/product-analyse?productId=${id}`,
  market: '/m_apps/csp-sycm-op/MarketOverview',
  search: '/m_apps/csp-sycm-op/searchAnalysis',
};

export const TRADE_INDICATORS = ['payAmt', 'payBuyerCnt', 'vstPayRate', 'avgPayAmt', 'payOrderCnt', 'payItemQty'];
// 多加别的指标（如 avgStayTime）时近 7 / 30 天会整体返回空，只用页面上这 4 个
export const FLUX_INDICATORS = ['uv', 'pv', 'bounceRate', 'newVisitorCnt'];
export const RANK_BY = { pay_amt: 'pay_amt', visitors: 'item_uv', wishlist: 'wishlist', add_to_cart: 'addcart' };

const ALL_COUNTRIES = JSON.stringify({ countryId: 'AllCountries' });
const ALL_PLATFORMS = JSON.stringify({ countryId: 'AllCountries', platform: 'ALL' });
// 流量来源只能分端查：APP 和 PC（非 APP）；platform=ALL 返回空
export const SOURCE_PLATFORMS = { APP: 'APP', PC: '非 APP（PC / 手机网页）' };

export const round = (v, digits = 4) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : v ?? null);
const rows = (d) => (Array.isArray(d?.dataSource) ? d.dataSource : []);
const validMs = (ts) => {
  const n = Number(ts);
  return ts !== null && ts !== '' && Number.isFinite(n) && n > 0 ? n : null;
};
const dateOnly = (ts) => (validMs(ts) ? new Date(validMs(ts)).toISOString().slice(0, 10) : null);

/** 生意参谋最新出数日期（美国太平洋时间） */
export async function latestStatDate(call, ctx) {
  const d = await call({
    api: 'mtop.aliexpress.dps.queryhttp', page: PAGES.market,
    data: { channelId: ctx.channelId, serviceKey: '/api/public/stat-date', method: 'get', params: JSON.stringify({ module: 'ae_sycm_item' }) },
  });
  const day = d?.result?.updateDay;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new Error('生意参谋没有返回最新数据日期');
  return day;
}

/** 指标卡片：value + 较上期 + 周同比 */
export function parseCard(data) {
  return rows(data).map((r) => {
    const out = { key: r.key, label: r.label, value: round(r.value) };
    if (r.cycleLabel) Object.assign(out, { prev_label: r.cycleLabel, prev: round(r.cycleTarget), change: round(r.cycleData) });
    if (r.lineLabel) Object.assign(out, { yoy_label: r.lineLabel, yoy: round(r.lineTarget), yoy_change: round(r.lineData) });
    return out;
  });
}

const dps = (call, ctx, page, data) => call({ api: 'mtop.aliexpress.dps.query', page, data: { channelId: ctx.channelId, ...data } });

export async function storeOverview(call, ctx, range) {
  const base = { statDate: range.end, dateType: range.period, bizType: 'ALL' };
  // 一个接一个发：前一个触发安全验证就不再发后面的
  const trade = await dps(call, ctx, PAGES.sycm, { ...base, serviceKey: 'tradeOverviewCard', indicators: TRADE_INDICATORS.join(','), params: ALL_COUNTRIES });
  const flux = await dps(call, ctx, PAGES.sycm, { ...base, serviceKey: 'fluxOverviewCard', indicators: FLUX_INDICATORS.join(','), params: ALL_PLATFORMS });
  return { trade: parseCard(trade), traffic: parseCard(flux) };
}

/** 每日走势：tradeTrend / fluxTrend 的行是 { statDate, key, value }，同一天多个指标；xxxGood / xxxAvg 是同行对比线 */
export function parseTrend(datasets, { peers = false } = {}) {
  const byDate = new Map();
  const labels = {};
  for (const d of datasets) {
    for (const r of rows(d)) {
      if (!r.statDate || !r.key) continue;
      const peer = r.key.match(/^(.*?)(Good|Avg)$/);
      if (peer && !peers) continue;
      if (!peer) labels[r.key] = r.label;
      const row = byDate.get(r.statDate) ?? { date: r.statDate };
      if (peer) {
        const slot = peer[2] === 'Good' ? 'peer_good' : 'peer_avg';
        row[slot] = { ...row[slot], [peer[1]]: round(r.value) };
      } else row[r.key] = round(r.value);
      byDate.set(r.statDate, row);
    }
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const additive = ['payAmt', 'payOrderCnt', 'payItemQty', 'uv', 'pv'];
  const totals = Object.fromEntries(additive.filter((k) => days.some((r) => r[k] !== undefined)).map((k) => [k, round(days.reduce((s, r) => s + (r[k] ?? 0), 0), 2)]));
  return { labels, days, totals };
}

export async function storeTrend(call, ctx, end, { peers = false } = {}) {
  const base = { statDate: end, dateType: 'day', bizType: 'ALL' };
  const trade = await dps(call, ctx, PAGES.sycm, { ...base, serviceKey: 'tradeTrend', indicators: TRADE_INDICATORS.join(','), params: ALL_COUNTRIES });
  const flux = await dps(call, ctx, PAGES.flows, { ...base, serviceKey: 'fluxTrend', indicators: 'uv,pv', params: ALL_PLATFORMS });
  return parseTrend([trade, flux], { peers });
}

/** 卖家后台首页「店铺数据」卡片：美国时间今天到目前为止 */
export function parseToday(data) {
  const d = data?.data ?? {};
  return {
    updated_at: validMs(d.updateTime) ? new Date(validMs(d.updateTime)).toISOString() : null,
    pay_amount: d.totalValue ?? null,
    metrics: (d.dataItems || []).map((i) => ({ label: i.name, value: i.value })),
  };
}

export async function storeToday(call) {
  return parseToday(await call({ api: 'mtop.global.merchant.newindex.dashboard.getv2', method: 'GET', page: PAGES.home, data: {} }));
}

export function parseSources(data) {
  return rows(data).map((r) => ({
    source: r.sourceDesc ?? r.sourceName ?? String(r.sourceId),
    visitors: r.uv ?? null,
    visitor_share: round(r.uvRate),
    order_buyers: r.orderBuyerCnt ?? null,
    order_conv_rate: round(r.orderConvRate),
    ...(r.bounceRate !== undefined ? { bounce_rate: round(r.bounceRate) } : {}),
  }));
}

/** 流量来源：店铺级（不传 productId）或单品级；分 APP / 非 APP 两端返回 */
export async function trafficSources(call, ctx, range, productId) {
  const one = (platform) => (productId
    ? dps(call, ctx, PAGES.product(productId), {
      productId, serviceKey: 'goodsSourceDetailExpandable', statDate: range.end, dateType: range.period,
      indicators: 'uv,uvRate,orderBuyerCnt,orderConvRate,bounceRate',
      params: JSON.stringify({ sortBy: 'uv', sort: 'desc', countryId: 'AllCountries', platform, itemId: productId }),
    })
    : dps(call, ctx, PAGES.flows, {
      serviceKey: 'trafficSourceDistribution', statDate: compactDate(range.end), dateType: range.period,
      params: JSON.stringify({ countryId: 'AllCountries', platform, visitType: '-9999', sortBy: 'uv', sort: 'desc' }),
    }));
  const out = {};
  for (const p of Object.keys(SOURCE_PLATFORMS)) out[p] = parseSources(await one(p));
  return out;
}

export function parseRankRow(r) {
  return {
    product_id: String(r.itemId),
    title: r.title ?? '',
    price: r.minPrice === r.maxPrice ? r.minPrice : `${r.minPrice}~${r.maxPrice}`,
    category: r.cateLeafName ?? null,
    first_online: dateOnly(r.firstOnlineDate),
    pay_amount: r.payAmt ?? null,
    pay_items: r.payItemQty ?? null,
    pay_buyers: r.payBuyerCnt ?? null,
    visitors: r.uv ?? null,
    new_visitors: r.newVisitorCnt ?? null,
    views: r.pv ?? null,
    search_exposure: r.searchExpPv ?? null,
    conv_rate: round(r.payConversionRate),
    add_to_cart_buyers: r.itemAddCartBuyerCnt ?? null,
    wishlist_buyers: r.itemAddWishListBuyerCnt ?? null,
    refund_amount: r.refundAmt ?? null,
    avg_stay_seconds: round(r.avgStayTime, 1),
    pay_amount_change: round(r.payAmtChainRatio),
    visitors_change: round(r.uvChainRatio),
  };
}

export async function productRank(call, ctx, range, { rankBy = 'pay_amt', page = 1, pageSize = 20 } = {}) {
  const times = rankTimes(range);
  const d = await call({
    api: 'mtop.aliexpress.seller.business.advice.table.query', method: 'GET', page: PAGES.rank,
    data: {
      categoryLevel: 1, categoryId: '-9999', current: page, pageSize, firstOnline30d: 'false', rankType: RANK_BY[rankBy],
      bizType: 'ALL', url: '/api/goods-rank-new/indicator', platform: 'ALL', country: 'AllCountries',
      ...(range.period === 'day' ? { dateType: 'recent1', statDate: rankTimes({ start: range.end, end: range.end }).statDate } : { dateType: range.period, ...times }),
    },
  });
  return { total: d?.pageInfo?.total ?? null, products: rows(d).map(parseRankRow) };
}

const modelRows = (d) => (Array.isArray(d?.data?.model) ? d.data.model : []);

export function parseKeywords(data) {
  const all = modelRows(data);
  // 有分端 / 分国家的行时只取「全部」那一行
  const total = all.filter((r) => String(r.platform) === '-9999' && String(r.country_id) === '-9999');
  return (total.length ? total : all).map((r) => ({
    keyword: r.keyword,
    english: r.translated && r.translated !== r.keyword ? r.translated : undefined,
    lang: r.lang,
    exposure: r.pv ?? null,
    exposure_users: r.uv ?? null,
    visitors: r.se_ipv_uv ?? null,
    pay_buyers: r.pay_buyer_cnt ?? null,
    pay_orders: r.pay_ord_cnt ?? null,
    pay_amount: r.pay_amt ?? null,
    pay_conv_rate: round(r.pay_conversion_rate),
    exposure_users_change: round(r.uvChainRatio),
  })).sort((a, b) => (b.pay_buyers ?? 0) - (a.pay_buyers ?? 0) || (b.visitors ?? 0) - (a.visitors ?? 0) || (b.exposure ?? 0) - (a.exposure ?? 0));
}

const COUNTRY_FIELDS = {
  payAmt: 'pay_amount', payBuyerCnt: 'pay_buyers', payNewBuyerCnt: 'new_pay_buyers', payOldBuyerCnt: 'repeat_pay_buyers', payItemQty: 'pay_items',
  uv: 'visitors', newVisitorCnt: 'new_visitors', searchExpPv: 'search_exposure', l2dUvRate: 'search_click_rate', payConversionRate: 'conv_rate',
  addcartBuyerCnt: 'add_to_cart_buyers', itemAddWishListBuyerCnt: 'wishlist_buyers', payPerBuyerAmt: 'avg_order_value', refundAmt: 'refund_amount',
  divPayableTaxAmt: 'tax', avgStayTime: 'avg_stay_seconds', cntyPayAmtProp: 'pay_amount_share',
};

/** 第一行是「全部国家」合计，其余按支付金额、访客从高到低 */
export function parseCountries(data) {
  const all = modelRows(data).map((r) => {
    const out = { country: r.countryId };
    for (const [from, to] of Object.entries(COUNTRY_FIELDS)) if (r[from] !== undefined) out[to] = round(r[from]);
    return out;
  });
  const isTotal = (r) => /全部|All/i.test(String(r.country));
  const rest = all.filter((r) => !isTotal(r)).sort((a, b) => (b.pay_amount ?? 0) - (a.pay_amount ?? 0) || (b.visitors ?? 0) - (a.visitors ?? 0));
  return [...all.filter(isTotal), ...rest];
}

/** 单品分析：搜索词 + 分国家 + 流量来源，按 sections 选择 */
export async function productAnalysis(call, ctx, range, productId, { sections, limit = 20 }) {
  const page = PAGES.product(productId);
  const jobs = {
    keywords: async () => {
      const all = parseKeywords(await dps(call, ctx, page, {
        productId, serviceKey: 'productKeywordTable', statDate: compactDate(range.end), dateType: range.period,
        params: JSON.stringify({ translate: true, itemId: productId }),
      }));
      return { total: all.length, top: all.slice(0, limit) };
    },
    countries: async () => {
      const all = parseCountries(await dps(call, ctx, page, {
        productId, serviceKey: 'productMetricTableByCountry', statDate: compactDate(range.end), dateType: range.period, bizType: 'ALL',
        params: JSON.stringify({ countryId: 'AllCountries', platform: 'ALL', itemId: productId }),
      }));
      return { total: all.length, top: all.slice(0, limit + 1) };
    },
    sources: () => trafficSources(call, ctx, range, productId),
  };
  const out = {};
  for (const s of new Set(sections)) out[s] = await jobs[s]();
  return out;
}
