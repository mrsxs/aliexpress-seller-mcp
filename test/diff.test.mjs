import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityText, diffSnapshots, summarizeResults } from '../lib/diff.mjs';

const item = (id, over = {}) => ({
  productId: id, title: `t${id}`, image: '', listPrice: 5, real: 5, display: 5,
  activityPct: 0, activityTools: [], earlyBird: '', ...over,
});
const snap = (region, items) => ({ [region]: { items } });

test('没有上一次快照时不产生事件', () => {
  assert.deepEqual(diffSnapshots(null, snap('US', [item('a')])), []);
});

test('活动开始 / 结束 / 变化', () => {
  const prev = snap('US', [item('a'), item('b', { real: 3, activityPct: 0.4, activityTools: ['limitedDiscount'] }), item('c', { real: 3, activityPct: 0.4, activityTools: ['superDeals'] })]);
  const curr = snap('US', [
    item('a', { real: 3.5, activityPct: 0.3, activityTools: ['limitedDiscount'] }),
    item('b'),
    item('c', { real: 2.5, activityPct: 0.5, activityTools: ['superDeals'] }),
  ]);
  const evs = diffSnapshots(prev, curr);
  const byId = Object.fromEntries(evs.map((e) => [e.productId, e]));
  assert.equal(byId.a.type, 'activity-start');
  assert.match(byId.a.text, /限时折扣 −30%.*\$5\.00 → \$3\.50/);
  assert.equal(byId.b.type, 'activity-end');
  assert.equal(byId.c.type, 'activity-change');
  assert.equal(byId.a.region, 'US');
  assert.equal(byId.a.after.activity, '限时折扣 −30%');
});

test('小幅波动不算事件；价格变化 ≥3% 算', () => {
  const prev = snap('DE', [item('a', { real: 5 }), item('b', { real: 5 })]);
  const curr = snap('DE', [item('a', { real: 5.05 }), item('b', { real: 4.5 })]);
  const evs = diffSnapshots(prev, curr);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].productId, 'b');
  assert.equal(evs[0].type, 'price-change');
  assert.match(evs[0].text, /下降/);
});

test('先涨无活动价、早鸟价；只对比两次都有的商品', () => {
  const prev = snap('US', [item('a', { listPrice: 5 }), item('gone')]);
  const curr = snap('US', [item('a', { listPrice: 6, real: 6, earlyBird: 'Early bird deal, only 3 left' }), item('new', { activityPct: 0.5, activityTools: ['superDeals'] })]);
  const types = diffSnapshots(prev, curr).map((e) => e.type).sort();
  assert.deepEqual(types, ['early-bird', 'list-raise', 'price-change']);
});

test('上次没有的地区不对比；概况统计', () => {
  assert.deepEqual(diffSnapshots(snap('US', [item('a')]), snap('FR', [item('a', { activityPct: 0.5 })])), []);
  assert.deepEqual(summarizeResults(snap('US', [item('a'), item('b', { activityPct: 0.2 })])), { US: { count: 2, activity: 1 } });
  assert.equal(activityText(item('x')), '无活动');
});

test('SKU 不同不对比；同 SKU 跨多次快照仍能发现活动开始', async () => {
  const { diffAgainstBaseline } = await import('../lib/diff.mjs');
  const r1 = snap('US', [item('a', { skuId: 's1', real: 5 })]);
  const r2 = snap('US', [item('a', { skuId: 's2', real: 9, listPrice: 9 })]); // 展示了另一个 SKU
  const r3 = snap('US', [item('a', { skuId: 's1', real: 3, activityPct: 0.4, activityTools: ['superDeals'] })]);
  const b1 = diffAgainstBaseline({}, r1, 1);
  assert.equal(b1.events.length, 0);
  const b2 = diffAgainstBaseline(b1.baseline, r2, 2);
  assert.equal(b2.events.length, 0, 'SKU 变化不应报价格变化');
  const b3 = diffAgainstBaseline(b2.baseline, r3, 3);
  assert.equal(b3.events.length, 1);
  assert.equal(b3.events[0].type, 'activity-start');
  assert.equal(b3.events[0].skuId, 's1');
  // 30 天未出现的条目被清理
  const old = diffAgainstBaseline({ 'US|z|': { real: 1, seen: 0 } }, r1, 31 * 86_400_000);
  assert.equal(old.baseline['US|z|'], undefined);
});
