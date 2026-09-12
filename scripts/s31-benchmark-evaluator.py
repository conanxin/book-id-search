#!/usr/bin/env python3

import argparse
import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path


PASS = 0
INVALID_INPUT = 1
NEEDS_JUDGMENT = 2


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_manifest(path):
    data = load_json(path)

    cases = data.get("cases")

    if not isinstance(cases, list):
        raise ValueError("manifest cases must be a list")

    ids = [c.get("id") for c in cases]

    if any(not isinstance(x, str) or not x for x in ids):
        raise ValueError("manifest contains invalid case id")

    if len(ids) != len(set(ids)):
        raise ValueError("manifest contains duplicate case id")

    metric_ids = {
        c["id"]
        for c in cases
        if c.get("metricEligible") is True
    }

    behavior_ids = {
        c["id"]
        for c in cases
        if c.get("metricEligible") is False
    }

    if not metric_ids:
        raise ValueError("manifest has no metric cases")

    return data, metric_ids, behavior_ids


def load_qrels(path):
    by_case = defaultdict(dict)
    seen = set()

    with open(
        path,
        encoding="utf-8",
        newline="",
    ) as f:
        reader = csv.DictReader(
            f,
            delimiter="\t",
        )

        required = {
            "case_id",
            "book_id",
            "grade",
        }

        if not required.issubset(
            set(reader.fieldnames or [])
        ):
            raise ValueError(
                "qrels missing required columns"
            )

        for row in reader:
            case_id = row["case_id"]
            book_id = row["book_id"]

            key = (case_id, book_id)

            if key in seen:
                raise ValueError(
                    f"duplicate qrel: {key}"
                )

            seen.add(key)

            try:
                grade = int(row["grade"])
            except Exception as exc:
                raise ValueError(
                    f"invalid qrel grade: {key}"
                ) from exc

            if grade not in (0, 1, 2, 3):
                raise ValueError(
                    f"grade outside 0..3: {key}"
                )

            by_case[case_id][book_id] = grade

    return by_case


def validate_run(data, metric_ids, top_k):
    cases = data.get("cases")

    if not isinstance(cases, list):
        raise ValueError(
            "run cases must be a list"
        )

    run_ids = [
        c.get("id")
        for c in cases
    ]

    if any(
        not isinstance(x, str) or not x
        for x in run_ids
    ):
        raise ValueError(
            "run contains invalid case id"
        )

    if len(run_ids) != len(set(run_ids)):
        raise ValueError(
            "run contains duplicate case id"
        )

    run_map = {
        c["id"]: c
        for c in cases
    }

    missing = sorted(
        metric_ids - set(run_map)
    )

    if missing:
        raise ValueError(
            "run missing metric cases: "
            + ",".join(missing)
        )

    for case_id in sorted(metric_ids):
        case = run_map[case_id]
        items = case.get("items")

        if not isinstance(items, list):
            raise ValueError(
                f"{case_id}: items must be list"
            )

        items = items[:top_k]

        ids = []
        ranks = []

        for item in items:
            book_id = item.get("id")
            rank = item.get("rank")

            if not isinstance(
                book_id,
                str,
            ) or not book_id:
                raise ValueError(
                    f"{case_id}: invalid book id"
                )

            if not isinstance(rank, int):
                raise ValueError(
                    f"{case_id}: rank must be int"
                )

            ids.append(book_id)
            ranks.append(rank)

        if len(ids) != len(set(ids)):
            raise ValueError(
                f"{case_id}: duplicate result id"
            )

        if ranks != list(
            range(
                1,
                len(ranks) + 1,
            )
        ):
            raise ValueError(
                f"{case_id}: ranks must be contiguous from 1"
            )

    return run_map


def gain(grade):
    return (2 ** grade) - 1


def dcg(grades):
    return sum(
        gain(g) / math.log2(i + 1)
        for i, g in enumerate(
            grades,
            1,
        )
    )


