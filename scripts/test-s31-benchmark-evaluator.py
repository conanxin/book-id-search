#!/usr/bin/env python3

import csv
import json
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
EVALUATOR = ROOT / "scripts" / "s31-benchmark-evaluator.py"


def write_json(path, obj):
    path.write_text(
        json.dumps(
            obj,
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def write_qrels(path):
    with path.open(
        "w",
        encoding="utf-8",
        newline="",
    ) as f:
        w = csv.writer(
            f,
            delimiter="\t",
        )
        w.writerow([
            "case_id",
            "query",
            "book_id",
            "title",
            "author",
            "publisher",
            "year",
            "grade",
            "rule",
            "policy_source",
            "original_top10",
            "original_rank",
            "pool_best_rank",
        ])
        w.writerow([
            "case-01",
            "test query",
            "book-good",
            "Good Book",
            "Author",
            "Publisher",
            "2000",
            "3",
            "test",
            "test",
            "true",
            "1",
            "1",
        ])
        w.writerow([
            "case-01",
            "test query",
            "book-bad",
            "Bad Book",
            "Other",
            "Publisher",
            "2001",
            "0",
            "test",
            "test",
            "true",
            "2",
            "2",
        ])


def run_eval(
    manifest,
    qrels,
    run,
    out_json,
):
    return subprocess.run(
        [
            sys.executable,
            str(EVALUATOR),
            "--manifest",
            str(manifest),
            "--qrels",
            str(qrels),
            "--run",
            str(run),
            "--json",
            str(out_json),
        ],
        text=True,
        capture_output=True,
    )


def main():
    with tempfile.TemporaryDirectory(
        prefix="s31-evaluator-test-"
    ) as td:

        d = Path(td)

        manifest = d / "manifest.json"
        qrels = d / "qrels.tsv"
        run = d / "run.json"
        out = d / "out.json"

        write_json(
            manifest,
            {
                "cases": [
                    {
                        "id": "case-01",
                        "metricEligible": True,
                    },
                    {
                        "id": "behavior-01",
                        "metricEligible": False,
                    },
                ]
            },
        )

        write_qrels(
            qrels
        )

        # --------------------------------------------------
        # T1: fully judged => PASS
        # --------------------------------------------------

        write_json(
            run,
            {
                "cases": [
                    {
                        "id": "case-01",
                        "items": [
                            {
                                "rank": 1,
                                "id": "book-good",
                            },
                            {
                                "rank": 2,
                                "id": "book-bad",
                            },
                        ],
                    }
                ]
            },
        )

        p = run_eval(
            manifest,
            qrels,
            run,
            out,
        )

        assert p.returncode == 0, (
            p.returncode,
            p.stdout,
            p.stderr,
        )

        result = json.loads(
            out.read_text(
                encoding="utf-8"
            )
        )

        assert result["status"] == "PASS"
        assert result["authoritative"] is True
        assert result["aggregate"]["hitAt1"] == 1.0

        print("T1_FULLY_JUDGED_PASS=PASS")

        # --------------------------------------------------
        # T2: unseen id => NEEDS_JUDGMENT, never PASS
        # --------------------------------------------------

        write_json(
            run,
            {
                "cases": [
                    {
                        "id": "case-01",
                        "items": [
                            {
                                "rank": 1,
                                "id": "__UNSEEN__",
                            },
                            {
                                "rank": 2,
                                "id": "book-good",
                            },
                        ],
                    }
                ]
            },
        )

        p = run_eval(
            manifest,
            qrels,
            run,
            out,
        )

        assert p.returncode == 2, (
            p.returncode,
            p.stdout,
            p.stderr,
        )

        result = json.loads(
            out.read_text(
                encoding="utf-8"
            )
        )

        assert result["status"] == "NEEDS_JUDGMENT"
        assert result["authoritative"] is False
        assert result["aggregate"] is None
        assert len(result["unjudged"]) == 1
        assert result["unjudged"][0]["bookId"] == "__UNSEEN__"

        print("T2_UNJUDGED_FAIL_CLOSED=PASS")

        # --------------------------------------------------
        # T3: missing metric case => INVALID_INPUT
        # --------------------------------------------------

        write_json(
            run,
            {
                "cases": []
            },
        )

        p = run_eval(
            manifest,
            qrels,
            run,
            out,
        )

        assert p.returncode == 1
        assert "STATUS=INVALID_INPUT" in p.stderr

        print("T3_MISSING_CASE_FAIL_CLOSED=PASS")

        # --------------------------------------------------
        # T4: non-10 top-k => INVALID_INPUT
        # --------------------------------------------------

        p = subprocess.run(
            [
                sys.executable,
                str(EVALUATOR),
                "--manifest",
                str(manifest),
                "--qrels",
                str(qrels),
                "--run",
                str(run),
                "--json",
                str(out),
                "--top-k",
                "5",
            ],
            text=True,
            capture_output=True,
        )

        assert p.returncode == 1
        assert (
            "ERROR=S31-v1 requires --top-k 10"
            in p.stderr
        )

        print(
            "T4_NON10_TOPK_FAIL_CLOSED=PASS"
        )

        # --------------------------------------------------
        # T5: duplicate qrel => INVALID_INPUT
        # --------------------------------------------------

        with qrels.open(
            "a",
            encoding="utf-8",
        ) as f:
            f.write(
                "case-01\t"
                "test query\t"
                "book-good\t"
                "duplicate\t"
                "Author\t"
                "Publisher\t"
                "2000\t"
                "3\t"
                "dup\t"
                "test\t"
                "true\t"
                "1\t"
                "1\n"
            )

        write_json(
            run,
            {
                "cases": [
                    {
                        "id": "case-01",
                        "items": [
                            {
                                "rank": 1,
                                "id": "book-good",
                            }
                        ],
                    }
                ]
            },
        )

        p = run_eval(
            manifest,
            qrels,
            run,
            out,
        )

        assert p.returncode == 1
        assert "duplicate qrel" in p.stderr

        print("T5_DUPLICATE_QREL_FAIL_CLOSED=PASS")

    print("S31_EVALUATOR_TESTS=5/5_PASS")


if __name__ == "__main__":
    main()
