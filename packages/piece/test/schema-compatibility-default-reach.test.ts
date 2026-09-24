/**
 * Which `default` values written inside a schema are merged into a value read
 * through that schema.
 *
 * Reading a value through a destination schema merges that schema's defaults
 * into it, so `assertSchemaSubset` walks a destination for every `default` that
 * sits below a constraint merging it could break.
 * `DEFAULT_INERT_SUBSCHEMA_KEYS` says which keywords that walk stops at, and a
 * keyword is named there because no default under it is ever merged in.
 *
 * These tests boot a runtime and read a value through each such schema, so the
 * decision recorded in `packages/piece` rests on measured `packages/runner`
 * behavior rather than on an assumption about it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  extractDefaultValues,
  type IExtendedStorageTransaction,
  type JSONSchema,
  Runtime,
  snapshotQueryResult,
} from "@commonfabric/runner";
import { validateSchemaValue } from "@commonfabric/runner/cfc";
import type { JSONSchemaObj } from "@commonfabric/api";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Identity } from "@commonfabric/identity";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  assertSchemaSubset,
  DEFAULT_INERT_SUBSCHEMA_KEYS,
} from "../src/schema-compatibility.ts";

const signer = await Identity.fromPassphrase("schema compatibility reach");
const space = signer.did();

/**
 * An object schema naming a member `a` with a default beside a member `b`
 * without one. Written under a keyword a read descends, the default on `a` is
 * merged into the value.
 */
const defaultedMember: JSONSchema = {
  type: "object",
  properties: {
    b: { type: "number" },
    a: { type: "number", default: 0 },
  },
};

/**
 * One case per keyword {@link DEFAULT_INERT_SUBSCHEMA_KEYS} names. Each case
 * gives a schema carrying a default under that keyword, a value to read through
 * it, and what `validateSchemaValue` says about the pair.
 *
 * Each schema is shaped so that the default would be merged in if anything read
 * the keyword at all. `then` and `else` come with the `if` that selects them,
 * and the array keywords come with an array.
 *
 * Most cases carry {@link defaultedMember}. Two cannot. `not` describes the
 * values the schema rejects, so its case carries a schema `{ b: 2 }` does not
 * match. `propertyNames` constrains names rather than values, so its case
 * carries a string default.
 */
const DEFAULT_UNDER_INERT_KEYWORD: Record<
  string,
  { schema: JSONSchemaObj; stored: unknown; validationIssue?: string }
> = {
  not: {
    schema: { type: "object", not: { type: "number", default: 5 } },
    stored: { b: 2 },
  },
  propertyNames: {
    schema: {
      type: "object",
      propertyNames: { type: "string", default: "a" },
    },
    stored: { b: 2 },
  },
  contentSchema: {
    schema: { type: "string", contentSchema: defaultedMember },
    stored: "b",
    validationIssue: "content validation is not supported",
  },
  $defs: {
    schema: {
      type: "object",
      $defs: { Dormant: defaultedMember },
      properties: { b: { type: "number" } },
    },
    stored: { b: 2 },
  },
  definitions: {
    schema: {
      type: "object",
      definitions: { Dormant: defaultedMember },
      properties: { b: { type: "number" } },
    },
    stored: { b: 2 },
  },
  if: {
    schema: { type: "object", if: defaultedMember },
    stored: { b: 2 },
  },
  then: {
    schema: { type: "object", if: { type: "object" }, then: defaultedMember },
    stored: { b: 2 },
  },
  else: {
    schema: { type: "object", if: { type: "string" }, else: defaultedMember },
    stored: { b: 2 },
  },
  dependentSchemas: {
    schema: { type: "object", dependentSchemas: { b: defaultedMember } },
    stored: { b: 2 },
  },
  contains: {
    schema: { type: "array", contains: defaultedMember },
    stored: [{ b: 2 }],
  },
  unevaluatedProperties: {
    schema: { type: "object", unevaluatedProperties: defaultedMember },
    stored: { b: { b: 2 } },
  },
  unevaluatedItems: {
    schema: { type: "array", unevaluatedItems: defaultedMember },
    stored: [{ b: 2 }],
  },
};

/** Whether `value` or anything nested inside it carries a `default`. */
function carriesDefault(value: unknown): boolean {
  if (!isObjectOrArray(value)) return false;
  return Object.hasOwn(value, "default") ||
    Object.values(value).some(carriesDefault);
}

