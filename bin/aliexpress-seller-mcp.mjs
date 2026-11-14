#!/usr/bin/env node
// 速卖通卖家 MCP（stdio）：店铺经营数据 / 订单 / 商品 / 市场数据 + 图搜竞品比价与监控。
// 全部通过本机紫鸟店铺浏览器里已登录的页面取数（不走开放平台、不需要 AppKey）：
//   卖家数据：在卖家后台标签页里调后台自己的接口；比价：在买家前台标签页里图搜。
// 只读：不改价、不改商品、不发货；唯一的写操作是本机的监控数据（ae_watch_create / ae_watch_run）。
// 协议：每行一条 JSON-RPC 2.0 消息；stdout 只写协议消息，诊断写 stderr。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { assertFileId } from '../lib/aliexpress.mjs';
import { withBrowserLock } from '../lib/browser-lock.mjs';
import { BUYER_SITE, PageBlockedError, SELLER_SITE, createBrowserSession } from '../lib/browser.mjs';
import { CooldownError, createCooldown, isVerifyMessage, optional } from '../lib/cooldown.mjs';
import { ImageInputError, loadImage } from '../lib/image-input.mjs';
import { findCategory, loadCategories, marketOverview, searchCategories, searchWords, WORD_ORDER } from '../lib/market.mjs';
import { computeNextRun, createMonitor } from '../lib/monitor.mjs';
import { listOrders, orderCounts, ORDER_STATUS, ORDER_TYPES, PAGE_SIZES } from '../lib/orders.mjs';
import { listProducts, PRODUCT_TABS } from '../lib/products.mjs';
import { DEFAULT_REGIONS, validateRegions } from '../lib/regions.mjs';
import { EVENT_TYPES, PRICE_NOTE, QueryError, changeEvents, latestPrices, listWatches, priceHistory, resolveWatch, summarizeRegions } from '../lib/scout-query.mjs';
import { collectImageSearch } from '../lib/search-runner.mjs';
import {
  assertDate, CHANNEL_READ_FAILED, contextStale, createSellerApi, PERIODS, resolveRange, SellerError, sellerContext, SHOP_MODELS,
} from '../lib/seller.mjs';
import { ShopConfigError, parseShops, resolveShop } from '../lib/shops.mjs';
import { latestStatDate, productAnalysis, productRank, RANK_BY, SOURCE_PLATFORMS, storeOverview, storeToday, storeTrend, trafficSources } from '../lib/store-data.mjs';
import { validateWatchPatch } from '../lib/watch-validate.mjs';
import { assertWatchId, createWatchStore } from '../lib/watch-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const DATA_DIR = process.env.AE_DATA_DIR || process.env.AE_SCOUT_DATA || join(homedir(), '.aliexpress-seller-mcp');
const store = createWatchStore(DATA_DIR);

// 配置错误不让进程退出（客户端只会显示 exited with code 1），而是在每次调用时说明
let SHOPS = [];
let configError = null;
try {
  SHOPS = parseShops();
} catch (err) {
  configError = err;
  process.stderr.write(`[aliexpress-seller-mcp] ${err.message}\n`);
}
const shopFor = (ref) => {
  if (configError) throw configError;
  return resolveShop(SHOPS, ref);
};

// ---- 浏览器：每个（站点, 紫鸟店铺）一个会话；本进程内排队，跨进程用数据目录里的锁文件 ----
const sessions = new Map();
const sessionFor = (site, storeId) => {
  const key = `${site.urlPrefix}|${storeId}`;
  if (!sessions.has(key)) sessions.set(key, createBrowserSession(site));
  return sessions.get(key);
};
let queue = Promise.resolve();
const exclusive = (fn) => {
  const run = queue.then(() => withBrowserLock(DATA_DIR, fn, { owner: `aliexpress-seller-mcp ${process.pid}` }));
  queue = run.catch(() => {});
  return run;
};

// 某家店触发速卖通安全验证后冷却 10 分钟（买家前台、卖家后台共用；记在数据目录，别的进程也看得到）
const cooldown = createCooldown({ dir: DATA_DIR });
const shopLabel = (storeId) => SHOPS.find((s) => s.storeId === storeId) ?? { storeId, name: storeId };
const noteIfVerify = (shop, err) => {
  if (isVerifyMessage(err?.message)) cooldown.note(shop, err);
};

