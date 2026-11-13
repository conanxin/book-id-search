"""Offline unit and frozen-dataset checks for P4 experimental tools."""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
from contract import ContractError, decode_batch, decode_indices
from facet_eval import _matches, assess, dcg


class IndexBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.candidates = [{"book_id": "A"}, {"book_id": "B"}, {"book_id": "C"}]
        self.cases = [{"case_id": "one", "results": self.candidates}]
        self.answer = {"results": [{
            "case_id": "one", "diagnosis": "rank_order",
            "ranked_indices": [3, 1, 2],
            "next_action": "rerank", "limitation": "metadata only"
        }]}

    def test_valid_permutation_maps_only_existing_ids(self):
        self.assertEqual(decode_indices(self.candidates, [3, 1, 2]), ["C", "A", "B"])
        result = decode_batch(self.answer, self.cases)[0]
        self.assertEqual(result["ranked_ids"], ["C", "A", "B"])
        self.assertNotIn("ranked_indices", result)

    def test_duplicate_indices_rejected(self):
        with self.assertRaisesRegex(ContractError, "INDICES_NOT_PERMUTATION"):
            decode_indices(self.candidates, [1, 1, 2])

    def test_out_of_range_rejected(self):
        for x in (0, -1, 4, 999):
            with self.subTest(x=x), self.assertRaises(ContractError):
                decode_indices(self.candidates, [1, 2, x])

    def test_string_float_bool_all_rejected(self):
        for x in ("1", 1.0, True, None):
            with self.subTest(x=x), self.assertRaises(ContractError):
                decode_indices(self.candidates, [x, 2, 3])

    def test_missing_or_truncated_list_rejected(self):
        for x in ([], [1, 2], [1, 2, 3, 1]):
            with self.subTest(x=x), self.assertRaises(ContractError):
                decode_indices(self.candidates, x)

    def test_duplicate_and_empty_input_ids_rejected(self):
        with self.assertRaisesRegex(ContractError, "DUPLICATE_INPUT_BOOK_ID"):
            decode_indices([{"book_id": "A"}, {"book_id": "A"}], [1, 2])
        with self.assertRaisesRegex(ContractError, "INVALID_INPUT_BOOK_ID"):
            decode_indices([{"book_id": "A"}, {"book_id": ""}], [1, 2])

    def test_unknown_case_and_invented_id_field_rejected(self):
        bad = json.loads(json.dumps(self.answer))
        bad["results"][0]["case_id"] = "different"
        with self.assertRaisesRegex(ContractError, "UNKNOWN_OR_DUPLICATE_CASE"):
            decode_batch(bad, self.cases)
        bad = json.loads(json.dumps(self.answer))
        bad["results"][0]["ranked_ids"] = ["fake"]
        with self.assertRaisesRegex(ContractError, "INVALID_CASE_FIELDS"):
            decode_batch(bad, self.cases)

    def test_invalid_diagnosis_and_case_count_rejected(self):
        bad = json.loads(json.dumps(self.answer))
        bad["results"][0]["diagnosis"] = "proven"
        with self.assertRaisesRegex(ContractError, "INVALID_DIAGNOSIS"):
            decode_batch(bad, self.cases)
        with self.assertRaisesRegex(ContractError, "CASE_COUNT_MISMATCH"):
            decode_batch({"results": []}, self.cases)


class FacetTests(unittest.TestCase):
    def test_evidence_selector_and_dcg(self):
        book = {"title": "围城", "author": "钱钟书著",
                "publisher": "桂林：漓江出版社", "year": "1997",
                "grade": 3, "rule": "target-1997-lijiang"}
        self.assertTrue(_matches(book, {"title_eq": "围城", "year_eq": "1997"}))
        self.assertFalse(_matches(book, {"year_eq": "2000"}))
        with self.assertRaises(ValueError):
            _matches(book, {"unsupported_predicate": 1})
        self.assertEqual(dcg([0, 0]), 0)
        self.assertEqual(dcg([3]), 7.0)

    def test_real_frozen_cases_and_unknown_evidence(self):
        if not (ROOT / "benchmarks" / "s31" / "v1.1" / "qrels.tsv").exists():
            self.skipTest("Run in book-id-search checkout with frozen S31 v1.1 data")
        spec = json.loads((HERE / "facets.json").read_text(encoding="utf-8"))
        output = assess(ROOT, spec, 10)
        by_case = {c["case_id"]: c for c in output["cases"]}
        self.assertEqual(len(by_case), 5)
        self.assertEqual(by_case["edition-choice-02"]["catalog_coverage_lower"], 0.5)
        self.assertEqual(by_case["edition-choice-02"]["counts"]["MISSING_IN_TOPK"], 1)
        self.assertFalse(by_case["edition-choice-02"]["all_facets_supported"])
        self.assertEqual(by_case["edition-choice-05"]["catalog_coverage_lower"], 1.0)
        self.assertEqual(by_case["edition-choice-06"]["counts"]["NEEDS_PRIMARY_EVIDENCE"], 1)
        self.assertEqual(by_case["edition-choice-06"]["catalog_coverage_lower"], 0.5)
        self.assertEqual(by_case["edition-choice-06"]["catalog_coverage_upper"], 1.0)
        self.assertEqual(by_case["exact-natural-02"]["catalog_coverage_lower"], 0.0)
        self.assertEqual(by_case["exact-natural-10"]["catalog_coverage_lower"], 1.0)

    def test_target_at_rank_six_changes_top_k_coverage(self):
        if not (ROOT / "benchmarks" / "s31" / "v1.1" / "qrels.tsv").exists():
            self.skipTest("S31 data missing")
        spec = json.loads((HERE / "facets.json").read_text(encoding="utf-8"))
        at_five = {x["case_id"]: x for x in assess(ROOT, spec, 5)["cases"]}
        at_six = {x["case_id"]: x for x in assess(ROOT, spec, 6)["cases"]}
        self.assertEqual(at_five["edition-choice-02"]["catalog_coverage_lower"], 0.0)
        self.assertEqual(at_six["edition-choice-02"]["catalog_coverage_lower"], 0.5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
