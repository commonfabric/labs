import { expect } from "@std/expect";
import {
  resolveStoredLabel,
  storedConfidentiality,
  storedLabelMapEntries,
} from "../v2/cfc-stored-label-map.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("cfc-stored-label-map", () => {
  describe("storedLabelMapEntries()", () => {
    it("returns each record entry's four members, and no entry that is not a record", () => {
      const cfc = {
        labelMap: {
          entries: [
            {
              path: ["a"],
              origin: "derived",
              observes: "value",
              label: { confidentiality: ["secret"] },
              extra: true,
            },
            "entry",
            ["entry"],
          ],
        },
      };
      expect(storedLabelMapEntries(cfc)).toEqual([{
        path: ["a"],
        origin: "derived",
        observes: "value",
        label: { confidentiality: ["secret"] },
      }]);
    });

    it("returns no entry for a member holding no label map", () => {
      for (
        const cfc of [
          undefined,
          [],
          {},
          { labelMap: [] },
          { labelMap: { entries: {} } },
        ]
      ) expect(storedLabelMapEntries(cfc)).toEqual([]);
    });
  });

  describe("resolveStoredLabel()", () => {
    const resolve = (ref: string) =>
      ref === "cid:held" ? { confidentiality: ["held"] } : undefined;

    it("returns the document a `cid:` reference names, or `undefined` where none is held", () => {
      expect(resolveStoredLabel({ $ref: "cid:held" }, resolve)).toEqual({
        confidentiality: ["held"],
      });
      expect(resolveStoredLabel({ $ref: "cid:missing" }, resolve))
        .toBeUndefined();
    });

    it("returns `undefined` for a reference to anything but a `cid:` document", () => {
      expect(resolveStoredLabel({ $ref: "of:held" }, resolve)).toBeUndefined();
    });

    it("returns a label that is not a single-member reference as it is", () => {
      const inline = { confidentiality: ["inline"] };
      const extended = { $ref: "cid:held", confidentiality: ["inline"] };
      expect(resolveStoredLabel(inline, resolve)).toBe(inline);
      expect(resolveStoredLabel(extended, resolve)).toBe(extended);
    });
  });

  describe("storedConfidentiality()", () => {
    it("returns the clauses a label's `confidentiality` lists", () => {
      expect(storedConfidentiality({ confidentiality: ["a", "b"] })).toEqual([
        "a",
        "b",
      ]);
    });

    it("returns no clause for a label holding no `confidentiality`", () => {
      expect(storedConfidentiality({ integrity: ["x"] })).toEqual([]);
    });

    it("returns `undefined` for a label that is not a record", () => {
      for (const label of [undefined, null, "secret", ["secret"]]) {
        expect(storedConfidentiality(label)).toBeUndefined();
      }
    });

    it("returns `undefined` for a label whose `confidentiality` is not a list", () => {
      expect(storedConfidentiality({ confidentiality: "secret" }))
        .toBeUndefined();
    });
  });
});
