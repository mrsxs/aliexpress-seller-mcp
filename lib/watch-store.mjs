// 监控任务与快照的文件存储：data/watches/<id>/{meta.json,image.txt,events.json,snapshots.json,snap/<ts>.json.gz}
import { mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const MAX_SNAPSHOTS = 300; // 每小时一次约可存 12 天
const MAX_EVENTS = 3000;
const WATCH_ID = /^w\d{10,16}$/;
const SNAP_TS = /^\d{10,16}$/;

export function assertWatchId(id) {
  if (!WATCH_ID.test(String(id || ''))) throw Object.assign(new Error('监控 ID 不正确'), { status: 400 });
  return String(id);
}

export function assertSnapTs(ts) {
  if (!SNAP_TS.test(String(ts || ''))) throw Object.assign(new Error('快照时间不正确'), { status: 400 });
  return String(ts);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function createWatchStore(dataDir) {
  const root = join(dataDir, 'watches');
  const dir = (id) => join(root, assertWatchId(id));

  async function listWatches() {
    let ids = [];
    try {
      ids = (await readdir(root)).filter((d) => WATCH_ID.test(d));
    } catch {
      return [];
    }
    const metas = await Promise.all(ids.map((id) => readJson(join(root, id, 'meta.json'), null)));
    return metas.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  }

  const getWatch = (id) => readJson(join(dir(id), 'meta.json'), null);

  /** create=false 用于更新：目录已被删除时写入失败，不会把已删除的监控重建出来 */
  async function saveWatch(watch, { create = true } = {}) {
    if (create) await mkdir(join(dir(watch.id), 'snap'), { recursive: true });
    await writeFile(join(dir(watch.id), 'meta.json'), JSON.stringify(watch, null, 1));
    return watch;
  }

  const deleteWatch = (id) => rm(dir(id), { recursive: true, force: true });

  const saveImage = (id, dataUrl) => (dataUrl ? writeFile(join(dir(id), 'image.txt'), dataUrl) : Promise.resolve());
  const loadImage = async (id) => {
    try {
      return await readFile(join(dir(id), 'image.txt'), 'utf8');
    } catch {
      return null;
    }
  };

  const listSnapshots = (id) => readJson(join(dir(id), 'snapshots.json'), []);

  /** 保存快照（超过上限时删除最旧的） */
  async function addSnapshot(id, ts, results, summary) {
    const index = await listSnapshots(id);
    await writeFile(join(dir(id), 'snap', `${ts}.json.gz`), gzipSync(JSON.stringify(results)));
    const next = [...index, { ts, summary }];
    const overflow = next.slice(0, Math.max(0, next.length - MAX_SNAPSHOTS));
    await Promise.all(overflow.map((s) => unlink(join(dir(id), 'snap', `${s.ts}.json.gz`)).catch(() => {})));
    await writeFile(join(dir(id), 'snapshots.json'), JSON.stringify(next.slice(overflow.length)));
  }

  async function loadSnapshot(id, ts) {
    let buf;
    try {
      buf = await readFile(join(dir(id), 'snap', `${assertSnapTs(ts)}.json.gz`));
    } catch {
      throw Object.assign(new Error('快照不存在或已被清理'), { status: 404 });
    }
    return JSON.parse(gunzipSync(buf).toString('utf8'));
  }

  const loadEvents = (id) => readJson(join(dir(id), 'events.json'), []);

  async function appendEvents(id, events) {
    if (!events.length) return;
    const all = [...(await loadEvents(id)), ...events];
    await writeFile(join(dir(id), 'events.json'), JSON.stringify(all.slice(-MAX_EVENTS)));
  }

  const loadBaseline = (id) => readJson(join(dir(id), 'baseline.json'), {});
  const saveBaseline = (id, baseline) => writeFile(join(dir(id), 'baseline.json'), JSON.stringify(baseline));

  return { loadBaseline, saveBaseline, listWatches, getWatch, saveWatch, deleteWatch, saveImage, loadImage, listSnapshots, addSnapshot, loadSnapshot, loadEvents, appendEvents };
}
