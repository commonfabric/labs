import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { internSchema } from "@commonfabric/data-model-schema";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  ensureSchemaDocument,
  loadSchemaDocument,
  loadStoredCfcEnvelope,
} from "../src/cfc/prepare.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

// Regression guard for cid: schema-document content-address verification (S5).
//
// cid:<hash> schema documents are content-addressed but stored on an unverified
// write path any same-space writer can reach. The loaded schema drives label
// derivation for other principals' writes, so loadSchemaDocument must re-derive
// the canonical hash and reject a value that does not match its address.
const space = "did:key:cid-verify" as const;

const fakeTxReturning = (stored: JSONSchema): IExtendedStorageTransaction =>
  ({
    readOrThrow: () => ({ value: stored }),
  }) as unknown as IExtendedStorageTransaction;

describe("cid schema document verification", () => {
  it("returns the schema when its content matches the address", () => {
    const { schema, taggedHashString } = internSchema(
      { type: "object", properties: { a: { type: "string" } } } as JSONSchema,
      true,
    );
    const result = loadSchemaDocument(
      fakeTxReturning(schema),
      space,
      taggedHashString,
    );
    expect(result).toEqual(schema);
  });

  it("refuses to ensure a document whose claimed hash mismatches its content", () => {
    const { schema } = internSchema(
      { type: "object", properties: { a: { type: "string" } } } as JSONSchema,
      true,
    );
    expect(() =>
      ensureSchemaDocument(
        {} as IExtendedStorageTransaction,
        space,
        "fid1:not-the-hash-of-that-schema",
        schema as JSONSchema,
      )
    ).toThrow(/hash mismatch/);
  });

  it("throws when the stored content does not hash to the address (poisoned)", () => {
    const { taggedHashString } = internSchema(
      { type: "object", properties: { a: { type: "string" } } } as JSONSchema,
      true,
    );
    // A different schema served at the same cid: address.
    const poisoned = internSchema(
      { type: "string", ifc: { confidentiality: [] } } as JSONSchema,
      true,
    ).schema;
    expect(() =>
      loadSchemaDocument(fakeTxReturning(poisoned), space, taggedHashString)
    ).toThrow(/hash mismatch/);
  });
});

// `loadStoredCfcEnvelope` is the ONE gatherer of a document's stored CFC schema
// envelope: the commit path's merge loop and the `cf piece setsrc --check`
// preflight both call it, so its three outcomes ARE the shared failure
// taxonomy. `unreadable` in particular has to stay its own state — the commit
// records it as a rejection reason and refuses the write, so a caller that
// mistook it for "no envelope" would green-light an update the real commit
// then rejects.
const fakeTxOverDocuments = (
  documents: Record<string, unknown>,
): IExtendedStorageTransaction =>
  ({
    // Honors the read PATH like the real transaction (the stored-metadata
    // read is scoped to ["cfc"] — a path-blind stub would hand a whole
    // document to a subtree read and misreport "no metadata" as a
    // malformed envelope).
    readOrThrow: (target: { id: string; path?: readonly string[] }) => {
      let value: unknown = documents[target.id];
      for (const segment of target.path ?? []) {
        if (!isObjectOrArray(value)) return undefined;
        value = (value as Record<string, unknown>)[segment];
      }
      return value;
    },
  }) as unknown as IExtendedStorageTransaction;

const envelopeTarget = { space, id: "of:doc", scope: "space" } as const;

const metadataNaming = (schemaHash: string) => ({
  cfc: { version: 1, schemaHash, labelMap: { version: 1, entries: [] } },
});

