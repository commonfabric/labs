import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { diffPlan } from "../../src/ops/bulk-diff.ts";
import type { PiecePlan, PiecePlanRow } from "../../src/ops/bulk-plan.ts";

const header = {
  kind: "piece-plan",
  v: 1,
  space: "did:key:test",
  takenAt: "2026-08-24T00:00:00.000Z",
  selector: "collection" as const,
  enumerated: { collection: 4, registry: 0, registeredOutside: 0 },
} as const;

function retargetRow(piece: string, from: string, to: string): PiecePlanRow {
  return {
    piece,
    phase: "topics",
    expect: { patternIdentity: from, symbol: "default", retained: true },
    op: {
      kind: "retarget",
      source: { main: "topic.tsx" },
      patternIdentity: to,
      symbol: "default",
    },
  };
}

function restoreRow(piece: string, from: string, to: string): PiecePlanRow {
  return {
    piece,
    expect: { patternIdentity: from, symbol: "default", retained: true },
    op: { kind: "restore", patternIdentity: to, symbol: "default" },
  };
}

function surveyRow(
  piece: string,
  identity: string,
  symbol = "default",
): PiecePlanRow {
  return {
    piece,
    expect: { patternIdentity: identity, symbol, retained: true },
  };
}

describe("bulk-diff", () => {
  describe("diffPlan()", () => {
    it("refuses a plan carrying repair rows, naming them", () => {
      const plan = {
        header,
        rows: [{
          piece: "fid1:ccc",
          expect: {
            patternIdentity: "x",
            symbol: "default",
            retained: true,
            documentHash: "9f2c",
          },
          op: {
            kind: "repair" as const,
            fixer: "fix-titles.ts",
            fixerIdentity: "impl-v1",
          },
        }],
      };
      expect(() => diffPlan(plan, plan)).toThrow(
        "cannot verify a document repair",
      );
      expect(() => diffPlan(plan, plan)).toThrow("fid1:ccc");
    });

    it("returns landed, outstanding, and moved-elsewhere for retarget rows", () => {
      const plan: PiecePlan = {
        header,
        rows: [
          retargetRow("of:fid1:aaY", "old", "new"),
          retargetRow("of:fid1:bbY", "old", "new"),
          retargetRow("of:fid1:ccc", "old", "new"),
        ],
      };
      const after: PiecePlan = {
        header,
        rows: [
          surveyRow("of:fid1:aaY", "new"),
          surveyRow("of:fid1:bbY", "old"),
          surveyRow("of:fid1:ccc", "other"),
        ],
      };
      expect(diffPlan(plan, after).rows.map((row) => row.status)).toEqual(
        ["landed", "outstanding", "moved-elsewhere"],
      );
    });

    it("returns the same three verdicts for restore rows", () => {
      const plan: PiecePlan = {
        header,
        rows: [
          restoreRow("of:fid1:aaY", "new", "old"),
          restoreRow("of:fid1:bbY", "new", "old"),
          restoreRow("of:fid1:ccc", "new", "old"),
        ],
      };
      const after: PiecePlan = {
        header,
        rows: [
          surveyRow("of:fid1:aaY", "old"),
          surveyRow("of:fid1:bbY", "new"),
          surveyRow("of:fid1:ccc", "other"),
        ],
      };
      expect(diffPlan(plan, after).rows.map((row) => row.status)).toEqual(
        ["landed", "outstanding", "moved-elsewhere"],
      );
    });

    it("returns moved-elsewhere for a piece on the identity but another symbol", () => {
      const plan: PiecePlan = {
        header,
        rows: [retargetRow("of:fid1:aaY", "old", "new")],
      };
      const after: PiecePlan = {
        header,
        rows: [surveyRow("of:fid1:aaY", "new", "Other")],
      };
      expect(diffPlan(plan, after).rows[0].status).toBe("moved-elsewhere");
    });

    it("returns unchanged and changed for rows without an op", () => {
      const plan: PiecePlan = {
        header,
        rows: [
          surveyRow("of:fid1:aaY", "same"),
          surveyRow("of:fid1:bbY", "a"),
          surveyRow("of:fid1:ccc", "a"),
        ],
      };
      const after: PiecePlan = {
        header,
        rows: [
          surveyRow("of:fid1:aaY", "same"),
          surveyRow("of:fid1:bbY", "b"),
          surveyRow("of:fid1:ccc", "a", "Other"),
        ],
      };
      expect(diffPlan(plan, after).rows.map((row) => row.status)).toEqual(
        ["unchanged", "changed", "changed"],
      );
    });

    it("returns missing for a plan row the after-survey lacks", () => {
      const plan: PiecePlan = { header, rows: [surveyRow("of:fid1:aaY", "x")] };
      const diff = diffPlan(plan, { header, rows: [] });
      expect(diff.rows[0].status).toBe("missing");
      expect(diff.rows[0].after).toBeUndefined();
    });

    it("returns pieces only the after-survey holds as unplanned", () => {
      const plan: PiecePlan = { header, rows: [surveyRow("of:fid1:aaY", "x")] };
      const after: PiecePlan = {
        header,
        rows: [surveyRow("of:fid1:aaY", "x"), surveyRow("of:fid1:new", "x")],
      };
      expect(diffPlan(plan, after).unplanned).toEqual(["of:fid1:new"]);
    });

    it("returns the references each verdict was decided from", () => {
      const plan: PiecePlan = {
        header,
        rows: [retargetRow("of:fid1:aaY", "old", "new")],
      };
      const after: PiecePlan = {
        header,
        rows: [surveyRow("of:fid1:aaY", "other")],
      };
      expect(diffPlan(plan, after).rows[0]).toEqual({
        piece: "of:fid1:aaY",
        phase: "topics",
        status: "moved-elsewhere",
        before: { patternIdentity: "old", symbol: "default" },
        after: { patternIdentity: "other", symbol: "default" },
        target: { patternIdentity: "new", symbol: "default" },
      });
    });

    it("returns counts that add up to the plan's rows", () => {
      const plan: PiecePlan = {
        header,
        rows: [
          retargetRow("of:fid1:aaY", "old", "new"),
          retargetRow("of:fid1:bbY", "old", "new"),
          surveyRow("of:fid1:ccc", "x"),
        ],
      };
      const after: PiecePlan = {
        header,
        rows: [surveyRow("of:fid1:aaY", "new"), surveyRow("of:fid1:ccc", "x")],
      };
      const { counts } = diffPlan(plan, after);
      expect(counts).toEqual({
        landed: 1,
        outstanding: 0,
        "moved-elsewhere": 0,
        unchanged: 1,
        changed: 0,
        missing: 1,
      });
    });

    it("throws for plans from different spaces", () => {
      const plan: PiecePlan = { header, rows: [surveyRow("of:fid1:aaY", "x")] };
      const elsewhere: PiecePlan = {
        header: { ...header, space: "did:key:other" },
        rows: [surveyRow("of:fid1:aaY", "x")],
      };
      expect(() => diffPlan(plan, elsewhere)).toThrow("different spaces");
    });

    it("throws for a plan listing one piece twice, on either side", () => {
      const twice: PiecePlan = {
        header,
        rows: [surveyRow("of:fid1:aaY", "x"), surveyRow("of:fid1:aaY", "x")],
      };
      const once: PiecePlan = {
        header,
        rows: [surveyRow("of:fid1:aaY", "x")],
      };
      expect(() => diffPlan(twice, once)).toThrow("more than once");
      expect(() => diffPlan(once, twice)).toThrow("more than once");
    });

    it("folds the of: alias when matching plan and after-survey rows", () => {
      const plan: PiecePlan = { header, rows: [surveyRow("of:fid1:aaY", "x")] };
      const after: PiecePlan = { header, rows: [surveyRow("fid1:aaY", "x")] };
      const diff = diffPlan(plan, after);
      expect(diff.rows[0].status).toBe("unchanged");
      expect(diff.unplanned).toEqual([]);
    });

    it("throws for an incomplete plan on either side", () => {
      const incomplete: PiecePlan = {
        header: {
          ...header,
          problems: [{ piece: "fid1:x", problem: "unreadable" }],
        },
        rows: [],
      };
      const clean: PiecePlan = { header, rows: [] };
      expect(() => diffPlan(incomplete, clean)).toThrow("incomplete");
      expect(() => diffPlan(clean, incomplete)).toThrow("incomplete");
    });

    it("throws for an alias-spelled duplicate", () => {
      const twice: PiecePlan = {
        header,
        rows: [surveyRow("fid1:aaY", "x"), surveyRow("of:fid1:aaY", "x")],
      };
      const once: PiecePlan = { header, rows: [surveyRow("fid1:aaY", "x")] };
      expect(() => diffPlan(twice, once)).toThrow("more than once");
    });
  });
});
