// 商品库存（新版商品管理页 /ait/cn_pop/itemManagement 的库存接口）：每个 SKU 按仓库分开给可售库存——
// 商家仓（dropshipping）、JIT 仓（半托管 JIT 备货，如「杭州JIT库存」）、优选仓（半托管仓发 / 菜鸟平台仓）。
// 旧版商品列表接口（products.mjs）不带库存，库存都从这里取。
import { listProducts, PRODUCT_TABS } from './products.mjs';
import { SellerError } from './seller.mjs';

export const STOCK_PAGE = '/ait/cn_pop/itemManagement/pop_product_manage';
// 一次最多 50 个商品（实测 100 个报「系统开小差了」）
export const STOCK_BATCH = 50;
export const STOCK_TYPES = {
  jit: 'JIT 库存（半托管 JIT 仓）',
  seller: '商家仓库存',
  warehouse: '优选仓库存（半托管仓发）',
  total: '各仓合计',
};
const KIND = { jit_warehouse: 'jit', dropshipping: 'seller', own_warehouse: 'warehouse' };
const LIST_PAGE_SIZE = 50;
// 客户端（如 Accio）一般 120 秒超时。截止时间从工具被调用时算起（排队、打开浏览器都算），
// 每个请求都和截止时间赛跑：单次请求内部的重试再久，到点也立即停下说明，不让客户端干等。
// 赛跑输了的请求在页面里自己结束（只读，不影响数据），浏览器锁随工具返回释放。
export const SCAN_BUDGET_MS = 100_000;
// 剩余时间不到这么多就不再发新请求
const MIN_LEFT_MS = 3_000;
const noPause = async () => {};

const count = (v, what) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isFinite(n)) throw new SellerError(`库存接口返回的数据不完整（${what}没有库存数）`);
  return n;
};

/** 一个 SKU 的各仓记录 → { jit, seller, warehouse, total, warehouses }；没有这类仓时是 null（和 0 件不同） */
export function skuStock(entries, skuId = '') {
  if (!Array.isArray(entries)) throw new SellerError(`库存接口返回的数据不完整（SKU ${skuId} 没有仓库记录）`);
  const out = { jit: null, seller: null, warehouse: null, total: 0, warehouses: [] };
  for (const w of entries) {
    const qty = count(w?.sellableStock, `SKU ${skuId} 的${w?.warehouseName ?? '某个仓'}`);
    const kind = KIND[w.warehouseType];
    if (kind) out[kind] = (out[kind] ?? 0) + qty;
    out.total += qty;
    out.warehouses.push({ type: kind ?? String(w.warehouseType ?? ''), name: w.warehouseName ?? w.warehouseCode ?? null, stock: qty });
  }
  return out;
}

/** 接口返回 → Map(商品 ID -> { product_stock, skus: { skuId: skuStock } })；要的商品缺一个就报错，不当成没库存 */
export function parseStock(d, ids) {
  const model = d?.model;
  if (!model || typeof model !== 'object') throw new SellerError('库存接口返回的数据不完整（没有 model）');
  const out = new Map();
  for (const id of ids) {
    const p = model[id];
    if (!p || !p.skuStocksMap || typeof p.skuStocksMap !== 'object') throw new SellerError(`库存接口没有返回商品 ${id} 的库存`);
    const skus = {};
    for (const [sku, entries] of Object.entries(p.skuStocksMap)) skus[sku] = skuStock(entries, sku);
    out.set(String(id), { product_stock: p.productStock === undefined || p.productStock === null ? null : count(p.productStock, `商品 ${id} `), skus });
  }
  return out;
}

/** 按商品 ID 查库存，每批最多 50 个，批与批之间 pause() */
export async function queryStock(call, productIds, { pause = noPause } = {}) {
  const ids = [...new Set(productIds.map(String))];
  for (const id of ids) if (!/^\d{1,20}$/.test(id)) throw new SellerError(`商品 ID 格式不对：${id}`);
  const out = new Map();
  for (let i = 0; i < ids.length; i += STOCK_BATCH) {
    if (i) await pause();
    const batch = ids.slice(i, i + STOCK_BATCH);
    // 商品 ID 按数字原样拼进 JSON（不经过 Number，避免精度问题）
    const d = await call({ api: 'mtop.item.global.merchant.product.stock.query', page: STOCK_PAGE, data: { productIds: `[${batch.join(',')}]` } });
    for (const [k, v] of parseStock(d, batch)) out.set(k, v);
  }
  return out;
}

/** 给 listProducts 的结果补上库存：商品 stock = 后台显示的总库存，每个 SKU 加 stock（各仓合计）和 stock_jit / stock_seller / stock_warehouse */
export function attachStock(products, stock) {
  return products.map((p) => {
    const s = stock.get(p.product_id);
    if (!s) throw new SellerError(`库存接口没有返回商品 ${p.product_id} 的库存`);
    const out = { ...p };
    if (s.product_stock !== null) out.stock = s.product_stock;
    if (p.skus) {
      out.skus = p.skus.map((sku) => {
        const k = s.skus[sku.sku_id];
        if (!k) throw new SellerError(`库存接口没有返回商品 ${p.product_id} 的 SKU ${sku.sku_id}`);
        const withStock = { ...sku, stock: k.total };
        for (const kind of ['jit', 'seller', 'warehouse']) if (k[kind] !== null) withStock[`stock_${kind}`] = k[kind];
        return withStock;
      });
    }
    return out;
  });
}

