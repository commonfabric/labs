import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  FabricBytes,
  FabricHash,
} from "@commonfabric/data-model/fabric-primitives";
import { wildcardPolicyMatchesValue } from "../src/cfc/prepare.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

describe("CFC wildcard policy applicability on unresolvable links", () => {
  // Regression guard for wildcard policy applicability on unresolvable links
  // (audit S17).
  //
  // When a written value is a link whose target value cannot be resolved, the
  // policy's value condition cannot be evaluated against real data. The pre-fix
  // code fell back to comparing the policy schema against the link's
  // author-embedded schema, so an attacker could embed a mismatching schema to
  // make the policy entry "not apply" and skip its writeAuthorizedBy /
  // requiredIntegrity / uiContract checks. Unresolvable links must fail closed:
  // the entry applies.
  //
  // Driving through a full write is impractical because the Cell write path
  // collapses an unresolvable link before it reaches the verifier, so the link
  // only reaches this matcher when verifying a pre-existing stored link whose
  // target is not present in the transaction. This exercises that branch
  // directly.

  const space = "did:key:wildcard-link" as const;
  const policySchema = {
    type: "object",
    ifc: { writeAuthorizedBy: ["trusted-handler"] },
  } as const satisfies JSONSchema;
  const target = { space, id: "of:guarded" as const, scope: "space" as const };

  // A link whose embedded schema (string) deliberately mismatches the object
  // policy schema, pointing at a target the transaction cannot resolve.
  const linkValue = {
    "/": {
      [LINK_V1_TAG]: {
        id: "of:unresolvable-target",
        path: [] as string[],
        space,
        scope: "space",
        schema: { type: "string" },
      },
    },
  };

  it("applies (fail-closed) when the linked target cannot be resolved", () => {
    const tx = {
      getWriteDetails: () => [],
      readValueOrThrow: () => undefined,
    } as unknown as IExtendedStorageTransaction;

    expect(wildcardPolicyMatchesValue(tx, target, policySchema, linkValue))
      .toBe(true);
  });

  it("still value-conditions when the linked target resolves to a non-matching value", () => {
    // The link resolves to a string; the policy schema requires an object, so
    // the entry legitimately does not apply (the value-condition is real data,
    // not an author-controlled schema).
    const tx = {
      getWriteDetails: () => [
        {
          address: {
            id: "of:unresolvable-target",
            scope: "space",
            path: ["value"],
          },
          value: "a string, not an object",
        },
      ],
      readValueOrThrow: () => undefined,
    } as unknown as IExtendedStorageTransaction;

    expect(wildcardPolicyMatchesValue(tx, target, policySchema, linkValue))
      .toBe(false);
  });
});

describe("CFC wildcard policy applicability on links below the policy's path", () => {
  // A pattern result holds each field as a redirect link to the cell that
  // stores it. A policy whose condition names those fields' types must still
  // apply to such a value: a link says nothing about what it leads to.
  const space = "did:key:nested-link" as const;
  const target = { space, id: "of:guarded" as const, scope: "space" as const };
  // Every cell a nested link below leads to resolves, in this transaction, to
  // a number: a value no condition here accepts. A matcher that followed a
  // nested link would read it and exclude the entry; the counts show the
  // matcher consults neither the transaction's writes nor its reads.
  let lookups = 0;
  let reads = 0;
  const tx = {
    getWriteDetails: () => {
      lookups++;
      return [
        "of:name-cell",
        "of:avatar-cell",
        "of:kind-cell",
        "of:mode-cell",
        "of:field-cell",
      ].map((id) => ({
        address: { id, scope: "space", path: ["value"] },
        value: 42,
      }));
    },
    readValueOrThrow: () => {
      reads++;
      return 42;
    },
  } as unknown as IExtendedStorageTransaction;
  afterEach(() => {
    expect(lookups).toBe(0);
    expect(reads).toBe(0);
    lookups = 0;
    reads = 0;
  });
  const link = (id: string) => ({
    "/": {
      [LINK_V1_TAG]: {
        id,
        path: [] as string[],
        space,
        scope: "space",
        overwrite: "redirect",
      },
    },
  });
  const profileCondition = {
    type: "object",
    properties: { name: { type: "string" }, avatar: { type: "string" } },
    ifc: { writeAuthorizedBy: ["trusted-handler"] },
  } as const satisfies JSONSchema;

  it("applies when a field the condition types as a string holds a link", () => {
    expect(
      wildcardPolicyMatchesValue(tx, target, profileCondition, {
        name: link("of:name-cell"),
        avatar: link("of:avatar-cell"),
      }),
    ).toBe(true);
  });

  it("applies when a link stands where a `const` or `enum` is required", () => {
    const schema = {
      type: "object",
      properties: {
        kind: { const: "url" },
        mode: { enum: ["a", "b"] },
      },
    } as const satisfies JSONSchema;
    expect(
      wildcardPolicyMatchesValue(tx, target, schema, {
        kind: link("of:kind-cell"),
        mode: link("of:mode-cell"),
      }),
    ).toBe(true);
  });

  it("still does not apply when a plain field contradicts the condition beside a link", () => {
    const schema = {
      type: "object",
      properties: { kind: { const: "url" }, name: { type: "string" } },
    } as const satisfies JSONSchema;
    expect(
      wildcardPolicyMatchesValue(tx, target, schema, {
        kind: "piece",
        name: link("of:name-cell"),
      }),
    ).toBe(false);
  });

  it("applies a `oneOf` whose branches a nested link matches more than one of", () => {
    // Each branch conditions the same field differently, and the value holds a
    // link there, which matches both. Requiring exactly one branch would
    // exclude the entry.
    const schema = {
      oneOf: [
        { type: "object", properties: { field: { type: "string" } } },
        { type: "object", properties: { field: { type: "number" } } },
      ],
    } as const satisfies JSONSchema;
    expect(
      wildcardPolicyMatchesValue(tx, target, schema, {
        field: link("of:field-cell"),
      }),
    ).toBe(true);
  });

  it("applies a `oneOf` that plain values match in more than one branch", () => {
    const schema = {
      oneOf: [{ type: "number" }, { type: "integer" }],
    } as const satisfies JSONSchema;
    expect(wildcardPolicyMatchesValue(tx, target, schema, 3)).toBe(true);
    expect(wildcardPolicyMatchesValue(tx, target, schema, "3")).toBe(false);
  });
});

