// 订单列表（卖家后台「所有订单」页）。接口是 Ultron 页面协议：
// 第一次请求返回整页组件（筛选、分页、10 个订单表格组件…）；翻页 / 筛选时把上一次返回的
// linkage、hierarchy 和改过的输入组件（看板、筛选、分页）gzip + base64 后放进 params 再请求一次（页面就是这么做的）。
// 买家名本来就打码，这里也不输出，只留国家。
import { gzipSync } from 'node:zlib';
import { SellerError } from './seller.mjs';

export const ORDER_PAGE = '/m_apps/order-manage/orderList';
const ORDER_API = 'mtop.aliexpress.trade.seller.order.list';
const BOARD_API = 'mtop.aliexpress.trade.seller.order.board';

export const ORDER_STATUS = {
  all: ['930', '所有订单状态'],
  unpaid: ['100', '等待买家付款'],
  confirm_shipping_mode: ['420', '等待卖家确认发货模式'],
  to_ship: ['500', '等待发货'],
  partially_shipped: ['600', '您已部分发货'],
  shipped: ['700', '等待买家收货'],
  finished: ['970', '交易结束'],
  frozen: ['-1', '冻结中'],
  payment_processing: ['200', '付款处理中'],
  confirm_amount: ['300', '等待您确认金额'],
  cancel_requested: ['550', '买家申请取消订单'],
  info_required: ['990', '用户待补充信息'],
};

export const ORDER_TYPES = {
  all: '所有订单类型',
  semiChoiceSelfWareHouseOrder: '半托管仓发订单',
  semiChoiceJitOrder: '半托管 JIT 订单',
  unSemiChoice: '非半托管订单',
  semiChoice2SelfShipOrder: '半托管转自发货订单',
  locOrder: '发货考核订单',
  collectLocOrder: '揽收考核订单',
  wholeSaleOrder: '店铺批发订单',
  presaleOrder: '预售订单',
};

export const PAGE_SIZES = [10, 20, 50, 100];

const BOARD_TABS = ['TodayNew', 'Unpaid', 'WaitConfirmShippingMode', 'WaitSendGoods', 'InCancel', 'InIssue', 'WaitSellerEvaluate'];
const BOARD_LABELS = {
  TodayNew: 'today_new', Unpaid: 'unpaid', WaitConfirmShippingMode: 'confirm_shipping_mode', WaitSendGoods: 'to_ship',
  InCancel: 'cancel_requested', InIssue: 'in_dispute', WaitSellerEvaluate: 'to_review',
};

const findComp = (data, re) => Object.keys(data || {}).find((k) => re.test(k));

/** 用上一次的返回构造翻页 / 筛选请求的 params（纯函数，便于测试） */
export function buildAdjustParams(prev, { status = 'all', orderType = 'all', page = 1, pageSize = 20, orderId } = {}) {
  const inputs = prev?.linkage?.input;
  if (!Array.isArray(inputs) || !prev.hierarchy) throw new Error('订单列表返回结构变了（没有 linkage.input），无法翻页');
  const data = {};
  for (const id of inputs) data[id] = structuredClone(prev.data[id]);
  const pager = findComp(data, /pagination/);
  const search = findComp(data, /order_search/);
  if (!pager || !search) throw new Error('订单列表返回结构变了（找不到分页 / 筛选组件），无法翻页');
  const [code, label] = ORDER_STATUS[status];
  const fields = data[search].fields;
  fields.searchParams = { ...fields.searchParams, orderStatus: code, lastSelectOrderStatus: code, orderBusinessType: orderType, reset: false };
  if (orderId) fields.searchParams.tradeOrderId = String(orderId);
  for (const c of fields.conditions || []) {
    if (c.type === 'orderStatus') c.current = { label, value: code };
    if (c.type === 'orderBusinessType') c.current = { label: ORDER_TYPES[orderType] ?? orderType, value: orderType };
    if (c.type === 'tradeOrderId' && orderId) c.current = { value: String(orderId) };
  }
  data[pager].fields.searchParams = { page, pageSize };
  return { endpoint: prev.endpoint, operator: pager, linkage: prev.linkage, data, hierarchy: prev.hierarchy };
}

export const encodeParams = (params) => gzipSync(Buffer.from(JSON.stringify(params))).toString('base64');

