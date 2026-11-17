// 不依赖页面定时器的 mtop 调用。
// 页面自带的 window.lib.mtop 内部用 setTimeout；紫鸟窗口最小化或标签页在后台超过 5 分钟后，Chrome 会把
// 定时器限流到约 1 分钟一次，请求会卡住几分钟（2026-11-14 实测：后台 >120 秒无返回，前台 0.86 秒）。
// 这里在 Node 里按 H5 规则签名（sign = md5(token&t&appKey&data)，token 取 cookie _m_h5_tk 的前半段），
// 页面里只发一次 fetch；超时由 Node 侧（CDP 调用超时）控制，不受页面限流影响。
import { createHash } from 'node:crypto';
import { hasRiskText, isRiskJson } from './risk.mjs';

// 令牌缺失 / 过期时服务端会在响应里下发新的 _m_h5_tk，重签一次即可。
// 风控（RGV587_ERROR、FAIL_SYS_USER_VALIDATE、data.url 指向验证页）先判断，绝不重试。
const RISK = /RGV587|FAIL_SYS_USER_VALIDATE/;
const TOKEN_RETRY = /FAIL_SYS_TOKEN_EMPTY|FAIL_SYS_TOKEN_EXOIRED|FAIL_SYS_TOKEN_EXPIRED|FAIL_SYS_ILLEGAL_ACCESS/;

export const BUYER_MTOP_HOST = 'acs.aliexpress.com';
export const SELLER_MTOP_HOST = 'seller-acs.aliexpress.com';

export class MtopError extends Error {
  constructor(message, ret) {
    super(message);
    this.ret = ret;
  }
}

export function h5Token(cookieHeader) {
  const m = String(cookieHeader || '').match(/(?:^|;\s*)_m_h5_tk=([^;]+)/);
  return m ? decodeURIComponent(m[1]).split('_')[0] : '';
}

export function h5Sign(token, t, appKey, dataStr) {
  return createHash('md5').update(`${token}&${t}&${appKey}&${dataStr}`).digest('hex');
}

/** 组装请求（纯函数，便于测试）：返回 { url, body } */
export function buildMtopRequest({ api, v = '1.0', data = {}, appKey, host = BUYER_MTOP_HOST, method = 'POST', query = {}, token, t }) {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  const qs = new URLSearchParams({
    jsv: '2.7.2', appKey: String(appKey), t: String(t), sign: h5Sign(token, t, appKey, dataStr),
    api, v, type: 'originaljson', dataType: 'json', ...query,
  });
  if (method === 'GET') qs.set('data', dataStr);
  return {
    url: `https://${host}/h5/${api.toLowerCase()}/${v}/?${qs}`,
    body: method === 'POST' ? `data=${encodeURIComponent(dataStr)}` : null,
  };
}

// ---- 下面两个函数会被序列化到页面里执行，必须自包含；不用 setTimeout ----
async function pageFetch({ url, body, headers, id = null }) {
  const ctrl = new AbortController();
  if (id) (window.__aeAborts || (window.__aeAborts = {}))[id] = ctrl;
  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      credentials: 'include',
      headers: Object.assign({}, headers || {}, body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      body: body || undefined,
      signal: ctrl.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { error: (e && e.message) || '请求失败' };
  } finally {
    if (id && window.__aeAborts) delete window.__aeAborts[id];
  }
}

export function abortInPage(id) {
  const ctrl = window.__aeAborts && window.__aeAborts[id];
  if (!ctrl) return false;
  ctrl.abort();
  delete window.__aeAborts[id];
  return true;
}

let seq = 0;
/** Node 侧：在页面里执行一个可取消的请求函数；CDP 调用超时后取消页面里还没结束的请求，免得旧请求继续跑 */
export async function callAbortable(cdp, fn, arg, timeoutMs) {
  const id = `${process.pid}-${Date.now()}-${++seq}`;
  try {
    return await cdp.callInPage(fn, { ...arg, id }, timeoutMs);
  } catch (err) {
    await Promise.resolve(cdp.callInPage(abortInPage, id, 3000)).catch(() => {});
    throw err;
  }
}

/**
 * 在店铺浏览器的标签页里调用一个 mtop 接口。cdp 来自 createBrowserSession().connect()。
 * opts: { api, v, data, appKey, host, method: 'POST'|'GET', query: 额外 URL 参数, headers: 额外请求头, timeoutMs }
 * 成功返回完整响应 JSON（{ ret, data, ... }）；失败抛 MtopError（带 ret）。
 */
export async function mtopFetch(cdp, { timeoutMs = 60_000, headers, signal, ...opts }) {
  for (let attempt = 0; ; attempt++) {
    // 调用方已经放弃（比如扫描到了截止时间）：不再发新请求，包括令牌失效后的重试
    if (signal?.aborted) throw new MtopError(`${opts.api} 已取消（超过时限）`);
    const token = h5Token(await cdp.evaluate('document.cookie', 5000));
    // 读 cookie 期间可能刚好被取消：发请求前再看一次
    if (signal?.aborted) throw new MtopError(`${opts.api} 已取消（超过时限）`);
    const req = buildMtopRequest({ ...opts, token, t: Date.now() });
    const r = await callAbortable(cdp, pageFetch, { ...req, headers }, timeoutMs);
    if (!r || r.error) throw new MtopError(`${opts.api} 请求失败：${r?.error || '无返回'}`);
    let json;
    try {
      json = JSON.parse(r.text);
    } catch {
      if (hasRiskText(String(r.text).slice(0, 4000))) {
        throw new MtopError(`${opts.api} 失败：FAIL_SYS_USER_VALIDATE::返回了安全验证页`, ['FAIL_SYS_USER_VALIDATE']);
      }
      throw new MtopError(`${opts.api} 返回的不是 JSON（HTTP ${r.status}）`);
    }
    // ret 一般是数组，偶尔是字符串；先规范化再判断
    const retList = Array.isArray(json?.ret) ? json.ret : typeof json?.ret === 'string' ? [json.ret] : [];
    const ret = retList.join(';');
    if (RISK.test(ret)) throw new MtopError(`${opts.api} 失败：${ret}`, retList);
    if (isRiskJson(json)) throw new MtopError(`${opts.api} 失败：FAIL_SYS_USER_VALIDATE::返回了验证页地址`, ['FAIL_SYS_USER_VALIDATE']);
    if (TOKEN_RETRY.test(ret) && attempt === 0) continue;
    if (!/^SUCCESS/.test(retList[0] || '')) throw new MtopError(`${opts.api} 失败：${ret || `HTTP ${r.status}`}`, retList);
    return json;
  }
}
