import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  anchorsEnvelopeWith,
  AnchorsLabelError,
  confidentialityOver,
  integrityOver,
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
    [],
    ["anchor-1"],
    "of:anchors",
    () => undefined,
  );

/** A version-1 envelope holding `entries`. */
const anchorsEnvelope = (entries: unknown[], version = 1): FabricValue =>
  ({
    version,
    schemaHash: "hash",
    labelMap: { version: 1, entries },
  }) as FabricValue;

/** The envelope after an edit moves `end`, with the field holding `alice`. */
const movingEnd = (
  envelope: FabricValue,
  labelDocument: (hash: string) => FabricValue | undefined = () => undefined,
) =>
  anchorsEnvelopeWith(
    envelope,
    ["alice"],
    [],
    ["end"],
    "of:anchors",
    labelDocument,
  );

/** A `PolicyCertified` atom, the hereditary family, for `policy`. */
const certified = (policy: string) => ({
  type: CFC_ATOM_TYPE.PolicyCertified,
  policy,
});

/** The label-map entries of `envelope`. */
const entriesOf = (envelope: unknown) =>
  (envelope as { labelMap: { entries: unknown[] } }).labelMap.entries;

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

    it("returns no clause of a label-metadata template, for a field that is the whole value", () => {
      // The root field's path is a prefix of every path, so every entry
      // bears on it, and a template has to be left out by its origin.

      const stored = {
        version: 1,
        schemaHash: "hash",
        labelMap: {
          version: 1,
          entries: [
            { path: ["body"], label: { confidentiality: ["field"] } },
            {
              path: ["cfc", "labels", "value", "confidentiality"],
              origin: "label-metadata",
              observes: "labelMetadata",
              label: { confidentiality: ["template"] },
            },
          ],
        },
      };

      expect(
        confidentialityOver([stored], [], "of:field", () => undefined),
      ).toEqual(["field"]);
    });
  });

  describe("integrityOver()", () => {
    it("returns the atoms of the deepest entry of each component at or above the path, and none of an entry inside it", () => {
      const stored = anchorsEnvelope([
        { path: [], origin: "declared", label: { integrity: ["root"] } },
        {
          path: ["text"],
          origin: "declared",
          label: { integrity: ["field"] },
        },
        {
          path: ["*"],
          origin: "derived",
          label: { integrity: [certified("p")] },
        },
        {
          path: ["text", "0"],
          origin: "declared",
          label: { integrity: ["inside"] },
        },
        { path: ["title"], label: { integrity: ["beside"] } },
      ]);

      expect(integrityOver([stored], ["text"], "of:field", () => undefined))
        .toEqual(["field", certified("p")]);
    });

    it("returns no atom of an entry of another observation class", () => {
      const stored = anchorsEnvelope([
        { path: ["text"], observes: "shape", label: { integrity: ["shape"] } },
        { path: ["text"], observes: "value", label: { integrity: ["value"] } },
      ]);

      expect(integrityOver([stored], ["text"], "of:field", () => undefined))
        .toEqual(["value"]);
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

    it("returns one derived value entry at a moved anchor, joining the writer's confidentiality and the field's, and holding no integrity", () => {
      // The offset the engine wrote is not the one the entry's writer chose,
      // so the writer's integrity no longer speaks for it.

      const result = movingEnd(anchorsEnvelope([{
        path: ["end"],
        origin: "derived",
        observes: "value",
        label: { confidentiality: ["carol"], integrity: ["bob-wrote"] },
      }]));

      expect(entriesOf(result)).toEqual([{
        path: ["end"],
        origin: "derived",
        observes: "value",
        label: { confidentiality: ["carol", "alice"] },
      }]);
    });

    it("returns one entry at a moved anchor that held two derived value entries", () => {
      const result = movingEnd(anchorsEnvelope([
        {
          path: ["end"],
          origin: "derived",
          observes: "value",
          label: { confidentiality: ["carol"] },
        },
        {
          path: ["end"],
          origin: "derived",
          observes: "value",
          label: { confidentiality: ["dave", "alice"] },
        },
      ]));

      expect(entriesOf(result)).toEqual([{
        path: ["end"],
        origin: "derived",
        observes: "value",
        label: { confidentiality: ["carol", "dave", "alice"] },
      }]);
    });

    it("returns `undefined` for a moved anchor whose entry already holds the field's confidentiality and no integrity", () => {
      expect(movingEnd(anchorsEnvelope([{
        path: ["end"],
        origin: "derived",
        observes: "value",
        label: { confidentiality: ["alice"] },
      }]))).toBeUndefined();
    });

    it("returns a derived entry of no class at a moved anchor without its integrity, beside a new value entry", () => {
      // A read of the offset consumes an entry of no class as well, so its
      // integrity goes; its confidentiality stays, since reads of the other
      // classes consume it too.

      const result = movingEnd(anchorsEnvelope([{
        path: ["end"],
        origin: "derived",
        label: { confidentiality: ["carol"], integrity: ["bob-wrote"] },
      }]));

      expect(entriesOf(result)).toEqual([
        {
          path: ["end"],
          origin: "derived",
          label: { confidentiality: ["carol"] },
        },
        {
          path: ["end"],
          origin: "derived",
          observes: "value",
          label: { confidentiality: ["alice"] },
        },
      ]);
    });

    it("returns every entry of another component, class or anchor as it was stored", () => {
      const kept = [
        {
          path: ["end"],
          origin: "declared",
          label: { integrity: ["policy"] },
        },
        {
          path: ["end"],
          origin: "derived",
          observes: "shape",
          label: { confidentiality: ["carol"], integrity: ["bob-wrote"] },
        },
        {
          path: ["start"],
          origin: "derived",
          observes: "value",
          label: { confidentiality: ["carol"], integrity: ["bob-wrote"] },
        },
      ];

      const result = movingEnd(anchorsEnvelope(kept));

      expect(entriesOf(result)).toEqual([
        ...kept,
        {
          path: ["end"],
          origin: "derived",
          observes: "value",
          label: { confidentiality: ["alice"] },
        },
      ]);
    });

    it("returns the writer's label held by reference joined into the entry it writes", () => {
      const carols = { confidentiality: ["carol"], integrity: ["bob-wrote"] };
      const hash = taggedHashStringOf(carols);

      const result = movingEnd(
        anchorsEnvelope([{
          path: ["end"],
          origin: "derived",
          observes: "value",
          label: { $ref: `cid:${hash}` },
        }], 2),
        (wanted) => wanted === hash ? carols : undefined,
      );

      expect(entriesOf(result)).toEqual([{
        path: ["end"],
        origin: "derived",
        observes: "value",
        label: { confidentiality: ["carol", "alice"] },
      }]);
    });

    it("throws `AnchorsLabelError` for a writer's label at a moved anchor that no stored document backs", () => {
      expect(() =>
        movingEnd(anchorsEnvelope([{
          path: ["end"],
          origin: "derived",
          observes: "value",
          label: { $ref: "cid:missing" },
        }], 2))
      ).toThrow(AnchorsLabelError);
    });

    it("returns a moved anchor's entry holding the hereditary atoms its writer and the field both hold", () => {
      const result = anchorsEnvelopeWith(
        anchorsEnvelope([{
          path: ["end"],
          origin: "derived",
          observes: "value",
          label: { integrity: [certified("p"), certified("q"), "writer"] },
        }]),
        [],
        [certified("p"), "writer"],
        ["end"],
        "of:anchors",
        () => undefined,
      );

      expect(entriesOf(result)).toEqual([{
        path: ["end"],
        origin: "derived",
        observes: "value",
        label: { integrity: [certified("p")] },
      }]);
    });

    it("returns `undefined` for an envelope it cannot read where the field holds no confidentiality", () => {
      expect(anchorsEnvelopeWith(
        { version: 1, labelMap: { version: 1, entries: [] } },
        [],
        [],
        ["end"],
        "of:anchors",
        () => undefined,
      )).toBeUndefined();
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