const basic = (list, label) => list?.find((b) => b.label === label)?.value ?? null;
const money = (text) => {
  const m = String(text ?? '').match(/([A-Z]{2,3})?\s*\$?\s*([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[2].replace(/,/g, '')) : null;
};

export function parseOrderRow(r) {
  const info = r.orderBasic?.basicInfo || [];
  return {
    order_id: basic(info, '订单号'),
    created_at: basic(info, '下单时间'),
    status: r.orderStatus?.status?.text ?? null,
    status_code: r.orderStatus?.status?.type ?? null,
    amount: r.amount?.text ?? null,
    amount_value: money(r.amount?.text),
    country: r.buyerInfo?.basicInfo?.find((b) => b.type === 'countryCode')?.value ?? null,
    tags: (r.orderBasic?.tags || []).map((t) => t.text).filter(Boolean),
    // 服务列只输出状态类短语（已取消、纠纷中…）；不像状态的文本（可能是买家留言、电话、地址）一律不输出
    notes: (r.service || []).flat().map((s) => s?.text).filter(isServiceStatus),
    items: (r.productInfo || []).map((p) => ({
      title: p.itemTitle,
      sku: (p.productProperty || []).map((x) => x.value).join(' / ') || null,
      sku_code: p.skuCode?.value ?? null,
      quantity: p.quantity ?? null,
      unit_price: p.unitFee ?? null,
      subtotal: p.subTotalFee ?? null,
      order_line_id: String(p.url ?? '').match(/tradeOrderLineId=(\d+)/)?.[1] ?? null,
    })),
  };
}

// 服务列只输出这些完整的状态短语（整句匹配，不按关键词包含判断，免得放过「退款请联系张三」这类自由文本）；倒计时单独认
const SERVICE_PHRASES = new Set([
  '已取消', '买家申请取消', '取消订单申请中', '纠纷中', '有纠纷', '纠纷处理中', '退款中', '已退款', '部分退款', '仲裁中', '售后中',
  '等待付款', '等待发货', '等待买家收货', '等待确认收货', '交易成功', '交易关闭', '订单关闭', '已发货', '部分发货',
  '发货超时', '即将超时', '已延长收货', '已延长发货期', '资金冻结中', '放款中', '已放款', '待评价', '已评价', '风控审核中',
]);
const COUNTDOWN = /^(剩余|还剩|超时剩余|发货剩余)\d{1,3}(天|小时|分钟)(\d{1,2}(小时|分钟))?$/;
/** 状态短语：完全等于已知短语，或者是「剩余 N 天」这样的倒计时 */
export const isServiceStatus = (t) => typeof t === 'string' && (SERVICE_PHRASES.has(t.trim()) || COUNTDOWN.test(t.replace(/\s+/g, '')));

export function parseOrderPage(res) {
  const data = res?.data || {};
  if (!Object.keys(data).length) throw new SellerError('订单接口返回的数据不完整（没有订单表格）');
  const hasTable = Object.keys(data).some((k) => /order_table_\d+_\d+$/.test(k));
  const pagerTotal = data[findComp(data, /pagination/)]?.fields?.total;
  // 没有订单表格：只有分页明确写着 0 条才是「没有订单」，否则是结构不对
  if (!hasTable && pagerTotal !== 0) throw new SellerError('订单接口返回的数据不完整（没有订单表格）');
  const tables = Object.keys(data).filter((k) => /order_table_\d+_\d+$/.test(k)).sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()));
  const orders = tables.flatMap((k) => data[k]?.fields?.dataSource || []).map(parseOrderRow);
  const pager = data[findComp(data, /pagination/)]?.fields ?? {};
  return { page: pager.page ?? null, page_size: pager.pageSize ?? null, total: pager.total ?? null, orders };
}

export async function orderCounts(call, ctx) {
  if (ctx.shopModel === 'ONE_STOP_SERVICE') return null;
  const d = await call({ api: BOARD_API, page: ORDER_PAGE, data: { channelId: ctx.channelId, statisticsOrderTabList: JSON.stringify(BOARD_TABS) } });
  const r = d?.statisticsResult || {};
  return Object.fromEntries(Object.entries(BOARD_LABELS).map(([k, v]) => [v, r[k] ?? null]));
}

export async function listOrders(call, ctx, opts = {}) {
  if (ctx.shopModel === 'ONE_STOP_SERVICE') {
    // 2026-11-14 实测：全托管店调订单接口报 FAIL_BIZ_SESSION_NO_PERMISSION
    throw new SellerError('全托管店铺没有买家订单（由平台履约），卖家后台查不到订单；看销量用 ae_store_overview / ae_product_rank。');
  }
  const base = { channelId: ctx.channelId, timezone: 'America/Los_Angeles', _bizLang: 'zh_CN', ext: JSON.stringify({ channelId: ctx.channelId }) };
  const first = await call({ api: ORDER_API, page: ORDER_PAGE, data: base });
  const { status = 'all', orderType = 'all', page = 1, pageSize = 10, orderId } = opts;
  const isDefault = status === 'all' && orderType === 'all' && page === 1 && pageSize === 10 && !orderId;
  const res = isDefault ? first : await call({ api: ORDER_API, page: ORDER_PAGE, data: { ...base, params: encodeParams(buildAdjustParams(first, opts)) } });
  return parseOrderPage(res);
}
