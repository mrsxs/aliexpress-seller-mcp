import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { findCategory, flattenMetrics, parseCategories, parseWord, searchCategories } from '../lib/market.mjs';
import { buildAdjustParams, encodeParams, parseOrderPage } from '../lib/orders.mjs';
import { parseProductPage } from '../lib/products.mjs';
import { MtopError } from '../lib/mtop-fetch.mjs';
import { addDays, assertDate, createSellerApi, periodRange, pickAeShop, rankTimes, resolveRange, SellerError, sellerContext } from '../lib/seller.mjs';
import { parseShops, resolveShop, ShopConfigError } from '../lib/shops.mjs';
import { parseCard, parseCountries, parseKeywords, parseRankRow, parseSources, parseToday, parseTrend } from '../lib/store-data.mjs';

test('店铺配置：数组、默认店、按名称或 ID 找店、错误提示', () => {
  const shops = parseShops({ AE_SHOPS: JSON.stringify([{ name: 'A', store_id: '11111111111111' }, { name: 'B', store_id: '22222222222222', default: true }]) });
  assert.equal(resolveShop(shops).name, 'B');
  assert.equal(resolveShop(shops, '11111111111111').name, 'A');
  assert.throws(() => resolveShop(shops, 'C'), /没有找到店铺「C」；已配置：A、B/);
  assert.equal(parseShops({ AE_SHOPS: JSON.stringify([{ store_id: '33333333333333' }]) })[0].isDefault, true);
  assert.deepEqual(parseShops({ AE_STORE_ID: '44444444444444' }).map((s) => s.storeId), ['44444444444444']);
  assert.deepEqual(parseShops({}), []);
  assert.throws(() => resolveShop([]), /还没有配置店铺/);
  assert.equal(resolveShop([], '55555555555555').storeId, '55555555555555');
  for (const [raw, re] of [
    ['{bad', /不是合法 JSON/],
    ['[]', /非空数组/],
    [JSON.stringify([{ name: 'A', store_id: 'x' }]), /store_id/],
    [JSON.stringify([{ name: 'A', store_id: '11111111111111', token: 1 }]), /未知字段 token/],
    [JSON.stringify([{ name: 'A', store_id: '11111111111111' }, { name: 'A', store_id: '22222222222222' }]), /店铺名重复/],
    [JSON.stringify([{ name: 'A', store_id: '11111111111111' }, { name: 'B', store_id: '11111111111111' }]), /店铺 ID 重复/],
    [JSON.stringify([{ name: 'A', store_id: '11111111111111', default: true }, { name: 'B', store_id: '22222222222222', default: true }]), /最多一家/],
  ]) assert.throws(() => parseShops({ AE_SHOPS: raw }), (e) => e instanceof ShopConfigError && re.test(e.message), raw);
});

test('时间口径：区间、太平洋时间、商品排行的北京时间毫秒数', async () => {
  assert.deepEqual(periodRange('recent7', '2026-11-12'), { period: 'recent7', start: '2026-11-06', end: '2026-11-12', days: 7 });
  assert.equal(periodRange('recent30', '2026-11-12').start, '2026-10-14');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.throws(() => assertDate('2026-02-30'), SellerError);
  assert.throws(() => periodRange('week', '2026-11-12'), /period 只能是/);
  // 页面实测值：近 7 天到 11-12 → statDate 1793894400000、endDate 1794499199059
  assert.deepEqual(rankTimes({ start: '2026-11-06', end: '2026-11-12' }), { statDate: 1793894400000, endDate: 1794499199059 });
  const calls = [];
  const latest = async (fresh) => { calls.push(Boolean(fresh)); return '2026-11-12'; };
  assert.equal((await resolveRange({}, latest)).end, '2026-11-12');
  assert.equal((await resolveRange({ period: 'day', date: '2026-11-01' }, latest)).start, '2026-11-01');
  calls.length = 0;
  await assert.rejects(resolveRange({ date: '2026-11-13' }, latest), /最新到 2026-11-12/);
  assert.deepEqual(calls, [false, true], '被拒前重取一次最新日期');
  // 日期格式错先报，不去问接口
  calls.length = 0;
  await assert.rejects(resolveRange({ date: '2026-02-30' }, latest), /YYYY-MM-DD/);
  assert.deepEqual(calls, []);
});

