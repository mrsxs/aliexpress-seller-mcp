// 解析速卖通搜索页 SSR 数据（window._dida_config_._init_data_），输出每个商品的价格明细
// 所有金额单位：美元（或页面币种），由「分」换算

const INIT_MARKER = 'window._dida_config_._init_data_=';

// 已知的新人平台补贴优惠 ID；每个商品还会在 pdp_npi 的 pisId 里给出自己的新人补贴 ID
const KNOWN_NEW_USER_PROMO_IDS = new Set(['5000000218165408', '5000000218165411', '5000000218165403']);

/** 从 start 位置的 '{' 开始，按括号配对找到 JSON 对象结尾（跳过字符串内的括号） */
function findJsonEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** 提取 SSR 初始化数据；页面不是正常搜索页（如验证码页）时返回 null */
export function extractInitData(html) {
  const markerAt = html.indexOf(INIT_MARKER);
  if (markerAt < 0) return null;
  const dataKeyAt = html.indexOf('data:', markerAt + INIT_MARKER.length);
  const start = dataKeyAt < 0 ? -1 : html.indexOf('{', dataKeyAt);
  const end = start < 0 ? -1 : findJsonEnd(html, start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end + 1));
  } catch {
    return null;
  }
}

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
const cents = (v) => {
  const n = Number(v);
  return isBlank(v) || Number.isNaN(n) ? null : n;
};
const toMoney = (c) => (c === null ? null : Math.round(c) / 100);
const round2 = (v) => Math.round(v * 100) / 100;
const toNum = (v) => {
  const n = Number(v);
  return isBlank(v) || Number.isNaN(n) ? null : n;
};

/** "131 sold" / "1.2K+ sold" / "10,000+ sold" -> 数字 */
function parseSoldText(text) {
  const m = String(text || '').replace(/,/g, '').match(/([\d.]+)\s*([kK万])?/);
  if (!m) return null;
  const unit = m[2] === '万' ? 10000 : m[2] ? 1000 : 1;
  return Math.round(Number(m[1]) * unit);
}

function decodeNpi(raw) {
  try {
    return decodeURIComponent(raw || '');
  } catch {
    return raw || '';
  }
}

/** promotionResultDetails 形如 "id:flag:金额分;id:flag:金额分" */
function parsePromotions(detail, newUserIds) {
  return String(detail || '')
    .split(';')
    .filter(Boolean)
    .map((part) => {
      const [id, flag, amount] = part.split(':');
      return { id, flag, amount: toMoney(cents(amount)) ?? 0, isNewUser: newUserIds.has(id) };
    });
}

function parseDelivery(info) {
  const [minDays, maxDays, from, to] = String(info || '').split(',');
  return minDays ? { minDays: toNum(minDays), maxDays: toNum(maxDays), from: from || '', to: to || '' } : null;
}

function sellingPointTexts(item) {
  return (item.sellingPoints || []).map((s) => s?.tagContent?.tagText).filter(Boolean);
}

function normalizeImage(url) {
  if (typeof url !== 'string' || !url) return '';
  return url.startsWith('//') ? `https:${url}` : url;
}

// 新人补贴之外的平台/卖家活动工具（pro_tool_code）
const NEW_USER_TOOL = 'platformItemSubsidy';

/** 从卖点标签里提取活动相关价格线索 */
function parseTagOffers(tags) {
  const coin = tags.map((t) => t.match(/Extra\s+(\d+(?:\.\d+)?)%\s+off with coins/i)).find(Boolean);
  const bulk = tags.map((t) => t.match(/\$\s?([\d.]+)\s+each,?\s*≥\s*(\d+)\s+pieces/i)).find(Boolean);
  const lowest = tags.map((t) => t.match(/(\d+)-day lowest price:?\s*(?:US\s*)?\$\s?([\d.]+)/i)).find(Boolean);
  const lowestNoPrice = tags.map((t) => t.match(/lowest price in (\d+) days/i)).find(Boolean);
  return {
    coinPct: coin ? Number(coin[1]) / 100 : 0,
    bulk: bulk ? { price: Number(bulk[1]), minQty: Number(bulk[2]) } : null,
    lowestRef: lowest
      ? { days: Number(lowest[1]), price: Number(lowest[2]) }
      : lowestNoPrice
        ? { days: Number(lowestNoPrice[1]), price: null }
        : null,
    earlyBird: tags.find((t) => /early bird/i.test(t)) || '',
  };
}