describe("CFC wildcard policy value conditions on `FabricPrimitive` types", () => {
  const space = "did:key:wildcard-fabric" as const;
  const target = {
    space,
    id: "of:guarded-bytes" as const,
    scope: "space" as const,
  };
  const tx = {
    getWriteDetails: () => [],
    readValueOrThrow: () => undefined,
  } as unknown as IExtendedStorageTransaction;
  const bytesCondition = { type: "FabricBytes" } as const satisfies JSONSchema;

  it("applies to a value of the named `FabricPrimitive` class", () => {
    expect(
      wildcardPolicyMatchesValue(
        tx,
        target,
        bytesCondition,
        new FabricBytes(new Uint8Array([1])),
      ),
    ).toBe(true);
  });

  it("does not apply to other values, including other `FabricPrimitive`s", () => {
    expect(wildcardPolicyMatchesValue(tx, target, bytesCondition, { a: 1 }))
      .toBe(false);
    expect(
      wildcardPolicyMatchesValue(
        tx,
        target,
        bytesCondition,
        new FabricHash(new Uint8Array(32), "fid1"),
      ),
    ).toBe(false);
    expect(wildcardPolicyMatchesValue(tx, target, bytesCondition, "text"))
      .toBe(false);
  });

  it("stays conservative on a type name outside the vocabulary", () => {
    // The matcher's unknown-type fallthrough returns "applies" so a policy
    // with a type this build does not know cannot be dodged.
    const unknownCondition = {
      type: "SomeFutureType",
    } as unknown as JSONSchema;
    expect(wildcardPolicyMatchesValue(tx, target, unknownCondition, { a: 1 }))
      .toBe(true);
  });
});

describe("CFC policy value-conditions on tuple (prefixItems) schemas", () => {
  // `policySchemaMatchesValue` validates an array against `prefixItems` as
  // well as `items`, so a tuple-shaped value condition matches only the arrays
  // its slots admit, and the policy entry applies exactly where its condition
  // says it does.

  const space = "did:key:tuple-policy" as const;
  const target = { space, id: "of:guarded" as const, scope: "space" as const };
  const tx = {
    getWriteDetails: () => [],
    readValueOrThrow: () => undefined,
  } as unknown as IExtendedStorageTransaction;

  it("conditions each tuple slot instead of vacuously matching", () => {
    const schema = {
      type: "array",
      prefixItems: [{ const: "transfer" }, { type: "number" }],
    } as const satisfies JSONSchema;

    expect(wildcardPolicyMatchesValue(tx, target, schema, ["transfer", 5]))
      .toBe(true);
    expect(wildcardPolicyMatchesValue(tx, target, schema, ["burn", 5]))
      .toBe(false);
    expect(wildcardPolicyMatchesValue(tx, target, schema, ["transfer", "x"]))
      .toBe(false);
  });

  it("a closed tuple (items: false) rejects extra elements", () => {
    // The shared matcher honors a boolean `items`: a closed tuple matches no
    // array with extra elements, so the policy entry does not apply to a
    // value shape its condition excludes.
    const schema = {
      type: "array",
      prefixItems: [{ const: "cmd" }],
      items: false,
    } as const satisfies JSONSchema;

    expect(wildcardPolicyMatchesValue(tx, target, schema, ["cmd"]))
      .toBe(true);
    expect(wildcardPolicyMatchesValue(tx, target, schema, ["cmd", "extra"]))
      .toBe(false);
  });

  it("conditions items only past the tuple slots", () => {
    const schema = {
      type: "array",
      prefixItems: [{ const: "cmd" }],
      items: { type: "number" },
    } as const satisfies JSONSchema;

    // Slot 0 is a string the `items` schema would reject — it must only
    // condition the elements past the tuple arity.
    expect(wildcardPolicyMatchesValue(tx, target, schema, ["cmd", 1, 2]))
      .toBe(true);
    expect(wildcardPolicyMatchesValue(tx, target, schema, ["cmd", 1, "x"]))
      .toBe(false);
  });
});
