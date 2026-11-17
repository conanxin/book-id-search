import { describe, expect, it, vi } from "vitest";
import { summarize } from "./evaluate";

describe("review benchmark metrics", () => {
  it("keeps unknown labels out of confusion counts", () => {
    const r = summarize([{ label: "yes", admitted: true }, { label: "no", admitted: true },
      { label: "yes", admitted: false }, { label: "no", admitted: false }, { label: "uncertain", admitted: true }]);
    expect(r).toMatchObject({ total: 5, judged: 4, excluded: 1, tp: 1, fp: 1, tn: 1, fn: 1, precision: 0.5, recall: 0.5, falsePositiveRate: 0.5 });
  });
  it("does not award perfect precision to a gate that accepts nothing", () => {
    expect(summarize([{ label: "yes", admitted: false }, { label: "no", admitted: false }]))
      .toMatchObject({ judged: 2, tp: 0, fn: 1, tn: 1, precision: null, recall: 0, falsePositiveRate: 0 });
  });
  it("uses null for unobservable rates in empty or unjudged sets", () => {
    expect(summarize([])).toMatchObject({ precision: null, recall: null, falsePositiveRate: null });
    expect(summarize([{ label: "uncertain", admitted: false }])).toMatchObject({ judged: 0, excluded: 1, recall: null });
  });
});

import { readFileSync } from "node:fs";
import { evaluateCasebook, validateCasebook } from "./evaluate";
const read = () => JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
it("evaluates the frozen PR85 policy with unchanged clue extraction and keeps observed and constructed evidence apart", () => {
  const data = read(), before = JSON.stringify(data), result = evaluateCasebook(data);
  expect(result.observed.total).toBe(16);
  expect(result.synthetic.total).toBe(10);
  expect(result.observed.excluded).toBe(2);
  expect(Object.keys(result.byBookObserved)).toHaveLength(5);
  expect(JSON.stringify(data)).toBe(before);
  expect(result.runtimePolicyWrites).toBe(0);
  expect(result.newModelCalls).toBe(0);
});
it.each(["duplicate", "unknown_book", "bad_label", "bad_override", "claimed_human"])("rejects invalid casebook: %s", kind => {
  const data = read();
  if (kind === "duplicate") data.cases.push(data.cases[0]);
  if (kind === "unknown_book") data.cases[0].bookKey = "missing";
  if (kind === "bad_label") data.cases[0].label = "maybe";
  if (kind === "bad_override") data.cases[0].bookOverride = { title: 42 };
  if (kind === "claimed_human") data.cases[0].humanReview = "verified";
  expect(() => validateCasebook(data)).toThrow();
});

it("evaluates without making network requests", () => {
  const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("NETWORK_FORBIDDEN"));
  try { evaluateCasebook(read()); expect(spy).not.toHaveBeenCalled(); } finally { spy.mockRestore(); }
});
