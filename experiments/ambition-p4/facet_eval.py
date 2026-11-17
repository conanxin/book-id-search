"""Facet-aware read-only audit of the frozen S31 v1.1 Top-K book pool.

A catalog match is not proof of source-text completeness. This evaluator
reports unsupported facets and primary-evidence gaps explicitly instead of
using a single nDCG value as a proxy for an entire compound research goal.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
from typing import Any


def read_frozen(repo_root: Path) -> tuple[dict, dict, dict]:
    folder = repo_root / "benchmarks" / "s31" / "v1.1"
    manifest = json.loads((folder / "cases.json").read_text(encoding="utf-8"))
    baseline = json.loads((folder / "baseline-current.json").read_text(encoding="utf-8"))
    if manifest.get("status") != "FROZEN_V1_1" or baseline.get("benchmarkVersion") != "s31-v1.1":
        raise ValueError("S31_VERSION_MISMATCH")
    qrels = {}
    with (folder / "qrels.tsv").open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        if not {"case_id", "book_id", "title", "author", "publisher", "year", "grade", "rule"}.issubset(reader.fieldnames or []):
            raise ValueError("QRELS_SCHEMA")
        for row in reader:
            key = (row["case_id"], row["book_id"])
            if key in qrels:
                raise ValueError("DUPLICATE_QREL")
            grade = int(row["grade"])
            if grade not in (0, 1, 2, 3):
                raise ValueError("QREL_GRADE")
            row["grade"] = grade
            qrels[key] = row
    return manifest, baseline, qrels


def _matches(row: dict, selector: dict) -> bool:
    allowed = {"title_eq", "title_contains", "author_contains", "publisher_contains",
               "year_eq", "qrel_rule_in", "grade_min"}
    if not isinstance(selector, dict) or not selector or set(selector) - allowed:
        raise ValueError("INVALID_FACET_SELECTOR")
    for name, value in selector.items():
        if name == "title_eq" and row["title"].strip() != value:
            return False
        if name == "title_contains" and value not in row["title"]:
            return False
        if name == "author_contains" and value not in row["author"]:
            return False
        if name == "publisher_contains" and value not in row["publisher"]:
            return False
        if name == "year_eq" and row["year"] != value:
            return False
        if name == "qrel_rule_in" and row["rule"] not in value:
            return False
        if name == "grade_min" and row["grade"] < value:
            return False
    return True


def dcg(grades: list[int]) -> float:
    return sum((2 ** grade - 1) / math.log2(rank + 1) for rank, grade in enumerate(grades, 1))


def assess(repo_root: Path, facet_manifest: dict, k: int = 10) -> dict[str, Any]:
    if not isinstance(k, int) or not 1 <= k <= 10:
        raise ValueError("K_OUT_OF_RANGE")
    manifest, baseline, qrels = read_frozen(repo_root)
    source_cases = {r["id"] for r in manifest["cases"] if r.get("metricEligible") is True}
    runs = {row["id"]: row for row in baseline["cases"]}
    cases = facet_manifest.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("EMPTY_FACET_MANIFEST")
    results = []
    visited = set()
    for case in cases:
        cid = case.get("case_id")
        if cid not in source_cases or cid in visited:
            raise ValueError("UNKNOWN_OR_DUPLICATE_CASE")
        visited.add(cid)
        facets = case.get("facets")
        if not isinstance(facets, list) or not facets:
            raise ValueError("EMPTY_FACETS")
        pool = runs[cid]["items"][:k]
        rows = []
        for item in pool:
            key = (cid, item["id"])
            if key not in qrels:
                raise ValueError("UNJUDGED_POOL_ITEM")
            rows.append({**qrels[key], "rank": item["rank"]})
        actual_grades = [x["grade"] for x in rows]
        ideal_grades = sorted(
            [v["grade"] for (c, _), v in qrels.items() if c == cid], reverse=True
        )[:k]
        ideal = dcg(ideal_grades)
        ndcg = dcg(actual_grades) / ideal if ideal else 0.0
        counts = {"SUPPORTED_IN_POOL": 0, "MISSING_IN_TOPK": 0, "NEEDS_PRIMARY_EVIDENCE": 0}
        facet_rows = []
        facet_ids = set()
        for facet in facets:
            fid = facet.get("id")
            if not isinstance(fid, str) or not fid or fid in facet_ids:
                raise ValueError("INVALID_OR_DUPLICATE_FACET")
            facet_ids.add(fid)
            level = facet.get("verification")
            if level not in ("catalog_metadata", "human_qrel", "primary_required"):
                raise ValueError("INVALID_VERIFICATION_LEVEL")
            witness_rows = [x for x in rows if _matches(x, facet.get("selector"))]
            if not witness_rows:
                status = "MISSING_IN_TOPK"
            elif level == "primary_required":
                status = "NEEDS_PRIMARY_EVIDENCE"
            else:
                status = "SUPPORTED_IN_POOL"
            counts[status] += 1
            facet_rows.append({
                "facet_id": fid, "verification": level, "status": status,
                "witnesses": [
                    {"rank": x["rank"], "book_id": x["book_id"],
                     "title": x["title"], "grade": x["grade"], "rule": x["rule"]}
                    for x in witness_rows
                ]
            })
        n = len(facet_rows)
        lower = counts["SUPPORTED_IN_POOL"] / n
        upper = (counts["SUPPORTED_IN_POOL"] + counts["NEEDS_PRIMARY_EVIDENCE"]) / n
        results.append({
            "case_id": cid, "top_k": k, "facets": facet_rows, "facet_count": n,
            "counts": counts, "catalog_coverage_lower": round(lower, 6),
            "catalog_coverage_upper": round(upper, 6),
            "all_facets_supported": counts["SUPPORTED_IN_POOL"] == n,
            "baseline_ndcg_at_k": round(ndcg, 6),
            "warning": "Top-K pool coverage; not full-corpus recall or original-text verification."
        })
    return {"benchmark": "s31-v1.1", "top_k": k, "cases": results}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--facets", type=Path, default=Path(__file__).with_name("facets.json"))
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.facets.read_text(encoding="utf-8"))
    result = assess(args.repo_root, manifest, args.top_k)
    content = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(content, encoding="utf-8")
    print(content, end="")


if __name__ == "__main__":
    main()