test('卖家后台：从店铺列表取 channelId 和经营模式；x-referer 按接口页面改写；错误翻译', async () => {
  const list = [
    { channelId: 1, channelType: 'LAZADA', shopStatusId: 1 },
    { channelId: 2203, channelType: 'AE', shopModel: 'ONE_STOP_SERVICE', shopName: 'S', shopStatusId: 1, shopStatusName: '营业中' },
  ];
  assert.deepEqual(pickAeShop(list, null), { channelId: '2203', shopModel: 'ONE_STOP_SERVICE', shopName: 'S', status: '营业中' });
  assert.equal(pickAeShop([], null), null);

  const cdp = { evaluate: async () => ({ appKey: '123', query: { 'x-i18n-regionID': 'AE' }, headers: { 'x-referer': 'csp.aliexpress.com/m_apps/home' } }) };
  const seen = [];
  const fakeFetch = async (_cdp, opts) => {
    seen.push(opts);
    if (opts.api === 'mtop.ae.csp.nav.shop.list') return { data: { data: { shopList: list } } };
    if (opts.api === 'bad.login') throw new MtopError('x 失败：FAIL_SYS_SESSION_EXPIRED::Session过期');
    if (opts.api === 'bad.other') throw new MtopError('x 失败：AE-ERR::参数错误');
    if (opts.api === 'bad.transport') throw new Error('Runtime.evaluate 超时 (45000ms)');
    return { data: { ok: true } };
  };
  const ctx = await sellerContext(cdp, fakeFetch);
  assert.equal(ctx.channelId, '2203');
  assert.equal(ctx.shopModel, 'ONE_STOP_SERVICE');
  assert.equal(ctx.query['__channel-id__'], '2203');
  const call = createSellerApi(cdp, ctx, fakeFetch);
  assert.deepEqual(await call({ api: 'x.y', data: {}, page: '/m_apps/sycm/HomeNew' }), { ok: true });
  const last = seen.at(-1);
  assert.equal(last.headers['x-referer'], 'csp.aliexpress.com/m_apps/sycm/HomeNew?channelId=2203');
  assert.equal(last.query.H5Request, 'true');
  await assert.rejects(call({ api: 'bad.login', page: '/a' }), /登录已失效/);
  await assert.rejects(call({ api: 'bad.other', page: '/a' }), /卖家后台接口失败（bad.other）：AE-ERR::参数错误/);
  // 连接类错误不包装成用户错误，调用方据此重建浏览器会话
  await assert.rejects(call({ api: 'bad.transport', page: '/a' }), (e) => !(e instanceof SellerError) && /超时/.test(e.message));
});

