// lib/stock.mjs：各仓库存拆分、分批查询、补到商品列表、全店低库存扫描（样本是自造的）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachStock, parseStock, queryStock, SCAN_BUDGET_MS, scanLowStock, scanTabs, skuStock, STOCK_BATCH } from '../lib/stock.mjs';
import { SellerError } from '../lib/seller.mjs';

const wh = (type, sellableStock, name = type) => ({ warehouseType: type, warehouseName: name, sellableStock });

test('一个 SKU 的各仓库存：JIT / 商家仓 / 优选仓分开，没有的仓是 null，未知仓只算进合计', () => {
  const s = skuStock([wh('dropshipping', 5000, '商家仓'), wh('jit_warehouse', 3, '杭州JIT库存'), wh('own_warehouse', 2), wh('own_warehouse', '4'), wh('bonded', 1)], '1');
  assert.deepEqual({ jit: s.jit, seller: s.seller, warehouse: s.warehouse, total: s.total }, { jit: 3, seller: 5000, warehouse: 6, total: 5010 });
  assert.equal(s.warehouses.length, 5);
  assert.equal(s.warehouses.at(-1).type, 'bonded');
  const onlySeller = skuStock([wh('dropshipping', 0)], '2');
  assert.equal(onlySeller.jit, null);
  assert.equal(onlySeller.seller, 0);
  assert.throws(() => skuStock([wh('jit_warehouse', null)], '3'), (e) => e instanceof SellerError && /SKU 3/.test(e.message));
  assert.throws(() => skuStock([wh('jit_warehouse', '')], '4'), SellerError);
  assert.throws(() => skuStock(null, '5'), /没有仓库记录/);
});

test('解析库存接口：缺商品、缺 model 都报错，不当成没库存', () => {
  const d = { model: { 11: { productStock: 7, skuStocksMap: { 111: [wh('jit_warehouse', 7)] } } } };
  const m = parseStock(d, ['11']);
  assert.equal(m.get('11').product_stock, 7);
  assert.equal(m.get('11').skus['111'].jit, 7);
  assert.throws(() => parseStock(d, ['11', '12']), /没有返回商品 12/);
  assert.throws(() => parseStock({}, ['11']), /没有 model/);
  assert.throws(() => parseStock({ model: { 11: { productStock: 1 } } }, ['11']), /没有返回商品 11/);
});

function stockApi(stockOf) {
  const calls = [];
  const call = async ({ api, page, data }) => {
    calls.push({ api, page, data });
    const ids = JSON.parse(data.productIds.replace(/(\d+)/g, '"$1"'));
    return { model: Object.fromEntries(ids.map((id) => [id, stockOf(id)])) };
  };
  return { call, calls };
}

test('按商品查库存：每批最多 50 个，ID 原样传（不丢精度），批间停顿', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => String(9007199254740993n + BigInt(i)));
  const { call, calls } = stockApi(() => ({ productStock: 1, skuStocksMap: {} }));
  let pauses = 0;
  const out = await queryStock(call, [...ids, ids[0]], { pause: async () => { pauses++; } });
  assert.equal(out.size, 120);
  assert.deepEqual(calls.map((c) => c.data.productIds.split(',').length), [STOCK_BATCH, STOCK_BATCH, 20]);
  assert.ok(calls[0].data.productIds.startsWith('[9007199254740993,'));
  assert.equal(calls[0].api, 'mtop.item.global.merchant.product.stock.query');
  assert.equal(pauses, 2);
  await assert.rejects(queryStock(call, ['1&x=2']), /商品 ID 格式不对/);
});

test('商品列表补库存：总库存 + 每个 SKU 的合计和各仓', () => {
  const stock = parseStock({ model: { 11: { productStock: 15, skuStocksMap: { 111: [wh('dropshipping', 10), wh('jit_warehouse', 5)] } } } }, ['11']);
  const [p] = attachStock([{ product_id: '11', title: 'A', skus: [{ sku_id: '111' }] }], stock);
  assert.equal(p.stock, 15);
  assert.deepEqual(p.skus[0], { sku_id: '111', stock: 15, stock_jit: 5, stock_seller: 10 });
  assert.throws(() => attachStock([{ product_id: '12' }], stock), /没有返回商品 12/);
  // 列表里的 SKU 库存接口没给：报错，不悄悄跳过
  assert.throws(() => attachStock([{ product_id: '11', skus: [{ sku_id: '111' }, { sku_id: '112' }] }], stock), /商品 11 的 SKU 112/);
});

