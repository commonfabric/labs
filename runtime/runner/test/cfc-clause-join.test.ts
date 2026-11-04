import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type CfcConfClause,
  clauseAlternatives,
  isOrClause,
} from "../src/cfc/clause.ts";
import { mergeCfcLabelViews, mergeLabel } from "../src/cfc/label-view-core.ts";

// Epic A3 (docs/history/plans/cfc-future-work-implementation.md): the confidentiality
// join is clause CONCATENATION with normalize-on-ingest. It upholds the
// §3.1.8 prohibitions: never merge distinct clauses, never union alternative
// sets, never dedup an atom across a singleton and an OR-clause containing it.

const A = { type: "https://commonfabric.org/cfc/atom/User", subject: "A" };
const B = { type: "https://commonfabric.org/cfc/atom/User", subject: "B" };
const C = { type: "https://commonfabric.org/cfc/atom/User", subject: "C" };

describe("CFC clause join (mergeLabel)", () => {
  it("concatenates clauses: [[A∨B]] ⊔ [C] = [[A∨B], C]", () => {
    const merged = mergeLabel(
      { confidentiality: [{ anyOf: [A, B] }] },
      { confidentiality: [C] },
    );
    const conf = merged.confidentiality!;
    expect(conf).toHaveLength(2);
    const orClause = conf.find(isOrClause);
    expect(orClause && clauseAlternatives(orClause)).toEqual([A, B]);
    expect(conf).toContainEqual(C);
  });

  it("coalesces OR-clauses that differ only in alternative order", () => {
    const merged = mergeLabel(
      { confidentiality: [{ anyOf: [A, B] }] },
      { confidentiality: [{ anyOf: [B, A] }] },
    );
    // Two equivalent clauses normalize to one entry (bloat-free), NOT to a
    // merged/unioned clause.
    expect(merged.confidentiality).toHaveLength(1);
    expect(isOrClause(merged.confidentiality![0])).toBe(true);
    expect(clauseAlternatives(merged.confidentiality![0] as CfcConfClause))
      .toHaveLength(2);
  });

  it("never merges distinct clauses or unions their alternative sets", () => {
    const merged = mergeLabel(
      { confidentiality: [{ anyOf: [A, B] }] },
      { confidentiality: [{ anyOf: [B, C] }] },
    );
    // {A∨B} and {B∨C} are DIFFERENT constraints — both survive, no {A∨B∨C}.
    expect(merged.confidentiality).toHaveLength(2);
    for (const clause of merged.confidentiality!) {
      expect(clauseAlternatives(clause as CfcConfClause)).toHaveLength(2);
    }
  });

  it("never dedups an atom across a singleton and an OR-clause containing it", () => {
    // [A] and [A∨B] are different constraints; both survive side by side.
    const merged = mergeLabel(
      { confidentiality: [A] },
      { confidentiality: [{ anyOf: [A, B] }] },
    );
    expect(merged.confidentiality).toHaveLength(2);
    expect(merged.confidentiality).toContainEqual(A);
    expect(merged.confidentiality!.some(isOrClause)).toBe(true);
  });

  it("unwraps a singleton {anyOf:[a]} to the bare atom on ingest", () => {
    const merged = mergeLabel(
      { confidentiality: [{ anyOf: [A] }] },
      { confidentiality: [A] },
    );
    // Both sides mean "readable by A" — coalesce to one bare atom.
    expect(merged.confidentiality).toEqual([A]);
  });

  it("leaves flat labels and integrity untouched", () => {
    const merged = mergeLabel(
      { confidentiality: [A], integrity: [B] },
      { confidentiality: [C], integrity: [B] },
    );
    expect(merged.confidentiality).toEqual([A, C]);
    expect(merged.integrity).toEqual([B]);
  });
});

describe("CFC clause join (mergeCfcLabelViews)", () => {
  it("coalesces order-differing OR-clauses at the same path", () => {
    const view = mergeCfcLabelViews([
      {
        version: 1,
        entries: [{
          path: ["x"],
          label: { confidentiality: [{ anyOf: [A, B] }] },
        }],
      },
      {
        version: 1,
        entries: [{
          path: ["x"],
          label: { confidentiality: [{ anyOf: [B, A] }] },
        }],
      },
    ]);
    const entry = view!.entries.find((e) => e.path.join("/") === "x")!;
    expect(entry.label.confidentiality).toHaveLength(1);
    expect(isOrClause(entry.label.confidentiality![0])).toBe(true);
  });
});
