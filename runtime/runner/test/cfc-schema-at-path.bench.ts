/**
 * Guards the schemaAtPath hot path against scaling with data cardinality or
 * dormant definition count.
 *
 * Each iteration uses a fresh deep-frozen schema so the first lookup pays its
 * real ref-summary / definition-closure cost. The 1,000 numeric paths model a
 * large homogeneous array: they should share one symbolic `items` derivation,
 * rather than populate one cache entry per index.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { deepFreeze } from "@commonfabric/data-model";
import { ContextualFlowControl } from "../src/cfc.ts";
import { rendererVDOMSchema } from "../src/schemas.ts";

const INDEX_COUNT = 1_000;
const DEFINITION_COUNT = 500;

const makeSchema = (
  definitionCount: number,
  reachableCount: number,
): JSONSchema => {
  const definitions: Record<string, JSONSchema> = {};
  for (let index = 0; index < definitionCount; index++) {
    definitions[`Definition${index}`] = index + 1 < reachableCount
      ? { $ref: `#/$defs/Definition${index + 1}` }
      : {
        type: "object",
        properties: {
          value: { type: "string" },
          padding: { type: "number" },
        },
      };
  }
  return deepFreeze({
    type: "array",
    items: definitionCount === 0
      ? { type: "string" }
      : { $ref: "#/$defs/Definition0" },
    ...(definitionCount > 0 && { $defs: definitions }),
  } as JSONSchemaObj);
};

const deriveIndices = (
  b: Deno.BenchContext,
  definitionCount: number,
  reachableCount: number,
): void => {
  const schema = makeSchema(definitionCount, reachableCount);
  let result: JSONSchema = false;
  b.start();
  for (let index = 0; index < INDEX_COUNT; index++) {
    result = ContextualFlowControl.schemaAtPath(schema, [String(index)]);
  }
  b.end();
  if (result === false) throw new Error("unexpected rejecting schema");
};

const deriveRendererIndices = (
  b: Deno.BenchContext,
  distinct: boolean,
): void => {
  // Give every benchmark iteration a cold root identity while retaining the
  // production renderer schema's root $ref, union, and recursive definitions.
  const schema = deepFreeze({ ...rendererVDOMSchema });
  let result: JSONSchema = false;
  b.start();
  for (let index = 0; index < INDEX_COUNT; index++) {
    result = ContextualFlowControl.schemaAtPath(schema, [
      distinct ? String(index) : "0",
    ]);
  }
  b.end();
  if (result === false) throw new Error("unexpected rejecting schema");
};

Deno.bench({
  name: "schemaAtPath — 1,000 array indices, no definitions",
  group: "schemaAtPath-array-fanout",
  baseline: true,
  fn: (b) => deriveIndices(b, 0, 0),
});

Deno.bench({
  name: "schemaAtPath — 1,000 array indices, 1/500 definitions reachable",
  group: "schemaAtPath-array-fanout",
  fn: (b) => deriveIndices(b, DEFINITION_COUNT, 1),
});

Deno.bench({
  name: "schemaAtPath — 1,000 array indices, 500/500 definitions reachable",
  group: "schemaAtPath-array-fanout",
  fn: (b) => deriveIndices(b, DEFINITION_COUNT, DEFINITION_COUNT),
});

Deno.bench({
  name: "schemaAtPath — renderer root ref/union, repeated index",
  group: "schemaAtPath-renderer-fanout",
  baseline: true,
  fn: (b) => deriveRendererIndices(b, false),
});

Deno.bench({
  name: "schemaAtPath — renderer root ref/union, 1,000 distinct indices",
  group: "schemaAtPath-renderer-fanout",
  fn: (b) => deriveRendererIndices(b, true),
});
