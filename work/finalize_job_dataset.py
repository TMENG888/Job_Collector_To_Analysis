import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path


if len(sys.argv) < 3:
    raise SystemExit("用法: finalize_job_dataset.py <输出目录> <bigdata|crawler> [目标条数]")

output_dir = Path(sys.argv[1])
mode = sys.argv[2].strip().lower()
target_rows = int(sys.argv[3]) if len(sys.argv) > 3 else 5000

MODES = {
    "bigdata": {
        "label": "大数据开发工程师",
        "title_pattern": re.compile(r"大数据\s*(开发|工程师|研发|架构)|数据开发工程师|数据工程师|Hadoop\s*开发|Spark\s*开发|Flink\s*开发", re.I),
        "direct_pattern": re.compile(r"大数据开发|大数据工程|实时数仓|离线数仓|数据仓库|数据湖|Lakehouse", re.I),
        "skill_pattern": re.compile(r"Hadoop|Hive|Spark|Flink|HBase|Kafka|ETL|数仓|数据仓库|数据湖|Lakehouse|ClickHouse|Doris|Trino|Presto|Airflow|DataX", re.I),
        "role_pattern": re.compile(r"开发|工程师|架构|研发|技术|程序员|实习", re.I),
        "exclude_pattern": re.compile(r"销售|商务|市场|运营|产品经理|数据标注|数据分析师|BI\s*分析|采集员|录入|教师|讲师|培训", re.I),
        "levels": ["标题直接匹配", "职责直接匹配", "大数据技能匹配", "平台关键词匹配"],
        "keywords": ["大数据开发工程师", "大数据开发", "数据开发工程师", "大数据工程师", "Hadoop开发工程师", "Spark开发工程师"],
        "evidence": {
            "title": "岗位标题直接含大数据开发、数据开发工程师或主流大数据开发方向",
            "direct": "岗位描述明确包含大数据开发、数据仓库、数据湖或实时/离线数仓",
            "skill": "岗位属于开发或工程方向，且包含Hadoop、Spark、Flink、Hive等大数据技术",
            "platform": "招聘平台在目标关键词检索下返回，且岗位标题属于开发或工程方向",
        },
        "selection_rule": "使用大数据开发工程师、大数据开发、数据开发工程师、大数据工程师、Hadoop开发工程师和Spark开发工程师扩充候选池；严格过滤后按相关度优先级保留目标条数",
    },
    "crawler": {
        "label": "爬虫工程师",
        "title_pattern": re.compile(r"爬虫|数据抓取|网络抓取|采集开发|反爬|数据采集.*(开发|工程师)|信息采集.*(开发|工程师)", re.I),
        "direct_pattern": re.compile(r"爬虫|网络爬虫|网页抓取|数据抓取|Web\s*Scraping|反爬虫|反爬策略", re.I),
        "skill_pattern": re.compile(r"Scrapy|BeautifulSoup|Selenium|Playwright|XPath|lxml|Python\s*requests|requests\s*(库|框架)|代理池|抓包", re.I),
        "role_pattern": re.compile(r"开发|工程师|架构|研发|技术|程序员|Python|实习", re.I),
        "exclude_pattern": re.compile(r"销售|商务|市场|运营|产品经理|数据标注|录入|客服|审核|采集员|调研员|实地采集|人事|HR|猎头", re.I),
        "levels": ["标题直接匹配", "职责直接匹配", "采集技术匹配", "平台关键词匹配"],
        "keywords": ["爬虫工程师", "爬虫开发工程师", "Python爬虫工程师", "网络爬虫工程师", "数据采集工程师", "数据抓取工程师"],
        "evidence": {
            "title": "岗位标题直接含爬虫、数据抓取、采集开发或反爬方向",
            "direct": "岗位描述明确包含网络爬虫、网页抓取、数据抓取或反爬虫工作",
            "skill": "岗位属于开发或工程方向，且包含Scrapy、BeautifulSoup、Selenium、XPath等采集技术",
            "platform": "招聘平台在目标关键词检索下返回，且岗位标题属于开发或工程方向",
        },
        "selection_rule": "使用爬虫工程师、爬虫开发工程师、Python爬虫工程师、网络爬虫工程师、数据采集工程师和数据抓取工程师扩充候选池；严格过滤后按相关度优先级保留目标条数",
    },
}

