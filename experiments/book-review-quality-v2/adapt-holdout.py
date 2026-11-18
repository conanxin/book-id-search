"""Adapt field layout only; never add page-level evidence to classifier inputs."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
raw = (root / "holdout-frozen.json").read_bytes()
freeze = json.loads((root / "rule-freeze.json").read_text())
if hashlib.sha256(raw).hexdigest() != freeze["holdoutDatasetSha256Announced"]:
    raise ValueError("Frozen holdout bytes changed")
original = json.loads(raw)
adapted = {
    "schemaVersion": 1,
    "taskId": "BOOK_REVIEW_EVIDENCE_P3_HOLDOUT",
    "baselineCommit": "ce420a3c010b4a6bf1b261df374baf1d1cd85ef7",
    "annotationStatus": "ASSISTANT_PROVISIONAL_HUMAN_REVIEW_PENDING",
    "originalDatasetSha256": hashlib.sha256(raw).hexdigest(),
    "books": {key: {field: book[field] for field in ("title", "author", "isbn")}
              for key, book in original["books"].items()},
    "cases": [{
        "id": row["id"], "bookKey": row["bookKey"], "origin": row["origin"],
        "source": {field: row[field] for field in ("title", "excerpt", "url")},
        "label": row["label"], "editionStatus": row["editionStatus"],
        "labelReason": row["reason"], "humanReview": "pending", "assessor": "assistant",
    } for row in original["cases"]],
}
for row, before in zip(adapted["cases"], original["cases"]):
    assert row["source"] == {field: before[field] for field in ("title", "excerpt", "url")}
    assert row["label"] == before["label"]
output = root / "holdout-cases.json"
output.write_text(json.dumps(adapted, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"inputSha256": hashlib.sha256(raw).hexdigest(),
                  "adaptedSha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                  "cases": len(adapted["cases"]), "output": str(output)}))