test('生意参谋：指标卡片、每日走势（含同行线开关）、来源、今日', () => {
  const card = parseCard({ dataSource: [{ key: 'payAmt', label: '支付金额', value: 452.13, cycleLabel: '较前1日', cycleTarget: 916.98, cycleData: -0.50691, lineLabel: '周同比', lineTarget: 347.63, lineData: 0.3006 }] });
  assert.deepEqual(card[0], { key: 'payAmt', label: '支付金额', value: 452.13, prev_label: '较前1日', prev: 916.98, change: -0.5069, yoy_label: '周同比', yoy: 347.63, yoy_change: 0.3006 });

  const trade = { dataSource: [
    { statDate: '2026-11-02', key: 'payAmt', label: '支付金额', value: 10 }, { statDate: '2026-11-01', key: 'payAmt', label: '支付金额', value: 5.5 },
    { statDate: '2026-11-01', key: 'payAmtGood', value: 99 }, { statDate: '2026-11-01', key: 'payAmtAvg', value: 7 },
  ] };
  const flux = { dataSource: [{ statDate: '2026-11-01', key: 'uv', label: '店铺访客数', value: 100 }, { statDate: '2026-11-02', key: 'uv', label: '店铺访客数', value: 120 }] };
  const t = parseTrend([trade, flux]);
  assert.deepEqual(t.days.map((d) => d.date), ['2026-11-01', '2026-11-02']);
  assert.deepEqual(t.days[0], { date: '2026-11-01', payAmt: 5.5, uv: 100 });
  assert.deepEqual(t.totals, { payAmt: 15.5, uv: 220 });
  assert.deepEqual(parseTrend([trade], { peers: true }).days[0].peer_good, { payAmt: 99 });

  const src = parseSources({ dataSource: [{ sourceDesc: '搜索', uv: 10, uvRate: 0.123456, orderBuyerCnt: 1, orderConvRate: 0.1, sellerAdminSeq: '999' }] });
  assert.deepEqual(src, [{ source: '搜索', visitors: 10, visitor_share: 0.1235, order_buyers: 1, order_conv_rate: 0.1 }]);
  assert.equal(JSON.stringify(src).includes('999'), false);

  const today = parseToday({ data: { updateTime: '2026-11-14 12:00', totalValue: 'USD 1.00', dataItems: [{ name: '支付买家数', value: '3', nameHover: '…' }] } });
  assert.equal(today.updated_at, null);
  assert.deepEqual(today.metrics, [{ label: '支付买家数', value: '3' }]);
});

test('商品排行、单品搜索词（只取全部端 / 国家合计、按支付→访客→曝光排序）、分国家（合计在前）', () => {
  assert.equal(parseRankRow({ itemId: 1, firstOnlineDate: 'bad' }).first_online, null);
  const row = parseRankRow({ itemId: 1005000000000001, title: 't', minPrice: '1.00', maxPrice: '2.00', firstOnlineDate: Date.UTC(2026, 0, 2), payAmt: 9, payConversionRate: 0.076612, avgStayTime: 38.987 });
  assert.equal(row.product_id, '1005000000000001');
  assert.equal(row.price, '1.00~2.00');
  assert.equal(row.first_online, '2026-01-02');
  assert.equal(row.conv_rate, 0.0766);
  assert.equal(row.avg_stay_seconds, 39);

  const kw = parseKeywords({ data: { model: [
    { keyword: 'a', translated: 'a', platform: '-9999', country_id: '-9999', pv: 100, se_ipv_uv: 0, pay_buyer_cnt: 0 },
    { keyword: 'b', translated: 'bee', platform: '-9999', country_id: '-9999', pv: 5, se_ipv_uv: 2, pay_buyer_cnt: 1 },
    { keyword: 'c', platform: '-9999', country_id: '-9999', pv: 50, se_ipv_uv: 3, pay_buyer_cnt: 0 },
    { keyword: 'b', platform: 'APP', country_id: '-9999', pv: 4 },
  ] } });
  assert.deepEqual(kw.map((k) => k.keyword), ['b', 'c', 'a']);
  assert.equal(kw[0].english, 'bee');
  assert.equal(kw[2].english, undefined);

  const countries = parseCountries({ data: { model: [
    { countryId: '挪威', payAmt: 1.9, uv: 5 }, { countryId: '全部国家', payAmt: 100, uv: 900 }, { countryId: '美国', payAmt: 60, uv: 500 },
  ] } });
  assert.deepEqual(countries.map((c) => c.country), ['全部国家', '美国', '挪威']);
});

