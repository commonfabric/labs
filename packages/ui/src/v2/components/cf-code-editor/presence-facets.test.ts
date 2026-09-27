import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { PresenceRecord } from "@commonfabric/runtime-client";

import {
  CARET_FACET,
  caretFacetOf,
  decodeCaretFacet,
  participantFromRecord,
  presenceFailureCategory,
} from "./presence-facets.ts";

const caret = {
  focused: true,
  cursor: { epoch: 1, version: 3 },
  selection: { ranges: [{ anchor: 0, head: 2, assoc: -1 as const }], main: 0 },
  basis: "provisional" as const,
};

describe("presence-facets", () => {
  describe("decodeCaretFacet()", () => {
    it("returns what `caretFacetOf()` wrote, and refuses an extra key", () => {
      expect(decodeCaretFacet(caretFacetOf(caret))).toEqual(caret);
      expect(decodeCaretFacet({ ...caret, focused: false, selection: null }))
        .toEqual({ ...caret, focused: false, selection: null });
      expect(() => decodeCaretFacet({ ...caret, document: "no" })).toThrow(
        "caret facet",
      );
    });

    it("refuses a focused caret without a selection", () => {
      expect(() => decodeCaretFacet({ ...caret, selection: null })).toThrow(
        "caret facet",
      );
    });

    it("refuses an invalid range, association, position, or cursor", () => {
      const withRanges = (ranges: unknown[]) => ({
        ...caret,
        selection: { ranges, main: 0 },
      });
      expect(() =>
        decodeCaretFacet(withRanges([{ anchor: -1, head: 0, assoc: 0 }]))
      )
        .toThrow("range");
      expect(() => decodeCaretFacet(withRanges([{ anchor: 0, head: 0 }])))
        .toThrow("range");
      expect(() =>
        decodeCaretFacet(withRanges([{ anchor: 0, head: 0, assoc: 2 }]))
      )
        .toThrow("range");
      expect(() =>
        decodeCaretFacet(
          withRanges([{ anchor: 2_147_483_648, head: 0, assoc: 0 }]),
        )
      ).toThrow("range");
      expect(() => decodeCaretFacet(withRanges([]))).toThrow("selection");
      expect(() =>
        decodeCaretFacet({ ...caret, cursor: { epoch: 1, version: 1.5 } })
      ).toThrow("cursor");
    });
  });

  describe("participantFromRecord()", () => {
    const record: PresenceRecord = {
      participantId: "participant:1",
      principal: "did:key:z6Mk-peer",
      revision: 4,
      name: "Ada",
      facets: { [CARET_FACET]: caretFacetOf(caret), pointer: { x: 1 } },
    };

    it("returns the participant the caret facet describes", () => {
      expect(participantFromRecord(record)).toEqual({
        participantId: "participant:1",
        revision: 4,
        name: "Ada",
        ...caret,
      });
    });

    it("returns `null` for a record without a readable caret facet", () => {
      expect(
        participantFromRecord({ ...record, facets: { pointer: { x: 1 } } }),
      )
        .toBeNull();
      expect(
        participantFromRecord({
          ...record,
          facets: { [CARET_FACET]: { focused: "yes" } },
        }),
      ).toBeNull();
    });
  });

  describe("presenceFailureCategory()", () => {
    it("maps a relay refusal, an unsupported server, and anything else", () => {
      const refused = new Error("Presence name is empty");
      refused.name = "PresenceError";
      const unsupported = new Error("memory server does not support presence");
      unsupported.name = "ProtocolError";
      expect(presenceFailureCategory(refused)).toBe("protocol");
      expect(presenceFailureCategory(unsupported)).toBe("configuration");
      expect(
        presenceFailureCategory(
          new Error("runtime storage does not support presence"),
        ),
      ).toBe("configuration");
      expect(presenceFailureCategory(new Error("memory session closed"))).toBe(
        "connection",
      );
      expect(presenceFailureCategory("nope")).toBe("connection");
    });
  });
});
