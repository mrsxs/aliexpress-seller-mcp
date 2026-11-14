// 可选收货地。vat 仅用于界面提示（速卖通对这些地区展示含税价）
export const REGIONS = [
  { code: 'US', name: '美国', flag: '🇺🇸', group: '北美' },
  { code: 'CA', name: '加拿大', flag: '🇨🇦', group: '北美' },
  { code: 'MX', name: '墨西哥', flag: '🇲🇽', group: '拉美' },
  { code: 'BR', name: '巴西', flag: '🇧🇷', group: '拉美' },
  { code: 'CL', name: '智利', flag: '🇨🇱', group: '拉美' },
  { code: 'GB', name: '英国', flag: '🇬🇧', group: '欧洲', vat: 0.2 },
  { code: 'DE', name: '德国', flag: '🇩🇪', group: '欧盟', vat: 0.19 },
  { code: 'FR', name: '法国', flag: '🇫🇷', group: '欧盟', vat: 0.2 },
  { code: 'ES', name: '西班牙', flag: '🇪🇸', group: '欧盟', vat: 0.21 },
  { code: 'IT', name: '意大利', flag: '🇮🇹', group: '欧盟', vat: 0.22 },
  { code: 'NL', name: '荷兰', flag: '🇳🇱', group: '欧盟', vat: 0.21 },
  { code: 'PL', name: '波兰', flag: '🇵🇱', group: '欧盟', vat: 0.23 },
  { code: 'BE', name: '比利时', flag: '🇧🇪', group: '欧盟', vat: 0.21 },
  { code: 'PT', name: '葡萄牙', flag: '🇵🇹', group: '欧盟', vat: 0.23 },
  { code: 'AU', name: '澳大利亚', flag: '🇦🇺', group: '亚太' },
  { code: 'NZ', name: '新西兰', flag: '🇳🇿', group: '亚太' },
  { code: 'KR', name: '韩国', flag: '🇰🇷', group: '亚太' },
  { code: 'JP', name: '日本', flag: '🇯🇵', group: '亚太' },
  { code: 'SA', name: '沙特', flag: '🇸🇦', group: '中东' },
  { code: 'AE', name: '阿联酋', flag: '🇦🇪', group: '中东' },
  { code: 'IL', name: '以色列', flag: '🇮🇱', group: '中东' },
];

export const DEFAULT_REGIONS = ['US', 'GB', 'DE', 'FR', 'ES', 'BR', 'AU', 'KR'];

const CODES = new Set(REGIONS.map((r) => r.code));

/** 校验并去重地区列表 */
export function validateRegions(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('请至少选择一个地区');
  const unique = [...new Set(list.map((c) => String(c).toUpperCase()))];
  const bad = unique.filter((c) => !CODES.has(c));
  if (bad.length) throw new Error(`不支持的地区: ${bad.join(',')}`);
  if (unique.length > REGIONS.length) throw new Error('地区数量过多');
  return unique;
}
