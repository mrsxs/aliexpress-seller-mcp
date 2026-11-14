// 一次图搜比价：连上紫鸟店铺浏览器 → 需要时上传图片 → 逐个收货地抓搜索结果。
// 调用方负责互斥（同一浏览器同一时间只跑一个任务）。
import { searchRegions, uploadImage } from './aliexpress.mjs';

/** emit 收到 log / browser / uploaded / region / region-error / warning / done 事件 */
export async function runImageSearch(session, input, emit) {
  const started = Date.now();
  const cdp = await session.connect(input.storeId, (msg) => emit({ type: 'log', message: msg }));
  emit({ type: 'browser', ...session.info() });

  let { fileId } = input;
  if (!fileId) {
    emit({ type: 'log', message: '正在上传图片到速卖通…' });
    const up = await uploadImage(cdp, input.image);
    fileId = up.fileId;
    emit({ type: 'uploaded', fileId, bytes: up.bytes });
  }

  await searchRegions(cdp, {
    fileId,
    regions: input.regions,
    onResult: ({ region, items, ms }) => emit({ type: 'region', region, items, ms }),
    onError: ({ region, error }) => emit({ type: 'region-error', region, error }),
    onWarning: (message) => emit({ type: 'warning', message }),
  });
  emit({ type: 'done', fileId, ms: Date.now() - started });
}

/** 静默跑一次，收集各地区结果：{ fileId, results: {region: {items, ms}}, errors: {region: message}, warnings, ms } */
export async function collectImageSearch(session, input) {
  const results = {};
  const errors = {};
  const warnings = [];
  let fileId = input.fileId ?? null;
  let ms = 0;
  const emit = (ev) => {
    if (ev.type === 'region') results[ev.region] = { items: ev.items, ms: ev.ms };
    if (ev.type === 'region-error') errors[ev.region] = ev.error;
    if (ev.type === 'warning') warnings.push(ev.message);
    if (ev.type === 'uploaded') fileId = ev.fileId;
    if (ev.type === 'done') ms = ev.ms;
  };
  try {
    await runImageSearch(session, input, emit);
  } catch (err) {
    session.reset();
    throw err;
  }
  // 所有地区都失败（如店铺浏览器被关）时重置会话，下次重新定位并打开浏览器
  if (!Object.keys(results).length && Object.keys(errors).length) session.reset();
  return { fileId, results, errors, warnings, ms };
}