const collect = (input) => exclusive(async () => {
  const shop = shopLabel(input.storeId);
  cooldown.check(shop);
  try {
    return await collectImageSearch(sessionFor(BUYER_SITE, input.storeId), input);
  } catch (err) {
    noteIfVerify(shop, err);
    throw err;
  }
});
// 监控只借用 runWatch（立即跑一轮）；定时由调用方（如定时任务）负责，这里不启动定时器
const monitor = createMonitor({
  store, runSearch: ({ storeId, fileId, regions }) => collect({ storeId, fileId, regions, image: null }), notify: () => {},
  // 同一个监控同一时间只跑一轮（跨进程）；另一个进程正在跑就很快放弃
  withRunLock: (id, fn) => withBrowserLock(DATA_DIR, fn, { owner: `aliexpress-seller-mcp ${process.pid} 监控 ${id}`, key: `watch:${id}`, waitMs: 5_000 }),
});

// 店铺上下文（channelId、经营模式）和最新出数日期缓存 10 分钟
const CTX_TTL_MS = 10 * 60_000;
const ctxCache = new Map();
const latestCache = new Map();
const cached = async (map, key, load) => {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < CTX_TTL_MS) return hit.value;
  const value = await load();
  map.set(key, { at: Date.now(), value });
  return value;
};

const isUserError = (err) => err instanceof QueryError || err instanceof SellerError || err instanceof ShopConfigError || err instanceof ImageInputError
  || err instanceof CooldownError || err instanceof PageBlockedError;

/** 在某家店的卖家后台里执行：fn({ call, ctx, latest }) */
async function withSeller(shopRef, fn) {
  const shop = shopFor(shopRef);
  return exclusive(async () => {
    cooldown.check(shop);
    const session = sessionFor(SELLER_SITE, shop.storeId);
    try {
      const cdp = await session.connect(shop.storeId);
      // 用户可能在同一个浏览器里切了后台店铺：页面当前的 channel 和缓存的不一样就重取店铺上下文
      const raw = await cdp.evaluate("(window.mtopConfig && window.mtopConfig.queryStringParameters && window.mtopConfig.queryStringParameters['__channel-id__']) || ''", 5000).catch(() => CHANNEL_READ_FAILED);
      const pageChannel = raw === CHANNEL_READ_FAILED ? null : String(raw ?? '');
      const hit = ctxCache.get(shop.storeId);
      if (hit && contextStale(hit.value.pageChannel, raw)) ctxCache.delete(shop.storeId);
      const ctx = await cached(ctxCache, shop.storeId, async () => ({ ...(await sellerContext(cdp)), pageChannel }));
      const call = createSellerApi(cdp, ctx);
      // fresh=true：太平洋时间刚过零点时缓存的「最新日期」可能旧了，被拒前重取一次
      const latest = (fresh = false) => {
        if (fresh) latestCache.delete(ctx.channelId);
        return cached(latestCache, ctx.channelId, () => latestStatDate(call, ctx));
      };
      const out = await fn({ call, ctx, latest });
      return { shop: shop.name, store_name: ctx.shopName, shop_model: SHOP_MODELS[ctx.shopModel] ?? ctx.shopModel, ...out };
    } catch (err) {
      noteIfVerify(shop, err);
      if (!(err instanceof QueryError)) ctxCache.delete(shop.storeId);
      if (!isUserError(err)) session.reset();
      throw err;
    }
  });
}

/** 参数校验函数抛的是普通 Error，转成用户错误（不打印堆栈） */
const userInput = (fn) => {
  try {
    return fn();
  } catch (err) {
    throw new QueryError(err.message);
  }
};

const PRODUCT_ID = /^\d{6,20}$/;
/** 进浏览器排队之前先查参数，错了立刻返回（不用等锁、不连浏览器） */
function precheck(a) {
  if (a.date !== undefined) userInput(() => assertDate(a.date));
  if (a.product_id !== undefined && !PRODUCT_ID.test(a.product_id)) throw new QueryError('product_id 应是速卖通商品 ID（数字）');
  if (a.order_id !== undefined && !/^\d{10,25}$/.test(a.order_id)) throw new QueryError('order_id 应是订单号（数字）');
  if (a.category_id !== undefined && !/^\d{1,12}$/.test(a.category_id)) throw new QueryError('category_id 应是数字类目 ID（用 ae_categories 查）');
  if (a.country !== undefined && !/^(ALL|[A-Z]{2})$/.test(a.country)) throw new QueryError('country 应是两位国家代码（如 US），或 ALL');
}

const RANGE_NOTE = '日期是美国太平洋时间（生意参谋口径）；金额 USD，支付金额含平台代收税费。';
const rangeOut = (r) => ({ period: r.period, start: r.start, end: r.end });

