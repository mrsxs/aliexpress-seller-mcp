// 速卖通操作：在店铺浏览器页面里上传图片、按收货地抓取图搜结果
import { isBlockingError } from './cooldown.mjs';
import { callAbortable } from './mtop-fetch.mjs';
import { hasRiskText, redact, riskInObject } from './risk.mjs';
import { SEARCH_VERIFY } from './parse.mjs';
import { parseSearchHtml } from './parse.mjs';
import { BUYER_MTOP_HOST, mtopFetch } from './mtop-fetch.mjs';

const AE_ORIGIN = 'https://www.aliexpress.com';
const REGION_COOKIE = 'aep_usuc_f';
const UPLOAD_MAX_BYTES = 200 * 1024; // 与速卖通前端一致：超过 200KB 先压缩
const UPLOAD_MAX_SIDE = 1200;

export const searchUrl = (fileId) => `${AE_ORIGIN}/w/wholesale-.html?isNewImageSearch=y&filename=${encodeURIComponent(fileId)}`;

export function assertFileId(fileId) {
  if (!/^OSS\/[\w\-./]+\.(jpe?g|png|webp)$/i.test(String(fileId || ''))) throw new Error('fileId 格式不正确');
  return String(fileId);
}

// ---- 以下两个函数会被序列化到页面里执行，必须自包含 ----

/**
 * 页面内：把图片压缩成 JPEG base64（≤ maxBytes），并取 cna cookie。
 * 用 createImageBitmap + OffscreenCanvas：不依赖页面渲染和定时器，紫鸟窗口最小化时也能跑
 * （<img>.decode() 挂在渲染流程上，窗口最小化后不会完成）。
 */
