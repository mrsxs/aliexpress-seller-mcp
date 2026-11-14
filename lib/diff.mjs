// 对比两次快照，找出活动开始/结束/变化、价格变化、先涨价等事件（纯函数）

const TOOL_NAMES = {
  superDeals: 'SuperDeals',
  realSuperDeals: 'SuperDeals',
  limitedDiscount: '限时折扣',
  channelDiscount: '渠道折扣',
  platformItemSubsidy: '平台补贴',
  mockedSalePrice: '模拟售价',
  proEngine: '营销引擎',
};

// 阈值：活动折扣变化 ≥3 个百分点、价格变化 ≥3%、无活动价上涨 ≥5% 才算事件，过滤舍入噪音
const PCT_POINT_DELTA = 0.03;
const PRICE_DELTA = 0.03;
const LIST_RAISE_DELTA = 0.05;

export const ACTIVITY_EVENT_TYPES = new Set(['activity-start', 'activity-change', 'early-bird']);

export function activityText(item) {
  if (!(item?.activityPct > 0)) return '无活动';
  const names = [...new Set((item.activityTools || []).map((t) => TOOL_NAMES[t] || t))].join('+') || '活动';
  return `${names} −${Math.round(item.activityPct * 100)}%`;
}

const money = (v) => (Number.isFinite(v) ? `$${v.toFixed(2)}` : '—');
const rel = (a, b) => (a > 0 && Number.isFinite(b) ? (b - a) / a : 0);
const toolsKey = (item) => [...(item.activityTools || [])].sort().join(',');

function brief(item) {
  return {
    listPrice: item.listPrice,
    real: item.real,
    display: item.display,
    activityPct: item.activityPct || 0,
    activity: activityText(item),
  };
}

/** 单个商品在单个地区的变化 */
function diffItem(prev, curr) {
  const wasActive = prev.activityPct > 0;
  const isActive = curr.activityPct > 0;
  const events = [];
  if (!wasActive && isActive) {
    events.push({ type: 'activity-start', text: `活动开始：${activityText(curr)}，${money(prev.real)} → ${money(curr.real)}` });
  } else if (wasActive && !isActive) {
    events.push({ type: 'activity-end', text: `活动结束：${money(prev.real)} → ${money(curr.real)}` });
  } else if (isActive && (toolsKey(prev) !== toolsKey(curr) || Math.abs(curr.activityPct - prev.activityPct) >= PCT_POINT_DELTA)) {
    events.push({ type: 'activity-change', text: `活动变化：${activityText(prev)} → ${activityText(curr)}，${money(prev.real)} → ${money(curr.real)}` });
  } else if (Math.abs(rel(prev.real, curr.real)) >= PRICE_DELTA) {
    events.push({ type: 'price-change', text: `价格${curr.real > prev.real ? '上涨' : '下降'}：${money(prev.real)} → ${money(curr.real)}` });
  }
  // 大促前常见的「先涨无活动价再打折」
  if (rel(prev.listPrice, curr.listPrice) >= LIST_RAISE_DELTA) {
    events.push({ type: 'list-raise', text: `无活动价上调：${money(prev.listPrice)} → ${money(curr.listPrice)}` });
  }
  if (!prev.earlyBird && curr.earlyBird) {
    events.push({ type: 'early-bird', text: `出现早鸟价：${curr.earlyBird}` });
  }
  return events;
}

const BASELINE_TTL_MS = 30 * 86_400_000;
const baselineKey = (region, item) => `${region}|${item.productId}|${item.skuId || ''}`;

function baselineEntry(item, ts) {
  return {
    listPrice: item.listPrice,
    real: item.real,
    display: item.display,
    activityPct: item.activityPct || 0,
    activityTools: item.activityTools || [],
    earlyBird: item.earlyBird || '',
    seen: ts,
  };
}

/**
 * 和基准对比：基准记录每个「地区|商品|SKU」上次出现时的价格。
 * 搜索卡片每次展示的 SKU 可能不同，只有同 SKU 才比较，避免误报。
 * 返回 { events, baseline }（新基准，不修改传入对象；30 天未出现的条目会清理）
 */
export function diffAgainstBaseline(baseline, currResults, ts = Date.now()) {
  const prev = baseline || {};
  const events = [];
  const updates = {};
  for (const [region, curr] of Object.entries(currResults || {})) {
    for (const item of curr.items || []) {
      const key = baselineKey(region, item);
      const before = prev[key];
      updates[key] = baselineEntry(item, ts);
      // 超过保留期没出现过的旧基准不拿来比（说明里写的是 30 天重置基准）
      if (!before || ts - (before.seen || 0) >= BASELINE_TTL_MS) continue;
      for (const ev of diffItem(before, item)) {
        events.push({
          ...ev,
          region,
          productId: item.productId,
          skuId: item.skuId || '',
          title: item.title,
          image: item.image,
          before: brief(before),
          after: brief(item),
        });
      }
    }
  }
  const kept = Object.fromEntries(Object.entries(prev).filter(([, v]) => ts - (v.seen || 0) < BASELINE_TTL_MS));
  return { events, baseline: { ...kept, ...updates } };
}

/** 两份快照直接对比（以 prev 为基准） */
export function diffSnapshots(prevResults, currResults) {
  if (!prevResults) return [];
  const { baseline } = diffAgainstBaseline({}, prevResults, 0);
  return diffAgainstBaseline(baseline, currResults, 0).events;
}

/** 每个地区的活动概况，存进快照索引，列表里展示用 */
export function summarizeResults(results) {
  return Object.fromEntries(
    Object.entries(results || {}).map(([region, r]) => {
      const items = r.items || [];
      return [region, { count: items.length, activity: items.filter((i) => i.activityPct > 0).length }];
    }),
  );
}
