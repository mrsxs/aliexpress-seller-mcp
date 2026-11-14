// 卖家后台（csp.aliexpress.com）mtop 客户端 + 生意参谋的时间口径。
// 请求在紫鸟店铺浏览器的卖家后台标签页里发（带店铺登录态），签名在 Node 侧（lib/mtop-fetch.mjs），
// 不用页面自带的 lib.mtop：它依赖页面定时器，窗口最小化后会被 Chrome 限流卡住。
// appKey、附加参数、请求头取自页面的 window.mtopConfig；x-referer 按接口所属页面改写，和在那个页面里点开时一致，
// 所以不用把标签页导航到对应页面（2026-11-14 实测：生意参谋、订单、商品接口都可以在任一卖家后台页里调）。
import { hasRiskText, redact, riskInObject } from './risk.mjs';
import { MtopError, SELLER_MTOP_HOST, mtopFetch } from './mtop-fetch.mjs';

export class SellerError extends Error {}

const FALLBACK_APP_KEY = '30267743';
const DAY_MS = 86_400_000;

export const SHOP_MODELS = { POP: '普通店（可参加半托管）', ONE_STOP_SERVICE: '全托管' };

/**
 * 从「店铺切换」接口的返回里挑出速卖通店铺：优先页面当前的 channelId，否则取营业中的那家。
 * 全托管店的后台首页 mtopConfig 里没有 channelId，只能从这里拿。
 */
export function pickAeShop(shopList, currentChannelId) {
  const ae = (shopList || []).filter((s) => s.channelType === 'AE' && s.channelId);
  const shop = ae.find((s) => String(s.channelId) === String(currentChannelId)) ?? ae.find((s) => s.shopStatusId === 1) ?? ae[0];
  if (!shop) return null;
  return { channelId: String(shop.channelId), shopModel: shop.shopModel ?? null, shopName: shop.shopName ?? null, status: shop.shopStatusName ?? null };
}

/** 读卖家后台页面的 mtop 配置，并确定店铺 channelId 和经营模式（POP / 全托管） */
export async function sellerContext(cdp, fetchImpl = mtopFetch) {
  const cfg = await cdp.evaluate(`(() => { const c = window.mtopConfig || {};
    return { appKey: c.appKey || null, query: c.queryStringParameters || {}, headers: c.headers || {} }; })()`, 5000);
  const appKey = cfg?.appKey || FALLBACK_APP_KEY;
  const current = cfg?.query?.['__channel-id__'];
  let res;
  try {
    res = await fetchImpl(cdp, {
      api: 'mtop.ae.csp.nav.shop.list', v: '1.0', appKey, host: SELLER_MTOP_HOST, method: 'POST', data: current ? { channelId: current } : {},
      query: { ...cfg.query, H5Request: 'true', valueType: 'original', timeout: '30000' }, headers: cfg.headers, timeoutMs: 30_000,
    });
  } catch (err) {
    // 只有接口业务错误（登录失效、验证码…）是用户能处理的；连接超时 / 断开照原样抛，让调用方重建浏览器会话
    if (err instanceof MtopError) throw new SellerError(explainSellerError('店铺列表', err.message));
    throw err;
  }
  const shop = pickAeShop(res?.data?.data?.shopList, current);
  if (!shop) throw new SellerError('这个卖家账号下没有速卖通店铺：请确认紫鸟店铺浏览器登录的是速卖通卖家后台');
  return {
    appKey, headers: cfg.headers, channelId: shop.channelId, shopModel: shop.shopModel, shopName: shop.shopName,
    query: { ...cfg.query, '__channel-id__': shop.channelId },
  };
}

/**
 * 缓存的店铺上下文还能不能用：页面当前的 channel 读到了（包括空串）而且和缓存时的不一样，就要重取。
 * 缓存时没读到（null = 未知）、这次读到了，也重取；这次读取失败（READ_FAILED）就先不动。
 */
export const CHANNEL_READ_FAILED = Symbol('channel read failed');
export function contextStale(cachedPageChannel, current) {
  if (current === CHANNEL_READ_FAILED) return false;
  return cachedPageChannel !== String(current ?? '');
}

