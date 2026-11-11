import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import {
  anchorsEnvelopeWith,
  confidentialityOver,
} from "../v2/cfc-anchors-label.ts";
import { storedCfcEnvelopeDefect } from "../v2/cfc-stored-envelope.ts";

const entry = {
  path: ["text"],
  observes: "value",
  label: { confidentiality: ["secret"] },
};

/** A label map whose `version` and `entries` are getters of its class. */
class GetterLabelMap {
  get version(): number {
    return 1;
  }

  get entries(): unknown[] {
    return [entry];
  }
}

/** An envelope whose required members are getters of its class. */
class GetterEnvelope {
  get version(): number {
    return 1;
  }

  get schemaHash(): string {
    return "hash";
  }

  get labelMap(): GetterLabelMap {
    return new GetterLabelMap();
  }
}

// The cast is what lets the getter classes in: a `FabricValue` holds a class
// instance only if it is a branded `FabricInstance`, and none defines these
// members.
const withAnchor = (envelope: unknown): unknown =>
  anchorsEnvelopeWith(
    envelope as FabricValue,
    ["secret"],
    ["anchor-1"],
    "of:anchors",
  );

describe("cfc-anchors-label", () => {
  describe("confidentialityOver()", () => {
    it("returns no clause of a label-metadata template, for a field named `cfc`", () => {
      // A template's path is keyed against the stored document, so it shares
      // its first segment with a payload field named `cfc` without labeling
      // that field.

      const stored = {
        version: 1,
        schemaHash: "hash",
        labelMap: {
          version: 1,
          entries: [
            { path: ["cfc"], label: { confidentiality: ["field"] } },
            {
              path: ["cfc", "labels", "value", "cfc", "confidentiality"],
              origin: "label-metadata",
              observes: "labelMetadata",
              label: { confidentiality: ["template"] },
            },
          ],
        },
      };

      expect(
        confidentialityOver([stored], ["cfc"], "of:field", () => undefined),
      ).toEqual(["field"]);
    });
  });

  describe("anchorsEnvelopeWith()", () => {
    it("returns a readable envelope for one whose required members are class getters", () => {
      const stored = new GetterEnvelope();
      expect(storedCfcEnvelopeDefect(stored)).toBeUndefined();

      const result = withAnchor(stored);
      expect(storedCfcEnvelopeDefect(result)).toBeUndefined();
      expect(result).toMatchObject({ version: 1, schemaHash: "hash" });
    });

    it("returns a readable envelope for a label map whose members are class getters", () => {
      const stored = {
        version: 1,
        schemaHash: "hash",
        labelMap: new GetterLabelMap(),
      };
      expect(storedCfcEnvelopeDefect(stored)).toBeUndefined();

      const result = withAnchor(stored);
      expect(storedCfcEnvelopeDefect(result)).toBeUndefined();
      expect(result).toMatchObject({ labelMap: { version: 1 } });
    });

    it("returns an envelope keeping members it does not define", () => {
      const result = withAnchor({
        version: 1,
        schemaHash: "hash",
        legacy: true,
        labelMap: { version: 1, entries: [entry], views: [] },
      });
      expect(result).toMatchObject({
        legacy: true,
        labelMap: { views: [] },
      });
    });
  });
});
