import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { cfcLabelDocumentHash } from "../src/cfc/label-documents.ts";
import {
  interpretStoredEnvelope,
  resolveStoredCfcMetadata,
  UnresolvableCfcLabelDocumentError,
} from "../src/cfc/metadata.ts";
import { wholeValueLabel } from "../src/cfc/consumed-label.ts";
import type { CfcMetadata, LabelMapEntry } from "../src/cfc/types.ts";

/** An atom saying `subject` wrote what it labels. */
const by = (subject: string) => ({ kind: "authored-by", subject });

/** A resolved envelope holding `entries`. */
function metadata(entries: LabelMapEntry[]): CfcMetadata {
  return {
    version: 1,
    schemaHash: "h",
    labelMap: { version: 1, entries },
  };
}

describe("cfc whole value label", () => {
  describe("resolveStoredCfcMetadata()", () => {
    // A label unique to this file, so that no other test registered it.
    const label = { integrity: [by("did:key:zWholeValueReadResolver")] };
    const id = `cid:${cfcLabelDocumentHash(label)}`;
    const stored = interpretStoredEnvelope("of:doc", {
      version: 2,
      schemaHash: "h",
      labelMap: { version: 1, entries: [{ path: [], label: { $ref: id } }] },
    });
    if (stored === undefined) throw new Error("No envelope.");

    it("throws for a label document the reader does not supply and nothing registered", () => {
      expect(() => resolveStoredCfcMetadata(stored, () => undefined)).toThrow(
        UnresolvableCfcLabelDocumentError,
      );
    });

    it("throws for a label document whose content does not hash to its address", () => {
      const forged = { integrity: [by("did:key:zMallory")] };

      expect(() => resolveStoredCfcMetadata(stored, () => ({ value: forged })))
        .toThrow(UnresolvableCfcLabelDocumentError);
    });

    it("throws for a reader that fails", () => {
      expect(() =>
        resolveStoredCfcMetadata(stored, () => {
          throw new Error("offline");
        })
      ).toThrow("offline");
    });

    it("returns the label a reference names, read through the reader and verified", () => {
      const read: string[] = [];
      const resolved = resolveStoredCfcMetadata(stored, (asked) => {
        read.push(asked);
        return { value: label };
      });

      expect(read).toEqual([id]);
      expect(resolved.labelMap.entries.map((entry) => entry.label)).toEqual([
        label,
      ]);
    });
  });

  describe("wholeValueLabel()", () => {
    it("returns the label of everything read, the value's own and every label below it", () => {
      const label = wholeValueLabel(
        metadata([
          {
            path: ["note"],
            origin: "declared",
            label: { confidentiality: ["a"] },
          },
          {
            path: ["note", "secret"],
            origin: "declared",
            label: { confidentiality: ["b"] },
          },
          {
            path: ["other"],
            origin: "declared",
            label: { confidentiality: ["c"] },
          },
        ]),
        ["note"],
      );

      expect(label?.confidentiality).toEqual(["a", "b"]);
    });

    it("returns the integrity of every entry it reads", () => {
      const label = wholeValueLabel(
        metadata([{
          path: ["note"],
          origin: "declared",
          label: { integrity: [by("did:key:zAl")] },
        }]),
        ["note"],
      );

      expect(label?.integrity).toEqual([by("did:key:zAl")]);
    });

    it("returns a pointer's label only for a read of every class", () => {
      const entries = metadata([{
        path: ["note"],
        origin: "declared",
        observes: "followRef",
        label: { confidentiality: ["pointer"] },
      }]);

      expect(wholeValueLabel(entries, ["note"])?.confidentiality ?? [])
        .toEqual([]);
      expect(wholeValueLabel(entries, ["note"], "all")?.confidentiality)
        .toEqual(["pointer"]);
    });

    it("returns `undefined` for a value no entry labels", () => {
      expect(wholeValueLabel(metadata([]), ["note"])).toBeUndefined();
    });
  });
});
