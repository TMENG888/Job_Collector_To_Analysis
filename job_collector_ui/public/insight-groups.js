const regions={
  北京:'北京',天津:'天津',上海:'上海',重庆:'重庆',
  河北:'石家庄 唐山 秦皇岛 邯郸 邢台 保定 张家口 承德 沧州 廊坊 衡水 雄安 雄安新区',
  山西:'太原 大同 阳泉 长治 晋城 朔州 晋中 运城 忻州 临汾 吕梁',
  内蒙古:'呼和浩特 包头 乌海 赤峰 通辽 鄂尔多斯 呼伦贝尔 巴彦淖尔 乌兰察布 兴安盟 锡林郭勒盟 阿拉善盟',
  辽宁:'沈阳 大连 鞍山 抚顺 本溪 丹东 锦州 营口 阜新 辽阳 盘锦 铁岭 朝阳 葫芦岛',
  吉林:'长春 吉林 四平 辽源 通化 白山 松原 白城 延边',
  黑龙江:'哈尔滨 齐齐哈尔 鸡西 鹤岗 双鸭山 大庆 伊春 佳木斯 七台河 牡丹江 黑河 绥化 大兴安岭',
  江苏:'南京 无锡 徐州 常州 苏州 南通 连云港 淮安 盐城 扬州 镇江 泰州 宿迁 昆山 江阴 张家港 常熟 太仓',
  浙江:'杭州 宁波 温州 嘉兴 湖州 绍兴 金华 衢州 舟山 台州 丽水 义乌 慈溪 余姚',
  安徽:'合肥 芜湖 蚌埠 淮南 马鞍山 淮北 铜陵 安庆 黄山 滁州 阜阳 宿州 六安 亳州 池州 宣城',
  福建:'福州 厦门 莆田 三明 泉州 漳州 南平 龙岩 宁德 晋江',
  江西:'南昌 景德镇 萍乡 九江 新余 鹰潭 赣州 吉安 宜春 抚州 上饶',
  山东:'济南 青岛 淄博 枣庄 东营 烟台 潍坊 济宁 泰安 威海 日照 临沂 德州 聊城 滨州 菏泽 莱芜',
  河南:'郑州 开封 洛阳 平顶山 安阳 鹤壁 新乡 焦作 濮阳 许昌 漯河 三门峡 南阳 商丘 信阳 周口 驻马店 济源',
  湖北:'武汉 黄石 十堰 宜昌 襄阳 鄂州 荆门 孝感 荆州 黄冈 咸宁 随州 恩施 仙桃 潜江 天门 神农架',
  湖南:'长沙 株洲 湘潭 衡阳 邵阳 岳阳 常德 张家界 益阳 郴州 永州 怀化 娄底 湘西',
  广东:'广州 韶关 深圳 珠海 汕头 佛山 江门 湛江 茂名 肇庆 惠州 梅州 汕尾 河源 阳江 清远 东莞 中山 潮州 揭阳 云浮',
  广西:'南宁 柳州 桂林 梧州 北海 防城港 钦州 贵港 玉林 百色 贺州 河池 来宾 崇左',
  海南:'海口 三亚 三沙 儋州 五指山 琼海 文昌 万宁 东方 定安 屯昌 澄迈 临高 白沙 昌江 乐东 陵水 保亭 琼中',
  四川:'成都 自贡 攀枝花 泸州 德阳 绵阳 广元 遂宁 内江 乐山 南充 眉山 宜宾 广安 达州 雅安 巴中 资阳 阿坝 甘孜 凉山',
  贵州:'贵阳 六盘水 遵义 安顺 毕节 铜仁 黔西南 黔东南 黔南',
  云南:'昆明 曲靖 玉溪 保山 昭通 丽江 普洱 临沧 楚雄 红河 文山 西双版纳 大理 德宏 怒江 迪庆',
  西藏:'拉萨 日喀则 昌都 林芝 山南 那曲 阿里',
  陕西:'西安 铜川 宝鸡 咸阳 渭南 延安 汉中 榆林 安康 商洛 杨凌',
  甘肃:'兰州 嘉峪关 金昌 白银 天水 武威 张掖 平凉 酒泉 庆阳 定西 陇南 临夏 甘南',
  青海:'西宁 海东 海北 黄南 海南州 果洛 玉树 海西',
  宁夏:'银川 石嘴山 吴忠 固原 中卫',
  新疆:'乌鲁木齐 克拉玛依 吐鲁番 哈密 昌吉 博尔塔拉 巴音郭楞 阿克苏 克孜勒苏 喀什 和田 伊犁 塔城 阿勒泰 石河子 阿拉尔 图木舒克 五家渠 北屯 铁门关 双河 可克达拉 昆玉 胡杨河 新星 白杨',
  香港:'香港',澳门:'澳门',台湾:'台湾 台北 高雄 台中 台南 新竹 基隆 桃园'
};
const clean=value=>String(value??'').normalize('NFKC').trim();
const provinceAliases=Object.keys(regions).map(name=>[name,name+(/北京|天津|上海|重庆/.test(name)?'市':name==='广西'?'壮族自治区':name==='新疆'?'维吾尔自治区':name==='宁夏'?'回族自治区':/内蒙古|西藏/.test(name)?'自治区':/香港|澳门/.test(name)?'特别行政区':'省')]);
const cities=new Map(Object.entries(regions).flatMap(([province,names])=>names.split(' ').map(name=>[name,province])));
export function provinceName(row){
  if(typeof row!=='object'||row===null)row={city:row};
  for(const value of [row.province,row['省份'],row.city,row.raw_city]){
    const raw=clean(value);if(!raw)continue;
    const parts=raw.split(/[|、,，/\s]+/).filter(Boolean);
    if(parts.length>1){const known=new Set(parts.map(part=>provinceName({city:part})));if(known.size>1)return '多省份';if(!known.has('未明确'))return [...known][0];}
    for(const [name,full]of provinceAliases)if(raw===name||raw===full||raw.startsWith(full))return name;
    const city=raw.split(/[-—·]/)[0].replace(/市$/,'');
    if(cities.has(city))return cities.get(city);
    const prefixed=[...cities].find(([name])=>raw.startsWith(name+'市'));
    if(prefixed)return prefixed[1];
    if(/^(全国|中国|国内|不限)$/.test(raw))return '全国/地点不限';
    if(/^(海外|国外|境外)/.test(raw))return '海外';
  }
  return '未明确';
}
export const experienceGroups=['在校/应届','1年以内','1-3年','3-5年','5-10年','10年以上','经验不限','未明确'];
export const sizeGroups=['100人以下','100-499人','500-999人','1000-9999人','10000人及以上','未明确'];
export function experienceGroup(value){
  const raw=clean(value);if(/^(不限|经验不限|不限经验|无需经验|无经验要求|无工作经验|无经验)$/.test(raw))return '经验不限';
  if(/应届|在校|学生|毕业生/.test(raw))return '在校/应届';
  if(!/年/.test(raw))return '未明确';
  const n=Number(raw.match(/\d+(?:\.\d+)?/)?.[0]);if(!Number.isFinite(n)||n>60)return '未明确';
  if(/以下|以内|不足|少于/.test(raw))return n<=1?'1年以内':'未明确';
  if(n<1)return '1年以内';
  return n<3?'1-3年':n<5?'3-5年':n<10?'5-10年':'10年以上';
}
export function companySizeGroup(value){
  const raw=clean(value).replace(/,/g,'');if(!/人/.test(raw))return '未明确';
  let n=Number(raw.match(/\d+(?:\.\d+)?/)?.[0]);if(!Number.isFinite(n))return '未明确';
  if(/万/.test(raw))n*=10000;
  if(/以下|少于|小于|不足/.test(raw)){if(n<=100)return '100人以下';return '未明确';}
  return n<100?'100人以下':n<500?'100-499人':n<1000?'500-999人':n<10000?'1000-9999人':'10000人及以上';
}
export function educationGroup(value){
  const raw=clean(value);if(!raw||/^\d+$/.test(raw))return '未明确';
  if(/不限|无学历要求/.test(raw))return '学历不限';
  if(/中专|中技/.test(raw))return '中专/中技';
  if(/博士/.test(raw))return '博士';if(/硕士|研究生/.test(raw))return '硕士';if(/本科/.test(raw))return '本科';if(/大专|专科/.test(raw))return '大专';
  return raw;
}
export function insightConditionValue(row,field){
  if(field==='province')return provinceName(row);
  if(field==='experience')return experienceGroup(row.experience);
  if(field==='company_size')return companySizeGroup(row.company_size);
  if(field==='education')return educationGroup(row.education);
  return clean(row[field])||'未明确';
}
export const insightFilterFields=['province','experience','education','company_size','employment_type'];
export function filterInsightCohort(rows,profile,except=''){
  return rows.filter(row=>insightFilterFields.every(field=>field===except||!profile[field]||insightConditionValue(row,field)===profile[field]));
}
export function insightFilterOptions(rows,profile,field){
  const counts=new Map();for(const row of filterInsightCohort(rows,profile,field)){const value=insightConditionValue(row,field);counts.set(value,(counts.get(value)||0)+1);}
  const order=field==='experience'?experienceGroups:field==='company_size'?sizeGroups:[];
  return [...counts].map(([value,count])=>({value,count})).sort((a,b)=>order.length?order.indexOf(a.value)-order.indexOf(b.value):a.value.localeCompare(b.value,'zh-CN'));
}
export function companyRecruitingRanking(rows,limit=10){
  const companies=new Map(),seen=new Set();let knownJobs=0;
  for(const row of rows){
    const name=clean(row.company_name||row.company);if(!name||/^(未明确|未知|保密|公司保密|匿名公司|--|-)$/.test(name))continue;
    const key=name.replace(/\s+/g,'').toLocaleLowerCase('zh-CN');
    const id=row.knowledge_key||(row.platform&&row.job_id?`${row.platform}:${row.job_id}`:'');
    const jobKey=id||JSON.stringify([key,row.job_name,row.city,row.experience,row.salary_midpoint_k]);
    if(seen.has(jobKey))continue;seen.add(jobKey);knownJobs++;
    if(!companies.has(key))companies.set(key,{name,count:0,platforms:new Set()});
    const item=companies.get(key);item.count++;if(row.platform)item.platforms.add(row.platform);
  }
  return {rows:[...companies.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN')).slice(0,limit).map((item,i)=>({...item,rank:i+1,share:knownJobs?item.count/knownJobs:0,platforms:[...item.platforms]})),knownJobs,totalJobs:rows.length,companyCount:companies.size};
}