// ---- 图搜比价 / 监控 ----
async function searchNow(a) {
  if (!a.image && !a.file_id) throw new QueryError('请提供 image（本地绝对路径 / 图片链接 / data URL）或 file_id（之前上传返回的）。');
  const { storeId, name } = shopFor(a.shop);
  const regions = userInput(() => validateRegions(a.regions ?? ['US', 'DE', 'GB']));
  const fileId = a.file_id ? userInput(() => assertFileId(a.file_id)) : null;
  const image = fileId ? null : await loadImage(a.image);
  const out = await collect({ storeId, fileId, regions, image });
  return {
    shop: name, file_id: out.fileId, elapsed_ms: out.ms,
    regions_captured: Object.keys(out.results), region_errors: out.errors, warnings: out.warnings,
    sorted_by: a.sort ?? 'rank', regions: summarizeRegions(out.results, { limit: a.limit ?? 10, sort: a.sort ?? 'rank' }),
    note: `file_id 可用于再次比价或建监控（ae_watch_create），不用重新上传图片。${PRICE_NOTE}`,
  };
}

/** 监控 ID：w + 毫秒时间 + 3 位随机数（同一毫秒并发创建也基本不撞；撞了由排他建目录发现） */
const newWatchId = (now) => `w${now}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;

async function createWatch(a) {
  const fileId = userInput(() => assertFileId(a.file_id));
  // 先读图片：读失败时不能留下一个已经建好的监控
  const image = a.image ? await loadImage(a.image) : null;
  const now = Date.now();
  const base = {
    id: newWatchId(now), storeId: shopFor(a.shop).storeId, fileId, createdAt: now, createdBy: 'MCP',
    enabled: true, notify: true, startAt: null, lastRunAt: null, lastStatus: '', lastError: '', snapshotCount: 0,
    ...userInput(() => validateWatchPatch({ name: a.name, intervalMin: a.interval_min ?? 60, regions: a.regions ?? ['US', 'DE', 'GB'] }, { partial: false })),
  };
  // ID 撞了（同一毫秒并发创建）就换一个：saveWatch 排他建目录，不会覆盖已有监控
  let watch;
  for (let i = 0; ; i++) {
    try {
      watch = await store.saveWatch({ ...base, nextRunAt: computeNextRun(base, now) });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' || i >= 4) throw err;
      base.id = newWatchId(now);
    }
  }
  if (image) await store.saveImage(watch.id, image);
  return { watch: { id: watch.id, name: watch.name, store_id: watch.storeId, regions: watch.regions, interval_min: watch.intervalMin },
    next: '用 ae_watch_run 立即跑第一轮；之后按间隔定时调用 ae_watch_run。' };
}

async function runWatchNow(a) {
  const watch = await resolveWatch(store, a.watch);
  assertWatchId(watch.id);
  if (monitor.isRunning(watch.id)) throw new QueryError(`监控「${watch.name}」正在本进程里抓取，请稍后。`);
  const result = await monitor.runWatch(watch.id);
  if (result?.error) throw new QueryError(`监控「${watch.name}」这一轮失败：${result.error}`);
  const after = await store.getWatch(watch.id);
  const events = (await store.loadEvents(watch.id)).filter((e) => e.ts === after.lastRunAt);
  const latest = await latestPrices(store, after, { limit: a.limit ?? 5 });
  return {
    watch: { id: after.id, name: after.name }, status: after.lastStatus, error: after.lastError || null,
    new_events: events.map((e) => ({ type: e.type, region: e.region, text: e.text, product_id: e.productId ?? null, title: e.title?.slice(0, 120) ?? null })),
    snapshot: latest.snapshot, regions_captured: latest.regions_captured, regions: latest.regions, note: latest.note,
  };
}

// ---- 卖家数据 ----
const overview = (a) => withSeller(a.shop, async ({ call, ctx, latest }) => {
  const range = await resolveRange(a, latest);
  return { ...rangeOut(range), ...(await storeOverview(call, ctx, range)), note: `${RANGE_NOTE}prev = 上一个同长度周期，yoy = 上周同期（只有单日有）；change 是变化比例。` };
});

const trend = (a) => withSeller(a.shop, async ({ call, ctx, latest }) => {
  const range = await resolveRange({ period: 'recent30', date: a.date }, latest);
  const out = await storeTrend(call, ctx, range.end, { peers: a.include_peers === true });
  return { start: out.days[0]?.date ?? range.start, end: range.end, ...out,
    note: `${RANGE_NOTE}每日一行；totals 是按天加总（访客数按天去重后直接相加）。${a.include_peers ? 'peer_good / peer_avg 是页面上的同行优秀 / 同行平均线。' : ''}` };
});

const today = (a) => withSeller(a.shop, async ({ call }) => ({ ...(await storeToday(call)), note: '美国太平洋时间今天到目前为止（卖家后台首页「店铺数据」卡片）。' }));

const sources = (a) => withSeller(a.shop, async ({ call, ctx, latest }) => {
  const range = await resolveRange(a, latest);
  const out = await trafficSources(call, ctx, range, a.product_id);
  return { ...rangeOut(range), product_id: a.product_id ?? null, platforms: SOURCE_PLATFORMS, ...out,
    note: `${RANGE_NOTE}分 APP 和非 APP 两端；同一访客可能来自多个渠道，各渠道访客数相加会大于总访客数。` };
});

const rank = (a) => withSeller(a.shop, async ({ call, ctx, latest }) => {
  const range = await resolveRange(a, latest);
  const out = await productRank(call, ctx, range, { rankBy: a.rank_by ?? 'pay_amt', page: a.page ?? 1, pageSize: a.page_size ?? 20 });
  return { ...rangeOut(range), rank_by: a.rank_by ?? 'pay_amt', page: a.page ?? 1, ...out, note: `${RANGE_NOTE}*_change 是较上一周期的变化比例。` };
});

const analysis = (a) => withSeller(a.shop, async ({ call, ctx, latest }) => {
  const range = await resolveRange({ period: a.period ?? 'recent30', date: a.date }, latest);
  const out = await productAnalysis(call, ctx, range, a.product_id, { sections: a.sections ?? ['keywords', 'countries', 'sources'], limit: a.limit ?? 20 });
  return { ...rangeOut(range), product_id: a.product_id, ...out,
    note: `${RANGE_NOTE}keywords：买家搜哪些词看到 / 买了这个商品（exposure 搜索曝光，visitors 词引导访客）；countries 第一行是全部国家合计；sources 分 APP / 非 APP。` };
});

const orders = (a) => {
  const page = a.page ?? 1;
  const pageSize = a.page_size ?? 20;
  // 后台列表最多翻到 5000 条：超出的页直接说明，不去请求
  if ((page - 1) * pageSize >= 5000) throw new QueryError(`订单列表最多翻到第 5000 条（page × page_size）：page_size=${pageSize} 时 page 最大 ${Math.ceil(5000 / pageSize)}`);
  return ordersInBrowser(a);
};

const ordersInBrowser = (a) => withSeller(a.shop, async ({ call, ctx }) => {
  const opts = { status: a.status ?? 'all', orderType: a.order_type ?? 'all', page: a.page ?? 1, pageSize: a.page_size ?? 20, orderId: a.order_id };
  // 一个接一个发；计数拿不到不影响列表，但安全验证 / 登录失效要整体停下
  const list = await listOrders(call, ctx, opts);
  const counts = await optional(orderCounts(call, ctx), (err) => ({ error: `计数没取到：${err.message}` }));
  return { status: ORDER_STATUS[opts.status][1], order_type: ORDER_TYPES[opts.orderType], ...list, counts,
    note: '下单时间是美国太平洋时间；列表最多翻到 5000 条（后台限制）。买家名不输出。counts 是订单看板的待办计数。' };
});

const products = (a) => withSeller(a.shop, async ({ call, ctx }) => {
  const tab = a.tab ?? 'online_product';
  const out = await listProducts(call, ctx, { tab, page: a.page ?? 1, pageSize: a.page_size ?? 20, skus: a.include_skus === true });
  return { tab: PRODUCT_TABS[tab], page: a.page ?? 1, ...out,
    note: 'month_* 是商品管理页给的近 30 天数据；半托管商品用 choice_* 标签页，全托管店用 online_product 等普通标签页。' };
});

const categoryOf = async (call, ctx, id) => {
  const cat = findCategory(await loadCategories(call, ctx), id);
  if (!cat) throw new QueryError(`没有类目 ${id}；用 ae_categories 按名称查类目 ID`);
  return cat;
};

const categories = (a) => withSeller(a.shop, async ({ call, ctx }) => ({
  ...searchCategories(await loadCategories(call, ctx), { query: a.query, parentId: a.parent_id, limit: a.limit ?? 50 }),
  note: '生意参谋的类目树（中文名）；id 用于 ae_market_overview / ae_search_words。',
}));

const market = (a) => withSeller(a.shop, async ({ call, ctx, latest }) => {
  const range = await resolveRange(a, latest);
  const cat = await categoryOf(call, ctx, a.category_id);
  const out = await marketOverview(call, ctx, range, cat, { country: a.country ?? 'ALL', limit: a.limit ?? 10 });
  return { ...rangeOut(range), category: { id: cat.id, path: cat.path, level: cat.level }, country: a.country ?? 'ALL', ...out,
    note: `${RANGE_NOTE}整个类目的数据（指数化，不是本店）；change 是较上一周期变化比例。` };
});

const words = (a) => withSeller(a.shop, async ({ call, ctx, latest }) => {
  const range = await resolveRange(a, latest);
  const cat = await categoryOf(call, ctx, a.category_id);
  const out = await searchWords(call, ctx, range, cat, { country: a.country ?? 'ALL', orderBy: a.order_by ?? 'searches', page: a.page ?? 1, pageSize: a.page_size ?? 20 });
  return { ...rangeOut(range), category: { id: cat.id, path: cat.path }, country: a.country ?? 'ALL', order_by: a.order_by ?? 'searches', ...out,
    note: `${RANGE_NOTE}类目下买家的搜索词：searches 搜索次数、searchers 搜索人数、supply_demand 供需比、searches_change 搜索量变化。` };
});

const shops = () => {
  if (configError) throw configError;
  return {
    shops: SHOPS.map((s) => ({ name: s.name, store_id: s.storeId, default: s.isDefault })),
    data_dir: DATA_DIR.startsWith(homedir()) ? `~${DATA_DIR.slice(homedir().length)}` : DATA_DIR,
    note: SHOPS.length ? '工具里的 shop 参数填店铺名或紫鸟店铺 ID；不填 = 默认店。' : '没有配置店铺：设置 AE_SHOPS（JSON 数组）或 AE_STORE_ID。',
  };
};

const INSTRUCTIONS = '速卖通卖家数据（通过本机紫鸟店铺浏览器里已登录的卖家后台取数，不走开放平台，只读）。'
  + '店铺经营：ae_store_overview（支付金额 / 买家 / 转化 / 访客等核心指标，单日或近 7 / 30 天，带环比）、ae_store_trend（近 30 天每日）、ae_store_today（今天实时）、'
  + 'ae_traffic_sources（流量来源）、ae_product_rank（商品排行）、ae_product_analysis（单品：搜索词 / 国家 / 来源）。'
  + '订单 ae_orders，商品 ae_products。市场：ae_categories 查类目 ID → ae_market_overview（类目大盘）、ae_search_words（类目热搜词）。'
  + '竞品比价：ae_search 用商品图在买家前台按国家图搜；长期跟踪 ae_watch_create + 定时 ae_watch_run，查询 ae_watches / ae_latest / ae_history / ae_events。'
  + '多店铺：ae_shops 列出已配置的店，其他工具用 shop 参数选店（店铺名或紫鸟店铺 ID），比较多家店时逐店调用。'
  + '生意参谋日期是美国太平洋时间，最新通常到昨天；全托管店没有订单接口。';

// ---- 工具定义 ----
const shopArg = { type: 'string', description: '店铺名或紫鸟店铺 ID；不填 = 默认店（见 ae_shops）' };
const watchArg = { type: 'string', description: '监控 ID 或名称；只有一个监控时可不填' };
const regionsArg = { type: 'array', items: { type: 'string' }, description: `收货国家代码数组，默认 ["US","DE","GB"]；常用 ${DEFAULT_REGIONS.join('、')}` };
const regionArg = { type: 'string', description: '收货国家代码，如 US、DE、GB、FR、ES' };
const periodArg = { type: 'string', enum: PERIODS, default: 'recent7', description: 'day 单日 / recent7 近 7 天 / recent30 近 30 天（都以 date 为最后一天）' };
const dateArg = { type: 'string', description: '统计区间的最后一天 YYYY-MM-DD（美国太平洋时间）；不填 = 生意参谋最新出数日（通常是昨天）' };
const pageArg = { type: 'integer', minimum: 1, maximum: 500, default: 1 };
const productIdArg = { type: 'string', description: '速卖通商品 ID' };
const categoryArg = { type: 'string', description: '类目 ID（用 ae_categories 查）' };
const countryArg = { type: 'string', description: '国家代码（如 US、FR、BR）；不填 = 全部国家（ALL）' };

const LOCAL_RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const BROWSER_RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });

const TOOLS = [
  { name: 'ae_shops', description: '列出已配置的速卖通店铺（名称、紫鸟店铺 ID、哪家是默认店）和本机数据目录。', annotations: LOCAL_RO, inputSchema: obj({}), run: shops },
  {
    name: 'ae_store_overview',
    description: '店铺核心指标（生意参谋）：支付金额、支付买家数、支付转化率、客单价、支付订单数、支付件数，以及店铺访客数、浏览量、跳失率、新访客数；'
      + '单日或近 7 / 30 天，带较上一周期变化（单日还有周同比）。',
    annotations: BROWSER_RO, inputSchema: obj({ shop: shopArg, period: periodArg, date: dateArg }), run: overview,
  },
  {
    name: 'ae_store_trend',
    description: '店铺近 30 天每日数据：支付金额、买家数、转化率、客单价、订单数、件数、访客数、浏览量，附区间合计；可选同行优秀 / 平均线。',
    annotations: BROWSER_RO,
    inputSchema: obj({ shop: shopArg, date: { ...dateArg, description: '最后一天 YYYY-MM-DD；不填 = 最新出数日' }, include_peers: { type: 'boolean', default: false, description: '附上每天的同行优秀 / 同行平均值' } }),
    run: trend,
  },
  { name: 'ae_store_today', description: '店铺今天（美国太平洋时间）到目前为止的实时数据：支付金额、浏览量、访客数、支付买家数、支付转化率。', annotations: BROWSER_RO, inputSchema: obj({ shop: shopArg }), run: today },
  {
    name: 'ae_traffic_sources',
    description: '流量来源（搜索、导购频道、推荐、会场、基础工具〔购物车 / 订单页等〕、站外…）：各来源访客数、占比、下单买家数、下单转化率，分 APP / 非 APP。'
      + '传 product_id 看单个商品，不传看全店。',
    annotations: BROWSER_RO, inputSchema: obj({ shop: shopArg, period: periodArg, date: dateArg, product_id: productIdArg }), run: sources,
  },
  {
    name: 'ae_product_rank',
    description: '商品排行（生意参谋）：按支付金额 / 访客 / 收藏 / 加购排序，每个商品的支付金额、件数、买家、访客、浏览、搜索曝光、转化率、加购 / 收藏人数、退款、停留时长和环比。',
    annotations: BROWSER_RO,
    inputSchema: obj({
      shop: shopArg, period: periodArg, date: dateArg,
      rank_by: { type: 'string', enum: Object.keys(RANK_BY), default: 'pay_amt', description: 'pay_amt 支付金额 / visitors 访客 / wishlist 收藏 / add_to_cart 加购' },
      page: pageArg, page_size: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    }),
    run: rank,
  },
  {
    name: 'ae_product_analysis',
    description: '单个商品的深入分析：keywords 买家用哪些搜索词看到 / 买了它（曝光、访客、支付、转化，带英文翻译）；countries 分国家的支付、访客、转化、加购、退款；'
      + 'sources 流量来源（APP / 非 APP）。用来回答「这个商品为什么卖得好 / 不好」。',
    annotations: BROWSER_RO,
    inputSchema: obj({
      shop: shopArg, product_id: productIdArg, period: { ...periodArg, default: 'recent30' }, date: dateArg,
      sections: { type: 'array', items: { type: 'string', enum: ['keywords', 'countries', 'sources'] }, description: '要哪些部分，默认全部' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '搜索词 / 国家各列多少行' },
    }, ['product_id']),
    run: analysis,
  },
  {
    name: 'ae_orders',
    description: '订单列表（卖家后台「所有订单」）：订单号、下单时间、状态、金额、买家国家、标签（半托管 JIT / 仓发等）、商品明细（标题、SKU、数量、单价）；'
      + '可按状态、订单类型筛选、翻页，或按订单号查。附订单看板计数（今日新订单、待发货、纠纷中…）。全托管店没有订单。',
    annotations: BROWSER_RO,
    inputSchema: obj({
      shop: shopArg,
      status: { type: 'string', enum: Object.keys(ORDER_STATUS), default: 'all', description: Object.entries(ORDER_STATUS).map(([k, [, v]]) => `${k} ${v}`).join(' / ') },
      order_type: { type: 'string', enum: Object.keys(ORDER_TYPES), default: 'all', description: Object.entries(ORDER_TYPES).map(([k, v]) => `${k} ${v}`).join(' / ') },
      order_id: { type: 'string', description: '只查这个订单号' },
      page: { ...pageArg, maximum: 500 }, page_size: { type: 'integer', enum: PAGE_SIZES, default: 20 },
    }),
    run: orders,
  },
  {
    name: 'ae_products',
    description: '商品列表（卖家后台商品管理）：价格区间、库存、近 30 天销量 / 访客 / 曝光 / 支付金额 / 转化、类目、分组、参加的活动，可选 SKU 明细；附各标签页数量。',
    annotations: BROWSER_RO,
    inputSchema: obj({
      shop: shopArg,
      tab: { type: 'string', enum: Object.keys(PRODUCT_TABS), default: 'online_product', description: Object.entries(PRODUCT_TABS).map(([k, v]) => `${k} ${v}`).join(' / ') },
      page: pageArg, page_size: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      include_skus: { type: 'boolean', default: false, description: '附每个 SKU 的编码、价格、库存、属性' },
    }),
    run: products,
  },
  {
    name: 'ae_categories',
    description: '查生意参谋的类目 ID：按中文名搜索，或列出某个类目的子类目；都不填列出一级类目。',
    annotations: BROWSER_RO,
    inputSchema: obj({ shop: shopArg, query: { type: 'string', description: '类目名关键词，如 玩具、模型' }, parent_id: { type: 'integer', description: '列出这个类目的子类目' }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }),
    run: categories,
  },
  {
    name: 'ae_market_overview',
    description: '类目大盘（市场数据，非本店）：访客指数、搜索指数、交易指数、客单价、供需指数、加购 / 收藏人数；子类目构成（按搜索指数）；国家构成（按访客指数，全部国家时）。',
    annotations: BROWSER_RO,
    inputSchema: obj({ shop: shopArg, category_id: categoryArg, period: periodArg, date: dateArg, country: countryArg, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: '子类目 / 国家各列多少个' } }, ['category_id']),
    run: market,
  },
  {
    name: 'ae_search_words',
    description: '类目热搜词（市场数据）：搜索次数 / 人数、搜索量变化、点击率、转化率、支付订单数、供需比、曝光商品数 / 商家数、主要搜索国家、是否品牌词。',
    annotations: BROWSER_RO,
    inputSchema: obj({
      shop: shopArg, category_id: categoryArg, period: periodArg, date: dateArg, country: countryArg,
      order_by: { type: 'string', enum: Object.keys(WORD_ORDER), default: 'searches', description: 'searches 搜索次数 / searchers 搜索人数 / click_rate 点击率 / conv_rate 转化率 / supply_demand 供需比' },
      page: pageArg, page_size: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    }, ['category_id']),
    run: words,
  },
  {
    name: 'ae_search',
    description: '竞品比价：用一张商品图在速卖通买家前台图搜，按收货国家抓同款的价格、销量、活动（每个国家约几秒）。'
      + '返回每国的价格分布和排在前面的商品，以及 file_id（再查或建监控时复用，不用重新上传）。',
    annotations: { ...BROWSER_RO, idempotentHint: false },
    inputSchema: obj({
      image: { type: 'string', description: '商品图：本地绝对路径、http(s) 图片链接或 data URL（jpg/png/webp/bmp/gif，≤10MB）' },
      file_id: { type: 'string', description: '之前上传返回的 file_id；填了就不用 image' },
      regions: regionsArg, shop: { ...shopArg, description: '用哪家店的紫鸟浏览器做买家搜索；不填 = 默认店' },
      limit: { type: 'integer', minimum: 1, maximum: 60, default: 10, description: '每个国家列出多少个商品' },
      sort: { type: 'string', enum: ['rank', 'price', 'sold'], default: 'rank' },
    }),
    run: searchNow,
  },
  {
    name: 'ae_watch_create',
    description: '新建竞品监控：对同一张图（file_id，来自 ae_search）按间隔反复图搜，记录价格和活动变化。只写本机监控数据。',
    annotations: LOCAL_WRITE,
    inputSchema: obj({
      name: { type: 'string', description: '监控名称，1–60 个字' },
      file_id: { type: 'string', description: 'ae_search 返回的 file_id' },
      regions: regionsArg, shop: shopArg,
      interval_min: { type: 'integer', minimum: 15, maximum: 1440, default: 60, description: '建议的抓取间隔（分钟），由调用方按它定时调用 ae_watch_run' },
      image: { type: 'string', description: '可选：同一张图（本地路径 / 链接），存下来备查' },
    }, ['name', 'file_id']),
    run: createWatch,
  },
  {
    name: 'ae_watch_run',
    description: '立即对一个监控跑一轮：图搜各国 → 存快照 → 和上一轮比出改价 / 活动事件。适合交给定时任务按间隔调用。',
    annotations: LOCAL_WRITE,
    inputSchema: obj({ watch: watchArg, limit: { type: 'integer', minimum: 1, maximum: 60, default: 5, description: '每国列出多少个商品' } }),
    run: runWatchNow,
  },
  {
    name: 'ae_watches',
    description: '列出所有竞品比价监控：名称、店铺、监控的国家、间隔、最近一次抓取时间和状态、保留的快照数。',
    annotations: LOCAL_RO, inputSchema: obj({}), run: () => listWatches(store),
  },
  {
    name: 'ae_latest',
    description: '某个监控最新一期（或指定一期）的价格：每个国家的价格分布（real_price 的最低 / 四分位 / 中位 / 最高）、有活动的商品数，以及按排名、价格或销量排在前面的商品明细。',
    annotations: LOCAL_RO,
    inputSchema: obj({
      watch: watchArg, region: regionArg,
      limit: { type: 'integer', minimum: 1, maximum: 60, default: 10, description: '每个国家列出多少个商品' },
      sort: { type: 'string', enum: ['rank', 'price', 'sold'], default: 'rank', description: 'rank 图搜排名 / price 参考价从低到高 / sold 销量从高到低' },
      snapshot_ts: { type: 'integer', description: '指定某一期的时间戳（ae_watches 或 ae_history 里的 ts）；不填 = 最新一期' },
    }),
    run: async (a) => latestPrices(store, await resolveWatch(store, a.watch), { region: a.region, limit: a.limit, sort: a.sort, snapshotTs: a.snapshot_ts }),
  },
  {
    name: 'ae_history',
    description: '某个竞品商品的价格走势：每一期在各国的排名、标价、展示价、参考价、活动折扣、销量。区分「该国这期没采到」和「采到了但这个商品没出现」。',
    annotations: LOCAL_RO,
    inputSchema: obj({
      watch: watchArg, region: regionArg,
      product_id: { type: 'string', description: '速卖通商品 ID（ae_latest 结果里的 product_id）' },
      sku_id: { type: 'string', description: '只看某个 SKU；不填 = 取该商品出现的那个 SKU' },
      days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
    }, ['product_id']),
    run: async (a) => priceHistory(store, await resolveWatch(store, a.watch), { productId: a.product_id, skuId: a.sku_id, region: a.region, days: a.days }),
  },
  {
    name: 'ae_events',
    description: '竞品的改价和活动事件（价格涨跌、无活动价上调、活动开始 / 结束 / 变化、早鸟价），最新的在前。',
    annotations: LOCAL_RO,
    inputSchema: obj({
      watch: watchArg, region: regionArg,
      type: { type: 'string', enum: EVENT_TYPES },
      days: { type: 'integer', minimum: 1, maximum: 365, default: 7 },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
    }),
    run: async (a) => changeEvents(store, await resolveWatch(store, a.watch), { region: a.region, type: a.type, days: a.days, limit: a.limit }),
  },
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** 按 inputSchema 做参数检查：未知参数、必填、类型、枚举、范围 */
function checkArgs(tool, args) {
  const { properties, required = [] } = tool.inputSchema;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new QueryError('arguments 必须是对象。');
  for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key)) throw new QueryError(`未知参数：${key}`);
  for (const key of required) if (args[key] === undefined || args[key] === '') throw new QueryError(`缺少参数：${key}`);
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (spec.type === 'integer' && !Number.isInteger(value)) throw new QueryError(`${key} 必须是整数。`);
    if (spec.type === 'string' && typeof value !== 'string') throw new QueryError(`${key} 必须是字符串。`);
    if (spec.type === 'boolean' && typeof value !== 'boolean') throw new QueryError(`${key} 必须是 true / false。`);
    if (spec.type === 'array') {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new QueryError(`${key} 必须是字符串数组。`);
      const allowed = spec.items?.enum;
      if (allowed) for (const v of value) if (!allowed.includes(v)) throw new QueryError(`${key} 里的值只能是：${allowed.join('、')}`);
    }
    if (spec.enum && !spec.enum.includes(value)) throw new QueryError(`${key} 只能是：${spec.enum.join('、')}`);
    if (spec.minimum !== undefined && value < spec.minimum) throw new QueryError(`${key} 不能小于 ${spec.minimum}。`);
    if (spec.maximum !== undefined && value > spec.maximum) throw new QueryError(`${key} 不能大于 ${spec.maximum}。`);
  }
}

async function callTool(name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
  try {
    const input = args ?? {};
    checkArgs(tool, input);
    precheck(input);
    return { content: [{ type: 'text', text: JSON.stringify(await tool.run(input)) }] };
  } catch (error) {
    if (!isUserError(error)) process.stderr.write(`[aliexpress-seller-mcp] ${error?.stack ?? error}\n`);
    return { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true };
  }
}

const listed = TOOLS.map(({ run, ...tool }) => tool);

async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'aliexpress-seller-mcp', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listed };
    case 'tools/call':
      return callTool(params?.name, params?.arguments);
    default:
      if (id === undefined) return undefined; // 通知（如 notifications/initialized）不回复
      throw Object.assign(new Error(`不支持的方法：${method}`), { code: -32601 });
  }
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`aliexpress-seller-mcp ${VERSION}
速卖通卖家 MCP（stdio）：通过本机紫鸟店铺浏览器里已登录的卖家后台取店铺数据、订单、商品、市场数据，并做图搜竞品比价。

环境变量：
  AE_SHOPS     店铺数组 JSON，如 [{"name":"主店","store_id":"12345678901234","default":true}]
  AE_STORE_ID  只有一家店时可以只设紫鸟店铺 ID
  AE_DATA_DIR  监控数据和浏览器锁文件目录（默认 ~/.aliexpress-seller-mcp）
  ZINIAO_CLI   ziniao-cli 命令路径（默认 ziniao-cli）
`);
  process.exit(0);
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'JSON 解析失败' } });
    return;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    send({ id: null, error: { code: -32600, message: '请求必须是 JSON 对象' } });
    return;
  }
  try {
    const result = await handle(message);
    if (message.id !== undefined && result !== undefined) send({ id: message.id, result });
  } catch (error) {
    if (message.id !== undefined) send({ id: message.id, error: { code: error.code ?? -32603, message: String(error.message ?? error) } });
  }
});
