/**
 * Benchmarks of `SchemaObjectTraverser` over a broad `anyOf` whose values sit
 * in documents of their own, the shape a rendered VDOM tree has: each child
 * and each linked prop is traversed under the options its value can match.
 * Each case builds its documents once and measures whole walks from the root.
 */

import type { FabricValue } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import type {
  Entity,
  MemorySpace,
  Revision,
  State,
  URI,
} from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import { rendererVDOMSchema } from "../src/schemas.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { StoreObjectManager } from "../src/storage/query.ts";
import {
  createDefaultTraversalContext,
  ManagedStorageTransaction,
  SchemaObjectTraverser,
} from "../src/traverse.ts";

const SPACE = "did:null:null" as MemorySpace;
const TYPE = "application/json" as const;
const ROOT = "of:root" as URI;

/** A link to the root of document `id`. */
const link = (id: string): FabricValue => ({
  "/": { [LINK_V1_TAG]: { id, path: [] } },
});

/** A VDOM element named `name` with `props` and `children`. */
const element = (
  name: string,
  children: FabricValue[] = [],
  props: Record<string, FabricValue> = {},
): FabricValue => ({ type: "vnode", name, props, children });

/** A store holding each of `docs` under its id. */
function storeOf(
  docs: Record<string, FabricValue>,
): Map<string, Revision<State>> {
  const store = new Map<string, Revision<State>>();
  for (const [id, value] of Object.entries(docs)) {
    store.set(`${id}/${TYPE}`, {
      the: TYPE,
      of: id as Entity,
      is: { value },
      since: 1,
    });
  }
  return store;
}

/**
 * Walks the root document of `docs` under `schema` once, as a query does
 * with `traverseCells` set and as a cell read does without it.
 */
function walkOnce(
  store: Map<string, Revision<State>>,
  docs: Record<string, FabricValue>,
  schema: JSONSchema,
  traverseCells: boolean,
): void {
  const traverser = new SchemaObjectTraverser(
    new ExtendedStorageTransaction(
      new ManagedStorageTransaction(new StoreObjectManager(store)),
    ),
    { path: ["value"], schema },
    createDefaultTraversalContext(
      { principal: "did:test:alice", sessionId: "session-1" },
      traverseCells,
    ),
  );
  traverser.traverseWithSchema({
    address: { space: SPACE, id: ROOT, type: TYPE, path: ["value"] },
    value: docs[ROOT],
  }, schema);
}

/** A list of `rows` rows, each a document holding three child documents. */
function listDocs(rows: number): Record<string, FabricValue> {
  const docs: Record<string, FabricValue> = {};
  const rowLinks: FabricValue[] = [];
  for (let row = 0; row < rows; row++) {
    const id = `of:row-${row}`;
    rowLinks.push(link(id));
    docs[id] = element("li", [
      link(`${id}-label`),
      link(`${id}-text`),
      link(`${id}-button`),
    ]);
    docs[`${id}-label`] = element("span", ["label"]);
    docs[`${id}-text`] = `row ${row}`;
    docs[`${id}-button`] = element("button", ["done"]);
  }
  docs[ROOT] = element("ul", rowLinks);
  return docs;
}

/** An element with `count` props, each a link to a document holding a value. */
function linkedPropDocs(count: number): Record<string, FabricValue> {
  const docs: Record<string, FabricValue> = {};
  const props: Record<string, FabricValue> = {};
  for (let index = 0; index < count; index++) {
    const id = `of:prop-${index}`;
    props[`data-${index}`] = link(id);
    docs[id] = index % 2 === 0 ? `value ${index}` : index;
  }
  docs[ROOT] = element("div", [], props);
  return docs;
}

{
  const docs = listDocs(200);
  const store = storeOf(docs);
  Deno.bench(
    "anyOf links: VDOM list of 200 rows, 800 linked children (query walk)",
    { group: "anyOf links" },
    () => walkOnce(store, docs, rendererVDOMSchema, true),
  );
}

{
  const docs = linkedPropDocs(400);
  const store = storeOf(docs);
  Deno.bench(
    "anyOf links: VDOM element with 400 linked props (query walk)",
    { group: "anyOf links" },
    () => walkOnce(store, docs, rendererVDOMSchema, true),
  );
}

{
  const docs: Record<string, FabricValue> = {};
  const record: Record<string, FabricValue> = {};
  for (let index = 0; index < 400; index++) {
    record[`key-${index}`] = link(`of:value-${index}`);
    docs[`of:value-${index}`] = { title: `value ${index}`, count: index };
  }
  docs[ROOT] = record;
  const store = storeOf(docs);
  const schema: JSONSchema = internSchema<JSONSchema>({
    type: "object",
    additionalProperties: {
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
        { type: "array", items: { type: "string" } },
        {
          type: "object",
          properties: { kind: { type: "string" } },
          required: ["kind"],
        },
        {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
        {
          type: "object",
          properties: { title: { type: "string" }, count: { type: "number" } },
          required: ["title"],
        },
      ],
    },
  });
  Deno.bench(
    "anyOf links: record of 400 linked values under 8 options (cell read)",
    { group: "anyOf links" },
    () => walkOnce(store, docs, schema, false),
  );
}

{
  const values: FabricValue[] = [];
  for (let index = 0; index < 2000; index++) values.push(index);
  const docs = { [ROOT]: values };
  const store = storeOf(docs);
  const schema: JSONSchema = internSchema<JSONSchema>({
    type: "array",
    items: {
      anyOf: [
        { type: "string" },
        { type: "boolean" },
        { type: "null" },
        { type: "undefined" },
        { type: "array" },
        { type: "object", required: ["a"] },
        { type: "object", required: ["b"] },
        { type: "object", required: ["c"] },
        { type: "object", required: ["d"] },
        { type: "number" },
      ],
    },
  });
  Deno.bench(
    "anyOf: 2,000 numbers under 10 options (cell read)",
    { group: "anyOf links" },
    () => walkOnce(store, docs, schema, false),
  );
}