/** 把一个商品卡片转换成扁平的价格明细 */
export function parseItem(item, rank) {
  const u = item?.trace?.utLogMap || {};
  const prices = item?.prices || {};
  const npiText = decodeNpi(item?.trace?.pdpParams?.pdp_npi);
  const npi = npiText.split('!');
  const pisId = (npiText.match(/pisId:(\d+)/) || [])[1];
  const newUserIds = new Set([...KNOWN_NEW_USER_PROMO_IDS, ...(pisId ? [pisId] : [])]);

  const originalC = cents(u.originPriceAmount) ?? cents(prices.originalPrice?.cent) ?? cents(prices.salePrice?.cent);
  const saleC = cents(u.salePriceAmount) ?? cents(prices.salePrice?.cent) ?? originalC;
  const promotions = parsePromotions(u.promotionResultDetails, newUserIds);
  const newUserSubsidy = promotions.filter((p) => p.isNewUser).reduce((s, p) => s + p.amount, 0);
  const otherDiscount = promotions.filter((p) => !p.isNewUser).reduce((s, p) => s + p.amount, 0);
  const display = toMoney(saleC);
  const original = toMoney(originalC);
  const real = display === null ? null : round2(display + newUserSubsidy);
  // 促销前标价：优惠都是从它往下扣的。欧盟的 original 是 30 天最低参考价，可能低于它
  const listPrice = promotions.length && display !== null ? round2(display + newUserSubsidy + otherDiscount) : original;
  const tax = toMoney(cents(u.taxAmount)) ?? 0;
  // taxAmount 按促销前标价计算，所以用标价反推税率，再换算到实际售价里包含的税
  const taxRate = tax > 0 && listPrice > tax ? tax / (listPrice - tax) : null;
  const taxInPrice = (price) => (taxRate && price !== null ? round2((price * taxRate) / (1 + taxRate)) : 0);
  const tags = sellingPointTexts(item);
  const offers = parseTagOffers(tags);
  const promoTools = String(u.pro_tool_code || '').split(',').filter(Boolean);
  // 活动 = 除新人补贴外的所有优惠（限时折扣、SuperDeals、渠道折扣等，老买家也能享受）
  const activityTools = promoTools.filter((t) => t !== NEW_USER_TOOL || (otherDiscount > 0 && newUserSubsidy === 0));

  return {
    rank,
    productId: String(item.productId || u.productId || ''),
    // 搜索卡片展示的 SKU，每次请求可能不同；对比价格时必须同 SKU
    skuId: String(prices.skuId || u.sku_id || ''),
    title: item?.title?.displayTitle || '',
    image: normalizeImage(item?.image?.imgUrl),
    url: `https://www.aliexpress.com/item/${item.productId}.html`,
    sold: toNum(u.real_trade_count) ?? parseSoldText(item?.trade?.tradeDesc) ?? 0,
    star: toNum(u.star_rating) ?? toNum(item?.evaluation?.starRating),
    isChoice: u.isChoice === 'true',
    currency: u.currency || prices.originalPrice?.currencyCode || prices.salePrice?.currencyCode || '',
    sellerOffer: toMoney(cents(u.sellerOfferPriceAmount)),
    adjustRatio: toNum(u.adjustRatio),
    original,
    listPrice,
    display,
    real,
    newUserSubsidy: round2(newUserSubsidy),
    otherDiscount: round2(otherDiscount),
    promotions,
    // false 表示划线价不是促销起算价（欧盟参考价、模拟售价等）
    consistent: original !== null && listPrice !== null && Math.abs(original - listPrice) <= 0.011,
    tax,
    taxRate: taxRate === null ? null : Math.round(taxRate * 1000) / 1000,
    taxInReal: taxInPrice(real),
    taxInDisplay: taxInPrice(display),
    taxMode: u.dutyTaxSceneModel || '',
    mockedPrice: toMoney(cents(u.mockedSalePrice)),
    superLinkOf: u._p_origin_prod || '',
    promoTools,
    // 活动价拆解：listPrice（无活动价）→ 扣活动优惠 → real（活动价/老买家到手价）→ 扣新人补贴 → display
    activityTools: otherDiscount > 0 ? activityTools : [],
    activityPct: listPrice > 0 && otherDiscount > 0 ? Math.round((otherDiscount / listPrice) * 1000) / 1000 : 0,
    coinPct: offers.coinPct,
    coinPrice: real !== null && offers.coinPct > 0 ? round2(real * (1 - offers.coinPct)) : real,
    bulk: offers.bulk,
    lowestRef: offers.lowestRef,
    earlyBird: offers.earlyBird,
    atmospheres: String(u.ump_atmospheres || '').split(',').filter((a) => a && a !== 'none'),
    tags,
    bulkTag: tags.find((t) => /each/i.test(t)) || '',
    npiCountry: npi[11] || '',
    cnyOriginal: toNum(npi[6]),
    cnyDisplay: toNum(npi[7]),
    delivery: parseDelivery(u.delivery_info),
  };
}

export const SEARCH_VERIFY = '触发了速卖通安全验证（搜索页要求验证码），请在紫鸟浏览器里打开速卖通手动完成验证后再试，不要反复重试';

/** 解析整页搜索结果；不是正常搜索页时抛出带提示的错误。finalUrl：跳转后的地址（被转到验证页 / 登录页时用） */
export function parseSearchHtml(html, finalUrl = '') {
  // 先看最终地址：被转到验证页时页面里可能也带一些初始化数据
  if (/_____tmd_____|\/punish\b|x5secdata/i.test(String(finalUrl))) throw new Error(SEARCH_VERIFY);
  if (/^https:\/\/login\.aliexpress\.com\//.test(String(finalUrl))) throw new Error('速卖通页面未登录：请在紫鸟店铺浏览器里登录速卖通后重试');
  const data = extractInitData(html);
  if (!data) {
    const blocked = /punish|x5sec|captcha|slide to verify|baxia/i.test(html);
    throw new Error(blocked ? SEARCH_VERIFY : '页面里没有搜索数据（可能是页面结构变化或请求被拦截）');
  }
  const mods = data?.data?.root?.fields?.mods;
  // 有数据但没有结果区域：不是「0 个结果」，是页面不对（不能当空结果存进盯价快照）
  if (!mods || typeof mods !== 'object') throw new Error('搜索页数据不完整（没有结果区域），可能是页面结构变化');
  // 图搜总会有相似商品：连 itemList 都没有说明页面不对，不当 0 个结果存成快照
  if (!mods.itemList || typeof mods.itemList !== 'object') throw new Error('搜索页数据不完整（没有商品列表），可能是页面结构变化');
  const content = Array.isArray(mods.itemList.content) ? mods.itemList.content : [];
  return content
    .filter((item) => item?.productId && item?.prices)
    .map((item, i) => parseItem(item, i + 1));
}