// 假的卖家后台：商品列表两个标签页 + 库存接口
function fakeShop({ online, choice, stockOf, totals = {} }) {
  const calls = [];
  const page = (rows, total, pageNo, size) => ({
    data: {
      table: { dataSource: rows.slice((pageNo - 1) * size, pageNo * size).map((r) => ({ productId: r.id, itemDesc: { title: r.title }, subDataSource: r.skus.map((s) => ({ skuId: s.id, skuCode: s.code, aePopSkuProps: [{ text: s.props }] })) })) },
      pagination: { total },
    },
  });
  const call = async (req) => {
    calls.push(req);
    if (req.api === 'mtop.item.manage.productlist.query') {
      const { pageNo, pageSize } = JSON.parse(req.data.pageInfo);
      return page(online, totals.online ?? online.length, pageNo, pageSize);
    }
    if (req.api === 'mtop.global.merchant.new.product.manager.render.list') {
      const { pagination } = JSON.parse(req.data.jsonBody);
      return page(choice, totals.choice ?? choice.length, pagination.current, pagination.pageSize);
    }
    const ids = req.data.productIds.slice(1, -1).split(',');
    return { model: Object.fromEntries(ids.map((id) => [id, stockOf(id)])) };
  };
  return { call, calls };
}

const product = (id, skuCount = 1) => ({ id, title: `T${id}`, skus: Array.from({ length: skuCount }, (_, i) => ({ id: `${id}0${i}`, code: `C${id}-${i}`, props: `P${i}` })) });

test('全店低库存扫描：两个标签页去重，只看有这类仓的 SKU，按库存从少到多', async () => {
  const online = Array.from({ length: 60 }, (_, i) => product(String(1000 + i)));
  const choice = [product('1000'), product('2000', 2)];
  const stockOf = (id) => {
    if (id === '2000') return { productStock: 3, skuStocksMap: { 200000: [wh('jit_warehouse', 0)], 200001: [wh('jit_warehouse', 3), wh('own_warehouse', 9)] } };
    if (id === '1001') return { productStock: 4, skuStocksMap: { 100100: [wh('jit_warehouse', 4)] } };
    if (id === '1002') return { productStock: 0, skuStocksMap: { 100200: [wh('dropshipping', 0)] } }; // 没有 JIT 仓：不算
    return { productStock: 99, skuStocksMap: { [`${id}00`]: [wh('jit_warehouse', 5)] } };
  };
  const { call, calls } = fakeShop({ online, choice, stockOf });
  let pauses = 0;
  const out = await scanLowStock(call, { shopModel: 'POP', channelId: '1' }, { pause: async () => { pauses++; } });
  assert.deepEqual(out.scanned, { 正在销售: 60, '半托管·正在销售': 2, products: 61 });
  assert.deepEqual(out.with_stock_type, { products: 60, skus: 61 });
  assert.deepEqual(out.matched, { skus: 3, products: 2, zero: 1 });
  assert.deepEqual(out.rows.map((r) => [r.sku_id, r.stock]), [['200000', 0], ['200001', 3], ['100100', 4]]);
  assert.deepEqual(out.rows[1], { product_id: '2000', title: 'T2000', sku_id: '200001', sku_code: 'C2000-1', props: 'P1', stock: 3, jit: 3, seller: null, warehouse: 9, total: 12, lists: ['半托管·正在销售'] });
  // 商品列表 2 页 + 半托管 1 页 + 库存 2 批（61 个商品）
  assert.equal(out.requests, 5);
  assert.equal(calls.length, 5);
  assert.equal(pauses, 4);
  assert.equal(out.truncated, false);

  const byTotal = await scanLowStock(call, { shopModel: 'POP' }, { type: 'total', below: 1 });
  assert.deepEqual(byTotal.rows.map((r) => r.sku_id), ['100200', '200000']);
  const limited = await scanLowStock(call, { shopModel: 'POP' }, { limit: 1 });
  assert.equal(limited.rows.length, 1);
  assert.equal(limited.truncated, true);
  assert.equal(limited.matched.skus, 3);
  await assert.rejects(scanLowStock(call, { shopModel: 'POP' }, { type: 'nope' }), /stock_type 只能是/);
});

