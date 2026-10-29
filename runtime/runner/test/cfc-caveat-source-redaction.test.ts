import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";

import {
  type CfcLabelView,
  redactCaveatSourcesForDisplay,
} from "../src/cfc/label-view.ts";

// Audit item 28b (inv-12): the pattern-facing introspection surface
// (`getCfcLabel()` → `handleCellGetCfcLabel`) must not surface `Caveat.source`
// — the principal that introduced a caveat. `redactCaveatSourcesForDisplay` is
// the view-level redaction applied only at that display response.

const caveat = (source: string) => ({
  type: CFC_ATOM_TYPE.Caveat,
  kind: "derived-from",
  source,
});

describe("redactCaveatSourcesForDisplay (audit 28b)", () => {
  it("strips Caveat.source while keeping kind/type", () => {
    const view: CfcLabelView = {
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: [caveat("did:alice")] },
      }],
    };
    const redacted = redactCaveatSourcesForDisplay(view);
    const atom = redacted.entries[0].label.confidentiality?.[0] as Record<
      string,
      unknown
    >;
    expect(atom.type).toBe(CFC_ATOM_TYPE.Caveat);
    expect(atom.kind).toBe("derived-from");
    expect("source" in atom).toBe(false);
  });

  it("does not mutate the input view (display copy is fresh)", () => {
    const original = caveat("did:alice");
    const view: CfcLabelView = {
      version: 1,
      entries: [{ path: ["x"], label: { integrity: [original] } }],
    };
    redactCaveatSourcesForDisplay(view);
    // The source survives on the original — only the returned copy is redacted.
    expect((original as Record<string, unknown>).source).toBe("did:alice");
  });

  it("leaves non-caveat atoms untouched across both label keys", () => {
    const view: CfcLabelView = {
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["plain"], integrity: ["trusted"] },
      }],
    };
    const redacted = redactCaveatSourcesForDisplay(view);
    expect(redacted.entries[0].label.confidentiality).toEqual(["plain"]);
    expect(redacted.entries[0].label.integrity).toEqual(["trusted"]);
  });

  it("strips a Caveat.source NESTED inside another atom (recursive)", () => {
    // CFC atoms nest: a PromptSlotBound's `source` is itself a CfcAtom, here a
    // Caveat. The outer atom keeps its structure, but the nested caveat's source
    // identity must still be removed.
    const view: CfcLabelView = {
      version: 1,
      entries: [{
        path: [],
        label: {
          confidentiality: [{
            type: CFC_ATOM_TYPE.PromptSlotBound,
            role: "instruction",
            source: {
              type: CFC_ATOM_TYPE.Caveat,
              kind: "k",
              source: "did:nest",
            },
          }],
        },
      }],
    };
    const redacted = redactCaveatSourcesForDisplay(view);
    const outer = redacted.entries[0].label.confidentiality?.[0] as Record<
      string,
      unknown
    >;
    expect(outer.type).toBe(CFC_ATOM_TYPE.PromptSlotBound);
    expect(outer.role).toBe("instruction");
    const nested = outer.source as Record<string, unknown>;
    expect(nested.type).toBe(CFC_ATOM_TYPE.Caveat);
    expect(nested.kind).toBe("k");
    expect("source" in nested).toBe(false);
  });
});
