import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path


output_dir = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\YS-Insight\Desktop\智能体开发岗位5000条_2026-09-25")
source_files = [
    output_dir / "shixiseng_标准化数据.csv",
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

title_pattern = re.compile(r"智能体|AI\s*Agent|Agent\s*(开发|工程师|研发)|Agentic", re.I)
direct_text_pattern = re.compile(r"智能体|AI\s*Agent|Agentic|\bAgent\b", re.I)
llm_skill_pattern = re.compile(r"大模型|LLM|RAG|LangChain|LangGraph|Dify|Coze|Function\s*Calling|MCP|Prompt\s*Engineering", re.I)
ai_topic_pattern = re.compile(r"人工智能|生成式\s*AI|AIGC|机器学习|深度学习|自然语言|NLP|知识图谱|多模态|大模型|LLM|RAG|算法|具身智能", re.I)
dev_role_pattern = re.compile(r"开发|算法|工程师|研发|研究|架构|科学家|技术|实习", re.I)
business_role_pattern = re.compile(r"销售|商务|客户经理|招商主管|猎头|人事|HR|市场营销|渠道经理", re.I)

eligible = []
excluded = []
for row in deduped:
    title = row.get("job_name", "") or ""
    searchable = " ".join([title, row.get("job_description", "") or "", row.get("skills", "") or "", row.get("tags", "") or ""])
    if title_pattern.search(title):
        row["relevance_level"] = "标题直接匹配"
        row["relevance_evidence"] = "岗位标题含智能体、AI Agent或Agent开发相关词"
    elif direct_text_pattern.search(searchable):
        row["relevance_level"] = "职责直接匹配"
        row["relevance_evidence"] = "岗位描述或技能含智能体、AI Agent或Agentic相关词"
    elif llm_skill_pattern.search(searchable):
        row["relevance_level"] = "大模型技能匹配"
        row["relevance_evidence"] = "岗位信息含LLM、RAG、LangChain、Dify等智能体相关技术词"
    elif ai_topic_pattern.search(searchable) and dev_role_pattern.search(title) and not business_role_pattern.search(title):
        row["relevance_level"] = "AI开发相关匹配"
        row["relevance_evidence"] = "岗位信息含人工智能、机器学习、NLP或生成式AI相关词，且岗位属于开发或算法方向"
    else:
        row["relevance_level"] = "低相关待排除"
        row["relevance_evidence"] = "仅由平台拆词返回，未发现智能体、大模型或AI开发证据"
    if row["relevance_level"] == "低相关待排除":
        excluded.append(row)
    else:
        eligible.append(row)

if len(eligible) < target_rows:
    raise RuntimeError(f"严格相关度过滤后只有 {len(eligible)} 条，少于目标 {target_rows} 条")

rows = eligible[:target_rows]
for index, row in enumerate(rows, 1):
    row["record_no"] = index

extra_columns = sorted({key for row in rows for key in row.keys()} - set(preferred_columns))
columns = preferred_columns + extra_columns

csv_path = output_dir / "智能体开发岗位_5000条_标准化数据.csv"
with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)

json_path = output_dir / "智能体开发岗位_5000条_标准化数据.json"
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
    "selection_rule": "公开渠道使用精确词智能体开发；智联使用智能体开发、智能体开发工程师、AI Agent开发、Agent开发工程师和大模型智能体开发扩充候选池；严格过滤后按采集顺序保留5000条",
    "relevance_filter": "保留标题或职责明确含智能体/Agent，含LLM、RAG、LangChain等大模型技能，或具有AI主题证据且属于开发/算法方向的岗位；排除仅由平台拆词返回且无上述证据的岗位",
    "excluded_examples": [{"platform": row.get("platform"), "job_name": row.get("job_name"), "query_keyword": row.get("query_keyword")} for row in excluded[:30]],
    "account_protection": "未导出Cookie或令牌；智联使用独立本地Chrome配置目录的人工登录会话，低频串行采集；其余渠道不使用账号",
}

quality_path = output_dir / "数据质量报告.json"
quality_path.write_text(json.dumps(quality, ensure_ascii=False, indent=2), encoding="utf-8")

manifest_path = output_dir / "最终交付清单.json"
manifest_path.write_text(json.dumps({
    "workbook": "智能体开发岗位_5000条.xlsx",
    "dataset": csv_path.name,
    "dataset_json": json_path.name,
    "quality_report": quality_path.name,
    "rows": len(rows),
    "columns": len(columns),
    "platforms": quality["platform_counts"],
    "dedupe_key": quality["dedupe_key"],
}, ensure_ascii=False, indent=2), encoding="utf-8")

print(json.dumps({
    "csv": str(csv_path), "json": str(json_path), "quality": str(quality_path),
    "rows": len(rows), "platforms": quality["platform_counts"],
    "relevance": quality["relevance_level_counts"], "field_completeness": field_completeness,
}, ensure_ascii=False))
