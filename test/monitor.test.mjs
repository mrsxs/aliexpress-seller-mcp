import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNextRun, createMonitor } from '../lib/monitor.mjs';
import { assertWatchId, createWatchStore } from '../lib/watch-store.mjs';

const item = (id, over = {}) => ({ productId: id, title: id, listPrice: 5, real: 5, display: 5, activityPct: 0, activityTools: [], ...over });

test('computeNextRun：开始时间、间隔、暂停', () => {
  const now = 1_000_000;
  assert.equal(computeNextRun({ enabled: false }, now), null);
  assert.equal(computeNextRun({ enabled: true, startAt: now + 5000, intervalMin: 60 }, now), now + 5000);
  assert.equal(computeNextRun({ enabled: true, intervalMin: 60 }, now), now);
  assert.equal(computeNextRun({ enabled: true, intervalMin: 60, lastRunAt: now }, now), now + 3_600_000);
});

test('监控两轮：保存快照、发现活动开始、发通知、排下一次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ae-watch-'));
  try {
    const store = createWatchStore(dir);
    let clock = 1_800_000_000_000;
    const rounds = [
      { US: { items: [item('a'), item('b')] } },
      { US: { items: [item('a', { real: 3, activityPct: 0.4, activityTools: ['limitedDiscount'] }), item('b')] } },
    ];
    let call = 0;
    const notices = [];
    const monitor = createMonitor({
      store,
      now: () => clock,
      notify: (title, msg) => notices.push({ title, msg }),
      runSearch: async () => ({ results: rounds[call++], errors: {} }),
    });
    const id = `w${clock}`;
    await store.saveWatch({ id, name: '测试', storeId: '1', fileId: 'OSS/x.jpg', regions: ['US'], intervalMin: 60, enabled: true, notify: true, createdAt: clock, nextRunAt: clock });

    await monitor.tick();
    let w = await store.getWatch(id);
    assert.equal(w.lastStatus, 'ok');
    assert.equal(w.snapshotCount, 1);
    assert.equal(w.nextRunAt, clock + 3_600_000);
    assert.equal(notices.length, 0);

    await monitor.tick(); // 未到时间，不跑
    assert.equal(call, 1);

    clock += 3_600_000;
    await monitor.tick();
    w = await store.getWatch(id);
    assert.equal(w.snapshotCount, 2);
    assert.equal(w.lastEventCount, 1);
    const events = await store.loadEvents(id);
    assert.equal(events[0].type, 'activity-start');
    assert.equal(events[0].productId, 'a');
    assert.equal(notices.length, 1);
    assert.match(notices[0].msg, /活动开始/);

    const snaps = await store.listSnapshots(id);
    assert.equal(snaps.length, 2);
    assert.deepEqual(snaps[1].summary, { US: { count: 2, activity: 1 } });
    const loaded = await store.loadSnapshot(id, snaps[1].ts);
    assert.equal(loaded.US.items[0].real, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('抓取全部失败记为错误，ID 校验防路径穿越', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ae-watch-'));
  try {
    const store = createWatchStore(dir);
    const monitor = createMonitor({ store, notify: () => {}, runSearch: async () => ({ results: {}, errors: { US: '验证码' } }) });
    const id = 'w1800000000000';
    await store.saveWatch({ id, name: 'x', storeId: '1', fileId: 'OSS/x.jpg', regions: ['US'], intervalMin: 60, enabled: true, createdAt: 1 });
    await monitor.runWatch(id);
    const w = await store.getWatch(id);
    assert.equal(w.lastStatus, 'error');
    assert.match(w.lastError, /验证码/);
    assert.throws(() => assertWatchId('../etc'), /监控 ID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('并发触发同一监控只跑一次；删除后的更新不会重建', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ae-watch-'));
  try {
    const store = createWatchStore(dir);
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const monitor = createMonitor({
      store, notify: () => {},
      runSearch: async () => { calls++; await gate; return { results: { US: { items: [] } }, errors: {} }; },
    });
    const id = 'w1800000000001';
    await store.saveWatch({ id, name: 'x', storeId: '1', fileId: 'OSS/x.jpg', regions: ['US'], intervalMin: 60, enabled: true, createdAt: 1, nextRunAt: 1 });
    const p1 = monitor.runWatch(id);
    const p2 = monitor.runWatch(id);
    const p3 = monitor.tick();
    release();
    await Promise.all([p1, p2, p3]);
    assert.equal(calls, 1);

    await store.deleteWatch(id);
    assert.equal(await monitor.update(id, { name: 'y' }), null);
    assert.equal(await store.getWatch(id), null);
    await assert.rejects(store.loadSnapshot(id, '1800000000000'), /快照不存在/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
