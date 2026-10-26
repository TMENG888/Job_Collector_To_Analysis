"""Read-only XLSX extraction and deterministic, stratified review selection."""
import json, random, re, hashlib
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(r'C:\Users\YS-Insight\Desktop\陈晓锋\测试采集数据集\ai漫剧师岗位_3150条.xlsx')
OUT = ROOT / 'ui_data' / 'keyword_validation' / 'ai_drama_v1'
OUT.mkdir(parents=True, exist_ok=True)
values = list(openpyxl.load_workbook(SOURCE, read_only=True, data_only=True)['岗位数据'].values)
headers = values[0]
rows = [dict(zip(headers, values[i]), row_no=i+1) for i in range(1, len(values))]
report = json.loads((ROOT/'ui_data/insights/岗位市场洞察.json').read_text(encoding='utf-8'))
baseline = {int(x['row_no']) for x in report['cohort_observations']}
rng = random.Random(20261006)
strata = {'creative_title': [], 'ambiguous_tools': [], 'random_background': []}
for r in rows:
    title = str(r.get('岗位名称') or '')
    jd = str(r.get('岗位描述') or '')
    if re.search(r'短剧|漫剧|AI.*(?:影视|视频|编导|剪辑|美术|创意|视觉|内容创作)', title, re.I):
        group = 'creative_title'
    elif r['row_no'] in baseline or re.search(r'ComfyUI|Midjourney|Stable\s*Diffusion|分镜|剪映|可灵|即梦', jd, re.I):
        group = 'ambiguous_tools'
    else:
        group = 'random_background'
    strata[group].append(r['row_no'])
selected = []
for group, count in [('creative_title', 60), ('ambiguous_tools', 30), ('random_background', 30)]:
    selected += [{'row_no': n, 'stratum': group} for n in sorted(rng.sample(strata[group], min(count,len(strata[group]))))]
payload = {'source':str(SOURCE), 'source_sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
           'scope':'AI短剧/漫剧及实际承担分镜、镜头生成、视频制作、剪辑成片的相邻创作岗位；排除仅共享工具的研发、推广及静态设计',
           'strata_population':{k:len(v) for k,v in strata.items()}, 'selected':selected,
           'baseline_row_numbers':sorted(baseline), 'rows':rows}
(OUT/'review_input.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'rows':len(rows),'strata':payload['strata_population'],'selected':len(selected)},ensure_ascii=False))