def evaluate(
    manifest_path,
    qrels_path,
    run_path,
    top_k,
):
    manifest, metric_ids, behavior_ids = (
        load_manifest(
            manifest_path
        )
    )

    qrels = load_qrels(
        qrels_path
    )

    missing_qrel_cases = sorted(
        metric_ids - set(qrels)
    )

    if missing_qrel_cases:
        raise ValueError(
            "qrels missing metric cases: "
            + ",".join(
                missing_qrel_cases
            )
        )

    run_data = load_json(
        run_path
    )

    run_map = validate_run(
        run_data,
        metric_ids,
        top_k,
    )

    unjudged = []
    case_metrics = []

    for case_id in sorted(metric_ids):
        items = (
            run_map[case_id]
            .get("items", [])
        )[:top_k]

        grades = []

        case_unjudged = []

        for item in items:
            book_id = item["id"]

            if book_id not in qrels[case_id]:
                case_unjudged.append({
                    "caseId":
                        case_id,
                    "rank":
                        item["rank"],
                    "bookId":
                        book_id,
                })
                continue

            grades.append(
                qrels[case_id][
                    book_id
                ]
            )

        if case_unjudged:
            unjudged.extend(
                case_unjudged
            )

            case_metrics.append({
                "caseId": case_id,
                "status":
                    "NEEDS_JUDGMENT",
                "unjudged":
                    case_unjudged,
            })

            continue

        relevant_ranks = [
            i
            for i, grade in enumerate(
                grades,
                1,
            )
            if grade > 0
        ]

        first = (
            relevant_ranks[0]
            if relevant_ranks
            else None
        )

        ideal = sorted(
            qrels[case_id].values(),
            reverse=True,
        )[:top_k]

        ideal_dcg = dcg(
            ideal
        )

        actual_dcg = dcg(
            grades
        )

        ndcg = (
            actual_dcg / ideal_dcg
            if ideal_dcg > 0
            else 0.0
        )

        case_metrics.append({
            "caseId":
                case_id,
            "status":
                "JUDGED",
            "hit1":
                first == 1,
            "hit3":
                first is not None
                and first <= 3,
            "hit10":
                first is not None
                and first <= 10,
            "reciprocalRank":
                1.0 / first
                if first
                else 0.0,
            "nDCG10":
                ndcg,
            "relevantInTop10":
                len(
                    relevant_ranks
                ),
            "grades":
                grades,
        })

    if unjudged:
        return {
            "status":
                "NEEDS_JUDGMENT",
            "authoritative":
                False,
            "topK":
                top_k,
            "metricCases":
                len(metric_ids),
            "behaviorCases":
                sorted(
                    behavior_ids
                ),
            "unjudged":
                unjudged,
            "aggregate":
                None,
            "caseMetrics":
                case_metrics,
        }

    judged = [
        m
        for m in case_metrics
        if m["status"] == "JUDGED"
    ]

    n = len(judged)

    aggregate = {
        "cases":
            n,
        "hitAt1":
            sum(
                m["hit1"]
                for m in judged
            ) / n,
        "hitAt3":
            sum(
                m["hit3"]
                for m in judged
            ) / n,
        "hitAt10":
            sum(
                m["hit10"]
                for m in judged
            ) / n,
        "MRR":
            sum(
                m["reciprocalRank"]
                for m in judged
            ) / n,
        "meanNDCG10":
            sum(
                m["nDCG10"]
                for m in judged
            ) / n,
    }

    return {
        "status":
            "PASS",
        "authoritative":
            True,
        "topK":
            top_k,
        "metricCases":
            len(metric_ids),
        "behaviorCases":
            sorted(
                behavior_ids
            ),
        "unjudged":
            [],
        "aggregate":
            aggregate,
        "caseMetrics":
            case_metrics,
    }


