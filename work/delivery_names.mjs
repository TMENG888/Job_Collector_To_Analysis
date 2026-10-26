// 交付文件命名唯一来源。rebuild / verify / fix_delivery_manifest 三处必须共用，否则映射会漂移。
//
// 约定：
//   子目录 中文渠道数据\<sub>_标准化数据.csv         sub    = 库内 platform 字面量
//   根目录 <delivery>_标准化数据.csv                  delivery = 对外主口径（中文名）
//   根目录 <legacy>_标准化数据.csv                    legacy   = 旧流程兼容副本（英文名）
//   nowcoder 的对外文件名沿用既有的 nowcoder_（不是「牛客_」），改名会断下游引用。
export const chineseChannelLabel = {
  '实习僧': '实习僧', '智联招聘': '智联招聘', '就业在线': '就业在线', '国聘': '国聘',
  '中国公共招聘网': '中国公共招聘网', '猎聘': '猎聘', '前程无忧': '前程无忧', nowcoder: '牛客',
};
export const channelLabel = {
  shixiseng: '实习僧', zhaopin: '智联招聘', jobonline: '就业在线', iguopin: '国聘',
  mohrss: '中国公共招聘网', liepin: '猎聘', job51: '前程无忧', nowcoder: 'nowcoder',
  // 库内 platform 为中文时，每张表自带一份英文兼容键（对外旧流程按英文名引用文件）
  '实习僧': 'shixiseng', '智联招聘': 'zhaopin', '就业在线': 'jobonline', '国聘': 'iguopin',
  '中国公共招聘网': 'mohrss', '猎聘': 'liepin', '前程无忧': 'job51',
};

export const safeName = value => String(value).replace(/[\\/:*?"<>|]/g, '_');

export const deliveryNames = platform => {
  const zh = chineseChannelLabel[platform] || channelLabel[platform] || platform;
  // legacy 必须永远是英文渠道名：有英文键就用英文值，无映射（如 nowcoder）保持原名。
  const mapped = channelLabel[platform];
  const legacy = (mapped && /^[a-z0-9_]+$/i.test(mapped)) ? mapped : platform;
  return {
    delivery: platform === 'nowcoder' ? 'nowcoder' : zh,
    legacy,
    sub: platform,
    zhAlias: zh,
  };
};

// 交付面所有应存在的文件（用于对账清单）
export const deliveryFiles = platform => {
  const names = deliveryNames(platform);
  const list = [['子', `中文渠道数据/${safeName(names.sub)}_标准化数据.csv`], ['根中', `${safeName(names.delivery)}_标准化数据.csv`]];
  if (names.legacy !== names.delivery) list.push(['根英', `${safeName(names.legacy)}_标准化数据.csv`]);
  return list;
};