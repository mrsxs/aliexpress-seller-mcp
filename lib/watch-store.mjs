// 监控任务与快照的文件存储：data/watches/<id>/{meta.json,image.txt,events.json,snapshots.json,snap/<ts>.json.gz}
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
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

/** 文件不存在时用默认值；文件损坏、没权限要报出来（不能悄悄当成空数据，否则下一次写入会把历史覆盖掉） */
async function readJson(file, fallback) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`监控数据读取失败（${file.split(/[\\/]/).slice(-2).join('/')}）：${err.code || err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`监控数据文件损坏（${file.split(/[\\/]/).slice(-2).join('/')}），请检查或删除后重建这个监控`);
  }
}

/** 先写临时文件再改名：中途崩溃 / 磁盘满不会留下写了一半的文件 */
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
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
    // 列表里跳过读不出来的（单个监控损坏不影响列出其他的）
    const metas = await Promise.all(ids.map((id) => readJson(join(root, id, 'meta.json'), null).catch(() => null)));
    return metas.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  }

  const getWatch = (id) => readJson(join(dir(id), 'meta.json'), null);

  /** create=false 用于更新：目录已被删除时写入失败，不会把已删除的监控重建出来 */
  async function saveWatch(watch, { create = true } = {}) {
    if (create) {
      await mkdir(root, { recursive: true });
      // 排他创建：同一 ID 已存在就失败（EEXIST），调用方换个 ID 重试，不会覆盖已有监控
      await mkdir(dir(watch.id));
      await mkdir(join(dir(watch.id), 'snap'));
    }
    await writeAtomic(join(dir(watch.id), 'meta.json'), JSON.stringify(watch, null, 1));
    return watch;
  }

  const deleteWatch = (id) => rm(dir(id), { recursive: true, force: true });

  const saveImage = (id, dataUrl) => (dataUrl ? writeAtomic(join(dir(id), 'image.txt'), dataUrl) : Promise.resolve());
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
    await writeAtomic(join(dir(id), 'snap', `${ts}.json.gz`), gzipSync(JSON.stringify(results)));
    const next = [...index, { ts, summary }];
    const overflow = next.slice(0, Math.max(0, next.length - MAX_SNAPSHOTS));
    await Promise.all(overflow.map((s) => unlink(join(dir(id), 'snap', `${s.ts}.json.gz`)).catch(() => {})));
    await writeAtomic(join(dir(id), 'snapshots.json'), JSON.stringify(next.slice(overflow.length)));
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
    await writeAtomic(join(dir(id), 'events.json'), JSON.stringify(all.slice(-MAX_EVENTS)));
  }

  const loadBaseline = (id) => readJson(join(dir(id), 'baseline.json'), {});
  const saveBaseline = (id, baseline) => writeAtomic(join(dir(id), 'baseline.json'), JSON.stringify(baseline));

  return { loadBaseline, saveBaseline, listWatches, getWatch, saveWatch, deleteWatch, saveImage, loadImage, listSnapshots, addSnapshot, loadSnapshot, loadEvents, appendEvents };
}