test('全店扫描：翻页期间数量对不上就报错；全托管店只扫正在销售', async () => {
  const stockOf = (id) => ({ productStock: 1, skuStocksMap: { [`${id}00`]: [wh('dropshipping', 1)] } });
  const short = fakeShop({ online: [product('1'), product('2')], choice: [], stockOf, totals: { online: 3 } });
  await assert.rejects(scanLowStock(short.call, { shopModel: 'POP' }), /取到 2 个商品，和后台总数 3 对不上/);
  const full = fakeShop({ online: [product('1')], choice: [product('2')], stockOf });
  const out = await scanLowStock(full.call, { shopModel: 'ONE_STOP_SERVICE' });
  assert.deepEqual(scanTabs('ONE_STOP_SERVICE'), ['online_product']);
  assert.equal(out.scanned.products, 1);
  assert.ok(!full.calls.some((c) => c.api === 'mtop.global.merchant.new.product.manager.render.list'));
});

test('全店扫描：翻页重复的商品不能顶替漏掉的；库存缺 SKU 报错；超时停下说明', async () => {
  const stockOf = (id) => ({ productStock: 1, skuStocksMap: { [`${id}00`]: [wh('jit_warehouse', 1)] } });
  // 后台总数 51：第 2 页重复了第 1 个商品，第 51 个没给
  const ids = [...Array.from({ length: 50 }, (_, i) => String(1000 + i)), '1000'];
  const dup = fakeShop({ online: ids.map((id) => product(id)), choice: [], stockOf });
  await assert.rejects(scanLowStock(dup.call, { shopModel: 'POP' }), /取到 50 个商品，和后台总数 51 对不上/);

  // 列表有 2 个 SKU，库存只给 1 个
  const partial = fakeShop({ online: [product('7', 2)], choice: [], stockOf: () => ({ productStock: 10, skuStocksMap: { 700: [wh('jit_warehouse', 10)] } }) });
  await assert.rejects(scanLowStock(partial.call, { shopModel: 'POP' }), /商品 7 的 SKU 701/);

  // 同一标签页重复出现不会把标签页名记两次
  const twice = fakeShop({ online: [product('8'), product('8')], choice: [], stockOf, totals: { online: 1 } });
  const ok = await scanLowStock(twice.call, { shopModel: 'POP' }, { below: 2 });
  assert.deepEqual(ok.rows.map((r) => r.lists), [['正在销售']]);

  // 时间花在请求和停顿里（不是花在看表上）：每次请求 30 秒、停顿 10 秒；第 3 次请求前已过 80 秒 > 70 秒，停下
  let t = 0;
  const slow = fakeShop({ online: Array.from({ length: 120 }, (_, i) => product(String(3000 + i))), choice: [], stockOf });
  const timed = async (req) => { t += 30_000; return slow.call(req); };
  await assert.rejects(
    scanLowStock(timed, { shopModel: 'POP' }, { deadline: 70_000, now: () => t, pause: async () => { t += 10_000; } }),
    /时限内没扫完（已取 100 个商品、发了 2 次请求）/,
  );
  assert.equal(slow.calls.length, 2);
  assert.ok(SCAN_BUDGET_MS < 120_000);

  // 单个请求卡住（比如内部重试）：到截止时间立即停，不等它
  const started = Date.now();
  let seenSignal;
  const hang = async (req) => { seenSignal = req.signal; return new Promise(() => {}); };
  await assert.rejects(scanLowStock(hang, { shopModel: 'POP' }, { deadline: Date.now() + 3_150 }), /时限内没扫完（已取 0 个商品、发了 1 次请求）/);
  // 截止后请求的取消信号已触发：mtopFetch 不会再发令牌重试
  assert.equal(seenSignal.aborted, true);
  const took = Date.now() - started;
  assert.ok(took >= 3_000 && took < 4_500, `应在截止时间（约 3.15 秒）停下，实际 ${took} ms`);
});
