"""Deterministic catalog-ID boundary for AI-generated candidate *indices*.

Only the trusted input catalog supplies book IDs.  A model supplies a
permutation of 1..N; this module refuses missing, duplicated, foreign, or
ill-typed indices rather than guessing how to repair them.
"""
from __future__ import annotations

from typing import Any

DIAGNOSES = {"candidate_gap", "rank_order", "healthy", "uncertain"}
CASE_FIELDS = {"case_id", "diagnosis", "ranked_indices", "next_action", "limitation"}


class ContractError(ValueError):
    """The model output cannot safely be mapped back to catalog IDs."""


def decode_indices(candidates: list[dict[str, Any]], indices: Any) -> list[str]:
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= 10:
        raise ContractError("INPUT_CANDIDATE_COUNT")
    ids = []
    for row in candidates:
        if not isinstance(row, dict):
            raise ContractError("INVALID_INPUT_ROW")
        book_id = row.get("book_id")
        if not isinstance(book_id, str) or not book_id.strip():
            raise ContractError("INVALID_INPUT_BOOK_ID")
        ids.append(book_id)
    if len(set(ids)) != len(ids):
        raise ContractError("DUPLICATE_INPUT_BOOK_ID")

    n = len(ids)
    if not isinstance(indices, list) or len(indices) != n:
        raise ContractError("INDEX_LENGTH")
    # bool is a subclass of int in Python; enforce *exact* integer type.
    if any(type(i) is not int or i < 1 or i > n for i in indices):
        raise ContractError("INVALID_INDEX_TYPE_OR_RANGE")
    if set(indices) != set(range(1, n + 1)):
        raise ContractError("INDICES_NOT_PERMUTATION")
    return [ids[i - 1] for i in indices]


def decode_batch(payload: Any, cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(payload, dict) or set(payload) != {"results"}:
        raise ContractError("INVALID_BATCH_FIELDS")
    if not isinstance(cases, list) or not cases:
        raise ContractError("EMPTY_INPUT_CASES")
    inputs = {}
    for row in cases:
        if not isinstance(row, dict) or not isinstance(row.get("case_id"), str):
            raise ContractError("INVALID_INPUT_CASE")
        cid = row["case_id"]
        if cid in inputs:
            raise ContractError("DUPLICATE_INPUT_CASE")
        inputs[cid] = row.get("results")
    answers = payload["results"]
    if not isinstance(answers, list) or len(answers) != len(inputs):
        raise ContractError("CASE_COUNT_MISMATCH")

    decoded = []
    seen = set()
    for item in answers:
        if not isinstance(item, dict) or set(item) != CASE_FIELDS:
            raise ContractError("INVALID_CASE_FIELDS")
        cid = item["case_id"]
        if not isinstance(cid, str) or cid not in inputs or cid in seen:
            raise ContractError("UNKNOWN_OR_DUPLICATE_CASE")
        seen.add(cid)
        if item["diagnosis"] not in DIAGNOSES:
            raise ContractError("INVALID_DIAGNOSIS")
        for name in ("next_action", "limitation"):
            if not isinstance(item[name], str):
                raise ContractError("INVALID_TEXT_FIELD")
        ids = decode_indices(inputs[cid], item["ranked_indices"])
        decoded.append({
            "case_id": cid,
            "diagnosis": item["diagnosis"],
            "ranked_ids": ids,
            "next_action": item["next_action"],
            "limitation": item["limitation"],
        })
    if seen != set(inputs):
        raise ContractError("MISSING_CASE")
    return decoded
