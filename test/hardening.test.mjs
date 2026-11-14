// Codex 审查后的加固：风控先判且不重试、图搜遇验证整体停下、内层失败不当空结果、隐私白名单、盯价文件安全、页面请求超时取消
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchRegions } from '../lib/aliexpress.mjs';
import { classifyPage } from '../lib/browser.mjs';
import { isVerifyError, optional } from '../lib/cooldown.mjs';
import { diffAgainstBaseline } from '../lib/diff.mjs';
import { loadImage } from '../lib/image-input.mjs';
import { flattenMetrics } from '../lib/market.mjs';
import { createMonitor } from '../lib/monitor.mjs';
import { callAbortable, mtopFetch } from '../lib/mtop-fetch.mjs';
import { isServiceStatus, parseOrderPage } from '../lib/orders.mjs';
import { parseSearchHtml } from '../lib/parse.mjs';
import { parseProductPage } from '../lib/products.mjs';
import { createSellerApi, explainSellerError, SellerError } from '../lib/seller.mjs';
import { createWatchStore } from '../lib/watch-store.mjs';

test('mtop：只有 data.url 指向验证页也算风控、不重试；返回验证页 HTML → 验证', async () => {
  let n = 0;
  const cdp = (text) => ({ evaluate: async () => '_m_h5_tk=a_1', callInPage: async () => { n++; return { status: 200, text }; } });
  await assert.rejects(mtopFetch(cdp(JSON.stringify({ ret: ['FAIL_SYS_ILLEGAL_ACCESS::x'], data: { url: 'https://x/_____tmd_____/punish?x5secdata=1' } })), { api: 'm', appKey: 'k' }), /FAIL_SYS_USER_VALIDATE/);
  assert.equal(n, 1);
  await assert.rejects(mtopFetch(cdp('<html>punish x5sec</html>'), { api: 'm', appKey: 'k' }), /FAIL_SYS_USER_VALIDATE/);
});

test('页面请求超时：取消页面里同一个请求', async () => {
  const calls = [];
  const cdp = { callInPage: async (fn, arg) => { calls.push(arg); if (calls.length === 1) throw new Error('Runtime.evaluate 超时'); return true; } };
  await assert.rejects(callAbortable(cdp, () => {}, { url: 'x' }, 10), /超时/);
  assert.equal(calls[1], calls[0].id);
});

test('卖家后台：验证优先于登录；内层 success:false 不当空结果；错误脱敏', async () => {
  assert.ok(isVerifyError({ message: explainSellerError('a', 'FAIL_SYS_USER_VALIDATE::请登录验证') }));
  assert.doesNotMatch(explainSellerError('a', 'boom sellerId=ENC12345678901 https://x.com/a'), /ENC12345678901|https/);
  const call = createSellerApi({}, { appKey: 'k', query: {}, headers: {}, channelId: '1' }, async () => ({ data: { success: false, errorMsg: 'RGV587_ERROR' } }));
  await assert.rejects(call({ api: 'a', page: '/p' }), (e) => e instanceof SellerError && isVerifyError(e));
  const call2 = createSellerApi({}, { appKey: 'k', query: {}, headers: {}, channelId: '1' }, async () => ({ data: { success: false, errorCode: 'BIZ_FAIL' } }));
  await assert.rejects(call2({ api: 'a', page: '/p' }), /卖家后台接口失败（a）/);
});

test('搜索页：最终地址是验证页 → 验证；有数据但没有结果区域 → 报错（不当 0 个结果）', () => {
  assert.throws(() => parseSearchHtml('<html>ok</html>', 'https://www.aliexpress.com/_____tmd_____/punish?x5secdata=1'), (e) => isVerifyError(e));
  const html = (obj) => `<script>window._dida_config_._init_data_= { data: ${JSON.stringify(obj)} }</script>`;
  assert.throws(() => parseSearchHtml(html({ data: { root: { fields: {} } } })), /数据不完整/);
});

