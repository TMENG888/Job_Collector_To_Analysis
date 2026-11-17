import asyncio
import gzip
import hashlib
import json
import re
import sqlite3
import unicodedata
from contextlib import closing
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from .compute import knowledge_path
from .processes import join_process_owner

REGIONS = {
    "北京": "北京",
    "天津": "天津",
    "上海": "上海",
    "重庆": "重庆",
    "河北": "石家庄 唐山 秦皇岛 邯郸 邢台 保定 张家口 承德 沧州 廊坊 衡水 雄安 雄安新区",
    "山西": "太原 大同 阳泉 长治 晋城 朔州 晋中 运城 忻州 临汾 吕梁",
    "内蒙古": "呼和浩特 包头 乌海 赤峰 通辽 鄂尔多斯 呼伦贝尔 巴彦淖尔 乌兰察布 兴安盟 锡林郭勒盟 阿拉善盟",
    "辽宁": "沈阳 大连 鞍山 抚顺 本溪 丹东 锦州 营口 阜新 辽阳 盘锦 铁岭 朝阳 葫芦岛",
    "吉林": "长春 吉林 四平 辽源 通化 白山 松原 白城 延边",
    "黑龙江": "哈尔滨 齐齐哈尔 鸡西 鹤岗 双鸭山 大庆 伊春 佳木斯 七台河 牡丹江 黑河 绥化 大兴安岭",
    "江苏": "南京 无锡 徐州 常州 苏州 南通 连云港 淮安 盐城 扬州 镇江 泰州 宿迁 昆山 江阴 张家港 常熟 太仓",
    "浙江": "杭州 宁波 温州 嘉兴 湖州 绍兴 金华 衢州 舟山 台州 丽水 义乌 慈溪 余姚",
    "安徽": "合肥 芜湖 蚌埠 淮南 马鞍山 淮北 铜陵 安庆 黄山 滁州 阜阳 宿州 六安 亳州 池州 宣城",
    "福建": "福州 厦门 莆田 三明 泉州 漳州 南平 龙岩 宁德 晋江",
    "江西": "南昌 景德镇 萍乡 九江 新余 鹰潭 赣州 吉安 宜春 抚州 上饶",
    "山东": "济南 青岛 淄博 枣庄 东营 烟台 潍坊 济宁 泰安 威海 日照 临沂 德州 聊城 滨州 菏泽 莱芜",
    "河南": "郑州 开封 洛阳 平顶山 安阳 鹤壁 新乡 焦作 濮阳 许昌 漯河 三门峡 南阳 商丘 信阳 周口 驻马店 济源",
    "湖北": "武汉 黄石 十堰 宜昌 襄阳 鄂州 荆门 孝感 荆州 黄冈 咸宁 随州 恩施 仙桃 潜江 天门 神农架",
    "湖南": "长沙 株洲 湘潭 衡阳 邵阳 岳阳 常德 张家界 益阳 郴州 永州 怀化 娄底 湘西",
    "广东": "广州 韶关 深圳 珠海 汕头 佛山 江门 湛江 茂名 肇庆 惠州 梅州 汕尾 河源 阳江 清远 东莞 中山 潮州 揭阳 云浮",
    "广西": "南宁 柳州 桂林 梧州 北海 防城港 钦州 贵港 玉林 百色 贺州 河池 来宾 崇左",
    "海南": "海口 三亚 三沙 儋州 五指山 琼海 文昌 万宁 东方 定安 屯昌 澄迈 临高 白沙 昌江 乐东 陵水 保亭 琼中",
    "四川": "成都 自贡 攀枝花 泸州 德阳 绵阳 广元 遂宁 内江 乐山 南充 眉山 宜宾 广安 达州 雅安 巴中 资阳 阿坝 甘孜 凉山",
    "贵州": "贵阳 六盘水 遵义 安顺 毕节 铜仁 黔西南 黔东南 黔南",
    "云南": "昆明 曲靖 玉溪 保山 昭通 丽江 普洱 临沧 楚雄 红河 文山 西双版纳 大理 德宏 怒江 迪庆",
    "西藏": "拉萨 日喀则 昌都 林芝 山南 那曲 阿里",
    "陕西": "西安 铜川 宝鸡 咸阳 渭南 延安 汉中 榆林 安康 商洛 杨凌",
    "甘肃": "兰州 嘉峪关 金昌 白银 天水 武威 张掖 平凉 酒泉 庆阳 定西 陇南 临夏 甘南",
    "青海": "西宁 海东 海北 黄南 海南州 果洛 玉树 海西",
    "宁夏": "银川 石嘴山 吴忠 固原 中卫",
    "新疆": "乌鲁木齐 克拉玛依 吐鲁番 哈密 昌吉 博尔塔拉 巴音郭楞 阿克苏 克孜勒苏 喀什 和田 伊犁 塔城 阿勒泰 石河子 阿拉尔 图木舒克 五家渠 北屯 铁门关 双河 可克达拉 昆玉 胡杨河 新星 白杨",
    "香港": "香港",
    "澳门": "澳门",
    "台湾": "台湾 台北 高雄 台中 台南 新竹 基隆 桃园"
}
CITIES = {city: province for province, names in REGIONS.items() for city in names.split()}


