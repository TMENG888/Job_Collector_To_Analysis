"""Merge, deduplicate and relevance-rank job collection CSV files.

Usage: finalize_configurable_dataset.py <output_dir> <profile.json> [target_rows]
The profile is intentionally data-driven so the local UI can create new job
collections without editing Python source code.
"""

import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path


csv.field_size_limit(min(sys.maxsize, 2_147_483_647))

if len(sys.argv) < 3:
    raise SystemExit("用法: finalize_configurable_dataset.py <输出目录> <岗位配置.json> [目标条数]")

output_dir = Path(sys.argv[1]).resolve()
profile_path = Path(sys.argv[2]).resolve()
profile = json.loads(profile_path.read_text(encoding="utf-8"))
target_rows = int(sys.argv[3]) if len(sys.argv) > 3 else int(profile.get("target_rows", 5000))
label = str(profile.get("label") or "岗位").strip()
task_id = profile.get("task_id")
if not task_id:
    raise ValueError("缺少 task_id，拒绝生成无法确认任务归属的交付文件")


def literal_pattern(terms, fallback=r"(?!)"):
    cleaned = [str(value).strip() for value in (terms or []) if str(value).strip()]
    if not cleaned:
        return re.compile(fallback, re.I)
    pieces = [re.escape(value).replace(r"\ ", r"\s*") for value in cleaned]
    return re.compile("|".join(pieces), re.I)


rules = profile.get("relevance", {})
title_pattern = literal_pattern(rules.get("title_terms") or profile.get("keywords") or [label])
direct_pattern = literal_pattern(rules.get("direct_terms") or profile.get("keywords") or [label])
skill_pattern = literal_pattern(rules.get("skill_terms"))
role_pattern = literal_pattern(rules.get("role_terms"))
platform_role_terms = rules.get("platform_role_terms") or ["开发", "工程师", "架构", "研发", "技术", "程序员", "实习"]
platform_role_pattern = literal_pattern(platform_role_terms)
default_exclude_terms = ["销售", "商务", "市场", "运营", "产品经理", "数据标注", "录入", "客服", "审核", "教师", "讲师", "人事", "猎头"]
exclude_terms = rules.get("exclude_terms") or default_exclude_terms
exclude_pattern = literal_pattern(exclude_terms)
configured_queries = {
    str(value).strip().casefold()
    for value in (profile.get("keywords") or [profile.get("primary_keyword") or label])
    if str(value).strip()
}
levels = rules.get("levels") or ["标题直接匹配", "职责直接匹配", "技术栈匹配", "平台关键词匹配"]
evidence = rules.get("evidence") or {
    "title": "岗位标题直接命中目标岗位关键词",
    "direct": "岗位描述或技能字段直接命中目标岗位关键词",
    "skill": "岗位属于工程开发方向，且命中配置的技术栈关键词",
    "platform": "招聘平台在目标关键词检索下返回，且岗位标题属于工程开发方向",
}

preferred_columns = [
    "record_no", "relevance_level", "relevance_evidence", "platform", "query_keyword", "query_city",
    "job_id", "job_name", "company_id", "company_name", "salary", "city", "district", "experience",
    "education", "employment_type", "company_nature", "company_size", "industry", "publish_time",
    "refresh_time", "deadline", "tags", "skills", "job_description", "address", "recruiter_name",
    "recruiter_title", "job_url", "company_url", "source_total", "access_level", "collected_at",
    "contact_phone", "source_agency",
]


def discover_sources():
    directories = [output_dir]
    for value in profile.get("source_directories", []):
        candidate = Path(value).expanduser().resolve()
        if candidate not in directories:
            directories.append(candidate)
    files = []
    excluded_names = {"最终合并数据.csv"}
    for directory in directories:
        if not directory.exists():
            continue
        if directory != output_dir:
            owner_path = directory / "任务归属.json"
            if not owner_path.exists() or json.loads(owner_path.read_text(encoding="utf-8")).get("task_id") != task_id:
                raise ValueError(f"外部源目录不属于当前任务，拒绝混入历史数据：{directory}")
        for candidate in directory.glob("*_标准化数据.csv"):
            if candidate.name not in {f"{channel}_标准化数据.csv" for channel in ["shixiseng", "iguopin", "mohrss", "job51", "jobonline", "zhaopin", "yupao", "boss"]}:
                continue
            if candidate.name in excluded_names or candidate.name.startswith(f"{label}岗位_"):
                continue
            files.append(candidate)
    return sorted(set(files), key=lambda item: str(item).lower())


def read_rows(file_path):
    with file_path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            row["_source_file"] = str(file_path)
            yield row


source_files = discover_sources()
if not source_files:
    raise FileNotFoundError("没有找到可合并的 *_标准化数据.csv；请先运行采集，或在配置中添加 source_directories")