def render_markdown(result):
    lines = [
        "# S31 Benchmark Evaluation",
        "",
        f"- status: {result['status']}",
        f"- authoritative: {str(result['authoritative']).lower()}",
        f"- topK: {result['topK']}",
        f"- metric cases: {result['metricCases']}",
        "",
    ]

    if result["status"] == "NEEDS_JUDGMENT":
        lines.extend([
            "## UNJUDGED",
            "",
            "Regression PASS is forbidden until these records are judged.",
            "",
        ])

        for row in result["unjudged"]:
            lines.append(
                "- "
                f"{row['caseId']} "
                f"rank={row['rank']} "
                f"`{row['bookId']}`"
            )

        return "\n".join(lines) + "\n"

    agg = result["aggregate"]

    lines.extend([
        "## Aggregate",
        "",
        f"- Hit@1: {agg['hitAt1']:.6f}",
        f"- Hit@3: {agg['hitAt3']:.6f}",
        f"- Hit@10: {agg['hitAt10']:.6f}",
        f"- MRR: {agg['MRR']:.6f}",
        f"- mean nDCG@10: {agg['meanNDCG10']:.6f}",
        "",
        "## Per case",
        "",
        "| Case | H1 | H3 | H10 | RR | nDCG@10 | Relevant@10 |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ])

    for m in result["caseMetrics"]:
        lines.append(
            f"| {m['caseId']} | "
            f"{int(m['hit1'])} | "
            f"{int(m['hit3'])} | "
            f"{int(m['hit10'])} | "
            f"{m['reciprocalRank']:.6f} | "
            f"{m['nDCG10']:.6f} | "
            f"{m['relevantInTop10']} |"
        )

    return "\n".join(lines) + "\n"


def parse_args():
    p = argparse.ArgumentParser()

    p.add_argument(
        "--manifest",
        required=True,
    )
    p.add_argument(
        "--qrels",
        required=True,
    )
    p.add_argument(
        "--run",
        required=True,
    )
    p.add_argument(
        "--top-k",
        type=int,
        default=10,
    )
    p.add_argument(
        "--json",
    )
    p.add_argument(
        "--markdown",
    )

    return p.parse_args()


def main():
    args = parse_args()

    if args.top_k != 10:
        print(
            "STATUS=INVALID_INPUT",
            file=sys.stderr,
        )
        print(
            "ERROR=S31-v1 requires --top-k 10",
            file=sys.stderr,
        )
        return INVALID_INPUT

    try:
        result = evaluate(
            args.manifest,
            args.qrels,
            args.run,
            args.top_k,
        )
    except Exception as exc:
        print(
            "STATUS=INVALID_INPUT",
            file=sys.stderr,
        )
        print(
            "ERROR="
            + str(exc),
            file=sys.stderr,
        )
        return INVALID_INPUT

    rendered = render_markdown(
        result
    )

    if args.json:
        with open(
            args.json,
            "w",
            encoding="utf-8",
        ) as f:
            json.dump(
                result,
                f,
                ensure_ascii=False,
                indent=2,
            )
            f.write("\n")

    if args.markdown:
        with open(
            args.markdown,
            "w",
            encoding="utf-8",
        ) as f:
            f.write(
                rendered
            )

    print(
        f"STATUS={result['status']}"
    )
    print(
        "AUTHORITATIVE="
        + (
            "yes"
            if result["authoritative"]
            else "no"
        )
    )
    print(
        f"UNJUDGED_COUNT="
        f"{len(result['unjudged'])}"
    )

    if result["aggregate"] is not None:
        a = result["aggregate"]

        print(
            f"HIT_AT_1="
            f"{a['hitAt1']:.6f}"
        )
        print(
            f"HIT_AT_3="
            f"{a['hitAt3']:.6f}"
        )
        print(
            f"HIT_AT_10="
            f"{a['hitAt10']:.6f}"
        )
        print(
            f"MRR="
            f"{a['MRR']:.6f}"
        )
        print(
            "MEAN_NDCG_AT_10="
            f"{a['meanNDCG10']:.6f}"
        )

    if result["status"] == "NEEDS_JUDGMENT":
        return NEEDS_JUDGMENT

    return PASS


if __name__ == "__main__":
    raise SystemExit(
        main()
    )