def province_name(row):
    for value in (row.get('province'), row.get('省份'), row.get('city'), row.get('raw_city')):
        raw = unicodedata.normalize('NFKC', str(value or '')).strip()
        if not raw:
            continue
        parts = [p for p in re.split(r'[|、,，/\s]+', raw) if p]
        if len(parts) > 1:
            known = {province_name({'city': p}) for p in parts}
            if len(known) > 1:
                return '多省份'
            if '未明确' not in known:
                return next(iter(known))
        for province in REGIONS:
            suffix = '市' if province in ('北京','天津','上海','重庆') else {'广西':'壮族自治区','新疆':'维吾尔自治区','宁夏':'回族自治区','内蒙古':'自治区','西藏':'自治区','香港':'特别行政区','澳门':'特别行政区'}.get(province,'省')
            if raw == province or raw == province + suffix or raw.startswith(province + suffix):
                return province
        city = re.split(r'[-—·]', raw)[0].removesuffix('市')
        if city in CITIES:
            return CITIES[city]
        for name, province in CITIES.items():
            if raw.startswith(name + '市'):
                return province
        if raw in ('全国','中国','国内','不限'):
            return '全国/地点不限'
        if raw.startswith(('海外','国外','境外')):
            return '海外'
    return '未明确'


def company_ranking(rows):
    companies, seen = {}, set()
    for row in rows:
        name = unicodedata.normalize('NFKC', str(row.get('company_name') or row.get('company') or '')).strip()
        if not name or name in ('未明确','未知','保密','公司保密','匿名公司','--','-'):
            continue
        key = re.sub(r'\s+', '', name).lower()
        job = row.get('knowledge_key') or (str(row['platform']) + ':' + str(row['job_id']) if row.get('platform') and row.get('job_id') else None)
        if not job:
            job = json.dumps([key,row.get('job_name'),row.get('city'),row.get('experience'),row.get('salary_midpoint_k')],ensure_ascii=False)
        if job in seen:
            continue
        seen.add(job)
        item = companies.setdefault(key, {'name':name,'count':0,'platforms':[]})
        item['count'] += 1
        if row.get('platform') and row['platform'] not in item['platforms']:
            item['platforms'].append(row['platform'])
    ranked = sorted(companies.values(), key=lambda item: (-item['count'],item['name']))[:10]
    return {'rows':[{**item,'rank':index+1,'share':item['count']/len(seen) if seen else 0} for index,item in enumerate(ranked)],'knownJobs':len(seen),'totalJobs':len(rows),'companyCount':len(companies)}


