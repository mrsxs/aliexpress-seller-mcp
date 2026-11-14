import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changeEvents, latestPrices, listWatches, priceHistory, QueryError, resolveWatch } from '../lib/scout-query.mjs';
import { createWatchStore } from '../lib/watch-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const T1 = 1_800_000_000_000;
const FILE_ID = 'OSS/ae-image-search-sg2/2026-01-01/00000000-0000-4000-8000-000000000000.jpg';
const T2 = T1 + 3_600_000;
const item = (id, over = {}) => ({ rank: 1, productId: id, skuId: `${id}-s`, title: `t-${id}`, currency: 'USD', listPrice: 10, display: 9, real: 9, sold: 5, activityPct: 0, ...over });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ae-query-'));
  const store = createWatchStore(dir);
  const watch = { id: 'w1800000000000', name: '花簇竞品', storeId: 's1', regions: ['US', 'DE', 'GB'], intervalMin: 60, enabled: true, lastRunAt: T2, lastStatus: 'partial', lastError: 'GB 抓取失败' };
  await store.saveWatch(watch);
  await store.addSnapshot(watch.id, T1, {
    US: { items: [item('a', { rank: 1, real: 9 }), item('b', { rank: 2, real: 4, sold: 50 }), item('c', { rank: 3, real: 12, activityPct: 0.3 })] },
    DE: { items: [item('a', { rank: 2, currency: 'EUR', real: 8 })] },
  }, {});
  // 第二期：US 里 a 没出现，DE 没采到
  await store.addSnapshot(watch.id, T2, {
    US: { items: [item('b', { rank: 1, real: 3, sold: 60 }), item('c', { rank: 2, real: 11 })] },
    GB: { items: [item('a', { rank: 5, currency: 'GBP', real: 7 })] },
  }, {});
  await store.appendEvents(watch.id, [
    { type: 'price-change', region: 'US', productId: 'b', skuId: 'b-s', title: 't-b', text: '价格下降：$4.00 → $3.00', ts: T2 },
    { type: 'activity-start', region: 'DE', productId: 'a', text: '活动开始', ts: T1 },
  ]);
  return { dir, store, watch };
}

