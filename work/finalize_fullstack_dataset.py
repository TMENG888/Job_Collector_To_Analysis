import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path


output_dir = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\YS-Insight\Desktop\全栈开发岗位5000条_2026-09-25")
source_files = [
    output_dir / "iguopin_标准化数据.csv",
    output_dir / "mohrss_标准化数据.csv",
    output_dir / "zhaopin_标准化数据.csv",
]
target_rows = 5000

preferred_columns = [
    "record_no", "relevance_level", "relevance_evidence", "platform", "query_keyword", "query_city", "job_id", "job_name", "company_id", "company_name",
    "salary", "city", "district", "experience", "education", "employment_type", "company_nature", "company_size",
    "industry", "publish_time", "refresh_time", "deadline", "tags", "skills", "job_description", "address",
    "recruiter_name", "recruiter_title", "job_url", "company_url", "source_total", "access_level", "collected_at",
    "contact_phone", "source_agency",
]


def read_csv(path: Path):
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


raw_rows = []
for source_file in source_files:
    if not source_file.exists():
        raise FileNotFoundError(source_file)
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

if len(deduped) < target_rows:
    raise RuntimeError(f"去重后只有 {len(deduped)} 条，少于目标 {target_rows} 条")

rows = deduped[:target_rows]
title_pattern = re.compile(r"全栈|前后端|web\s*(开发|工程师)|full\s*stack", re.I)
direct_text_pattern = re.compile(r"全栈|前后端|full\s*stack", re.I)
frontend_pattern = re.compile(r"前端|vue|react|javascript|typescript|html5?|css3?|小程序", re.I)
backend_pattern = re.compile(r"后端|java|python|golang|\bgo\b|node\.?(js)?|spring|django|flask|mysql|数据库", re.I)
for index, row in enumerate(rows, 1):
    row["record_no"] = index
    title = row.get("job_name", "") or ""
    searchable = " ".join([title, row.get("job_description", "") or "", row.get("skills", "") or ""])
    if title_pattern.search(title):
        row["relevance_level"] = "标题直接匹配"
        row["relevance_evidence"] = "岗位标题含全栈、前后端或Full Stack相关词"
    elif direct_text_pattern.search(searchable):
        row["relevance_level"] = "职责直接匹配"
        row["relevance_evidence"] = "岗位描述或技能含全栈、前后端或Full Stack相关词"
    elif frontend_pattern.search(searchable) and backend_pattern.search(searchable):
        row["relevance_level"] = "前后端技能匹配"
        row["relevance_evidence"] = "岗位信息同时出现前端与后端技术词"
    else:
        row["relevance_level"] = "平台关键词匹配"
        row["relevance_evidence"] = "招聘平台对查询关键词返回的岗位"

extra_columns = sorted({key for row in rows for key in row.keys()} - set(preferred_columns))
columns = preferred_columns + extra_columns

csv_path = output_dir / "全栈开发岗位_5000条_标准化数据.csv"
with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)

json_path = output_dir / "全栈开发岗位_5000条_标准化数据.json"
json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

required_fields = ["platform", "job_id", "job_name", "company_name", "city", "job_url", "job_description"]
field_completeness = {
    field: {
        "filled": sum(1 for row in rows if str(row.get(field, "")).strip()),
        "rate": round(sum(1 for row in rows if str(row.get(field, "")).strip()) / len(rows), 4),
    }
    for field in required_fields
}

title_relevant = sum(1 for row in rows if title_pattern.search(row.get("job_name", "") or ""))
text_relevant = sum(
    1 for row in rows
    if direct_text_pattern.search(" ".join([row.get("job_name", "") or "", row.get("job_description", "") or "", row.get("skills", "") or ""]))
)
invalid_urls = [
    {"platform": row.get("platform"), "job_id": row.get("job_id"), "job_url": row.get("job_url")}
    for row in rows
    if row.get("job_url") and not re.match(r"^https?://", row.get("job_url", ""), re.I)
]

quality = {
    "target_rows": target_rows,
    "input_rows": len(raw_rows),
    "unique_rows_before_trim": len(deduped),
    "output_rows": len(rows),
    "duplicates_removed_during_final_merge": duplicate_count,
    "unique_platform_job_id": len({(row.get("platform"), row.get("job_id")) for row in rows}),
    "platform_counts": dict(Counter(row.get("platform", "") for row in rows)),
    "query_keyword_counts": dict(Counter(row.get("query_keyword", "") for row in rows)),
    "query_city_counts": dict(Counter(row.get("query_city", "") for row in rows)),
    "relevance_level_counts": dict(Counter(row.get("relevance_level", "") for row in rows)),
    "field_completeness": field_completeness,
    "title_keyword_match_rows": title_relevant,
    "title_or_description_keyword_match_rows": text_relevant,
    "invalid_job_url_count": len(invalid_urls),
    "invalid_job_url_examples": invalid_urls[:20],
    "dedupe_key": "platform + job_id",
    "selection_rule": "按公开渠道结果与登录会话采集顺序保留；达到5000条即停止",
    "account_protection": "未导出Cookie或令牌；智联使用独立本地Chrome配置目录的人工登录会话，低频串行采集；公开渠道不使用账号",
}

quality_path = output_dir / "数据质量报告.json"
quality_path.write_text(json.dumps(quality, ensure_ascii=False, indent=2), encoding="utf-8")

manifest_path = output_dir / "最终交付清单.json"
manifest_path.write_text(json.dumps({
    "workbook": "全栈开发岗位_5000条.xlsx",
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
    "platforms": quality["platform_counts"],
    "field_completeness": field_completeness,
    "title_keyword_match_rows": title_relevant,
    "title_or_description_keyword_match_rows": text_relevant,
}, ensure_ascii=False))