def snapshot_source(database, snapshot_key, metadata_only=False):
    if not isinstance(snapshot_key,str) or not re.fullmatch(r'[a-f0-9]{64}',snapshot_key):
        raise ValueError('报告快照标识无效')
    with closing(sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro',uri=True,timeout=5)) as db:
        exists=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='insight_report_snapshots'").fetchone()
        if not exists:
            return None
        columns='1' if metadata_only else 'report,report_hash'
        return db.execute(f'SELECT {columns} FROM insight_report_snapshots WHERE snapshot_key=?',(snapshot_key,)).fetchone()


def build_report(filename, database, snapshot_key=None):
    if snapshot_key:
        source=snapshot_source(database,snapshot_key)
        if not source:
            raise ValueError('报告快照不存在')
        if hashlib.sha256(source[0].encode('utf-8')).hexdigest()!=source[1]:
            raise ValueError('报告快照校验失败')
        report=json.loads(source[0])
    else:
        report = json.loads(Path(filename).read_text(encoding='utf-8'))
    rows = report.get('cohort_observations', [])
    if any(not row.get('company_name') for row in rows) and database:
        db = None
        try:
            db = sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
            for row in rows:
                if row.get('company_name') or not row.get('knowledge_key') or not row.get('knowledge_hash'):
                    continue
                params = (row['knowledge_key'],row['knowledge_hash'])
                source = db.execute('SELECT raw FROM job_versions WHERE job_key=? AND content_hash=?', params).fetchone() or db.execute('SELECT raw FROM jobs WHERE job_key=? AND content_hash=?', params).fetchone()
                if source:
                    raw = json.loads(source[0])
                    row['company_name'],row['company_id'] = raw.get('company_name',''),raw.get('company_id','')
                    row['province'] = province_name({**row,'province':raw.get('province') or raw.get('省份') or ''})
        except Exception:
            report['company_ranking_warning'] = '历史报告公司名称补齐暂不可用，未借用其他版本岗位'
        finally:
            if db:
                db.close()
    report['company_ranking'] = company_ranking(rows)
    raw = json.dumps(report,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf-8')
    return raw,gzip.compress(raw,compresslevel=6,mtime=0)


class ReportCache:
    def __init__(self, settings, owner=None):
        self.settings = settings
        self.filename = settings.data / 'insights/岗位市场洞察.json'
        self.cached = None
        self.snapshots = {}
        self.lock = asyncio.Lock()
        self.pool = ProcessPoolExecutor(max_workers=1, initializer=join_process_owner, initargs=(owner.name if owner else None,))

    def version(self, snapshot_key=None):
        if snapshot_key:
            if not re.fullmatch(r'[a-f0-9]{64}',snapshot_key):
                raise ValueError('报告快照标识无效')
            return f'insight-snapshot-v1-{snapshot_key}'
        try:
            stat = self.filename.stat()
            return f'fastapi-report-v1-{stat.st_size}-{stat.st_mtime_ns}'
        except FileNotFoundError:
            return None

    async def load(self, snapshot_key=None):
        version = self.version(snapshot_key)
        if not version:
            return None
        if self.cached and self.cached['version'] == version:
            return self.cached
        async with self.lock:
            if snapshot_key:
                if snapshot_key not in self.snapshots:
                    database=knowledge_path(self.settings.data)
                    source=await asyncio.to_thread(snapshot_source,database,snapshot_key,True)
                    if not source:
                        return None
                    raw,compressed=await asyncio.get_running_loop().run_in_executor(self.pool,build_report,None,str(database),snapshot_key)
                    self.snapshots[snapshot_key]={'version':version,'raw':raw,'gzip':compressed}
                    while len(self.snapshots)>3:
                        del self.snapshots[next(iter(self.snapshots))]
                return self.snapshots[snapshot_key]
            for _ in range(3):
                version = self.version()
                if self.cached and self.cached['version'] == version:
                    return self.cached
                raw, compressed = await asyncio.get_running_loop().run_in_executor(self.pool,build_report,str(self.filename),str(knowledge_path(self.settings.data)))
                if self.version() == version:
                    self.cached = {'version':version,'raw':raw,'gzip':compressed}
                    return self.cached
            raise ValueError('报告正在更新，请稍后重试，未采用混合版本')

    def close(self):
        self.pool.shutdown(wait=False,cancel_futures=True)
