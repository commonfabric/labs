import type { SchemaPathSelector } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";
import type {
  Entity,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";

import type { JSONSchema, JSONSchemaTypes } from "../src/builder/types.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  createDefaultTraversalContext,
  IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

// The acting identity traversal tracker keys resolve scoped addresses
// against (stage E).
const TEST_SCOPE_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};

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
  const entity = uri as Entity;
  const revision: Revision<State> = {
    the: type,
    of: entity,
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

Deno.bench("anyOf: 5-branch const discriminator", { group: "anyOf" }, (b) => {
  // Benchmark 1: 5-branch discriminated union with const discriminator

  const store = new Map<string, Revision<State>>();
  const doc = makeDoc(store, "of:bench-disc", {
    kind: "circle",
    radius: 5,
  });
  const schema = {
    anyOf: [
      {
        type: "object",
        properties: { kind: { const: "square" }, side: { type: "number" } },
        required: ["kind"],
      },
      {
        type: "object",
        properties: {
          kind: { const: "rect" },
          w: { type: "number" },
          h: { type: "number" },
        },
        required: ["kind"],
      },
      {
        type: "object",
        properties: { kind: { const: "circle" }, radius: { type: "number" } },
        required: ["kind"],
      },
      {
        type: "object",
        properties: {
          kind: { const: "triangle" },
          base: { type: "number" },
          height: { type: "number" },
        },
        required: ["kind"],
      },
      {
        type: "object",
        properties: {
          kind: { const: "ellipse" },
          rx: { type: "number" },
          ry: { type: "number" },
        },
        required: ["kind"],
      },
    ],
  } as JSONSchema;

  b.start();
  for (let i = 0; i < 100; i++) {
    const traverser = getTraverser(store, { path: ["value"], schema });
    traverser.traverse(doc);
  }
  b.end();
});

Deno.bench("anyOf: 2-branch disjoint merge", { group: "anyOf" }, (b) => {
  // Benchmark 2: 2-branch disjoint property merge

  const store = new Map<string, Revision<State>>();
  const doc = makeDoc(store, "of:bench-disjoint", {
    name: "Alice",
    age: 30,
    email: "alice@test.com",
  });
  const schema = {
    anyOf: [
      {
        type: "object",
        properties: { name: { type: "string" }, email: { type: "string" } },
      },
      {
        type: "object",
        properties: { age: { type: "number" } },
      },
    ],
  } as JSONSchema;

  b.start();
  for (let i = 0; i < 100; i++) {
    const traverser = getTraverser(store, { path: ["value"], schema });
    traverser.traverse(doc);
  }
  b.end();
});

Deno.bench(
  "anyOf: 3-branch nested object",
  { group: "anyOf" },
  (b) => {
    // Benchmark 3: Multi-branch object schema with anyOf at each property level

    const store = new Map<string, Revision<State>>();

    const root = makeDoc(store, "of:bench-nested", {
      name: "Alice",
      role: "admin",
      score: 95,
      email: "alice@test.com",
      active: true,
    });

    // 3 branches with overlapping properties — simulates MentionablePiece-like schemas
    const schema: JSONSchema = {
      anyOf: [
        {
          type: "object",
          properties: {
            name: { type: "string" },
            role: { type: "string" },
          },
        },
        {
          type: "object",
          properties: {
            name: { type: "string" },
            score: { type: "number" },
            active: { type: "boolean" },
          },
        },
        {
          type: "object",
          properties: {
            email: { type: "string" },
            active: { type: "boolean" },
          },
        },
      ],
    };

    b.start();
    for (let i = 0; i < 100; i++) {
      const traverser = getTraverser(store, {
        path: ["value"],
        schema,
      });
      traverser.traverse(root);
    }
    b.end();
  },
);

Deno.bench("anyOf: 10-branch type discriminator", { group: "anyOf" }, (b) => {
  // Benchmark 4: 10-branch wide union with type discriminator

  const store = new Map<string, Revision<State>>();
  const doc = makeDoc(store, "of:bench-wide", { x: 1, y: 2 });

  const branches: JSONSchema[] = [];
  // 8 incompatible primitive types
  for (
    const t of [
      "string",
      "number",
      "boolean",
      "null",
      "array",
      "string",
      "number",
      "boolean",
    ]
  ) {
    branches.push({ type: t as JSONSchemaTypes });
  }
  // 2 object types
  branches.push({
    type: "object",
    properties: { x: { type: "number" } },
  });
  branches.push({
    type: "object",
    properties: { y: { type: "number" } },
  });

  const schema = { anyOf: branches } as JSONSchema;

  b.start();
  for (let i = 0; i < 100; i++) {
    const traverser = getTraverser(store, { path: ["value"], schema });
    traverser.traverse(doc);
  }
  b.end();
});

Deno.bench(
  "anyOf: 2-level deep (props are anyOf)",
  { group: "anyOf" },
  (b) => {
    // Benchmark 5: 2-level deep nested anyOf — every property is itself an
    // anyOf

    const store = new Map<string, Revision<State>>();
    const doc = makeDoc(store, "of:bench-deep2", {
      a: "hello",
      b: 42,
      c: true,
    });

    // Top-level anyOf with 3 branches, each property schema is itself an anyOf
    const innerAnyOf: JSONSchema = {
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
      ],
    };
    const schema: JSONSchema = {
      anyOf: [
        {
          type: "object",
          properties: { a: innerAnyOf, b: innerAnyOf },
        },
        {
          type: "object",
          properties: { b: innerAnyOf, c: innerAnyOf },
        },
        {
          type: "object",
          properties: { a: innerAnyOf, c: innerAnyOf },
        },
      ],
    };

    b.start();
    for (let i = 0; i < 100; i++) {
      const traverser = getTraverser(store, { path: ["value"], schema });
      traverser.traverse(doc);
    }
    b.end();
  },
);

