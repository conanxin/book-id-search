#!/usr/bin/env python3
"""Export only the four experiment sessions and summarize counts, never publish transcripts."""
import json, re, subprocess
from pathlib import Path
HERE = Path(__file__).resolve().parent
OUT = HERE/"outputs"
HERMES = "/home/conanxin/.local/bin/hermes"
items = []
for batch,arm in [(1,"A"),(1,"B"),(2,"B"),(2,"A")]:
    key=f"batch{batch}_{arm}"
    r=json.loads((OUT/f"{key}.raw.json").read_text())
    m=re.search(r"session_id:\s*(\S+)",r["stderr"])
    if not m:
        raise RuntimeError(key+": cannot find session ID")
    session=m.group(1)
    filename=OUT/f"{key}.session-export.jsonl"
    command=[HERMES,"sessions","export","--format","jsonl","--session-id",session,"--yes",str(filename)]
    run=subprocess.run(command,capture_output=True,text=True,timeout=30)
    if run.returncode:
        raise RuntimeError(key+": session export failed: "+run.stderr[-400:])
    records=[json.loads(z) for z in filename.read_text().splitlines() if z.strip()]
    if len(records)!=1 or records[0].get("id")!=session:
        raise ValueError(key+": mismatched session export")
    z=records[0]
    # Keep only non-sensitive counts; do not retain complete transcript exports.
    filename.unlink(missing_ok=True)
    items.append({k:v for k,v in {
        "key":key,"session_id":session,"provider":z.get("provider") or z.get("billing_provider"),
        "model":z.get("model"),"tool_call_count":z.get("tool_call_count"),
        "message_count":z.get("message_count"),"input_tokens":z.get("input_tokens"),
        "output_tokens":z.get("output_tokens"),"reasoning_effort":"low",
        "elapsed_seconds":r["elapsed_seconds"]}.items()})
summary={"status":"VERIFIED_SESSIONS","sessions":items,
         "all_zero_tool_calls":all(x.get("tool_call_count")==0 for x in items)}
for arm in "AB":
    group=[x for x in items if x["key"].endswith("_"+arm)]
    summary[arm]={"input_tokens":sum(x["input_tokens"] for x in group),
                  "output_tokens":sum(x["output_tokens"] for x in group),
                  "elapsed_seconds":round(sum(x["elapsed_seconds"] for x in group),3)}
(OUT/"session_audit.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n")
print(json.dumps(summary,ensure_ascii=False,indent=2))