raw_rows = []
source_counts = {}
for source_file in source_files:
    rows = list(read_rows(source_file))
    source_counts[str(source_file)] = len(rows)
    raw_rows.extend(rows)

deduped = []
seen = set()
duplicate_count = 0
missing_key_count = 0
for row in raw_rows:
    key = (str(row.get("platform", "")).strip(), str(row.get("job_id", "")).strip())
    if not all(key):
        missing_key_count += 1
        continue
    if key in seen:
        duplicate_count += 1
        continue
    seen.add(key)
    deduped.append(row)

eligible = []
excluded = []
filter_reason_counts = Counter()
filter_reason_by_source = {}
for row in deduped:
    row["task_id"] = task_id
    row["relevance_level"] = "未做岗位相关性筛选"
    row["relevance_evidence"] = "保留采集候选；目标岗位由岗位洞察筛选"
    row.pop("_source_file", None)
    eligible.append(row)

rank = {level_name: index for index, level_name in enumerate(levels)}
eligible.sort(key=lambda row: rank.get(row.get("relevance_level", ""), len(rank)))
rows = eligible
for index, row in enumerate(rows, 1):
    row["record_no"] = index

extra_columns = sorted({key for row in rows for key in row} - set(preferred_columns))
columns = preferred_columns + extra_columns


def write_csv(file_path, values):
    with file_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(values)


safe_label = re.sub(r'[\\/:*?"<>|]', "_", label)
stable_csv = output_dir / "最终合并数据.csv"
stable_json = output_dir / "最终合并数据.json"
named_csv = output_dir / f"{safe_label}岗位_{len(rows)}条_标准化数据.csv"
named_json = output_dir / f"{safe_label}岗位_{len(rows)}条_标准化数据.json"
write_csv(stable_csv, rows)
write_csv(named_csv, rows)
json_text = json.dumps(rows, ensure_ascii=False, indent=2)
stable_json.write_text(json_text, encoding="utf-8")
named_json.write_text(json_text, encoding="utf-8")

required_fields = ["job_id", "job_name", "company_name", "city", "job_url", "job_description"]
field_completeness = {}
for field in required_fields:
    filled = sum(1 for row in rows if str(row.get(field, "")).strip())
    field_completeness[field] = {"filled": filled, "rate": round(filled / len(rows), 4) if rows else 0}

invalid_urls = [row for row in rows if row.get("job_url") and not re.match(r"^https?://", row.get("job_url", ""), re.I)]
quality = {
    "task_id": task_id,
    "collection_relevance_filter": False,
    "dataset_label": label,
    "target_rows": target_rows,
    "target_reached": len(rows) >= target_rows,
    "input_rows": len(raw_rows),
    "unique_rows_before_filter": len(deduped),
    "eligible_rows_before_trim": len(eligible),
    "low_relevance_rows_excluded": len(excluded),
    "filter_reason_counts": dict(filter_reason_counts),
    "filter_reason_by_source": {source: dict(counts) for source, counts in filter_reason_by_source.items()},
    "output_rows": len(rows),
    "duplicates_removed": duplicate_count,
    "missing_dedupe_key_removed": missing_key_count,
    "platform_counts": dict(Counter(row.get("platform", "") for row in rows)),
    "query_keyword_counts": dict(Counter(row.get("query_keyword", "") for row in rows)),
    "query_city_counts": dict(Counter(row.get("query_city", "") for row in rows)),
    "relevance_level_counts": dict(Counter(row.get("relevance_level", "") for row in rows)),
    "field_completeness": field_completeness,
    "invalid_job_url_count": len(invalid_urls),
    "source_files": source_counts,
    "dedupe_key": "platform + job_id",
    "account_protection": "Cookie与令牌不写入结果文件；登录平台仅使用本机独立Chrome配置目录；不绕过验证码或安全验证。",
}
(output_dir / "数据质量报告.json").write_text(json.dumps(quality, ensure_ascii=False, indent=2), encoding="utf-8")

manifest = {
    "task_id": task_id,
    "label": label,
    "target_rows": target_rows,
    "rows": len(rows),
    "target_reached": len(rows) >= target_rows,
    "dataset": stable_csv.name,
    "dataset_json": stable_json.name,
    "named_dataset": named_csv.name,
    "named_dataset_json": named_json.name,
    "quality_report": "数据质量报告.json",
    "workbook": f"{safe_label}岗位_{len(rows)}条.xlsx",
    "columns": len(columns),
    "platforms": quality["platform_counts"],
    "dedupe_key": quality["dedupe_key"],
}
(output_dir / "最终交付清单.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

print(json.dumps({
    "ok": True,
    "output_dir": str(output_dir),
    "rows": len(rows),
    "target": target_rows,
    "target_reached": len(rows) >= target_rows,
    "duplicates_removed": duplicate_count,
    "csv": str(stable_csv),
    "json": str(stable_json),
    "platforms": quality["platform_counts"],
}, ensure_ascii=False))
