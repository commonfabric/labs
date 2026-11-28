/**
 * GC check for a snapshot that outlives the snapshot its relative links
 * resolve against, run with the real event loop.
 */
import type { JSONSchema, JSONValue } from "@commonfabric/api";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import type { FabricValue } from "@commonfabric/data-model";
import {
  ImmutableCellStore,
  type ImmutableSnapshot,
  immutableSnapshot,
} from "../src/immutable-cell.ts";
import { decomposeSchema } from "../src/schema-decompose.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";
import type { URI } from "../src/sigil-types.ts";

const gc: unknown = Reflect.get(globalThis, "gc");
if (typeof gc !== "function") throw new Error("Requires --expose-gc");

const ORIGIN = { originDocument: "reclaimed" };

/**
 * Creates an origin and a snapshot read out of it in a store that is then
 * reclaimed without disposal, so only the returned snapshot outlives it.
 */
function childOfDroppedStore(): ImmutableSnapshot {
  const store = new ImmutableCellStore();
  const origin = store.create(ORIGIN);
  return store.create(
    { child: linkRefFrom({ path: ["originDocument"] }) },
    { id: origin.id, path: [] },
  );
}

/** What `read` returns, or the message of the error it throws. */
function outcome(read: () => FabricValue): FabricValue {
  try {
    return read();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Whether `store` can create a value linking to `id`, or why not. */
function linkTo(store: ImmutableCellStore, id: URI): FabricValue {
  return outcome(() => {
    store.create({ held: linkRefFrom({ id }) });
    return "created";
  });
}

function registerAll(documents: ReadonlyMap<string, JSONSchema>): void {
  for (const [hash, document] of documents) {
    registerSchemaDocument(hash, document);
  }
}

const release = acquireSchemaRegistryLease();
const child = childOfDroppedStore();
const originId = child.origin?.id;
if (originId === undefined) throw new Error("Expected a snapshot origin");
// A reader schema whose closure, once registered, names the child.
const reader = new ImmutableCellStore();
const readerSchema = decomposeSchema({
  default: linkRefFrom({ id: child.id }) as JSONValue,
});
reader.retainSchema({ $ref: readerSchema.rootRef });

// WeakRef targets survive the job that created them; a timer turn ends it.
await new Promise((resolve) => setTimeout(resolve, 0));
gc();
// Until the dropped store's finalizer runs, in a task of its own, the child is
// still registered while its origin has been collected: a value linking to the
// child cannot be created.
const writer = new ImmutableCellStore();
const collected = {
  origin: outcome(() => immutableSnapshot(originId).value),
  child: outcome(() => immutableSnapshot(child.id).value),
  linkToChild: linkTo(writer, child.id),
};
// A schema registration hands the reader the child, which it retains while it
// waits for the origin.
registerAll(readerSchema.documents);
const waiting = {
  child: outcome(() => reader.get(child.id).value),
  origin: outcome(() => reader.get(originId).value),
};
// Equal content mints the origin's identifier again, and the reader acquires
// it at the next schema registration.
const recreator = new ImmutableCellStore();
const recreatedSameId = recreator.create(ORIGIN).id === originId;
registerAll(
  decomposeSchema({ description: "expired origin retry" }).documents,
);
recreator.dispose();
const report = {
  collected,
  waiting,
  recreatedSameId,
  recovered: {
    origin: outcome(() => reader.get(originId).value),
    linkToChild: linkTo(writer, child.id),
  },
};
reader.dispose();
writer.dispose();
release();
console.log(JSON.stringify(report));
