import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractInitData, parseItem, parseSearchHtml } from '../lib/parse.mjs';
import { withRegion } from '../lib/aliexpress.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('extractInitData 能取出 SSR 数据', () => {
  const data = extractInitData(fixture('US.html'));
  assert.ok(data?.data?.root?.fields?.mods?.itemList?.content?.length > 0);
});

test('非搜索页返回 null / 抛出可读错误', () => {
  assert.equal(extractInitData('<html>nothing</html>'), null);
  assert.throws(() => parseSearchHtml('<html>nothing</html>'), /没有搜索数据/);
  assert.throws(() => parseSearchHtml('<html>punish x5sec</html>'), /验证码/);
});

test('美国：新人补贴被拆出来，原价-优惠=前台价', () => {
  const items = parseSearchHtml(fixture('US.html'));
  assert.equal(items.length, 60);
  assert.ok(items.every((i) => i.npiCountry === 'US'));
  assert.ok(items.filter((i) => i.consistent).length >= 58);
  const subsidized = items.filter((i) => i.newUserSubsidy > 0);
  assert.ok(subsidized.length > 20);
  for (const i of subsidized) {
    assert.ok(i.real > i.display, `${i.productId} 去新人价应高于前台价`);
    assert.equal(Math.round((i.display + i.newUserSubsidy) * 100) / 100, i.real);
  }
});

test('德国：无新人补贴，全部含增值税', () => {
  const items = parseSearchHtml(fixture('DE.html'));
  assert.ok(items.length >= 59);
  assert.ok(items.every((i) => i.npiCountry === 'DE'));
  assert.equal(items.filter((i) => i.newUserSubsidy > 0).length, 0);
  assert.ok(items.filter((i) => i.tax > 0).length >= 59);
  const rates = items.filter((i) => i.taxRate !== null).map((i) => i.taxRate);
  assert.ok(rates.filter((r) => Math.abs(r - 0.19) < 0.01).length >= rates.length - 2, `DE 税率应≈19%: ${rates.join(',')}`);
});

test('字段完整：图片、链接、卖家报价', () => {
  const [first] = parseSearchHtml(fixture('US.html'));
  assert.match(first.image, /^https:\/\//);
  assert.match(first.url, /aliexpress\.com\/item\/\d+\.html/);
  assert.ok(first.sellerOffer > 0);
  assert.ok(first.original >= first.display);
});

test('欧盟参考价：优惠从隐藏标价扣，税按标价算，再折算到实付价', () => {
  // 法国真实样例：划线 6.43、前台 6.02、优惠 7.37、taxAmount 2.23
  const item = {
    productId: '1005012533905477',
    prices: { originalPrice: { cent: 643 }, salePrice: { cent: 602 } },
    trace: {
      utLogMap: { originPriceAmount: '643', salePriceAmount: '602', taxAmount: '223', promotionResultDetails: '5000000207617209:1:737' },
      pdpParams: { pdp_npi: '6%40dis%21USD%216.43%216.02%21%21%2142.6%2139.9%21%40x%21sku%21sea%21FR%211' },
    },
  };
  const r = parseItem(item, 1);
  assert.equal(r.listPrice, 13.39);
  assert.equal(r.consistent, false);
  assert.ok(Math.abs(r.taxRate - 0.2) < 0.005, `taxRate ${r.taxRate}`);
  assert.equal(r.taxInReal, 1);
  assert.equal(r.npiCountry, 'FR');
});

test('销量文本与缺字段兜底', () => {
  const base = { productId: '1', prices: { salePrice: { cent: 100 } }, image: { imgUrl: 123 } };
  assert.equal(parseItem({ ...base, trade: { tradeDesc: '1.2K+ sold' } }, 1).sold, 1200);
  assert.equal(parseItem({ ...base, trade: { tradeDesc: '10,000+ sold' } }, 1).sold, 10000);
  const r = parseItem(base, 1);
  assert.equal(r.image, '');
  assert.equal(r.display, 1);
  assert.equal(r.real, 1);
  assert.equal(r.taxRate, null);
});

test('withRegion 替换或追加 region / c_tp', () => {
  assert.equal(withRegion('site=glo&c_tp=EUR&region=CN&x=1', 'DE', 'USD'), 'site=glo&x=1&c_tp=USD&region=DE');
  assert.equal(withRegion('site=glo', 'US', 'USD'), 'site=glo&c_tp=USD&region=US');
});

test('活动价拆解：限时折扣 / SuperDeals+新人补贴 / 金币价 / 批量价', () => {
  const items = parseSearchHtml(fixture('US.html'));
  const byId = Object.fromEntries(items.map((i) => [i.productId, i]));

  // 限时折扣：标价 1.42 → 活动价 0.98（-31%），金币再减 10%
  const limited = byId['1005007321020795'];
  assert.deepEqual(limited.activityTools, ['limitedDiscount']);
  assert.equal(limited.listPrice, 1.42);
  assert.equal(limited.real, 0.98);
  assert.equal(limited.activityPct, 0.31);
  assert.equal(limited.coinPct, 0.1);
  assert.equal(limited.coinPrice, 0.88);

  // SuperDeals + 新人补贴：活动只算 SuperDeals，新人补贴单独
  const sd = byId['1005012078000958'];
  assert.deepEqual(sd.activityTools, ['superDeals']);
  assert.equal(sd.listPrice, 4.39);
  assert.equal(sd.real, 2.02);
  assert.equal(sd.display, 1.09);
  assert.equal(sd.activityPct, 0.54);

  // 批量价、90 天最低价、早鸟
  assert.deepEqual(byId['1005011826387638'].bulk, { price: 1.04, minQty: 2 });
  assert.deepEqual(byId['1005005231774200'].lowestRef, { days: 90, price: null });
  assert.match(byId['1005013393884328'].earlyBird, /Early bird/);

  // 欧盟 30 天最低价
  const de = Object.fromEntries(parseSearchHtml(fixture('DE.html')).map((i) => [i.productId, i]));
  assert.deepEqual(de['1005012078000958'].lowestRef, { days: 30, price: 2.21 });
  assert.deepEqual(de['1005012078000958'].bulk, { price: 2.05, minQty: 3 });

  // 只有新人补贴的商品：没有活动
  const nuOnly = byId['1005012080638671'];
  assert.deepEqual(nuOnly.activityTools, []);
  assert.equal(nuOnly.activityPct, 0);
  assert.equal(nuOnly.real, nuOnly.listPrice);
});