describe("stored CFC envelope gathering", () => {
  it("reports a document with no stored metadata as none", () => {
    expect(
      loadStoredCfcEnvelope(
        fakeTxOverDocuments({ "of:doc": { value: 1 } }),
        envelopeTarget,
      ),
    ).toEqual({ status: "none" });
  });

  it("loads and verifies the envelope the metadata names", () => {
    const { schema, taggedHashString } = internSchema(
      { type: "object", properties: { a: { type: "string" } } } as JSONSchema,
      true,
    );
    const result = loadStoredCfcEnvelope(
      fakeTxOverDocuments({
        "of:doc": metadataNaming(taggedHashString),
        [`cid:${taggedHashString}`]: { value: schema },
      }),
      envelopeTarget,
    );

    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect(result.schema).toEqual(schema);
      // The metadata rides along for the commit path, which also needs the
      // stored label map.
      expect(result.metadata.schemaHash).toBe(taggedHashString);
    }
  });

  it("reports a missing envelope document as unreadable, not as none", () => {
    const result = loadStoredCfcEnvelope(
      fakeTxOverDocuments({ "of:doc": metadataNaming("missing-hash") }),
      envelopeTarget,
    );

    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.reason).toContain("missing or unreadable");
    }
  });

  it("reports a poisoned envelope document as unreadable", () => {
    const { taggedHashString } = internSchema(
      { type: "object", properties: { a: { type: "string" } } } as JSONSchema,
      true,
    );
    const poisoned = internSchema(
      { type: "string", ifc: { confidentiality: [] } } as JSONSchema,
      true,
    ).schema;
    const result = loadStoredCfcEnvelope(
      fakeTxOverDocuments({
        "of:doc": metadataNaming(taggedHashString),
        [`cid:${taggedHashString}`]: { value: poisoned },
      }),
      envelopeTarget,
    );

    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.reason).toContain("hash mismatch");
    }
  });

  // A root carrying `$ref: cid:` members — a decomposed write, or the
  // trail a reference-form declared schema leaves — recomposes at load,
  // every member verified against its own address.
  // One fixture per test: `loadSchemaDocument` falls back to the realm
  // registry on replica absence, and a test that loads a closure registers
  // it — a SHARED fixture would let one test's registration satisfy the
  // next test's deliberately missing document.
  const decomposedFixture = (tag: string) => {
    const child = internSchema(
      { type: "string", ifc: { confidentiality: [tag] } } as JSONSchema,
      true,
    );
    const root = internSchema(
      {
        type: "object",
        properties: { secret: { $ref: `cid:${child.taggedHashString}` } },
      } as JSONSchema,
      true,
    );
    return { child, root };
  };

  it("recomposes a reference-carrying root's closure into one inline schema", () => {
    const { child, root } = decomposedFixture("sealed-recomposed");
    const result = loadStoredCfcEnvelope(
      fakeTxOverDocuments({
        "of:doc": metadataNaming(root.taggedHashString),
        [`cid:${root.taggedHashString}`]: { value: root.schema },
        [`cid:${child.taggedHashString}`]: { value: child.schema },
      }),
      envelopeTarget,
    );

    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      const spelled = JSON.stringify(result.schema);
      // Self-contained: the definition arrived inline, no reference left.
      expect(spelled).not.toContain("cid:");
      expect(spelled).toContain('"sealed-recomposed"');
    }
  });

  it("reports an envelope whose definition document is missing as unreadable", () => {
    const { root } = decomposedFixture("sealed-missing");
    const result = loadStoredCfcEnvelope(
      fakeTxOverDocuments({
        "of:doc": metadataNaming(root.taggedHashString),
        [`cid:${root.taggedHashString}`]: { value: root.schema },
      }),
      envelopeTarget,
    );

    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.reason).toContain("missing or unreadable");
    }
  });

  it("reports an envelope whose definition document is poisoned as unreadable", () => {
    const { child, root } = decomposedFixture("sealed-poisoned");
    const poisoned = internSchema(
      { type: "number" } as JSONSchema,
      true,
    ).schema;
    const result = loadStoredCfcEnvelope(
      fakeTxOverDocuments({
        "of:doc": metadataNaming(root.taggedHashString),
        [`cid:${root.taggedHashString}`]: { value: root.schema },
        [`cid:${child.taggedHashString}`]: { value: poisoned },
      }),
      envelopeTarget,
    );

    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.reason).toContain("hash mismatch");
    }
  });

  it("propagates a transaction read failure instead of classifying it", () => {
    // An erroring TRANSACTION is the caller's operational failure, not a
    // property of the document — it must not read as any envelope state.
    const failingTx = {
      readOrThrow: () => {
        throw new Error("connection torn");
      },
    } as unknown as IExtendedStorageTransaction;
    expect(() => loadStoredCfcEnvelope(failingTx, envelopeTarget)).toThrow(
      "connection torn",
    );
  });

  it("reports metadata whose version this build postdates as unreadable", () => {
    const result = loadStoredCfcEnvelope(
      fakeTxOverDocuments({
        "of:doc": {
          cfc: {
            version: 3,
            schemaHash: "whatever-format-that-year-uses",
            labelMap: { version: 1, entries: [] },
          },
        },
      }),
      envelopeTarget,
    );

    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") {
      expect(result.reason).toContain("not one this build interprets");
    }
  });
});