/** 店铺要扫的标签页：全托管店没有半托管标签页 */
export const scanTabs = (shopModel) => (shopModel === 'ONE_STOP_SERVICE' ? ['online_product'] : ['online_product', 'choice_selected']);

/**
 * 扫全部在售商品，按 SKU 找某类库存低于 below 的。
 * type: jit / seller / warehouse / total；SKU 没有这类仓（null）时不算低库存。
 */
export async function scanLowStock(call, ctx, { type = 'jit', below = 5, limit = 200, pause = noPause, now = Date.now, deadline = now() + SCAN_BUDGET_MS } = {}) {
  if (!STOCK_TYPES[type]) throw new SellerError(`stock_type 只能是 ${Object.keys(STOCK_TYPES).join(' / ')}`);
  const tabs = scanTabs(ctx.shopModel);
  const products = new Map();
  const totals = {};
  let requests = 0;
  const tooSlow = () => new SellerError(`在售商品太多，时限内没扫完（已取 ${products.size} 个商品、发了 ${requests} 次请求）。`
    + '可以用 ae_products 加 include_stock=true 分页查库存。');
  // 先停顿再看时间：停顿和上一次请求花的时间都算进去
  const step = async () => {
    if (requests) await pause();
    if (deadline - now() < MIN_LEFT_MS) throw tooSlow();
    requests++;
  };
  // 到截止时间就取消：赛跑输了的请求不会再发令牌重试之类的新请求
  const ac = new AbortController();
  const scanCall = (req) => call({ ...req, signal: ac.signal });
  const guard = async (promise) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(tooSlow()); }, Math.max(0, deadline - now())); })]);
    } finally {
      clearTimeout(timer);
    }
  };
  for (const tab of tabs) {
    // 按商品 ID 去重计数：翻页时同一个商品重复出现不能顶替漏掉的商品
    const seen = new Set();
    for (let page = 1; ; page++) {
      await step();
      const r = await guard(listProducts(scanCall, ctx, { tab, page, pageSize: LIST_PAGE_SIZE, skus: true }));
      if (!Number.isInteger(r.total)) throw new SellerError(`${PRODUCT_TABS[tab]}的商品总数没取到`);
      totals[tab] = r.total;
      for (const p of r.products) {
        seen.add(p.product_id);
        const old = products.get(p.product_id);
        if (!old) products.set(p.product_id, { ...p, lists: [PRODUCT_TABS[tab]] });
        else if (!old.lists.includes(PRODUCT_TABS[tab])) products.set(p.product_id, { ...old, lists: [...old.lists, PRODUCT_TABS[tab]] });
      }
      if (!r.products.length || page * LIST_PAGE_SIZE >= r.total) break;
    }
    // 翻页期间有人上下架会对不上：报错让用户重试，不给一份缺数据的清单
    if (seen.size !== totals[tab]) throw new SellerError(`${PRODUCT_TABS[tab]}取到 ${seen.size} 个商品，和后台总数 ${totals[tab]} 对不上（可能正在上下架），请稍后重试`);
  }
  const ids = [...products.keys()];
  const stock = new Map();
  for (let i = 0; i < ids.length; i += STOCK_BATCH) {
    await step();
    for (const [k, v] of await guard(queryStock(scanCall, ids.slice(i, i + STOCK_BATCH)))) stock.set(k, v);
  }

  const rows = [];
  const withType = new Set();
  let skusWithType = 0;
  for (const [id, p] of products) {
    const s = stock.get(id);
    if (!s) throw new SellerError(`库存接口没有返回商品 ${id} 的库存`);
    const listed = new Map((p.skus || []).map((sku) => [sku.sku_id, sku]));
    // 列表里有的 SKU 库存接口必须都给：缺了就报错，不能让它的低库存悄悄漏掉
    for (const skuId of listed.keys()) if (!s.skus[skuId]) throw new SellerError(`库存接口没有返回商品 ${id} 的 SKU ${skuId}`);
    for (const [skuId, k] of Object.entries(s.skus)) {
      const value = k[type];
      if (value === null) continue;
      withType.add(id);
      skusWithType++;
      if (value >= below) continue;
      const sku = listed.get(skuId) || {};
      rows.push({
        product_id: id, title: p.title, sku_id: skuId, sku_code: sku.sku_code ?? null, props: sku.props ?? null,
        stock: value, jit: k.jit, seller: k.seller, warehouse: k.warehouse, total: k.total, lists: p.lists,
      });
    }
  }
  rows.sort((a, b) => a.stock - b.stock || a.product_id.localeCompare(b.product_id) || a.sku_id.localeCompare(b.sku_id));
  return {
    stock_type: STOCK_TYPES[type],
    below,
    scanned: { ...Object.fromEntries(tabs.map((t) => [PRODUCT_TABS[t], totals[t]])), products: products.size },
    with_stock_type: { products: withType.size, skus: skusWithType },
    matched: { skus: rows.length, products: new Set(rows.map((r) => r.product_id)).size, zero: rows.filter((r) => r.stock === 0).length },
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    requests,
  };
}
