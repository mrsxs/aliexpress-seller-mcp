// 监控参数校验（MCP 建监控用）
import { MAX_INTERVAL_MIN, MIN_INTERVAL_MIN } from './monitor.mjs';
import { validateRegions } from './regions.mjs';

export function validateWatchPatch(body, { partial }) {
  const patch = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 60) throw new Error('监控名称 1-60 个字');
    patch.name = name;
  }
  if (!partial || body.intervalMin !== undefined) {
    const n = Number(body.intervalMin);
    if (!Number.isInteger(n) || n < MIN_INTERVAL_MIN || n > MAX_INTERVAL_MIN) throw new Error(`间隔需在 ${MIN_INTERVAL_MIN}-${MAX_INTERVAL_MIN} 分钟之间`);
    patch.intervalMin = n;
  }
  if (body.startAt !== undefined) {
    const t = body.startAt === null || body.startAt === '' ? null : Number(body.startAt);
    if (t !== null && (!Number.isFinite(t) || t < Date.now() - 86_400_000 || t > Date.now() + 366 * 86_400_000)) throw new Error('开始时间不正确');
    patch.startAt = t;
  }
  if (body.regions !== undefined || !partial) patch.regions = validateRegions(body.regions);
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
  if (body.notify !== undefined) patch.notify = Boolean(body.notify);
  return patch;
}
