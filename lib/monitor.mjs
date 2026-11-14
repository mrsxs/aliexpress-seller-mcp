// 活动监控调度：到点自动重跑图搜，保存快照，对比上一次，发现活动变化时发 Mac 通知
import { ACTIVITY_EVENT_TYPES, diffAgainstBaseline, summarizeResults } from './diff.mjs';
import { systemNotify } from './notify.mjs';

const TICK_MS = 30_000;
export const MIN_INTERVAL_MIN = 15;
export const MAX_INTERVAL_MIN = 24 * 60;

/** 下次运行时间：设了开始时间且还没跑过 → 开始时间；否则上次 + 间隔 */
export function computeNextRun(watch, now = Date.now()) {
  if (!watch.enabled) return null;
  if (!watch.lastRunAt && watch.startAt && watch.startAt > now) return watch.startAt;
  if (!watch.lastRunAt) return now;
  return watch.lastRunAt + watch.intervalMin * 60_000;
}

/**
 * runSearch({ storeId, fileId, regions }) => Promise<{ results, errors }>，由 server 提供（走互斥队列）
 */
/** withRunLock(id, fn)：整轮执行（读元数据 → 搜索 → 写快照 / 事件 / 基准 → 更新元数据）的跨进程互斥，默认只在本进程内 */
export function createMonitor({ store, runSearch, notify = systemNotify, now = () => Date.now(), withRunLock = (id, fn) => fn() }) {
  const running = new Set();
  let timer = null;
  let ticking = false;

  /** 读-改-写；监控已被删除时不重建（saveWatch create:false） */
  async function update(id, patch) {
    const current = await store.getWatch(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    return store.saveWatch({ ...next, nextRunAt: computeNextRun(next, now()) }, { create: false });
  }

  /** scheduled=true 时再确认一次到期，防止过期的待运行列表重复执行 */
  async function runWatch(id, { scheduled = false } = {}) {
    if (running.has(id)) return { skipped: true };
    running.add(id); // 同步占位，避免并发触发同时通过检查
    try {
      // 拿到执行权之后再读元数据（另一个进程可能刚跑完这一轮）
      return await withRunLock(id, async () => {
        const watch = await store.getWatch(id);
        if (!watch) return { skipped: true };
        if (scheduled && !(watch.enabled && watch.nextRunAt && watch.nextRunAt <= now())) return { skipped: true };
        return execute(id, watch);
      });
    } finally {
      running.delete(id);
    }
  }

  async function execute(id, watch) {
    const started = now();
    try {
      const { results, errors } = await runSearch({ storeId: watch.storeId, fileId: watch.fileId, regions: watch.regions });
      const okRegions = Object.keys(results);
      if (!okRegions.length) throw new Error(Object.values(errors)[0] || '所有地区都抓取失败');
      await store.addSnapshot(id, started, results, summarizeResults(results));
      const diff = diffAgainstBaseline(await store.loadBaseline(id), results, started);
      const events = diff.events.map((e) => ({ ...e, ts: started }));
      // 先记事件再推进基准：事件写失败时基准不动，下一轮还能发现这次的变化（不会漏记）
      await store.appendEvents(id, events);
      await store.saveBaseline(id, diff.baseline);
      const activityEvents = events.filter((e) => ACTIVITY_EVENT_TYPES.has(e.type));
      if (watch.notify && activityEvents.length) {
        notify(`速卖通活动监控 · ${watch.name}`, `${activityEvents.length} 个竞品活动有变化：${activityEvents[0].region} ${activityEvents[0].text}`);
      }
      const failed = Object.keys(errors);
      await update(id, {
        lastRunAt: started,
        lastStatus: failed.length ? 'partial' : 'ok',
        lastError: failed.length ? `${failed.join(',')} 抓取失败` : '',
        lastEventCount: events.length,
        snapshotCount: (watch.snapshotCount || 0) + 1,
      });
      return { events: events.length };
    } catch (err) {
      console.error(`[monitor ${id}]`, err.message);
      await update(id, { lastRunAt: started, lastStatus: 'error', lastError: err.message }).catch((e) => console.error(`[monitor ${id}] 状态写入失败`, e.message));
      return { error: err.message };
    }
  }

  async function tick() {
    if (ticking) return; // 上一轮还在排队/执行时不叠加
    ticking = true;
    try {
      const watches = await store.listWatches();
      const due = watches.filter((w) => w.enabled && w.nextRunAt && w.nextRunAt <= now() && !running.has(w.id));
      for (const w of due) await runWatch(w.id, { scheduled: true });
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch((err) => console.error('[monitor tick]', err)), TICK_MS);
      tick().catch((err) => console.error('[monitor tick]', err));
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    tick,
    runWatch,
    update,
    isRunning: (id) => running.has(id),
  };
}
