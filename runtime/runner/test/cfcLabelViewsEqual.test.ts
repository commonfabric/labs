import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { CfcConfClause } from "../src/cfc/clause.ts";
import {
  type CfcLabelView,
  cfcLabelViewsEqual,
} from "../src/cfc/label-view-core.ts";

const USER_TYPE = "https://commonfabric.org/cfc/atom/User";

const viewWith = (
  confidentiality: readonly CfcConfClause[],
): CfcLabelView => ({
  version: 1,
  entries: [{
    path: ["body"],
    label: { confidentiality: [...confidentiality] },
  }],
});

describe("cfcLabelViewsEqual()", () => {
  it("returns `true` for one atom written with its properties in either order", () => {
    // Atoms are plain objects built at many call sites, and a mint that
    // spreads its optional fields ahead of `type` writes the same atom in a
    // different property order from one that writes `type` first. Both
    // spellings name one principal, which is the reading `uniqueCfcAtoms`
    // gives them when the merge path dedupes.

    const left = viewWith([{ type: USER_TYPE, subject: "did:key:z6Mk" }]);
    const right = viewWith([{ subject: "did:key:z6Mk", type: USER_TYPE }]);
    expect(cfcLabelViewsEqual(left, right)).toBe(true);
  });

  it("returns `true` for one atom nested inside an OR-clause in either property order", () => {
    const left = viewWith([{
      anyOf: [{ type: USER_TYPE, subject: "A" }],
    }]);
    const right = viewWith([{
      anyOf: [{ subject: "A", type: USER_TYPE }],
    }]);
    expect(cfcLabelViewsEqual(left, right)).toBe(true);
  });

  it("returns `false` for atoms that differ in a property value", () => {
    const left = viewWith([{ type: USER_TYPE, subject: "A" }]);
    const right = viewWith([{ subject: "B", type: USER_TYPE }]);
    expect(cfcLabelViewsEqual(left, right)).toBe(false);
  });

  it("returns `false` for atoms that differ in which properties they carry", () => {
    const left = viewWith([{ type: USER_TYPE, subject: "A" }]);
    const right = viewWith([{ type: USER_TYPE, subject: "A", scope: "s" }]);
    expect(cfcLabelViewsEqual(left, right)).toBe(false);
  });

  it("returns `false` for the same clauses listed in a different order", () => {
    // The clause list is a conjunction whose order canonicalization leaves
    // alone (`canonicalizeCfcLabel`), so two orderings are two forms and the
    // persist-side idempotence check in `prepare.ts` separates them too.

    const a = { type: USER_TYPE, subject: "A" };
    const b = { type: USER_TYPE, subject: "B" };
    expect(cfcLabelViewsEqual(viewWith([a, b]), viewWith([b, a]))).toBe(false);
  });

  it("returns `true` for the same entries listed in a different order", () => {
    const entryA = {
      path: ["a"],
      label: { confidentiality: [{ type: USER_TYPE, subject: "A" }] },
    };
    const entryB = {
      path: ["b"],
      label: { integrity: [{ type: USER_TYPE, subject: "B" }] },
    };
    expect(cfcLabelViewsEqual(
      { version: 1, entries: [entryA, entryB] },
      { version: 1, entries: [entryB, entryA] },
    )).toBe(true);
  });

  it("returns `false` for paths that differ only by a leading `value` segment", () => {
    // A view's paths are logical, so `["value","body"]` names the `body` of a
    // payload field called `value`, not the top-level `body`.

    expect(cfcLabelViewsEqual(
      {
        version: 1,
        entries: [{ path: ["value", "body"], label: { integrity: ["t"] } }],
      },
      {
        version: 1,
        entries: [{ path: ["body"], label: { integrity: ["t"] } }],
      },
    )).toBe(false);
  });

  it("returns `true` for `undefined` and a view whose entries all canonicalize away", () => {
    expect(cfcLabelViewsEqual(undefined, { version: 1, entries: [] })).toBe(
      true,
    );
    expect(cfcLabelViewsEqual(
      { version: 1, entries: [{ path: ["body"], label: { integrity: [] } }] },
      undefined,
    )).toBe(true);
  });

  it("returns `false` for a labeled view against no view at all", () => {
    expect(cfcLabelViewsEqual(viewWith(["prompt-influenced"]), undefined))
      .toBe(false);
  });

  it("returns `false` for the same label under different observation classes", () => {
    expect(cfcLabelViewsEqual(
      {
        version: 1,
        entries: [{
          path: ["a"],
          label: { integrity: ["t"] },
          observes: "value",
        }],
      },
      {
        version: 1,
        entries: [{
          path: ["a"],
          label: { integrity: ["t"] },
          observes: "shape",
        }],
      },
    )).toBe(false);
  });
});
