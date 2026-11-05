/**
 * Guards the cost of carrying an enclosing schema's `$defs` into a sub-schema
 * (`cfcSchemaWithInheritedDefs`) at the sites that do it on every read: the
 * union-arm loop in `schemaTypeValidity`, `elementSchemaFor`, and value
 * narrowing.
 *
 * Every case puts `$defs` on the parent, since the helper does nothing
 * otherwise, and runs in two regimes from two separate builds of one shape. An
 * interned schema is what a cell's schema is in production, and there the
 * helper's local-ref scan memoizes by identity. A plain literal that nothing
 * has interned is what a schema passed straight to the API is, and there the
 * scan cannot memoize, so the helper must not scan it. `internSchema` freezes
 * its argument in place, which is why the two regimes never share an object.
 */

import type { SchemaPathSelector } from "@commonfabric/api";
import { type FabricValue, isDeepFrozen } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import { elementSchemaFor } from "../src/cell.ts";
import { resolveSchemaForValue } from "../src/schema.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  createDefaultTraversalContext,
  IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  schemaAcceptsType,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

const TEST_SCOPE_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

const defs = () => ({
  Point: { type: "object", properties: { x: { type: "number" } } },
  Name: { type: "string" },
});

// An arm with no local ref, `width` properties wide and `depth` levels deep,
// so a scan has all of it to walk before finding nothing to attach.
function wideArm(width: number, depth: number, tag: string): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  for (let i = 0; i < width; i++) {
    properties[`${tag}${i}`] = depth === 0
      ? { type: "number" }
      : wideArm(width, depth - 1, `${tag}${i}_`);
  }
  return { type: "object", properties, required: [`${tag}0`] };
}

const union = (arms: JSONSchema[]): JSONSchema =>
  ({ $defs: defs(), anyOf: arms }) as JSONSchema;

// Three arms of ~155 nodes each.
const largeRefFree = () =>
  union([wideArm(5, 2, "a"), wideArm(5, 2, "b"), wideArm(5, 2, "c"), {
    type: "null",
  }]);
// The generated optional-handle shape: a `$ref` arm plus the absent case.
const refArm = () => union([{ $ref: "#/$defs/Point" }, { type: "null" }]);

const arrayOfLarge = () =>
  ({ type: "array", items: wideArm(5, 2, "e"), $defs: defs() }) as JSONSchema;

const objectOfRefs = () =>
  ({
    type: "object",
    $defs: defs(),
    properties: {
      p: { $ref: "#/$defs/Point" },
      n: { $ref: "#/$defs/Name" },
      plain: wideArm(3, 1, "q"),
    },
  }) as JSONSchema;

type Regime = "interned" | "literal";
type Case = { regime: Regime; schema: JSONSchema };

const regimes = (make: () => JSONSchema): Case[] => {
  const literal = make();
  const interned = internSchema(make()) as JSONSchema;
  if (isDeepFrozen(literal) || !isDeepFrozen(interned)) {
    throw new Error("regime mix-up");
  }
  return [
    { regime: "interned", schema: interned },
    { regime: "literal", schema: literal },
  ];
};

// A body reads its schema many times, so a regime that drifted — a subject
// that interned its input in place — would silently measure the other one.
const assertRegime = ({ regime, schema }: Case): void => {
  if (isDeepFrozen(schema) !== (regime === "interned")) {
    throw new Error(`regime drifted: ${regime}`);
  }
};

for (const c of regimes(largeRefFree)) {
  Deno.bench(`large ref-free arms, ${c.regime}`, { group: "arm scope" }, () => {
    assertRegime(c);
    for (let i = 0; i < 100; i++) schemaAcceptsType(c.schema, "object");
  });
}

for (const c of regimes(refArm)) {
  Deno.bench(`$ref arm, ${c.regime}`, { group: "arm scope" }, () => {
    assertRegime(c);
    for (let i = 0; i < 100; i++) schemaAcceptsType(c.schema, "object");
  });
}

for (const c of regimes(arrayOfLarge)) {
  Deno.bench(
    `large ref-free items, ${c.regime}`,
    { group: "element scope" },
    () => {
      assertRegime(c);
      for (let i = 0; i < 1000; i++) elementSchemaFor(c.schema, 3);
    },
  );
}

// `resolveSchema` interns its input in place, so only the interned regime is
// meaningful here.
const objectValue = { p: { x: 1 }, n: "n", plain: { q0: { q0_0: 1 } } };
const [objectOfRefsInterned] = regimes(objectOfRefs);
Deno.bench("refs + plain property", { group: "value narrowing" }, () => {
  for (let i = 0; i < 10; i++) {
    resolveSchemaForValue(objectOfRefsInterned.schema, objectValue);
  }
});

function getTraverser(
  store: Map<string, Revision<State>>,
  selector: SchemaPathSelector,
): SchemaObjectTraverser<FabricValue> {
  const manager = new StoreObjectManager(store);
  const managedTx = new ManagedStorageTransaction(manager);
  const tx = new ExtendedStorageTransaction(managedTx);
  return new SchemaObjectTraverser(
    tx,
    selector,
    createDefaultTraversalContext(TEST_SCOPE_IDENTITY),
  );
}

function makeDoc(
  store: Map<string, Revision<State>>,
  uri: string,
  value: FabricValue,
): IMemorySpaceValueAttestation {
  const type = "application/json" as const;
  const revision: Revision<State> = {
    the: type,
    of: uri as Entity,
    is: { value },
    since: 1,
  };
  store.set(`${revision.of}/${revision.the}`, revision);
  return {
    address: {
      space: "did:null:null" as `did:${string}:${string}`,
      id: uri as URI,
      type,
      path: ["value"],
    },
    value,
  };
}

// A 3-level discriminated document whose arms are `$ref`s into root `$defs`,
// the shape the schema generator emits.
const sectionOrHeader = () => ({
  anyOf: [{ $ref: "#/$defs/Section" }, { $ref: "#/$defs/Header" }],
});
const traversalSchema = () =>
  ({
    $defs: {
      Text: {
        type: "object",
        properties: { type: { const: "text" }, content: { type: "string" } },
        required: ["type"],
      },
      Image: {
        type: "object",
        properties: {
          type: { const: "image" },
          src: { type: "string" },
          alt: { type: "string" },
        },
        required: ["type"],
      },
      Section: {
        type: "object",
        properties: {
          type: { const: "section" },
          item: {
            anyOf: [{ $ref: "#/$defs/Text" }, { $ref: "#/$defs/Image" }],
          },
        },
        required: ["type"],
      },
      Header: {
        type: "object",
        properties: { type: { const: "header" }, title: { type: "string" } },
        required: ["type"],
      },
    },
    anyOf: [
      {
        type: "object",
        properties: { type: { const: "container" }, child: sectionOrHeader() },
        required: ["type"],
      },
      {
        type: "object",
        properties: { type: { const: "page" }, body: sectionOrHeader() },
        required: ["type"],
      },
    ],
  }) as JSONSchema;

const traversalDocValue = {
  type: "container",
  child: { type: "section", item: { type: "text", content: "hello" } },
};

// The traverser interns its schema, so only the interned regime is
// meaningful here.
const [traversalInterned] = regimes(traversalSchema);
Deno.bench("$ref arms, 3 levels", { group: "traversal" }, (b) => {
  const store = new Map<string, Revision<State>>();
  const doc = makeDoc(store, "of:bench-inherited-defs", traversalDocValue);
  b.start();
  for (let i = 0; i < 10; i++) {
    getTraverser(store, { path: ["value"], schema: traversalInterned.schema })
      .traverse(doc);
  }
  b.end();
});