if mode not in MODES:
    raise SystemExit(f"未知模式: {mode}，可选 bigdata、crawler")

settings = MODES[mode]
source_files = [
    output_dir / "shixiseng_标准化数据.csv",
    output_dir / "iguopin_标准化数据.csv",
    output_dir / "mohrss_标准化数据.csv",
    output_dir / "zhaopin_标准化数据.csv",
]

preferred_columns = [
    "record_no", "relevance_level", "relevance_evidence", "platform", "query_keyword", "query_city", "job_id", "job_name", "company_id", "company_name",
    "salary", "city", "district", "experience", "education", "employment_type", "company_nature", "company_size",
    "industry", "publish_time", "refresh_time", "deadline", "tags", "skills", "job_description", "address",
    "recruiter_name", "recruiter_title", "job_url", "company_url", "source_total", "access_level", "collected_at",
    "contact_phone", "source_agency",
]


def read_csv(path: Path):
    if not path.exists():
        raise FileNotFoundError(path)
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


raw_rows = []
for source_file in source_files:
    raw_rows.extend(read_csv(source_file))

deduped = []
seen = set()
duplicate_count = 0
for row in raw_rows:
    key = (row.get("platform", "").strip(), row.get("job_id", "").strip())
    if not all(key):
        continue
    if key in seen:
        duplicate_count += 1
        continue
    seen.add(key)
    deduped.append(row)

eligible = []
excluded = []
for row in deduped:
    title = row.get("job_name", "") or ""
    searchable = " ".join([
        title,
        row.get("job_description", "") or "",
        row.get("skills", "") or "",
        row.get("tags", "") or "",
    ])
    if settings["exclude_pattern"].search(title):
        level = "低相关待排除"
        evidence = "岗位标题属于非工程开发方向"
    elif settings["title_pattern"].search(title):
        level = settings["levels"][0]
        evidence = settings["evidence"]["title"]
    elif settings["direct_pattern"].search(searchable) and settings["role_pattern"].search(title):
        level = settings["levels"][1]
        evidence = settings["evidence"]["direct"]
    elif settings["skill_pattern"].search(searchable) and settings["role_pattern"].search(title):
        level = settings["levels"][2]
        evidence = settings["evidence"]["skill"]
    elif settings["role_pattern"].search(title):
        level = settings["levels"][3]
        evidence = settings["evidence"]["platform"]
    else:
        level = "低相关待排除"
        evidence = "仅由平台拆词返回，未发现目标岗位或技术证据"
    row["relevance_level"] = level
    row["relevance_evidence"] = evidence
    if level == "低相关待排除":
        excluded.append(row)
    else:
        eligible.append(row)

