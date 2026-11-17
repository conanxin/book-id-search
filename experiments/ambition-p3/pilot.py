#!/usr/bin/env python3
"""Frozen-pool prompt pilot: no production writes, no index changes."""
import argparse
import csv
import hashlib
import json
import math
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = HERE / "outputs"
BENCH = ROOT / "benchmarks" / "s31" / "v1.1"
HERMES = "/home/conanxin/.local/bin/hermes"
MODEL = "MiniMax-M3"
PROVIDER = "minimax-cn"
BATCHES = [
    ["edition-choice-02", "edition-choice-05", "exact-natural-02", "exact-natural-06"],
    ["edition-choice-01", "edition-choice-06", "exact-natural-03", "exact-natural-10"],
]
SEQUENCE = [(1, "A"), (1, "B"), (2, "B"), (2, "A")]
COMMON = """任务：仅根据给出的 10 条公开书目元数据，帮助读者找到符合查询意图的书。不能访问外部资料、运行工具或杜撰候选书。
对每个 case 必须返回诊断与完整重排（保留且仅保留输入的十个 book_id）。诊断仅能为：
candidate_gap（前十可能没有真正目标书，重排不能根治）；
rank_order（前十有候选目标，排序不佳）；
healthy（当前第 1 条已足够匹配主要目标）；
uncertain（给定字段不足以作可靠判断）。
输出严格 JSON，不要代码围栏或多余文字，结构：
{"results":[{"case_id":"与输入完全相同","diagnosis":"上述四类之一","ranked_ids":["全部10个ID，按建议次序"],"next_action":"不超过50字，可执行的最小下一步","limitation":"不超过50字，说明证据边界"}]}
每个 case 都要完整输出。判断不得引用未提供的书目记录、人工相关性真值或外部测试结果。"""
A = """普通任务指令：请改善书籍搜索结果质量。根据查询与当前返回列表，判断主要问题类型，把更适合的书排前面，并提出实用修复建议。
"""
B = """六维 Ambition Architect 指令：不要只重排；目标是让读者真正找到符合意图的作品及版本（Altitude）。逐项检查作者、书名、版本、译介与二手研究的身份区别，挑战“现有候选足够”的假设（Depth）。必要时借用目录学、书目控制、信息检索中有关作品-版本-记录的区分方法（Range）。区分能直接从元数据判断与必须查权威原件才可确认的事实（Verifiability）。只选择最小必要干预，不能用重排掩盖召回缺失，也不能为任务扩建系统（Stewardship）。遵守共同 JSON 结构和输入边界。
"""

def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def read_data():
    manifest = json.loads((BENCH / "cases.json").read_text())
    baseline = json.loads((BENCH / "baseline-current.json").read_text())
    rows = {}
    with (BENCH / "qrels.tsv").open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh, delimiter="\t"):
            rows[(row["case_id"], row["book_id"])] = row
    return manifest, baseline, rows

def cases_for(batch_num):
    manifest, baseline, rows = read_data()
    chosen = BATCHES[batch_num - 1]
    descriptions = {c["id"]: c for c in manifest["cases"]}
    runs = {c["id"]: c for c in baseline["cases"]}
    result = []
    for case_id in chosen:
        assert descriptions[case_id]["metricEligible"]
        c = runs[case_id]
        items = []
        for entry in c["items"][:10]:
            info = rows[(case_id, entry["id"])]
            items.append({k: v for k, v in {
                "rank": entry["rank"], "book_id": entry["id"], "title": info["title"],
                "author": info["author"], "publisher": info["publisher"],
                "year": info["year"]}.items()})
        assert len(items) == 10 and len({i["book_id"] for i in items}) == 10
        result.append({"case_id": case_id, "query": c["query"], "results": items})
    return result

def get_prompt(batch, arm):
    cases = cases_for(batch)
    return (COMMON + "\n" + (A if arm == "A" else B) +
            "\n以下是固定的、没有相关性标签的候选集：\n" +
            json.dumps(cases, ensure_ascii=False, separators=(",", ":")))