function orderFixture() {
  const comp = (id, fields) => [id, { id: id.split('_').pop(), fields }];
  const data = Object.fromEntries([
    comp('seller_pc_oml_order_search_1_10', { conditions: [{ type: 'orderStatus', current: { label: '所有订单状态', value: '930' } }, { type: 'orderBusinessType', current: { value: 'all' } }], searchParams: { orderStatus: '930', reset: false } }),
    comp('seller_pc_oml_order_pagination_2_11', { page: 1, pageSize: 10, total: 64, searchParams: { page: 1, pageSize: 10, reset: false } }),
    comp('seller_pc_oml_order_board_3_12', { searchParams: { reset: false } }),
    comp('seller_pc_oml_order_table_header_4_13', {}),
    comp('seller_pc_oml_order_table_5_1', { dataSource: [{
      orderBasic: { basicInfo: [{ label: '订单号', value: '8000000000000002' }, { label: '下单时间', value: '11/13/2026 14:02' }], tags: [{ text: '半托管JIT订单' }] },
      orderStatus: { status: { text: '等待发货', type: 'WAIT_SELLER_SEND_GOODS' } },
      amount: { text: 'US $1,203.09' },
      buyerInfo: { basicInfo: [{ type: 'countryCode', value: 'US' }, { type: 'buyerName', value: 'A**o' }] },
      service: [[{ text: '已取消' }]],
      productInfo: [{ itemTitle: 'Lamp', productProperty: [{ value: 'white' }], skuCode: { value: 'L-1' }, quantity: 2, unitFee: 'US $1.00', subTotalFee: 'US $2.00', url: 'https://x/snapshot.html?tradeOrderLineId=8000000000000003' }],
    }] }),
    comp('seller_pc_oml_order_table_5_0', { dataSource: [{ orderBasic: { basicInfo: [{ label: '订单号', value: '8000000000000001' }] }, productInfo: [] }] }),
  ]);
  return { endpoint: { mode: 'pc' }, hierarchy: { root: 'root_0' }, data,
    linkage: { input: ['seller_pc_oml_order_board_3_12', 'seller_pc_oml_order_search_1_10', 'seller_pc_oml_order_pagination_2_11'], signature: 's' } };
}

test('订单：翻页 / 筛选请求按页面协议构造；解析订单行且不输出买家名', () => {
  const prev = orderFixture();
  const params = buildAdjustParams(prev, { status: 'to_ship', orderType: 'semiChoiceJitOrder', page: 2, pageSize: 20 });
  assert.equal(params.operator, 'seller_pc_oml_order_pagination_2_11');
  assert.deepEqual(Object.keys(params.data).sort(), [...prev.linkage.input].sort());
  assert.deepEqual(params.data.seller_pc_oml_order_pagination_2_11.fields.searchParams, { page: 2, pageSize: 20 });
  const search = params.data.seller_pc_oml_order_search_1_10.fields;
  assert.equal(search.searchParams.orderStatus, '500');
  assert.equal(search.searchParams.orderBusinessType, 'semiChoiceJitOrder');
  assert.deepEqual(search.conditions[0].current, { label: '等待发货', value: '500' });
  // 不改动上一次的返回
  assert.equal(prev.data.seller_pc_oml_order_search_1_10.fields.searchParams.orderStatus, '930');
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(encodeParams(params), 'base64'))), params);
  assert.throws(() => buildAdjustParams({ data: {} }), /结构变了/);

  const page = parseOrderPage(prev);
  assert.equal(page.total, 64);
  assert.deepEqual(page.orders.map((o) => o.order_id), ['8000000000000001', '8000000000000002']);
  const o = page.orders[1];
  assert.equal(o.amount_value, 1203.09);
  assert.equal(o.country, 'US');
  assert.deepEqual(o.notes, ['已取消']);
  assert.deepEqual(o.items[0], { title: 'Lamp', sku: 'white', sku_code: 'L-1', quantity: 2, unit_price: 'US $1.00', subtotal: 'US $2.00', order_line_id: '8000000000000003' });
  assert.equal(JSON.stringify(page).includes('A**o'), false);
});

