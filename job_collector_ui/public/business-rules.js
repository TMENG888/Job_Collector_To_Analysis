// Business context needs specific evidence, rather than generic words like 文档 or 内容.
export const businessRules = [
  ['企业服务', /企业服务|SaaS|办公协同|ERP|CRM|企业管理平台|企业知识库/i],
  ['金融', /金融|银行|证券|保险|信贷|支付业务|投资交易/i],
  ['电商零售', /电商|零售|商品数据|商品价格|商城|店铺|竞品价格|购物|订单/i],
  ['教育', /教育行业|在线教育|教学|教研|学校|学习平台|教育产品/i],
  ['医疗健康', /医疗|医院|医药|临床|健康管理|患者|医疗数据/i],
  ['工业制造', /工业|制造|工厂|生产线|工业设备|智能制造/i],
  ['内容与知识服务', /内容平台|内容推荐|知识库|知识管理|搜索引擎|新闻资讯|媒体资讯|舆情|问答系统|知识检索/i],
  ['政务与公共服务', /政务|政府|公共服务|事业单位|公共资源/i],
  ['物流与交通', /物流|交通|车联网|仓储|货运|运输调度/i],
  ['游戏与文娱', /游戏|文娱|短视频|视频平台|直播平台|影视/i],
];
export function businessLabels(source) {
  const text=String(source || '');
  return businessRules.flatMap(([label,pattern])=>{
    const match=pattern.exec(text);
    return match ? [{label_type:'domain',label,source_field:'job_description',quote:text.slice(Math.max(0,match.index-20),Math.min(text.length,match.index+match[0].length+60))}] : [];
  });
}