export const refererFor = (page, channelId) => `csp.aliexpress.com${page}${page.includes('?') ? '&' : '?'}channelId=${channelId}`;

export function explainSellerError(api, message) {
  const msg = String(message || '');
  // 验证优先于登录判断（「FAIL_SYS_USER_VALIDATE::请登录验证」是验证）
  if (hasRiskText(msg)) return '触发了速卖通安全验证，请在紫鸟店铺浏览器里打开卖家后台手动完成验证后重试';
  if (/SESSION_EXPIRED|SID_INVALID|login|登录/i.test(msg)) return '卖家后台登录已失效，请在紫鸟店铺浏览器里重新登录速卖通卖家后台';
  return `卖家后台接口失败（${api}）：${redact(msg.replace(/^[^：]*：/, ''))}`;
}

/** 返回 call({ api, method, data, page })：page 是接口所属的后台页面路径，用来设置 x-referer */
export function createSellerApi(cdp, ctx, fetchImpl = mtopFetch) {
  return async function call({ api, method = 'POST', data, page }) {
    try {
      const res = await fetchImpl(cdp, {
        api, v: '1.0', appKey: ctx.appKey, host: SELLER_MTOP_HOST, method, data,
        query: { ...ctx.query, H5Request: 'true', valueType: 'original', timeout: '30000' },
        headers: { ...ctx.headers, 'x-referer': refererFor(page, ctx.channelId) },
        timeoutMs: 45_000,
      });
      const d = res.data;
      // 外层 SUCCESS 但内层业务失败：不能当空结果
      // 先看整个内层对象有没有风控（错误码和文案可能分开放，data.url 也可能指向验证页）
      if (d && typeof d === 'object' && riskInObject(d)) throw new SellerError(explainSellerError(api, 'FAIL_SYS_USER_VALIDATE'));
      if (d && typeof d === 'object' && (d.success === false || d.isSuccess === false)) {
        const parts = [d.errorCode, d.errorMsg || d.errorMessage || (typeof d.msg === 'string' ? d.msg : '')].filter(Boolean);
        throw new SellerError(explainSellerError(api, parts.join('：') || '业务失败'));
      }
      return d;
    } catch (err) {
      if (err instanceof MtopError) throw new SellerError(explainSellerError(api, err.message));
      throw err;
    }
  };
}

// ---- 时间口径 ----
// 生意参谋按美国太平洋时间出数，通常最新到太平洋时间的「昨天」；最新日期用 latestStatDate() 问接口。

export const PERIODS = ['day', 'recent7', 'recent30'];
const PERIOD_DAYS = { day: 1, recent7: 7, recent30: 30 };

export function assertDate(date, label = 'date') {
  const s = String(date ?? '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) throw new SellerError(`${label} 应是 YYYY-MM-DD 格式的日期`);
  return s;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

export const compactDate = (date) => date.replaceAll('-', '');

/** period + 结束日 → { period, start, end, days } */
export function periodRange(period, end) {
  const days = PERIOD_DAYS[period];
  if (!days) throw new SellerError(`period 只能是：${PERIODS.join('、')}`);
  return { period, start: addDays(end, 1 - days), end, days };
}

// 商品排行接口的时间参数是「北京时间当天 0 点」的毫秒数，结束时间是当天 23:59:59.059（页面就这么传，少了 endDate 返回空）
const CN_OFFSET_MS = 8 * 3600_000;
const dayStartMs = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - CN_OFFSET_MS;
};
export function rankTimes({ start, end }) {
  return { statDate: dayStartMs(start), endDate: dayStartMs(end) + DAY_MS - 941 };
}

/**
 * 按 period / date 参数算出统计区间；date 不填用接口给的最新日期，填了不能晚于它。
 * latest: () => Promise<'YYYY-MM-DD'>
 */
export async function resolveRange({ period = 'recent7', date } = {}, latest) {
  if (date) assertDate(date);
  let newest = await latest();
  if (date && date > newest) newest = await latest(true);
  const end = date || newest;
  if (end > newest) throw new SellerError(`生意参谋的数据最新到 ${newest}（美国太平洋时间），date 不能晚于它`);
  return periodRange(period, end);
}