test('监控列表：最近抓取时间、状态、最新一期采到的地区', async () => {
  const { dir, store } = await fixture();
  try {
    const [w] = await listWatches(store);
    assert.equal(w.name, '花簇竞品');
    assert.equal(w.snapshots_kept, 2);
    assert.equal(w.last_status, 'partial');
    assert.deepEqual(w.latest_snapshot.regions_captured, []);
    assert.equal(w.latest_snapshot.ts, T2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('最新一期：价格分布、排序、只列采到的地区，指定没采到的地区要报错', async () => {
  const { dir, store, watch } = await fixture();
  try {
    const out = await latestPrices(store, watch, { sort: 'price' });
    assert.equal(out.snapshot.ts, T2);
    assert.deepEqual(out.regions_captured, ['US', 'GB']);
    assert.deepEqual(out.regions.US.top.map((i) => i.product_id), ['b', 'c']);
    assert.equal(out.regions.US.real_price.min, 3);
    assert.equal(out.regions.US.real_price.max, 11);
    assert.equal(out.regions.GB.currency, 'GBP');
    await assert.rejects(latestPrices(store, watch, { region: 'DE' }), /这一期没有采到 DE/);
    const first = await latestPrices(store, watch, { snapshotTs: T1, sort: 'sold', limit: 1 });
    assert.deepEqual(first.regions.US.top.map((i) => i.product_id), ['b']);
    assert.equal(first.regions.US.with_activity, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('价格走势：区分 采到 / 采到但没出现 / 该国没采到', async () => {
  const { dir, store, watch } = await fixture();
  try {
    const out = await priceHistory(store, watch, { productId: 'a', days: 365, now: T2 });
    assert.deepEqual(out.series.US.map((p) => p.status), ['observed', 'not_observed']);
    assert.deepEqual(out.series.DE.map((p) => p.status), ['observed', 'region_not_captured']);
    assert.deepEqual(out.series.GB.map((p) => p.status), ['region_not_captured', 'observed']);
    assert.equal(out.summary.US.first_real_price, 9);
    assert.equal(out.summary.GB.currency, 'GBP');
    const b = await priceHistory(store, watch, { productId: 'b', region: 'US', days: 365, now: T2 });
    assert.equal(b.summary.US.first_real_price, 4);
    assert.equal(b.summary.US.last_real_price, 3);
    const none = await priceHistory(store, watch, { productId: 'zzz', days: 365, now: T2 });
    assert.equal(none.found_in_any_snapshot, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('事件：最新在前，按地区、类型、天数筛选', async () => {
  const { dir, store, watch } = await fixture();
  try {
    const all = await changeEvents(store, watch, { days: 365, now: T2 });
    assert.deepEqual(all.events.map((e) => e.type), ['price-change', 'activity-start']);
    const us = await changeEvents(store, watch, { region: 'US', days: 365, now: T2 });
    assert.equal(us.total, 1);
    await assert.rejects(changeEvents(store, watch, { type: 'nope' }), QueryError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('找监控：按 ID 或名称；只有一个时可不填；找不到列出现有的', async () => {
  const { dir, store, watch } = await fixture();
  try {
    assert.equal((await resolveWatch(store)).id, watch.id);
    assert.equal((await resolveWatch(store, '花簇竞品')).id, watch.id);
    await assert.rejects(resolveWatch(store, 'x'), /没有找到监控「x」；现有：花簇竞品/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MCP：握手、工具列表、调用、参数错误', async () => {
  const { dir } = await fixture();
  const env = { ...process.env, AE_DATA_DIR: dir, AE_SHOPS: JSON.stringify([{ name: '测试店', store_id: '12345678901234' }]) };
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'aliexpress-seller-mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    let buf = '';
    const waiting = new Map();
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        waiting.get(msg.id)?.(msg);
      }
    });
    let n = 0;
    const rpc = (method, params) => new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'aliexpress-seller-mcp');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = (await rpc('tools/list', {})).result.tools;
    assert.deepEqual(listed.map((t) => t.name), ['ae_shops', 'ae_store_overview', 'ae_store_trend', 'ae_store_today', 'ae_traffic_sources', 'ae_product_rank',
      'ae_product_analysis', 'ae_orders', 'ae_products', 'ae_categories', 'ae_market_overview', 'ae_search_words',
      'ae_search', 'ae_watch_create', 'ae_watch_run', 'ae_watches', 'ae_latest', 'ae_history', 'ae_events']);
    // 只有监控的两个工具写本机数据，其余全部只读
    assert.deepEqual(listed.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name), ['ae_watch_create', 'ae_watch_run']);
    assert.equal(listed.find((t) => t.name === 'ae_latest').annotations.readOnlyHint, true);
    const shops = JSON.parse((await rpc('tools/call', { name: 'ae_shops', arguments: {} })).result.content[0].text);
    assert.deepEqual(shops.shops, [{ name: '测试店', store_id: '12345678901234', default: true }]);
    const badShop = await rpc('tools/call', { name: 'ae_store_overview', arguments: { shop: '别的店' } });
    assert.match(badShop.result.content[0].text, /没有找到店铺「别的店」/);
    const badPeriod = await rpc('tools/call', { name: 'ae_store_overview', arguments: { period: 'week' } });
    assert.match(badPeriod.result.content[0].text, /period 只能是/);
    const badSections = await rpc('tools/call', { name: 'ae_product_analysis', arguments: { product_id: '1', sections: ['x'] } });
    assert.match(badSections.result.content[0].text, /sections 里的值只能是/);
    // 参数错误在排队连浏览器之前就返回
    const badOrder = await rpc('tools/call', { name: 'ae_orders', arguments: { order_id: 'abc' } });
    assert.match(badOrder.result.content[0].text, /order_id 应是订单号/);
    const badDate = await rpc('tools/call', { name: 'ae_store_overview', arguments: { date: '2026-02-30' } });
    assert.match(badDate.result.content[0].text, /YYYY-MM-DD/);
    const badProduct = await rpc('tools/call', { name: 'ae_traffic_sources', arguments: { product_id: '1&x=2' } });
    assert.match(badProduct.result.content[0].text, /product_id 应是/);
    const proto = await rpc('tools/call', { name: 'ae_shops', arguments: { constructor: 1 } });
    assert.match(proto.result.content[0].text, /未知参数：constructor/);
    // 图片读不到时不能留下监控
    const before = JSON.parse((await rpc('tools/call', { name: 'ae_watches', arguments: {} })).result.content[0].text).length;
    const orphan = await rpc('tools/call', { name: 'ae_watch_create', arguments: { name: 'x', file_id: FILE_ID, image: '/nope/missing.jpg' } });
    assert.equal(orphan.result.isError, true);
    assert.equal(JSON.parse((await rpc('tools/call', { name: 'ae_watches', arguments: {} })).result.content[0].text).length, before);
    const badBool = await rpc('tools/call', { name: 'ae_products', arguments: { include_skus: 'yes' } });
    assert.match(badBool.result.content[0].text, /true \/ false/);
    assert.equal(listed.find((t) => t.name === 'ae_watch_run').annotations.readOnlyHint, false);
    const noImage = await rpc('tools/call', { name: 'ae_search', arguments: {} });
    assert.match(noImage.result.content[0].text, /请提供 image/);
    const badRegions = await rpc('tools/call', { name: 'ae_search', arguments: { image: '/nope.jpg', regions: 'US' } });
    assert.match(badRegions.result.content[0].text, /regions 必须是字符串数组/);
    const missingFile = await rpc('tools/call', { name: 'ae_search', arguments: { image: '/definitely/not/here.jpg' } });
    assert.match(missingFile.result.content[0].text, /找不到图片文件/);
    const created = await rpc('tools/call', { name: 'ae_watch_create', arguments: { name: '新监控', file_id: FILE_ID, regions: ['US', 'FR'], interval_min: 120 } });
    const w = JSON.parse(created.result.content[0].text).watch;
    assert.deepEqual([w.name, w.regions, w.interval_min], ['新监控', ['US', 'FR'], 120]);
    const watches = JSON.parse((await rpc('tools/call', { name: 'ae_watches', arguments: {} })).result.content[0].text);
    assert.equal(watches.length, 2);
    const badName = await rpc('tools/call', { name: 'ae_watch_create', arguments: { name: '', file_id: FILE_ID } });
    assert.equal(badName.result.isError, true);
    const latest = await rpc('tools/call', { name: 'ae_latest', arguments: { watch: '花簇竞品', region: 'US', limit: 1 } });
    assert.equal(JSON.parse(latest.result.content[0].text).regions.US.top.length, 1);
    const bad = await rpc('tools/call', { name: 'ae_latest', arguments: { sort: 'cheap' } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /sort 只能是/);
    const missing = await rpc('tools/call', { name: 'ae_history', arguments: {} });
    assert.match(missing.result.content[0].text, /缺少参数：product_id/);
    const unknown = await rpc('nope/method', {});
    assert.equal(unknown.error.code, -32601);
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
