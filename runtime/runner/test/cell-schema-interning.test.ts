// Cell schema interning tests: schemas attached to cell links via
// runtime.getCell / cell.asSchema / runtime.getImmutableCell are interned —
// deep-frozen and collapsed to one canonical instance per structure — so the
// identity-keyed schema caches downstream (cfc.schemaAtPath, schema-ref
// memos, selector standardization, value-hash) hit instead of staying cold
// for mutable schema literals.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { isDeepFrozen } from "@commonfabric/data-model";
import { isInternedSchema } from "@commonfabric/data-model-schema";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// A fresh mutable copy per call: structurally equal, never the same object.
const makeSchema = () =>
  ({
    type: "object",
    properties: { title: { type: "string" }, count: { type: "number" } },
  }) as JSONSchema;

describe("cell link schema interning", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("getCell interns the schema onto the link", () => {
    const a = runtime.getCell(space, "intern-a", makeSchema(), tx);
    const b = runtime.getCell(space, "intern-b", makeSchema(), tx);

    const schemaA = a.getAsNormalizedFullLink().schema;
    const schemaB = b.getAsNormalizedFullLink().schema;
    expect(isInternedSchema(schemaA!)).toBe(true);
    expect(isDeepFrozen(schemaA)).toBe(true);
    // Structurally-equal literals collapse to one canonical instance.
    expect(schemaA).toBe(schemaB);
  });

  it("asSchema interns the schema onto the sibling link", () => {
    const cell = runtime.getCell(space, "intern-as-schema", undefined, tx);
    const sibling = cell.asSchema(makeSchema());
    const viaGetCell = runtime.getCell(space, "intern-c", makeSchema(), tx);

    const schema = sibling.getAsNormalizedFullLink().schema;
    expect(isInternedSchema(schema!)).toBe(true);
    // Canonical across the asSchema and getCell seams.
    expect(schema).toBe(viaGetCell.getAsNormalizedFullLink().schema);
  });

  it("getCellFromLink interns a schema already embedded in the link", () => {
    // Sigil/normalized links can carry schemas through parseLink; without an
    // explicit schema argument the embedded one must be interned too, or
    // schema-bearing links bypass the seam (review finding on #3982).
    const base = runtime.getCell(space, "intern-link-embed", undefined, tx);
    const link = { ...base.getAsNormalizedFullLink(), schema: makeSchema() };

    const cell = runtime.getCellFromLink(link, undefined, tx);

    const schema = cell.getAsNormalizedFullLink().schema;
    expect(isInternedSchema(schema!)).toBe(true);
    // Explicit parameter still takes precedence over the embedded schema.
    const override = { type: "object" } as JSONSchema;
    const cellWithOverride = runtime.getCellFromLink(
      { ...base.getAsNormalizedFullLink(), schema: makeSchema() },
      override,
      tx,
    );
    const overrideSchema = cellWithOverride.getAsNormalizedFullLink().schema;
    expect(isInternedSchema(overrideSchema!)).toBe(true);
    expect(overrideSchema).not.toBe(schema);
  });

  it("getImmutableCell interns the schema onto the link", () => {
    const cell = runtime.getImmutableCell(space, { title: "x" }, makeSchema());
    expect(isInternedSchema(cell.getAsNormalizedFullLink().schema!)).toBe(true);
  });

  it("asSchema does not freeze through a query-result proxy schema", () => {
    // A schema stored as a cell VALUE and read back via .get() is a
    // query-result proxy. Freezing it in place would freeze the underlying
    // stored value and violate the proxy's object invariants (this is the
    // wish builtin's schema-argument shape; see pattern-scope.test.ts "wish
    // result schema scope overrides query-derived scope").
    const holder = runtime.getCell<{ schema: unknown }>(
      space,
      "intern-proxy-holder",
      undefined,
      tx,
    );
    holder.set({ schema: makeSchema() });
    const proxySchema = holder.key("schema").get();

    const target = runtime.getCell(space, "intern-proxy-target", undefined, tx);
    const sibling = target.asSchema(proxySchema as JSONSchema);

    const linkSchema = sibling.getAsNormalizedFullLink().schema;
    expect(isInternedSchema(linkSchema!)).toBe(true);
    expect(linkSchema).not.toBe(proxySchema);
    // The proxy must remain stringifiable (its target stays extensible).
    expect(() => JSON.stringify(proxySchema)).not.toThrow();
    expect(JSON.parse(JSON.stringify(proxySchema))).toEqual(makeSchema());
  });
});