async function pageCompressImage({ dataUrl, maxBytes, maxSide }) {
  try {
    const src = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(src);
    let scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    let quality = 0.85;
    let out = null;
    for (let i = 0; i < 10; i++) {
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      if (out.size <= maxBytes) break;
      if (quality > 0.6) quality -= 0.1;
      else scale *= 0.8;
    }
    const bytes = new Uint8Array(await out.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const cna = (document.cookie.match(/(?:^|; )cna=([^;]*)/) || [])[1] || '';
    return { b64: btoa(bin), cna };
  } catch (e) {
    return { error: (e && e.message) || '图片解码失败' };
  }
}

/** 页面内：带 cookie 请求搜索页 HTML（Node 侧超时也会取消它：旧请求不能带着下一个地区的 cookie 返回） */
async function pageFetchHtml({ url, timeoutMs, id = null }) {
  const ctrl = new AbortController();
  if (id) (window.__aeAborts || (window.__aeAborts = {}))[id] = ctrl;
  try {
    const signal = AbortSignal.any ? AbortSignal.any([ctrl.signal, AbortSignal.timeout(timeoutMs)]) : ctrl.signal;
    const res = await fetch(url, { credentials: 'include', signal });
    return { status: res.status, finalUrl: res.url, html: await res.text() };
  } catch (e) {
    return { error: (e && e.message) || '请求失败' };
  } finally {
    if (id && window.__aeAborts) delete window.__aeAborts[id];
  }
}

// ---- Node 侧 ----

// 图片上传走 mtopFetch（Node 侧签名 + 页面 fetch），不经过页面的 lib.mtop：
// 紫鸟窗口最小化 / 标签页在后台时，lib.mtop 的定时器会被 Chrome 限流，上传会卡几分钟。
export async function uploadImage(cdp, dataUrl) {
  const img = await cdp.callInPage(pageCompressImage, { dataUrl, maxBytes: UPLOAD_MAX_BYTES, maxSide: UPLOAD_MAX_SIDE }, 30_000);
  if (!img || img.error) throw new Error(`图片处理失败: ${img?.error || '无返回'}`);
  const params = {
    platform: 'pc', page: 1, pageSize: 60, appId: 21738, isNewImageSearch: true,
    osf: 'pc_web_image_search', clientType: 'pc', searchBizScene: 'imageSearch',
    subScenario: 'imageUpload', image_base64: img.b64, shpt_co: 'US', _currency: 'USD',
    sortType: 'default', sortOrder: 'default', cookieId: img.cna, contentType: 'imageUpload',
  };
  let res;
  try {
    res = await mtopFetch(cdp, {
      api: 'mtop.relationrecommend.AliexpressRecommend.recommend', v: '1.0', appKey: '24815441',
      host: BUYER_MTOP_HOST, method: 'POST', data: { appId: 21738, params: JSON.stringify(params) }, timeoutMs: 60_000,
    });
  } catch (err) {
    if (hasRiskText(err.message)) throw new Error(SEARCH_VERIFY);
    throw new Error(`图片上传失败: ${redact(err.message)}`);
  }
  const d = res.data || {};
  if (riskInObject(d) || hasRiskText(d.exceptionInfo)) throw new Error(SEARCH_VERIFY);
  if (!d.success || !d.fileId) {
    const ret = Array.isArray(res.ret) ? res.ret.join(';') : String(res.ret ?? '');
    throw new Error(`图片上传失败: ${redact(d.exceptionInfo || ret || '未知原因')}`);
  }
  return { fileId: d.fileId, bytes: Math.round(img.b64.length * 0.75) };
}

async function getRegionCookie(cdp) {
  const { cookies } = await cdp.send('Network.getCookies', { urls: [`${AE_ORIGIN}/`] });
  const c = cookies.find((x) => x.name === REGION_COOKIE);
  if (!c) throw new Error('未找到速卖通地区 cookie（aep_usuc_f），请先在店铺浏览器里打开一次速卖通');
  return c;
}

/** 替换（或追加）cookie 值里的 region / c_tp 段 */
export function withRegion(cookieValue, region, currency) {
  const parts = cookieValue.split('&').filter((kv) => !kv.startsWith('region=') && !kv.startsWith('c_tp='));
  return [...parts, `c_tp=${currency}`, `region=${region}`].join('&');
}

const readRegion = (value) => (String(value).match(/(?:^|&)region=([A-Z]{2})/) || [])[1];

async function setRegionCookie(cdp, base, value) {
  const params = {
    name: base.name, value, domain: base.domain, path: base.path,
    secure: base.secure, httpOnly: base.httpOnly, sameSite: base.sameSite,
    // 会话 cookie 的 expires 为 -1，原样传回会被当成已过期
    ...(base.expires > 0 ? { expires: base.expires } : {}),
  };
  const { success } = await cdp.send('Network.setCookie', params);
  if (success === false) throw new Error('设置收货地 cookie 失败');
}

async function fetchRegion(cdp, url, cookie, region, currency) {
  await setRegionCookie(cdp, cookie, withRegion(cookie.value, region, currency));
  const applied = readRegion((await getRegionCookie(cdp)).value);
  if (applied !== region) throw new Error(`收货地切换未生效（当前 ${applied || '未知'}）`);
  const started = Date.now();
  const r = await callAbortable(cdp, pageFetchHtml, { url, timeoutMs: 45_000 }, 60_000);
  if (!r || r.error) throw new Error(r?.error || '请求无返回');
  const items = parseSearchHtml(r.html, r.finalUrl);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return { items, ms: Date.now() - started };
}

/**
 * 依次切换收货地抓取结果（cookie 是浏览器全局的，只能串行），结束后一定还原 cookie。
 * onResult({ region, items, ms }) / onError({ region, error })
 */
export async function searchRegions(cdp, { fileId, regions, currency = 'USD', onResult, onError, onWarning, isCancelled }) {
  const url = searchUrl(assertFileId(fileId));
  const original = await getRegionCookie(cdp);
  try {
    for (const region of regions) {
      if (isCancelled?.()) break;
      try {
        const { items, ms } = await fetchRegion(cdp, url, original, region, currency);
        onResult({ region, items, ms });
      } catch (err) {
        // 安全验证 / 登录失效：整体停下（finally 里照样还原 cookie），不再搜下一个地区
        if (isBlockingError(err)) throw err;
        onError({ region, error: err.message });
      }
    }
  } finally {
    await setRegionCookie(cdp, original, original.value).catch((err) => {
      console.error('[cookie restore]', err);
      onWarning?.(`收货地 cookie 还原失败，请在店铺浏览器里手动确认速卖通收货地（原值 region=${readRegion(original.value) || '?'}）`);
    });
  }
}