if len(eligible) < target_rows:
    diagnostic_path = output_dir / "相关度过滤诊断.json"
    diagnostic_path.write_text(json.dumps({
        "mode": mode,
        "target_rows": target_rows,
        "input_rows": len(raw_rows),
        "unique_rows": len(deduped),
        "eligible_rows": len(eligible),
        "excluded_rows": len(excluded),
        "eligible_platforms": dict(Counter(row.get("platform", "") for row in eligible)),
        "eligible_levels": dict(Counter(row.get("relevance_level", "") for row in eligible)),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    raise RuntimeError(f"严格相关度过滤后只有 {len(eligible)} 条，少于目标 {target_rows} 条；诊断已保存到 {diagnostic_path}")

rank = {level: index for index, level in enumerate(settings["levels"])}
eligible.sort(key=lambda row: rank.get(row.get("relevance_level", ""), len(rank)))
rows = eligible[:target_rows]
for index, row in enumerate(rows, 1):
    row["record_no"] = index

extra_columns = sorted({key for row in rows for key in row.keys()} - set(preferred_columns))
columns = preferred_columns + extra_columns
base_name = f"{settings['label']}岗位_{target_rows}条"

csv_path = output_dir / f"{base_name}_标准化数据.csv"
with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)

json_path = output_dir / f"{base_name}_标准化数据.json"
json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

required_fields = ["platform", "job_id", "job_name", "company_name", "city", "job_url", "job_description"]
field_completeness = {}
for field in required_fields:
    filled = sum(1 for row in rows if str(row.get(field, "")).strip())
    field_completeness[field] = {"filled": filled, "rate": round(filled / len(rows), 4)}

invalid_urls = [
    {"platform": row.get("platform"), "job_id": row.get("job_id"), "job_url": row.get("job_url")}
    for row in rows
    if row.get("job_url") and not re.match(r"^https?://", row.get("job_url", ""), re.I)
]

quality = {
    "dataset_label": settings["label"],
    "target_rows": target_rows,
    "input_rows": len(raw_rows),
    "unique_rows_before_trim": len(deduped),
    "eligible_rows_before_trim": len(eligible),
    "low_relevance_rows_excluded": len(excluded),
    "output_rows": len(rows),
    "duplicates_removed_during_final_merge": duplicate_count,
    "unique_platform_job_id": len({(row.get("platform"), row.get("job_id")) for row in rows}),
    "platform_counts": dict(Counter(row.get("platform", "") for row in rows)),
    "query_keyword_counts": dict(Counter(row.get("query_keyword", "") for row in rows)),
    "query_city_counts": dict(Counter(row.get("query_city", "") for row in rows)),
    "relevance_level_counts": dict(Counter(row.get("relevance_level", "") for row in rows)),
    "field_completeness": field_completeness,
    "invalid_job_url_count": len(invalid_urls),
    "invalid_job_url_examples": invalid_urls[:20],
    "dedupe_key": "platform + job_id",
    "selection_rule": settings["selection_rule"],
    "relevance_filter": "优先保留标题、职责或技术栈中存在明确目标岗位证据的记录；对招聘平台目标关键词返回的其他结果，仅保留岗位标题属于开发或工程方向的记录，并单独标记为平台关键词匹配；排除销售、运营、产品、标注、录入等低相关结果",
    "excluded_examples": [
        {"platform": row.get("platform"), "job_name": row.get("job_name"), "query_keyword": row.get("query_keyword")}
        for row in excluded[:30]
    ],
    "account_protection": "未导出Cookie或令牌；智联使用独立本地Chrome配置目录的人工登录会话，低频串行采集；其余渠道不使用账号",
}

quality_path = output_dir / "数据质量报告.json"
quality_path.write_text(json.dumps(quality, ensure_ascii=False, indent=2), encoding="utf-8")

manifest_path = output_dir / "最终交付清单.json"
manifest_path.write_text(json.dumps({
    "workbook": f"{base_name}.xlsx",
    "dataset": csv_path.name,
    "dataset_json": json_path.name,
    "quality_report": quality_path.name,
    "rows": len(rows),
    "columns": len(columns),
    "platforms": quality["platform_counts"],
    "dedupe_key": quality["dedupe_key"],
}, ensure_ascii=False, indent=2), encoding="utf-8")

print(json.dumps({
    "csv": str(csv_path),
    "json": str(json_path),
    "quality": str(quality_path),
    "rows": len(rows),
    "eligible_before_trim": len(eligible),
    "platforms": quality["platform_counts"],
    "relevance": quality["relevance_level_counts"],
    "field_completeness": field_completeness,
}, ensure_ascii=False))
