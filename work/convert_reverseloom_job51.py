from __future__ import annotations

import argparse
import csv
from datetime import datetime
from pathlib import Path


STANDARD_COLUMNS = [
    "platform",
    "query_keyword",
    "query_city",
    "job_id",
    "job_name",
    "company_id",
    "company_name",
    "salary",
    "city",
    "district",
    "experience",
    "education",
    "employment_type",
    "company_nature",
    "company_size",
    "industry",
    "publish_time",
    "refresh_time",
    "deadline",
    "tags",
    "skills",
    "job_description",
    "address",
    "recruiter_name",
    "recruiter_title",
    "job_url",
    "company_url",
    "source_total",
    "access_level",
    "collected_at",
]

EXTENDED_COLUMNS = [
    "headcount",
    "responsibilities",
    "requirements",
    "detail_status",
    "data_origin",
]


def split_area(area: str) -> tuple[str, str]:
    parts = [part.strip() for part in area.replace("—", "-").split("-", 1)]
    city = parts[0] if parts else ""
    district = parts[1] if len(parts) > 1 else ""
    return city, district


def convert_row(
    row: dict[str, str],
    query_keyword: str,
    query_city: str,
    source_total: int,
    collected_at: str,
) -> dict[str, str | int]:
    city, district = split_area(row.get("area", ""))
    status = row.get("status", "").strip().lower()
    return {
        "platform": "前程无忧",
        "query_keyword": query_keyword,
        "query_city": query_city,
        "job_id": row.get("jobId", "").strip(),
        "job_name": row.get("job_name", "").strip(),
        "company_id": "",
        "company_name": row.get("company", "").strip(),
        "salary": row.get("salary", "").strip(),
        "city": city or query_city,
        "district": district,
        "experience": row.get("experience", "").strip(),
        "education": row.get("degree", "").strip(),
        "employment_type": "",
        "company_nature": "",
        "company_size": "",
        "industry": "",
        "publish_time": "",
        "refresh_time": "",
        "deadline": "",
        "tags": row.get("benefits", "").strip(),
        "skills": "",
        "job_description": row.get("job_description", "").strip(),
        "address": row.get("address", "").strip(),
        "recruiter_name": "",
        "recruiter_title": "",
        "job_url": row.get("job_url", "").strip(),
        "company_url": "",
        "source_total": source_total,
        "access_level": "公开岗位详情页完整字段",
        "collected_at": collected_at,
        "headcount": row.get("headcount", "").strip(),
        "responsibilities": row.get("responsibilities", "").strip(),
        "requirements": row.get("requirements", "").strip(),
        "detail_status": "成功" if status == "success" else "失败",
        "data_origin": "ReverseLoom 公开岗位详情页",
    }


def convert_file(
    source: Path,
    output: Path,
    query_keyword: str,
    query_city: str,
) -> tuple[int, int]:
    with source.open("r", encoding="utf-8-sig", newline="") as handle:
        source_rows = list(csv.DictReader(handle))

    collected_at = datetime.now().astimezone().isoformat(timespec="seconds")
    converted = []
    seen = set()
    for source_row in source_rows:
        row = convert_row(
            source_row,
            query_keyword=query_keyword,
            query_city=query_city,
            source_total=len(source_rows),
            collected_at=collected_at,
        )
        job_id = str(row["job_id"])
        if not job_id or job_id in seen or row["detail_status"] != "成功":
            continue
        seen.add(job_id)
        converted.append(row)

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=STANDARD_COLUMNS + EXTENDED_COLUMNS)
        writer.writeheader()
        writer.writerows(converted)
    return len(source_rows), len(converted)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="将 ReverseLoom 前程无忧详情 CSV 转换为 Job Collector 标准字段。"
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--query-keyword", default="智能体开发")
    parser.add_argument("--query-city", default="广州")
    args = parser.parse_args()

    source_rows, output_rows = convert_file(
        args.source,
        args.output,
        query_keyword=args.query_keyword,
        query_city=args.query_city,
    )
    print(f"输入 {source_rows} 条，输出 {output_rows} 条：{args.output}")


if __name__ == "__main__":
    main()