test('商品列表：普通 / 半托管行和全托管行（供货价 subItems、类目路径）', () => {
  const pop = parseProductPage({ data: {
    pagination: { total: 308 }, tab: { dataSource: [{ value: 'online_product', count: 308 }, { value: 'draft' }] },
    table: { list: [{
      productId: 1005000000000010, itemDesc: { title: 'P', iconList: [{ hoverTip: [{ dataSource: ['<dl><dt>平台活动：</dt><dd>早鸟价7折</dd></dl>'] }] }] },
      price: { minPrice: '7.97', maxPrice: '9.00', currencyCode: 'USD' }, stock: '--', aeMonthSales: '12',
      aeRecentThirtySopData: { aeMonthVisitNum: { number: '995' }, aeMonthConverRate: '1.50%' }, catId: 1, aeNewCreateDesc: Date.UTC(2026, 9, 29),
      subDataSource: [{ skuId: '1', skuCode: 'A', skuPrice: { price: '7.97' }, aePopSkuStock: '5', aePopSkuProps: [{ text: 'red' }] }],
    }] },
  } }, { skus: true });
  assert.deepEqual(pop.tab_counts, { online_product: 308 });
  const p = pop.products[0];
  assert.deepEqual([p.price_min, p.price_max, p.currency, p.month_sales, p.month_visitors, p.month_conv_rate, p.created], [7.97, 9, 'USD', 12, 995, 0.015, '2026-10-29']);
  assert.equal(p.stock, undefined);
  assert.deepEqual(p.activities, ['平台活动：', '早鸟价7折']);
  assert.deepEqual(p.skus, [{ sku_id: '1', sku_code: 'A', price: 7.97, stock: 5, props: 'red' }]);

  const full = parseProductPage({ data: { table: { list: [{
    productId: 1005000000000020, itemDesc: { title: 'F' }, originalCurrencyCode: 'CNY', stock: 0, itemStockingType: 'JIT',
    price: { subItems: [{ uiType: 'strikeThroughText', text: '46.40-124.52' }, { uiType: 'text', text: '23.20-62.26' }, { uiType: 'balloonPrice', text: '区域零售价' }] },
    productCategory: '["玩具","模型拼装"]', selfCreateDesc: Date.UTC(2026, 6, 29),
    subDataSource: [{ skuId: '2', commodityCode: 'B', supplyPrice: '28.00', selfSkuStock: 0, selfSkuProps: [{ text: 'black' }] }],
  }] } } }, { skus: true });
  const f = full.products[0];
  assert.deepEqual([f.price_min, f.price_max, f.currency, f.price_before_discount, f.category, f.created, f.stock, f.stocking_type], [23.2, 62.26, 'CNY', '46.40-124.52', '玩具 / 模型拼装', '2026-07-29', 0, 'JIT']);
  assert.deepEqual(f.skus, [{ sku_id: '2', sku_code: 'B', price: 28, stock: 0, props: 'black' }]);
});

test('市场：类目树、路径、搜索；指标展开；热搜词', () => {
  const list = parseCategories([[0, 26, '玩具', 1], [26, 100, '模型', 2], [100, 101, '火车模型', 3], [0, 322, '鞋子', 1], 'bad']);
  assert.equal(list.length, 4);
  assert.equal(findCategory(list, '101').path, '玩具 / 模型 / 火车模型');
  assert.equal(findCategory(list, 999), null);
  assert.deepEqual(searchCategories(list).categories.map((c) => c.id), [26, 322]);
  assert.deepEqual(searchCategories(list, { query: '模型' }).categories.map((c) => c.id), [100, 101]);
  assert.deepEqual(searchCategories(list, { parentId: 26 }).categories.map((c) => c.id), [100]);
  assert.deepEqual(flattenMetrics({ statDate: { value: 'x' }, uvIndex: { value: 1.23456, cycleCrc: 0.1 }, payPerBuyerAmt: { value: 31.92 } }), { uvIndex: { value: 1.2346, change: 0.1 }, payPerBuyerAmt: 31.92 });
  const w = parseWord({ keyword: { value: 'squishy' }, isBrandWord: { value: 'Y' }, searchCnt: { value: 3011981 }, top3Country: { value: 'FR,US' } });
  assert.deepEqual([w.keyword, w.is_brand, w.searches, w.top_countries], ['squishy', true, 3011981, ['FR', 'US']]);
});