test('图搜：第一个地区遇到验证就整体停下（不再搜后面的地区），并且还原收货地 cookie', async () => {
  const cookie = { name: 'aep_usuc_f', value: 'region=US&c_tp=USD', domain: '.aliexpress.com', path: '/', expires: -1 };
  const set = [];
  let fetched = 0;
  const cdp = {
    send: async (m, p) => {
      if (m === 'Network.getCookies') return { cookies: [cookie] };
      if (m === 'Network.setCookie') { set.push(p.value); return { success: true }; }
      return {};
    },
    callInPage: async () => { fetched++; return { status: 200, finalUrl: 'https://www.aliexpress.com/_____tmd_____/punish?x5secdata=1', html: '' }; },
  };
  const results = [];
  const errors = [];
  await assert.rejects(searchRegions(cdp, { fileId: 'OSS/test/fictional.jpg', regions: ['US', 'DE', 'GB'], onResult: (r) => results.push(r), onError: (e) => errors.push(e) }), (e) => isVerifyError(e));
  assert.equal(fetched, 1);
  assert.deepEqual([results.length, errors.length], [0, 0]);
  assert.equal(set.at(-1), cookie.value); // 最后还原成原值
});

test('隐私：订单服务列只输出状态短语；市场指标只输出已知字段', () => {
  assert.equal(isServiceStatus('已取消'), true);
  assert.equal(isServiceStatus('纠纷中'), true);
  assert.equal(isServiceStatus('请联系 13800138000'), false);
  assert.equal(isServiceStatus('please ship fast'), false);
  assert.deepEqual(flattenMetrics({ uvIndex: { value: 1.23456, cycleCrc: 0.1 }, sellerAdminSeq: { value: 'SECRET' }, statDate: { value: 1 } }), { uvIndex: { value: 1.2346, change: 0.1 } });
});

test('结构不全：订单没有表格、商品没有表格 → 报错', () => {
  assert.throws(() => parseOrderPage({ data: {} }), /数据不完整/);
  assert.throws(() => parseProductPage({ data: {} }, {}), /数据不完整/);
  assert.deepEqual(parseProductPage({ data: { table: { dataSource: [] }, pagination: { total: 0 } } }, {}).products, []);
});

test('盯价基准：超过保留期没出现的旧基准不拿来比', () => {
  const day = 86_400_000;
  const item = { productId: '1', skuId: '', title: 't', price: 10, currency: 'USD' };
  const old = diffAgainstBaseline({}, { US: { items: [{ ...item, price: 5 }] } }, 0).baseline;
  const later = diffAgainstBaseline(old, { US: { items: [item] } }, 40 * day);
  assert.equal(later.events.length, 0);
});