def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    paths = {}
    for batch, arm in SEQUENCE:
        key = f"batch{batch}_{arm}"
        prompt = get_prompt(batch, arm)
        dest = OUT / f"{key}.prompt.txt"
        dest.write_text(prompt, encoding="utf-8")
        paths[key] = {"file": str(dest.relative_to(HERE)), "sha256": digest(prompt),
                      "chars": len(prompt), "cases": BATCHES[batch - 1]}
    evidence = {
        "status": "PREREGISTERED_NOT_RUN", "git_base": "8c9d3383b02e08e98b595dc58b76f3f93f7e1913",
        "benchmark": "s31-v1.1", "cases": BATCHES,
        "model": MODEL, "provider": PROVIDER, "reasoning": "low",
        "max_turns": 1, "run_budget_seconds": 120,
        "sequence": [f"batch{b}_{a}" for b,a in SEQUENCE],
        "prompts": paths,
        "rubric": "candidate_gap if no grade>0 in frozen top10; healthy if rank1 grade3; else rank_order",
        "notes": "Purposive 8-case pilot, not a representative/randomized trial. No outcome-driven changes after preregistration."
    }
    (HERE / "preregistration.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"prepared": list(paths), "inputs": len(BATCHES)*4, "sha": {k:v["sha256"] for k,v in paths.items()}}, ensure_ascii=False))

def run(batch, arm):
    key = f"batch{batch}_{arm}"
    prompt = OUT / f"{key}.prompt.txt"
    assert prompt.exists(), "Run prepare first"
    expected = json.loads((HERE / "preregistration.json").read_text())["prompts"][key]["sha256"]
    assert digest(prompt.read_text()) == expected, "Prompt was modified after preregistration"
    rawpath = OUT / f"{key}.raw.json"
    assert not rawpath.exists(), f"Already ran {key}; do not overwrite evidence"
    cmd = [HERMES, "chat", "--query-file", str(prompt), "--provider", PROVIDER,
           "-m", MODEL, "-t", "none", "--ignore-rules",
           "--reasoning", "low", "--max-turns", "1", "--run-budget", "120",
           "--source", "tool", "-Q", "--in", str(HERE)]
    started = time.time()
    try:
        r = subprocess.run(cmd, text=True, capture_output=True, timeout=150, cwd=HERE)
        record = {"key": key, "prompt_sha256": expected, "exit_code": r.returncode,
                  "elapsed_seconds": round(time.time()-started, 3),
                  "stdout": r.stdout, "stderr": r.stderr, "model": MODEL, "provider": PROVIDER}
    except subprocess.TimeoutExpired as exc:
        record = {"key": key, "prompt_sha256": expected, "exit_code": -1,
                  "elapsed_seconds": round(time.time()-started, 3),
                  "stdout": (exc.stdout or b"").decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or ""),
                  "stderr": "TIMEOUT", "model": MODEL, "provider": PROVIDER}
    rawpath.write_text(json.dumps(record, ensure_ascii=False, indent=2)+"\n")
    print(json.dumps({"key": key, "exit_code": record["exit_code"], "elapsed": record["elapsed_seconds"],
                      "stdout_chars": len(record["stdout"]), "stderr_tail": record["stderr"][-300:]},
                     ensure_ascii=False))

def dcg(grades):
    return sum((2**g-1)/math.log2(i+2) for i,g in enumerate(grades))

def parse_json_response(raw):
    text = raw["stdout"]
    i = text.find('{"results"')
    if i < 0:
        i = text.find("{\n")
    if i < 0:
        raise ValueError("Missing JSON object")
    decoder = json.JSONDecoder()
    output, consumed = decoder.raw_decode(text[i:])
    return output

