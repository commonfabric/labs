/** Exercises schema path admission independently of whether input data exists. */

import { Identity } from "@commonfabric/identity";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { schemaPathSelection } from "../src/schema-path.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";

/** Reads the admission result while keeping individual schema cases compact. */
function schemaSelectsPath(
  schema: JSONSchema | undefined,
  path: (string | number)[],
): boolean {
  return schemaPathSelection(schema, path).selected;
}

describe("schemaPathSelection", () => {
  it("retains outer properties beside alternative properties", () => {
    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      const schema: JSONSchema = {
        type: "object",
        properties: { outer: { type: "number" } },
        [keyword]: [{
          type: "object",
          properties: { inner: { type: "string" } },
        }],
      };
      expect(schemaSelectsPath(schema, ["outer"])).toBe(true);
      expect(schemaSelectsPath(schema, ["inner"])).toBe(true);
      expect(schemaSelectsPath(schema, ["missing"])).toBe(false);
    }
  });

  it("admits complete paths exposed by either eager or lazy alternatives", async () => {
    const signer = await Identity.fromPassphrase("schema-path-projection");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const write = runtime.edit();
      runtime.getCell(signer.did(), "projection", undefined, write).set({
        outer: "outer",
        inner: "inner",
        shared: { outer: "outer", inner: "inner" },
      });
      expect((await write.commit()).error).toBeUndefined();
      for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
        for (const mixed of [false, true]) {
          const schema: JSONSchema = {
            type: mixed ? ["object", "null"] : "object",
            properties: {
              outer: { type: "string" },
              shared: {
                type: "object",
                properties: { outer: { type: "string" } },
              },
            },
            [keyword]: [{
              type: "object",
              properties: {
                inner: { type: "string" },
                shared: {
                  type: "object",
                  properties: { inner: { type: "string" } },
                },
              },
            }],
          };
          expect(schemaSelectsPath(schema, ["inner"])).toBe(true);
          expect(schemaSelectsPath(schema, ["shared", "inner"])).toBe(true);
          expect(schemaSelectsPath(schema, ["shared", "missing"])).toBe(false);
          for (const lazy of [false, true]) {
            const tx = runtime.edit();
            try {
              if (lazy) tx.markLazyMaterialize(true);
              const value = runtime.getCell<Record<string, unknown>>(
                signer.did(),
                "projection",
                schema,
                tx,
              ).get();
              for (
                const path of [["outer"], ["inner"], ["shared", "outer"], [
                  "shared",
                  "inner",
                ]]
              ) {
                let selected: unknown = value;
                for (const segment of path) {
                  selected = (selected as Record<string, unknown> | undefined)
                    ?.[segment];
                }
                if (selected !== undefined) {
                  expect(schemaSelectsPath(schema, path)).toBe(true);
                }
              }
              if (!lazy) expect(value.inner).toBe("inner");
            } finally {
              tx.abort("projection inspected");
            }
          }
        }
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("selects declared optional inputs and excludes undeclared ancestors", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        optional: {
          type: "object",
          asCell: [{ kind: "readonly", scope: "user" }],
          properties: { value: { type: "string" } },
        },
        rejected: false,
      },
    };
    for (const path of [[], ["optional"], ["optional", "value"]]) {
      expect(schemaSelectsPath(schema, path)).toBe(true);
    }
    for (
      const path of [["missing"], ["missing", "value"], ["optional", "extra"], [
        "rejected",
      ]]
    ) {
      expect(schemaSelectsPath(schema, path)).toBe(false);
    }
  });

  it("selects absent array slots and record keys within their item schemas", () => {
    const item: JSONSchema = {
      type: "object",
      properties: { value: { type: "string" } },
    };
    const array: JSONSchema = { type: "array", items: item };
    const record: JSONSchema = { type: "object", additionalProperties: item };
    expect(schemaSelectsPath(array, [100, "value"])).toBe(true);
    expect(schemaSelectsPath(array, [100, "extra"])).toBe(false);
    expect(schemaSelectsPath(array, ["length"])).toBe(false);
    expect(schemaSelectsPath(array, ["01"])).toBe(false);
    expect(schemaSelectsPath(record, ["future", "value"])).toBe(true);
    expect(schemaSelectsPath(record, ["future", "extra"])).toBe(false);
    expect(
      schemaSelectsPath({ type: "array", prefixItems: [item], items: false }, [
        0,
        "value",
      ]),
    ).toBe(true);
    expect(
      schemaSelectsPath({ type: "array", prefixItems: [item], items: false }, [
        1,
      ]),
    ).toBe(false);
  });

  it("preserves unrestricted cells and excludes empty named projections", () => {
    for (const schema of [undefined, true, {}, { type: "object" }] as const) {
      expect(schemaSelectsPath(schema, ["any", "depth"])).toBe(true);
    }
    expect(schemaSelectsPath({ type: "object", properties: {} }, ["extra"]))
      .toBe(false);
    expect(
      schemaSelectsPath({
        type: "object",
        properties: {},
        additionalProperties: true,
      }, ["extra"]),
    ).toBe(true);
    expect(schemaSelectsPath({ type: "unknown" }, ["hidden"])).toBe(false);
  });

  it("identifies the conditional subtree without requiring its input root", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        plain: { type: "string" },
        handle: {
          anyOf: [
            {
              type: "object",
              properties: { value: { type: "string" } },
              asCell: ["cell"],
            },
            {
              type: "object",
              properties: { value: { type: "number" } },
              asCell: ["cell"],
            },
          ],
        },
      },
    };
    expect(schemaPathSelection(schema, ["plain"])).toEqual({
      selected: true,
      conditionalDepth: undefined,
    });
    expect(schemaPathSelection(schema, ["handle", "value"])).toEqual({
      selected: true,
      conditionalDepth: 1,
    });
    expect(
      schemaPathSelection({ type: "array", items: { type: "string" } }, [
        "length",
      ], { allowArrayLength: true }).selected,
    ).toBe(true);
  });

  it("resolves recursive definitions without opening undeclared paths", () => {
    const schema: JSONSchema = {
      $defs: {
        node: {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/node" },
            value: { type: "string" },
          },
        },
      },
      $ref: "#/$defs/node",
    };
    expect(schemaSelectsPath(schema, ["next", "next", "value"])).toBe(true);
    expect(schemaSelectsPath(schema, ["next", "extra"])).toBe(false);
  });

  it("resolves boolean definitions without exposing a false projection", () => {
    const release = acquireSchemaRegistryLease();
    try {
      for (const allowed of [true, false]) {
        expect(schemaSelectsPath({
          $defs: { target: allowed },
          $ref: "#/$defs/target",
        }, ["value"])).toBe(allowed);
        const hash = internSchemaAsTaggedHashString(allowed);
        registerSchemaDocument(hash, allowed);
        expect(schemaSelectsPath({ $ref: `cid:${hash}` }, ["value"])).toBe(
          allowed,
        );
      }
    } finally {
      release();
    }
  });

  it("selects concrete alternatives beside recursive and impossible branches", () => {
    const value: JSONSchema = {
      type: "object",
      properties: { value: { type: "string" } },
    };
    const recursive: JSONSchema = {
      $defs: {
        node: { anyOf: [{ $ref: "#/$defs/node" }, false, value] },
      },
      $ref: "#/$defs/node",
    };
    expect(schemaSelectsPath(recursive, ["value"])).toBe(true);
    expect(schemaSelectsPath(recursive, ["missing"])).toBe(false);
    expect(schemaSelectsPath({ allOf: [value, false] }, ["value"])).toBe(false);
    expect(schemaSelectsPath({ oneOf: [false, value] }, ["value"])).toBe(true);
  });

  it("requires a parent projection when the declared type has alternatives", () => {
    expect(schemaPathSelection({
      type: ["object", "undefined"],
      properties: { value: { type: "string" } },
    }, ["value"])).toEqual({ selected: true, conditionalDepth: 0 });
    expect(schemaPathSelection(
      {
        type: ["array", "undefined"],
        items: { type: "string" },
      },
      ["length"],
      { allowArrayLength: true },
    )).toEqual({
      selected: true,
      conditionalDepth: 0,
    });
  });

  it("selects union paths only when one branch admits the entire path", () => {
    const schema: JSONSchema = {
      anyOf: [
        {
          type: "object",
          properties: {
            left: { type: "object", properties: { value: { type: "string" } } },
          },
        },
        { type: "object", properties: { right: { type: "string" } } },
        { type: "undefined" },
      ],
    };
    expect(schemaSelectsPath(schema, ["left", "value"])).toBe(true);
    expect(schemaSelectsPath(schema, ["right"])).toBe(true);
    expect(schemaSelectsPath(schema, ["left", "extra"])).toBe(false);
    expect(schemaSelectsPath(schema, ["extra"])).toBe(false);
  });

  it("selects structural and conjunctive projections", () => {
    const schema: JSONSchema = {
      allOf: [
        { properties: { left: { type: "string" } } },
        { properties: { right: { type: "string" } } },
      ],
    };
    expect(schemaSelectsPath(schema, ["left"])).toBe(true);
    expect(schemaSelectsPath(schema, ["right"])).toBe(true);
    expect(schemaSelectsPath(schema, ["extra"])).toBe(false);
    expect(
      schemaSelectsPath({
        type: "object",
        properties: { value: { type: "string" } },
        allOf: [],
      }, ["value"]),
    ).toBe(true);
  });
});