test('盯价文件：损坏的文件报错（不当空数据）；同一 ID 不能重复创建', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aem-ws-'));
  try {
    const store = createWatchStore(dir);
    const w = { id: 'w1794600000000123', name: 'x', createdAt: 1 };
    await store.saveWatch(w);
    await assert.rejects(store.saveWatch(w), (e) => e.code === 'EEXIST');
    writeFileSync(join(dir, 'watches', w.id, 'events.json'), '{broken');
    await assert.rejects(store.loadEvents(w.id), /损坏/);
    assert.deepEqual(await store.loadBaseline(w.id), {});
    assert.equal((await store.listWatches()).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('盯价执行：整轮在执行权锁里跑；先记事件再推进基准', async () => {
  const order = [];
  const store = {
    getWatch: async () => ({ id: 'w1', storeId: '1', fileId: 'f', regions: ['US'], name: 'x', intervalMin: 60 }),
    saveWatch: async (w) => { order.push('meta'); return w; },
    addSnapshot: async () => order.push('snap'),
    loadBaseline: async () => ({}),
    appendEvents: async () => order.push('events'),
    saveBaseline: async () => order.push('baseline'),
  };
  const m = createMonitor({
    store, notify: () => {}, now: () => 1,
    runSearch: async () => ({ results: { US: { items: [] } }, errors: {} }),
    withRunLock: async (id, fn) => { order.push(`lock:${id}`); const r = await fn(); order.push('unlock'); return r; },
  });
  await m.runWatch('w1');
  assert.deepEqual(order, ['lock:w1', 'snap', 'events', 'baseline', 'meta', 'unlock']);
});

test('图片下载：边读边数，超过 10MB 立刻停', async () => {
  const big = new ReadableStream({ start(c) { for (let i = 0; i < 12; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); } });
  const fetchImpl = async () => new Response(big, { headers: { 'content-type': 'image/png' } });
  await assert.rejects(loadImage('https://example.test/a.png', { fetchImpl }), /太大/);
});

test('页面状态：速卖通验证页 / 登录页', () => {
  assert.equal(classifyPage({ href: 'https://www.aliexpress.com/_____tmd_____/punish?x5secdata=1' }), 'verify');
  assert.equal(classifyPage({ href: 'https://login.aliexpress.com/x' }), 'login');
  assert.equal(classifyPage({ href: 'https://csp.aliexpress.com/m_apps/home', ready: true, title: 'x' }), 'ready');
});

test('optional：登录失效、安全验证不吞', async () => {
  await assert.rejects(optional(Promise.reject(new Error('卖家后台登录已失效，请…')), null), /登录已失效/);
  assert.equal(await optional(Promise.reject(new Error('别的')), 'x'), 'x');
});

test('第二轮：内层错误码和文案分开放仍认出风控；ret 是字符串也先判风控', async () => {
  const ctx = { appKey: 'k', query: {}, headers: {}, channelId: '1' };
  const call = createSellerApi({}, ctx, async () => ({ data: { success: false, errorCode: 'FAIL_SYS_USER_VALIDATE', errorMsg: '系统繁忙' } }));
  await assert.rejects(call({ api: 'a', page: '/p' }), (e) => isVerifyError(e));
  const call2 = createSellerApi({}, ctx, async () => ({ data: { success: true, url: 'https://x/_____tmd_____/punish?x5secdata=1' } }));
  await assert.rejects(call2({ api: 'a', page: '/p' }), (e) => isVerifyError(e));
  let n = 0;
  const cdp = { evaluate: async () => '_m_h5_tk=a_1', callInPage: async () => { n++; return { status: 200, text: JSON.stringify({ ret: 'RGV587_ERROR::SM' }) }; } };
  await assert.rejects(mtopFetch(cdp, { api: 'm', appKey: 'k' }), /RGV587/);
  assert.equal(n, 1);
});

test('第二轮复审：上传内层风控、只写 Captcha 的页面、两类锁端口分开、服务列整句匹配、结构不全', async () => {
  const { lockPort } = await import('../lib/browser-lock.mjs');
  const dir = '/home/user/.aliexpress-seller-mcp';
  assert.notEqual(lockPort(dir), lockPort(dir, process.platform, 'watch:w1794600000018892'));
  for (let i = 0; i < 200; i++) {
    const p = lockPort(dir, process.platform, `watch:w${1794600000000000 + i}`);
    assert.ok(p >= 10000 && p < 20000);
  }
  let n = 0;
  const cdp = { evaluate: async () => '_m_h5_tk=a_1', callInPage: async () => { n++; return { status: 200, text: '<html><title>Captcha Interception</title></html>' }; } };
  await assert.rejects(mtopFetch(cdp, { api: 'm', appKey: 'k' }), /FAIL_SYS_USER_VALIDATE/);

  assert.equal(isServiceStatus('等待付款'), true);
  assert.equal(isServiceStatus('交易成功'), true);
  assert.equal(isServiceStatus('超时剩余2天'), true);
  assert.equal(isServiceStatus('退款请联系张三'), false);
  assert.equal(isServiceStatus('发货至张三家'), false);

  assert.throws(() => parseOrderPage({ data: { pagination_1: { fields: { total: 4 } } } }), /数据不完整/);
  assert.deepEqual(parseOrderPage({ data: { pagination_1: { fields: { total: 0 } } } }).orders, []);
  const html = (obj) => `<script>window._dida_config_._init_data_= { data: ${JSON.stringify(obj)} }</script>`;
  assert.throws(() => parseSearchHtml(html({ data: { root: { fields: { mods: {} } } } })), /没有商品列表/);
});

test('店铺上下文：页面 channel 变了要重取；缓存时没读到、这次读到也重取；这次读取失败先不动', async () => {
  const { contextStale, CHANNEL_READ_FAILED } = await import('../lib/seller.mjs');
  assert.equal(contextStale('A', 'A'), false);
  assert.equal(contextStale('A', 'B'), true);
  assert.equal(contextStale('A', ''), true);
  assert.equal(contextStale(null, 'B'), true);
  assert.equal(contextStale('A', CHANNEL_READ_FAILED), false);
  assert.equal(contextStale(null, CHANNEL_READ_FAILED), false);
});
