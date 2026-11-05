/**
 * Holding a run's findings to the list of ones already known.
 *
 * Both directions are the point, and each has its own way of going wrong. A
 * list that only suppressed would hide a new failure; a list that never went
 * stale would become a permanent excuse. The cases below pin each direction
 * separately, so neither can be satisfied by the other.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  assertUsableExpectedFailure,
  type ExpectedFailure,
  readExpectedFailures,
  reconcileExpectedFailures,
  reconciliationFails,
  renderReconciliation,
} from "../expected-failures.ts";
import type { CheckResult, CheckVerdict } from "../report.ts";

const finding = (
  checkId: string,
  verdict: CheckVerdict,
  message: string,
  runId = "run-1",
): CheckResult => ({
  checkId,
  title: checkId,
  runId,
  runDir: `/runs/${runId}`,
  verdict,
  message,
  citations: [],
  evidence: [],
});

const entry = (
  checkId: string,
  detail: string,
  runs = "run-1",
): ExpectedFailure => ({
  checkId,
  runShape: "a shape",
  runs,
  detail,
  why: "because",
  issue: "CT-0000",
});

describe("expected-failures", () => {
  describe("reconcileExpectedFailures()", () => {
    it("matches a finding whose check and message an entry names", () => {
      const reconciliation = reconcileExpectedFailures(
        [finding("AUD-9", "fail", "retained none of: a cell-labels read")],
        [entry("AUD-9", "a cell-labels read")],
        "warn",
      );

      expect(reconciliation.matched).toHaveLength(1);
      expect(reconciliation.unexpected).toEqual([]);
      expect(reconciliation.stale).toEqual([]);
      expect(reconciliationFails(reconciliation)).toBe(false);
    });

    it("reports a finding no entry covers as unexpected", () => {
      const reconciliation = reconcileExpectedFailures(
        [finding("AUD-3", "fail", "an output nothing accounts for")],
        [entry("AUD-9", "a cell-labels read")],
        "warn",
      );

      expect(reconciliation.unexpected).toHaveLength(1);
      expect(reconciliationFails(reconciliation)).toBe(true);
    });

    it("reports an entry that matched nothing as stale", () => {
      // The direction that keeps the list from rotting: a gap that has been
      // closed must take its entry with it.
      const reconciliation = reconcileExpectedFailures(
        [],
        [entry("AUD-9", "a cell-labels read")],
        "warn",
      );

      expect(reconciliation.stale).toHaveLength(1);
      expect(reconciliationFails(reconciliation)).toBe(true);
    });

    it("does not match an entry naming the same check for another reason", () => {
      // A check fails for more than one reason, and an entry that matched the
      // check alone would excuse reasons nobody decided about.
      const reconciliation = reconcileExpectedFailures(
        [finding("AUD-9", "fail", "retained none of: a policy trace")],
        [entry("AUD-9", "a cell-labels read")],
        "warn",
      );

      expect(reconciliation.unexpected).toHaveLength(1);
      expect(reconciliation.stale).toHaveLength(1);
    });

    it("leaves a verdict below the threshold out of the reconciliation", () => {
      // `--fail-on` still decides what counts as a finding; the list decides
      // only which findings were already known.
      const reconciliation = reconcileExpectedFailures(
        [finding("AUD-9", "warn", "retained none of: a cell-labels read")],
        [],
        "fail",
      );

      expect(reconciliation.unexpected).toEqual([]);
      expect(reconciliation.matched).toEqual([]);
    });

    it("keeps an entry live when what it names occurs below the threshold", () => {
      // Raising the threshold must not turn a standing gap into a closed one.
      // The warning is not a finding under `--fail-on fail`, but it is still
      // happening, so its entry is used rather than stale.
      const reconciliation = reconcileExpectedFailures(
        [finding("AUD-9", "warn", "retained none of: a cell-labels read")],
        [entry("AUD-9", "a cell-labels read")],
        "fail",
      );

      expect(reconciliation.stale).toEqual([]);
      expect(reconciliation.unexpected).toEqual([]);
      expect(reconciliationFails(reconciliation)).toBe(false);
    });

    it("does not match a finding on a run the entry does not name", () => {
      // The suppression an entry must not be able to do. `runShape` is prose;
      // `runs` is what decides, so the same message on a run nobody
      // considered is a new failure rather than a borrowed excuse.
      const reconciliation = reconcileExpectedFailures(
        [
          finding("AUD-9", "fail", "retained none of: a read", "run-1"),
          finding("AUD-9", "fail", "retained none of: a read", "run-2"),
        ],
        [entry("AUD-9", "a read", "run-1")],
        "warn",
      );

      expect(reconciliation.matched).toHaveLength(1);
      expect(reconciliation.unexpected).toHaveLength(1);
      expect(reconciliation.unexpected[0].runId).toBe("run-2");
      expect(reconciliationFails(reconciliation)).toBe(true);
    });

    it("anchors the run selector rather than matching a substring of an id", () => {
      // `run-1` must not speak for `run-10`.
      const reconciliation = reconcileExpectedFailures(
        [finding("AUD-9", "fail", "retained none of: a read", "run-10")],
        [entry("AUD-9", "a read", "run-1")],
        "warn",
      );

      expect(reconciliation.unexpected).toHaveLength(1);
    });

    it("matches every run an alternation names", () => {
      // The other direction: one entry may legitimately speak for a set of
      // runs, so long as it says which.
      const reconciliation = reconcileExpectedFailures(
        [
          finding("AUD-9", "fail", "retained none of: a read", "alpha"),
          finding("AUD-9", "fail", "retained none of: a read", "beta"),
        ],
        [entry("AUD-9", "a read", "alpha|beta")],
        "warn",
      );

      expect(reconciliation.matched).toHaveLength(2);
      expect(reconciliationFails(reconciliation)).toBe(false);
    });
  });

  describe("assertUsableExpectedFailure()", () => {
    it("refuses an entry whose detail is empty", () => {
      // An empty detail matches every message the check can write.
      expect(() =>
        assertUsableExpectedFailure({ ...entry("AUD-9", ""), detail: "" }, 0)
      ).toThrow("non-empty `detail`");
    });

    it("refuses an entry that names no issue", () => {
      expect(() =>
        assertUsableExpectedFailure(
          { ...entry("AUD-9", "a read"), issue: "" },
          0,
        )
      ).toThrow("non-empty `issue`");
    });

    it("refuses an entry whose run selector is not a regular expression", () => {
      expect(() =>
        assertUsableExpectedFailure(entry("AUD-9", "a read", "run-(["), 0)
      ).toThrow("not a regular expression");
    });

    it("refuses a malformed entry before any finding is reconciled", () => {
      // Loud at load rather than quietly broadening at match time.
      expect(() =>
        reconcileExpectedFailures(
          [],
          [{ ...entry("AUD-9", "x"), issue: "" }],
          "warn",
        )
      ).toThrow("non-empty `issue`");
    });
  });

  describe("readExpectedFailures()", () => {
    it("answers the entries of a well-formed file", () => {
      expect(readExpectedFailures({ expected: [entry("AUD-9", "a read")] }))
        .toHaveLength(1);
    });

    it("refuses a top level that is not an object", () => {
      // A list read out of an array or a bare string would answer entries
      // nobody wrote.
      expect(() => readExpectedFailures([])).toThrow("not an object");
      expect(() => readExpectedFailures(null)).toThrow("not an object");
    });

    it("refuses a file with no `expected` array", () => {
      // The failure this exists for: `?? []` would have turned a malformed
      // file into an empty list, and an empty list excuses nothing, so a
      // broken file would have looked like a strict one.
      expect(() => readExpectedFailures({})).toThrow("no `expected` array");
      expect(() => readExpectedFailures({ expected: "nonsense" })).toThrow(
        "no `expected` array",
      );
    });
  });

  describe("renderReconciliation()", () => {
    it("names each finding no entry covers, with the run it arose on", () => {
      // What a reader of a red job needs first: which finding, and where.
      const rendered = renderReconciliation(
        reconcileExpectedFailures(
          [finding("AUD-3", "fail", "an output nothing accounts for", "run-7")],
          [],
          "warn",
        ),
      );

      expect(rendered).toContain("1 finding(s) no entry covers");
      expect(rendered).toContain("AUD-3");
      expect(rendered).toContain("run-7");
      expect(rendered).toContain("an output nothing accounts for");
    });

    it("counts the findings an entry covers rather than listing them", () => {
      // The known ones are the quiet part of the report: a count says the
      // list is doing its job without burying the findings that are not.
      const rendered = renderReconciliation(
        reconcileExpectedFailures(
          [finding("AUD-9", "fail", "retained none of: a read")],
          [entry("AUD-9", "a read")],
          "warn",
        ),
      );

      expect(rendered).toContain("1 known finding(s)");
      expect(rendered).not.toContain("no entry covers");
    });

    it("names the issue of each entry that went stale", () => {
      const rendered = renderReconciliation(
        reconcileExpectedFailures([], [entry("AUD-9", "a read")], "warn"),
      );

      expect(rendered).toContain("CT-0000");
      expect(rendered).toContain("no longer occur");
    });
  });
});
