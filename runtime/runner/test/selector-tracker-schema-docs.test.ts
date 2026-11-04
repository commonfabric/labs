import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchemaObj } from "@commonfabric/api";
import { hashSchema, internSchema } from "@commonfabric/data-model-schema";
import { SelectorTracker } from "../src/storage/selector-tracker.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";
import {
  type DecomposedSchema,
  decomposeSchema,
} from "../src/schema-decompose.ts";

const registerAll = (decomposed: DecomposedSchema): void => {
  for (const [hash, document] of decomposed.documents) {
    registerSchemaDocument(hash, document);
  }
};

/** The standardized hash of the parent's sole anyOf item, fully resolved. */
const resolvedItemHash = (parent: JSONSchemaObj): string =>
  hashSchema(
    SelectorTracker.getStandardSchema(
      ContextualFlowControl.resolveSchemaRefs(
        parent.anyOf![0] as JSONSchemaObj,
        parent,
      )!,
    ),
  );

describe("selector-tracker-schema-docs", () => {
  it("returns `false` for a cold external ref instead of crashing, then matches after arrival", () => {
    const decomposed = decomposeSchema({
      type: "object",
      properties: { coldMatch: { $ref: "#/$defs/ColdMatchLeaf" } },
      $defs: {
        ColdMatchLeaf: { type: "string", title: "cold coverage probe" },
      },
    });
    const parent = internSchema({
      anyOf: [{ $ref: decomposed.rootRef }],
    }) as JSONSchemaObj;

    // Cold: the registry misses; the resolved-form hash simply does not
    // exist yet. Before the miss guard this threw
    // `TypeError: Invalid value used as weak map key`.
    expect(SelectorTracker.checkAnyOf(parent, "fid1:not-a-match")).toBe(
      false,
    );

    // The documents arrive; the SAME frozen parent now matches its
    // resolved form — a hash list memoized over the miss would return
    // `false` here forever.
    registerAll(decomposed);
    expect(SelectorTracker.checkAnyOf(parent, resolvedItemHash(parent)))
      .toBe(true);
  });

  it("stops matching a resolved form cached in an earlier lease epoch", () => {
    const release = acquireSchemaRegistryLease();
    const decomposed = decomposeSchema({
      type: "object",
      properties: { epochMatch: { $ref: "#/$defs/EpochMatchLeaf" } },
      $defs: {
        EpochMatchLeaf: { type: "string", title: "epoch coverage probe" },
      },
    });
    registerAll(decomposed);
    const parent = internSchema({
      anyOf: [{ $ref: decomposed.rootRef }],
    }) as JSONSchemaObj;
    const warmHash = resolvedItemHash(parent);
    expect(SelectorTracker.checkAnyOf(parent, warmHash)).toBe(true);

    release();

    // The epoch ended: the cache was swapped with the registry, so the
    // resolved form no longer matches until the documents arrive again.
    expect(SelectorTracker.checkAnyOf(parent, warmHash)).toBe(false);
    registerAll(decomposed);
    expect(SelectorTracker.checkAnyOf(parent, warmHash)).toBe(true);
  });
  it("does not resolve a union branch against its own `$defs` when the union declares none", () => {
    const definitions = { Entry: { type: "string" } } as const;
    const parent = internSchema({
      anyOf: [{ $ref: "#/$defs/Entry", $defs: definitions }],
    }) as JSONSchemaObj;
    const resolvedHash = hashSchema(SelectorTracker.getStandardSchema({
      type: "string",
      $defs: definitions,
    }));
    expect(SelectorTracker.checkAnyOf(parent, resolvedHash)).toBe(false);
  });

  it("resolves a union branch against the union's definitions, not the branch's own", () => {
    const childDefinitions = { Entry: { type: "string" } } as const;
    const parentDefinitions = { Entry: { type: "integer" } } as const;
    const parent = internSchema({
      anyOf: [{ $ref: "#/$defs/Entry", $defs: childDefinitions }],
      $defs: parentDefinitions,
    }) as JSONSchemaObj;
    const childHash = hashSchema(SelectorTracker.getStandardSchema({
      type: "string",
      $defs: childDefinitions,
    }));
    const parentHash = hashSchema(SelectorTracker.getStandardSchema({
      type: "integer",
      $defs: parentDefinitions,
    }));
    expect(SelectorTracker.checkAnyOf(parent, parentHash)).toBe(true);
    expect(SelectorTracker.checkAnyOf(parent, childHash)).toBe(false);
  });

  it("resolves a union branch that declares no `$defs` against the union's definitions", () => {
    const definitions = { Entry: { type: "string" } } as const;
    const parent = internSchema({
      anyOf: [{ $ref: "#/$defs/Entry" }],
      $defs: definitions,
    }) as JSONSchemaObj;
    const expected = hashSchema(SelectorTracker.getStandardSchema({
      type: "string",
      $defs: definitions,
    }));
    expect(SelectorTracker.checkAnyOf(parent, expected)).toBe(true);
  });
});
