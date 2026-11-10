import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { decodeMemoryBoundary } from "@commonfabric/memory/v2";
import {
  isCfcLabelDocumentContent,
  isCfcLabelReference,
  isInlineCfcLabelShape,
  isKnownCfcEnvelopeVersion,
  isLabelMetadataTemplateEntry,
  isReadableStoredCfcEnvelope,
  isWellFormedLabelMetadataTemplateEntry,
  LABEL_METADATA_TEMPLATE_ORIGIN,
  storedCfcEnvelopeDefect,
} from "@commonfabric/memory/v2/cfc-stored-envelope";

const secret = { confidentiality: ["secret"] };

/**
 * The value a writer's text `{"x":<wire>}` decodes to at `x`, as the store
 * decodes a commit.
 */
const decoded = (wire: string): unknown =>
  (decodeMemoryBoundary(`fvj1:{"x":${wire}}`) as { x: unknown }).x;

const envelope = (entries: unknown[], version: unknown = 2) => ({
  version,
  schemaHash: "hash",
  labelMap: { version: 1, entries },
});

describe("cfc-stored-envelope", () => {
  describe("isKnownCfcEnvelopeVersion()", () => {
    it("returns `true` for versions 1 and 2", () => {
      expect(isKnownCfcEnvelopeVersion(1)).toBe(true);
      expect(isKnownCfcEnvelopeVersion(2)).toBe(true);
    });

    it("returns `false` for any other version", () => {
      expect(isKnownCfcEnvelopeVersion(3)).toBe(false);
      expect(isKnownCfcEnvelopeVersion("1")).toBe(false);
      expect(isKnownCfcEnvelopeVersion(undefined)).toBe(false);
    });
  });

  describe("isCfcLabelReference()", () => {
    it("returns `true` for a record holding a string `$ref` alone", () => {
      expect(isCfcLabelReference({ $ref: "cid:abc" })).toBe(true);
    });

    it("returns `false` for a `$ref` beside another member, or not a string", () => {
      expect(isCfcLabelReference({ $ref: "cid:abc", extra: 1 })).toBe(false);
      expect(isCfcLabelReference({ $ref: 1 })).toBe(false);
      expect(isCfcLabelReference([{ $ref: "cid:abc" }])).toBe(false);
      expect(isCfcLabelReference(secret)).toBe(false);
    });
  });

  describe("isInlineCfcLabelShape()", () => {
    it("returns `true` for `confidentiality` and `integrity` holding arrays or `undefined`", () => {
      expect(isInlineCfcLabelShape({})).toBe(true);
      expect(isInlineCfcLabelShape(secret)).toBe(true);
      expect(
        isInlineCfcLabelShape({ confidentiality: [], integrity: undefined }),
      ).toBe(true);
    });

    it("returns `false` for a third member, a member not an array, or no record", () => {
      expect(isInlineCfcLabelShape({ ...secret, sealed: true })).toBe(false);
      expect(isInlineCfcLabelShape({ confidentiality: "secret" })).toBe(false);
      expect(isInlineCfcLabelShape({ integrity: {} })).toBe(false);
      expect(isInlineCfcLabelShape([secret])).toBe(false);
      expect(isInlineCfcLabelShape("secret")).toBe(false);
    });

    it("returns `false` for a class instance a stored value decodes to", () => {
      // Each of these keeps its state in private fields and shows no own
      // enumerable members, so a check of members alone passes it.

      for (
        const wire of [
          '{"/Bytes@1":""}',
          '{"/Bytes@1":"AQID"}',
          '{"/EpochNsec@1":"AA"}',
          '{"/RegExp@1":{"flags":"","flavor":"es2025","source":"x"}}',
        ]
      ) {
        const label = decoded(wire);
        expect(Object.keys(label as object)).toEqual([]);
        expect(isInlineCfcLabelShape(label)).toBe(false);
      }
    });

    it("returns `true` for a label with no prototype", () => {
      const label = Object.assign(Object.create(null), secret);

      expect(isInlineCfcLabelShape(label)).toBe(true);
    });
  });

  describe("isCfcLabelDocumentContent()", () => {
    it("returns `true` for `confidentiality` and `integrity` holding arrays", () => {
      expect(isCfcLabelDocumentContent({})).toBe(true);
      expect(
        isCfcLabelDocumentContent({ confidentiality: ["s"], integrity: [] }),
      ).toBe(true);
    });

    it("returns `false` for an `undefined` member, which a document never stores", () => {
      expect(isCfcLabelDocumentContent({ ...secret, integrity: undefined }))
        .toBe(false);
    });

    it("returns `false` for a third member, a member not an array, or no plain object", () => {
      expect(isCfcLabelDocumentContent({ ...secret, sealed: true })).toBe(
        false,
      );
      expect(isCfcLabelDocumentContent({ confidentiality: "s" })).toBe(false);
      expect(isCfcLabelDocumentContent([secret])).toBe(false);
      expect(isCfcLabelDocumentContent(decoded('{"/Bytes@1":"AQID"}'))).toBe(
        false,
      );
    });
  });

  describe("isLabelMetadataTemplateEntry()", () => {
    it("returns `true` for an entry of the template origin only", () => {
      expect(
        isLabelMetadataTemplateEntry({
          origin: LABEL_METADATA_TEMPLATE_ORIGIN,
        }),
      ).toBe(true);
      expect(isLabelMetadataTemplateEntry({ origin: "derived" })).toBe(false);
      expect(isLabelMetadataTemplateEntry({})).toBe(false);
    });
  });

  describe("isWellFormedLabelMetadataTemplateEntry()", () => {
    it("returns `true` for an entry under `cfc/labels` of the `labelMetadata` class", () => {
      expect(
        isWellFormedLabelMetadataTemplateEntry({
          path: ["cfc", "labels", "value", "*"],
          observes: "labelMetadata",
        }),
      ).toBe(true);
    });

    it("returns `false` for an entry keyed elsewhere or of another class", () => {
      expect(
        isWellFormedLabelMetadataTemplateEntry({
          path: ["body"],
          observes: "labelMetadata",
        }),
      ).toBe(false);
      expect(
        isWellFormedLabelMetadataTemplateEntry({
          path: ["cfc", "other"],
          observes: "labelMetadata",
        }),
      ).toBe(false);
      expect(
        isWellFormedLabelMetadataTemplateEntry({
          path: ["cfc", "labels"],
          observes: "value",
        }),
      ).toBe(false);
      expect(
        isWellFormedLabelMetadataTemplateEntry({ path: ["cfc", "labels"] }),
      ).toBe(false);
    });
  });

  describe("storedCfcEnvelopeDefect()", () => {
    it("returns `undefined` for a readable envelope of either version", () => {
      expect(
        storedCfcEnvelopeDefect(
          envelope([{ path: ["body"], label: secret }], 1),
        ),
      ).toBeUndefined();
      expect(
        storedCfcEnvelopeDefect(envelope([
          { path: ["body"], label: secret },
          { path: ["title"], label: { $ref: "cid:abc" } },
        ])),
      ).toBeUndefined();
      expect(storedCfcEnvelopeDefect(envelope([]))).toBeUndefined();
    });

    it("returns `undefined` for an envelope or entry holding members it does not define", () => {
      expect(
        storedCfcEnvelopeDefect({
          ...envelope([{
            path: ["body"],
            label: secret,
            origin: "derived",
            observes: "value",
            refinement: true,
          }]),
          stampPlacement: "committed",
          legacy: {},
        }),
      ).toBeUndefined();
    });

    it("returns `undefined` for a template keyed and classed as one", () => {
      expect(
        storedCfcEnvelopeDefect(envelope([{
          path: ["cfc", "labels", "value", "body"],
          origin: LABEL_METADATA_TEMPLATE_ORIGIN,
          observes: "labelMetadata",
          label: secret,
        }])),
      ).toBeUndefined();
    });

    it("returns `record` for a value that is not a record", () => {
      expect(storedCfcEnvelopeDefect([envelope([])])).toBe("record");
      expect(storedCfcEnvelopeDefect(null)).toBe("record");
      expect(storedCfcEnvelopeDefect("envelope")).toBe("record");
    });

    it("returns `version` for an unknown or absent version", () => {
      expect(storedCfcEnvelopeDefect(envelope([], 3))).toBe("version");
      expect(
        storedCfcEnvelopeDefect({
          schemaHash: "hash",
          labelMap: { version: 1, entries: [] },
        }),
      ).toBe("version");
    });

    it("returns `schema` for an envelope naming no schema", () => {
      expect(
        storedCfcEnvelopeDefect({
          version: 1,
          labelMap: { version: 1, entries: [] },
        }),
      ).toBe("schema");
      expect(
        storedCfcEnvelopeDefect({ ...envelope([]), schemaHash: 1 }),
      ).toBe("schema");
    });

    it("returns `label-map` for a label map of another version, with no entries, or absent", () => {
      expect(
        storedCfcEnvelopeDefect({
          ...envelope([]),
          labelMap: { version: 2, entries: [] },
        }),
      ).toBe("label-map");
      expect(
        storedCfcEnvelopeDefect({ ...envelope([]), labelMap: { version: 1 } }),
      ).toBe("label-map");
      expect(
        storedCfcEnvelopeDefect({ version: 1, schemaHash: "hash" }),
      ).toBe("label-map");
    });

    it("returns `entry-path` for an entry that is no record, or has no path of strings", () => {
      expect(storedCfcEnvelopeDefect(envelope(["secret"]))).toBe("entry-path");
      expect(
        storedCfcEnvelopeDefect(envelope([{ path: "body", label: secret }])),
      ).toBe("entry-path");
      expect(
        storedCfcEnvelopeDefect(
          envelope([{ path: ["body", 1], label: secret }]),
        ),
      ).toBe("entry-path");
    });

    it("returns `entry-label` for a label neither inline nor a reference", () => {
      expect(
        storedCfcEnvelopeDefect(
          envelope([{ path: ["body"], label: "secret" }]),
        ),
      ).toBe("entry-label");
      expect(
        storedCfcEnvelopeDefect(envelope([{ path: ["body"] }])),
      ).toBe("entry-label");
      expect(
        storedCfcEnvelopeDefect(envelope([{
          path: ["body"],
          label: { ...secret, sealed: true },
        }])),
      ).toBe("entry-label");
      expect(
        storedCfcEnvelopeDefect(envelope([{
          path: ["body"],
          label: decoded('{"/Bytes@1":"AQID"}'),
        }])),
      ).toBe("entry-label");
    });

    it("returns `version-1-reference` for a reference in a version-1 envelope", () => {
      expect(
        storedCfcEnvelopeDefect(
          envelope([{ path: ["body"], label: { $ref: "cid:abc" } }], 1),
        ),
      ).toBe("version-1-reference");
    });

    it("returns `template-keying` for a template keyed or classed as a payload label", () => {
      expect(
        storedCfcEnvelopeDefect(envelope([{
          path: ["body"],
          origin: LABEL_METADATA_TEMPLATE_ORIGIN,
          observes: "labelMetadata",
          label: secret,
        }])),
      ).toBe("template-keying");
      expect(
        storedCfcEnvelopeDefect(envelope([{
          path: ["cfc", "labels", "value", "body"],
          origin: LABEL_METADATA_TEMPLATE_ORIGIN,
          observes: "value",
          label: secret,
        }])),
      ).toBe("template-keying");
    });

    it("returns the defect of the first defective entry, checking each entry's path before its label", () => {
      expect(
        storedCfcEnvelopeDefect(envelope([
          { path: ["body"], label: secret },
          { path: ["title"], label: "secret" },
          { path: "note", label: secret },
        ])),
      ).toBe("entry-label");
      expect(
        storedCfcEnvelopeDefect(envelope([{ path: "body", label: "secret" }])),
      ).toBe("entry-path");
    });

    it("returns the envelope's defect before any entry's", () => {
      expect(storedCfcEnvelopeDefect(envelope(["secret"], 3))).toBe(
        "version",
      );
    });
  });

  describe("isReadableStoredCfcEnvelope()", () => {
    it("returns `true` for an envelope with no defect", () => {
      expect(
        isReadableStoredCfcEnvelope(envelope([{ path: [], label: secret }])),
      ).toBe(true);
    });

    it("returns `false` for an envelope with a defect", () => {
      expect(
        isReadableStoredCfcEnvelope(
          envelope([{ path: [], label: { $ref: "cid:abc" } }], 1),
        ),
      ).toBe(false);
      expect(isReadableStoredCfcEnvelope(undefined)).toBe(false);
    });
  });
});
