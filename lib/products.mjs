// 商品列表（卖家后台「商品管理」）：普通商品（POP）和半托管商品走两个接口，返回的行结构基本一致。
import { SellerError } from './seller.mjs';
export const PRODUCT_TABS = {
  online_product: '正在销售',
  offline_product: '已下架',
  draft: '草稿箱',
  pending_approval: '审核中',
  audit_failure: '审核不通过',
  violation_qc_failed: '违规 / 质检不通过（全托管）',
  choice_selected: '半托管·正在销售',
  choice_joined: '半托管·审核中',
  choice_reserve: '半托管·已预约',
};

const POP_PAGE = '/m_apps/product-manage/product-list';
const CHOICE_PAGE = '/m_apps/aepop-product-manage/choice-manage';

const isChoice = (tab) => tab.startsWith('choice_');
const num = (v) => {
  if (v === null || v === undefined || v === '' || v === '--') return null;
  const n = Number(String(v).replace(/[,%]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const pct = (v) => (typeof v === 'string' && v.endsWith('%') ? num(v) / 100 : num(v));
const day = (ts) => (num(ts) ? new Date(num(ts)).toISOString().slice(0, 10) : null);
const stripTags = (html) => String(html ?? '').replace(/<\/?(dl|dt|dd)>/g, '\n').replace(/<[^>]+>/g, '').split('\n').map((s) => s.trim()).filter(Boolean);

/** 商品图标里的活动说明（hoverTip 是 HTML 片段）→ ["平台活动：", "xxx", "2026-11-11 16:00 - …"] */
function activities(iconList) {
  const lines = [];
  for (const icon of iconList || []) {
    for (const tip of icon.hoverTip || []) for (const html of tip.dataSource || []) lines.push(...stripTags(html));
  }
  return lines;
}

/** 全托管商品的价格是 subItems：划线价（原供货价）+ 当前供货价文本，如 "23.20-62.26" */
function priceRange(price) {
  if (price?.minPrice !== undefined || price?.maxPrice !== undefined) return { min: num(price.minPrice), max: num(price.maxPrice), original: null };
  const items = price?.subItems || [];
  const range = (text) => {
    const m = String(text ?? '').match(/([\d.]+)(?:\s*-\s*([\d.]+))?/);
    return m ? [num(m[1]), num(m[2] ?? m[1])] : [null, null];
  };
  const current = items.find((i) => i.uiType === 'text' && /\d/.test(i.text ?? ''));
  const struck = items.find((i) => i.uiType === 'strikeThroughText');
  const [min, max] = range(current?.text ?? struck?.text);
  return { min, max, original: current && struck ? struck.text : null };
}

function categoryPath(raw) {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.join(' / ') : null;
  } catch {
    return null;
  }
}

export function parseProductRow(r, { skus = false } = {}) {
  const sop = r.aeRecentThirtySopData || {};
  const price = priceRange(r.price);
  const out = {
    product_id: String(r.productId),
    title: r.itemDesc?.title ?? r.itemDesc?.subject ?? '',
    image: r.itemDesc?.imageUrl ?? null,
    price_min: price.min,
    price_max: price.max,
    currency: r.price?.currencyCode ?? r.originalCurrencyCode ?? null,
    stock: num(r.stock),
    month_sales: num(r.aeMonthSales),
    month_visitors: num(sop.aeMonthVisitNum?.number),
    month_exposure: num(sop.aeMonthExposure?.number),
    month_pay_amount: num(sop.aeMonthPayAmt),
    month_pay_buyers: num(sop.aeMonthPayUserNum),
    month_conv_rate: pct(sop.aeMonthConverRate),
    category_id: r.catId ? String(r.catId) : null,
    category: categoryPath(r.productCategory),
    group: r.group ?? null,
    created: day(r.aeNewCreateDesc ?? r.selfCreateDesc),
    updated: day(r.aeNewUpdateDesc ?? r.selfUpdateDesc),
    activities: activities(r.itemDesc?.iconList),
    sku_count: (r.subDataSource || []).length,
  };
  if (price.original) out.price_before_discount = price.original;
  if (r.itemStockingType) out.stocking_type = r.itemStockingType;
  if (r.popChoiceNotes) out.choice_note = r.popChoiceNotes;
  if (r.auditFailReason) out.audit_fail_reason = r.auditFailReason;
  if (r.removeReason) out.remove_reason = r.removeReason;
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  if (skus) {
    out.skus = (r.subDataSource || []).map((s) => ({
      sku_id: String(s.skuId ?? s.itemDesc?.skuId ?? ''),
      sku_code: s.skuCode ?? s.commodityCode ?? null,
      price: num(s.skuPrice?.price ?? s.supplyPrice),
      stock: num(s.aePopSkuStock ?? s.selfSkuStock),
      props: (s.aePopSkuProps ?? s.selfSkuProps ?? []).map((p) => p.text).filter(Boolean).join(' / ') || null,
    }));
  }
  return out;
}

export function parseProductPage(d, opts) {
  const data = d?.data ?? {};
  // 缺表格不是「没有商品」：报错，不当空列表
  if (!data.table || typeof data.table !== 'object') throw new SellerError('商品列表返回的数据不完整（没有商品表格）');
  const list = data.table?.dataSource ?? data.table?.list ?? [];
  return {
    total: data.pagination?.total ?? null,
    tab_counts: Object.fromEntries((data.tab?.dataSource || []).filter((t) => t.count !== undefined).map((t) => [t.value, t.count])),
    products: list.map((r) => parseProductRow(r, opts)),
  };
}

export async function listProducts(call, ctx, { tab = 'online_product', page = 1, pageSize = 20, skus = false } = {}) {
  const d = isChoice(tab)
    ? await call({
      api: 'mtop.global.merchant.new.product.manager.render.list', page: CHOICE_PAGE,
      data: {
        jsonBody: JSON.stringify({ tab, table: { sort: {} }, filter: {}, pagination: { current: page, pageSize } }),
        from: 'AE-POP-CHOICE-LISTING', bizParam: JSON.stringify({ version: 'simple' }), channelId: ctx.channelId,
      },
    })
    : await call({
      api: 'mtop.item.manage.productlist.query', page: POP_PAGE,
      data: {
        pageInfo: JSON.stringify({ pageNo: page, pageSize }),
        params: JSON.stringify({ tab, filter: { queryRemoveReason: -1, queryCategory: '', queryGroup: '', querySelectInput: {} }, sort: {} }),
        bizParam: JSON.stringify({ version: 'simple' }),
      },
    });
  return parseProductPage(d, { skus });
}