def evaluate():
    manifest, baseline, rows = read_data()
    keys = [f"batch{b}_{a}" for b,a in SEQUENCE]
    findings, issues = [], []
    for batch, arm in SEQUENCE:
        key = f"batch{batch}_{arm}"
        f = OUT / f"{key}.raw.json"
        if not f.exists():
            issues.append(key+": NO_RUN")
            continue
        r = json.loads(f.read_text())
        if r["exit_code"] != 0:
            issues.append(key+f": EXIT_{r['exit_code']}")
            continue
        try:
            p = parse_json_response(r)
            report = {x["case_id"]: x for x in p["results"]}
            if set(report) != set(BATCHES[batch-1]):
                raise ValueError("Case IDs mismatch")
            for case_id in BATCHES[batch-1]:
                target = report[case_id]
                listed = baseline["cases"]
                b = next(x for x in listed if x["id"] == case_id)
                base_ids = [x["id"] for x in b["items"][:10]]
                predicted = target["ranked_ids"]
                if len(predicted) != 10 or len(set(predicted)) != 10 or set(predicted)!=set(base_ids):
                    # Preserve invalid output without discarding other valid cases in the batch.
                    issues.append(key+": INVALID_RANKED_IDS: "+case_id)
                    continue
                judged = {book: int(rows[(case_id,book)]["grade"]) for book in base_ids}
                grades = [judged[x] for x in predicted]
                origin_grades = [judged[x] for x in base_ids]
                max_dcg = dcg(sorted([int(v["grade"]) for (cid,_),v in rows.items() if cid==case_id],reverse=True)[:10])
                ndcg=lambda gs: dcg(gs)/max_dcg if max_dcg else 0.0
                gold = ("candidate_gap" if max(origin_grades)==0 else
                        "healthy" if origin_grades[0]==3 else "rank_order")
                findings.append({
                    "case_id":case_id, "arm":arm, "batch":batch, "gold_diagnosis":gold,
                    "predicted_diagnosis":target["diagnosis"],
                    "diagnosis_correct": target["diagnosis"]==gold,
                    "baseline_ndcg10":round(ndcg(origin_grades),6),
                    "ndcg10":round(ndcg(grades),6),
                    "delta_ndcg10":round(ndcg(grades)-ndcg(origin_grades),6),
                    "ranked_ids":predicted,"next_action":target.get("next_action",""),
                    "limitation":target.get("limitation",""),"elapsed_seconds":r["elapsed_seconds"]
                })
        except Exception as exc:
            issues.append(key+": PARSE_OR_SCHEMA_ERROR: "+str(exc))
    def aggregate(arm):
        z=[x for x in findings if x["arm"]==arm]
        run_times = [json.loads((OUT/f"batch{b}_{a}.raw.json").read_text())["elapsed_seconds"]
                     for b,a in SEQUENCE if a==arm and (OUT/f"batch{b}_{a}.raw.json").exists()]
        return {"cases":len(z),"diagnosis_correct":sum(x["diagnosis_correct"] for x in z),
                "mean_ndcg10":round(sum(x["ndcg10"] for x in z)/len(z),6) if z else None,
                "baseline_mean_ndcg10":round(sum(x["baseline_ndcg10"] for x in z)/len(z),6) if z else None,
                "mean_delta_ndcg10":round(sum(x["delta_ndcg10"] for x in z)/len(z),6) if z else None,
                "call_elapsed_seconds":round(sum(run_times),3) if run_times else None}
    a_cases = {x["case_id"]: x for x in findings if x["arm"] == "A"}
    b_cases = {x["case_id"]: x for x in findings if x["arm"] == "B"}
    paired_ids = sorted(set(a_cases) & set(b_cases))
    def pair_arm(index):
        vals = [index[c] for c in paired_ids]
        return {
            "diagnosis_correct": sum(x["diagnosis_correct"] for x in vals),
            "mean_ndcg10": round(sum(x["ndcg10"] for x in vals)/len(vals), 6) if vals else None,
            "mean_delta_ndcg10": round(sum(x["delta_ndcg10"] for x in vals)/len(vals), 6) if vals else None,
        }
    paired = {"n": len(paired_ids), "case_ids": paired_ids,
              "A": pair_arm(a_cases), "B": pair_arm(b_cases)}
    summary={"status":"COMPLETE" if len(findings)==16 and not issues else "PARTIAL",
             "calls_recorded": sum((OUT/f"batch{b}_{a}.raw.json").exists() for b,a in SEQUENCE),
             "issues":issues,"A":aggregate("A"),"B":aggregate("B"),
             "paired":paired,"cases":findings}
    (OUT/"pilot_results.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n")
    text=[f"# P3 8-case pilot — {summary['status']}","",
          "Historical frozen S31 v1.1 pooled ranking. Not independent new retrieval; no significance test.",
          f"Problems: {issues}", "", "## Aggregates",
          "| Metric | A | B |","|---|---:|---:|"]
    for k in ("diagnosis_correct","mean_ndcg10","baseline_mean_ndcg10","mean_delta_ndcg10","call_elapsed_seconds"):
        text.append(f"| {k} | {summary['A'].get(k)} | {summary['B'].get(k)} |")
    text += ["","## Case-level","| Case | Arm | Gold | Prediction | Correct | Baseline nDCG | nDCG | Δ |","|---|---|---|---|---|---:|---:|---:|"]
    for f in sorted(findings,key=lambda x:(x["case_id"],x["arm"])):
        text.append(f"| {f['case_id']} | {f['arm']} | {f['gold_diagnosis']} | {f['predicted_diagnosis']} | {f['diagnosis_correct']} | {f['baseline_ndcg10']} | {f['ndcg10']} | {f['delta_ndcg10']} |")
    (OUT/"pilot_results.md").write_text("\n".join(text)+"\n")
    print(json.dumps({k:v for k,v in summary.items() if k!="cases"},ensure_ascii=False,indent=2))
    for z in findings: print(f"{z['case_id']} {z['arm']}: {z['predicted_diagnosis']} ({z['gold_diagnosis']}) nDCG={z['ndcg10']}")
    if issues: raise SystemExit(2)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("action", choices=["prepare","run","evaluate"])
    ap.add_argument("--batch",type=int,choices=[1,2])
    ap.add_argument("--arm",choices=["A","B"])
    args=ap.parse_args()
    if args.action=="prepare":prepare()
    elif args.action=="run":
        if not (args.batch and args.arm):ap.error("--batch and --arm required")
        run(args.batch,args.arm)
    else:evaluate()

if __name__=="__main__":main()