/**
 * An `allOf` branch naming a member with a default. The constraint on the
 * whole object outside the branch is one that a second member breaks.
 */
const boundedObjectWithDefaultUnderAllOf: JSONSchema = {
  type: "object",
  maxProperties: 1,
  allOf: [defaultedMember],
};

describe("schema-compatibility-default-reach", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let cellCount = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * What `stored` reads back as when it is read through `schema`, detached
   * from the read: the validator compares what it is given, and takes a value
   * rather than a view.
   */
  function readThrough(schema: JSONSchema, stored: unknown): unknown {
    const cell = runtime.getCell<unknown>(
      space,
      `default reach ${cellCount++}`,
      undefined,
      tx,
    );
    cell.set(stored);
    return snapshotQueryResult(cell.asSchema(schema).get());
  }

  it("merges a default written under `allOf` into the value read", () => {
    // This is why the walk follows `allOf`. `{ b: 2 }` satisfies the schema,
    // and reading `{ b: 2 }` through that same schema returns a value the
    // schema rejects.

    expect(validateSchemaValue(boundedObjectWithDefaultUnderAllOf, { b: 2 }))
      .toBeUndefined();

    const read = readThrough(boundedObjectWithDefaultUnderAllOf, { b: 2 });
    expect(read).toEqual({ b: 2, a: 0 });
    expect(validateSchemaValue(boundedObjectWithDefaultUnderAllOf, read))
      .toBe("object has more than maxProperties 1");
  });

  it("refuses a link whose target carries that default", () => {
    expect(() =>
      assertSchemaSubset(
        boundedObjectWithDefaultUnderAllOf,
        boundedObjectWithDefaultUnderAllOf,
      )
    ).toThrow(/not stable under default insertion/);
  });

  it("merges a default beside a composition into the branch the value occupies", () => {
    // The branch types do not overlap, so `{}` stays in the branch that
    // lists it, and the default from the sibling `properties` lands inside
    // it there. `{}` satisfies the schema; what reads back does not.

    const schema: JSONSchema = {
      type: "object",
      anyOf: [{ enum: [{}] }, { type: "string" }],
      properties: { a: { type: "number", default: 1 } },
    };
    expect(validateSchemaValue(schema, {})).toBeUndefined();

    const read = readThrough(schema, {});
    expect(read).toEqual({ a: 1 });
    expect(validateSchemaValue(schema, read)).toBe(
      "value does not match anyOf",
    );
    expect(() => assertSchemaSubset(schema, schema))
      .toThrow(/not stable under default insertion/);
  });

  it("leaves a default written under `patternProperties` out of the value read", () => {
    // The walk follows `patternProperties` even though no default under it is
    // ever merged into a value. The comment on
    // `DEFAULT_INERT_SUBSCHEMA_KEYS` gives that as the side to err on, and
    // this case is the part of that claim a test can hold.

    const schema: JSONSchemaObj = {
      type: "object",
      patternProperties: { "^i": defaultedMember },
    };
    expect(readThrough(schema, { i: { b: 2 } })).toEqual({ i: { b: 2 } });
    expect(extractDefaultValues(schema, schema)).toBeUndefined();
  });

  it("has a case carrying a default for every keyword named as default-inert", () => {
    // Both halves matter. Without the first, a keyword added to the set is
    // never measured. Without the second, a case that forgot its `default`
    // passes below for a reason that has nothing to do with the keyword.

    expect(Object.keys(DEFAULT_UNDER_INERT_KEYWORD).sort())
      .toEqual([...DEFAULT_INERT_SUBSCHEMA_KEYS].sort());

    for (
      const [keyword, { schema }] of Object.entries(DEFAULT_UNDER_INERT_KEYWORD)
    ) {
      const under = (schema as Record<string, unknown>)[keyword];
      expect(carriesDefault(under), keyword).toBe(true);
    }
  });

  it("leaves a default written under a default-inert keyword out of the value read", () => {
    for (
      const [keyword, { schema, stored, validationIssue }] of Object.entries(
        DEFAULT_UNDER_INERT_KEYWORD,
      )
    ) {
      expect(validateSchemaValue(schema, stored), keyword).toBe(
        validationIssue,
      );
      expect(readThrough(schema, stored), keyword).toEqual(stored);
      expect(extractDefaultValues(schema, schema), keyword).toBeUndefined();
    }
  });
});