Deno.bench(
  "anyOf: 3-level deep (nested objects with anyOf at each)",
  { group: "anyOf" },
  (b) => {
    // Benchmark 6: 3-level deep nested anyOf — object → anyOf props → anyOf
    // sub-props

    const store = new Map<string, Revision<State>>();
    const doc = makeDoc(store, "of:bench-deep3", {
      user: {
        name: "Alice",
        age: 30,
      },
      meta: {
        tag: "admin",
        score: 99,
      },
    });

    const leafAnyOf: JSONSchema = {
      anyOf: [
        { type: "string" },
        { type: "number" },
      ],
    };
    const midAnyOf: JSONSchema = {
      anyOf: [
        {
          type: "object",
          properties: { name: leafAnyOf, age: leafAnyOf },
        },
        {
          type: "object",
          properties: { tag: leafAnyOf, score: leafAnyOf },
        },
      ],
    };
    const schema: JSONSchema = {
      anyOf: [
        {
          type: "object",
          properties: { user: midAnyOf, meta: midAnyOf },
        },
        {
          type: "object",
          properties: { user: midAnyOf },
        },
      ],
    };

    b.start();
    for (let i = 0; i < 100; i++) {
      const traverser = getTraverser(store, { path: ["value"], schema });
      traverser.traverse(doc);
    }
    b.end();
  },
);

Deno.bench(
  "anyOf: 3-level deep discriminated",
  { group: "anyOf" },
  (b) => {
    // Benchmark 7: 3-level deep with discriminators at every level

    const store = new Map<string, Revision<State>>();
    const doc = makeDoc(store, "of:bench-deep3-disc", {
      type: "container",
      child: {
        type: "section",
        item: {
          type: "text",
          content: "hello world",
        },
      },
    });

    const leafSchema: JSONSchema = {
      anyOf: [
        {
          type: "object",
          properties: {
            type: { const: "text" },
            content: { type: "string" },
          },
          required: ["type"],
        },
        {
          type: "object",
          properties: {
            type: { const: "image" },
            src: { type: "string" },
            alt: { type: "string" },
          },
          required: ["type"],
        },
        {
          type: "object",
          properties: {
            type: { const: "link" },
            href: { type: "string" },
            label: { type: "string" },
          },
          required: ["type"],
        },
      ],
    };

    const midSchema: JSONSchema = {
      anyOf: [
        {
          type: "object",
          properties: {
            type: { const: "section" },
            item: leafSchema,
          },
          required: ["type"],
        },
        {
          type: "object",
          properties: {
            type: { const: "header" },
            title: { type: "string" },
          },
          required: ["type"],
        },
        {
          type: "object",
          properties: {
            type: { const: "footer" },
            copyright: { type: "string" },
          },
          required: ["type"],
        },
      ],
    };

    const schema: JSONSchema = {
      anyOf: [
        {
          type: "object",
          properties: {
            type: { const: "container" },
            child: midSchema,
          },
          required: ["type"],
        },
        {
          type: "object",
          properties: {
            type: { const: "page" },
            body: midSchema,
          },
          required: ["type"],
        },
        {
          type: "object",
          properties: {
            type: { const: "document" },
            root: midSchema,
          },
          required: ["type"],
        },
      ],
    };

    b.start();
    for (let i = 0; i < 100; i++) {
      const traverser = getTraverser(store, { path: ["value"], schema });
      traverser.traverse(doc);
    }
    b.end();
  },
);

Deno.bench(
  "anyOf: wide+deep (4x3 branches)",
  { group: "anyOf" },
  (b) => {
    // Benchmark 8: Wide + deep — 4 branches at top, each with 3-branch anyOf
    // properties

    const store = new Map<string, Revision<State>>();
    const doc = makeDoc(store, "of:bench-wide-deep", {
      kind: "B",
      x: "hello",
      y: 42,
    });

    const propAnyOf: JSONSchema = {
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
      ],
    };

    const schema: JSONSchema = {
      anyOf: [
        {
          type: "object",
          properties: { kind: { const: "A" }, x: propAnyOf },
          required: ["kind"],
        },
        {
          type: "object",
          properties: { kind: { const: "B" }, x: propAnyOf, y: propAnyOf },
          required: ["kind"],
        },
        {
          type: "object",
          properties: { kind: { const: "C" }, y: propAnyOf, z: propAnyOf },
          required: ["kind"],
        },
        {
          type: "object",
          properties: { kind: { const: "D" }, w: propAnyOf },
          required: ["kind"],
        },
      ],
    };

    b.start();
    for (let i = 0; i < 100; i++) {
      const traverser = getTraverser(store, { path: ["value"], schema });
      traverser.traverse(doc);
    }
    b.end();
  },
);
