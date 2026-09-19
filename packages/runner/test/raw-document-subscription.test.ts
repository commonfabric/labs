/**
 * What the v2 replica's `sinkDocument` does today.
 *
 * It takes a document's URI and a callback, hands the callback that document
 * as stored — links unresolved, nothing they reach fetched — and calls it
 * again when the server pushes a new version. Nothing consumed it and nothing
 * described it, so its behavior was whatever the implementation happened to
 * do, and one of its properties fails silently.
 *
 * These cases record that behavior and its limits for the v2 implementation as
 * it stands. They are not a contract. `sinkDocument` is on neither
 * `ISpaceReplica` nor `IStorageProvider`, and recording what it does here does
 * not make it an API to build on; what a live consumer should subscribe
 * through is a separate question this file does not answer.
 *
 * Each case runs two storage managers against one in-process memory-v2 server,
 * so the reader learns of a change only through a server sync frame. What they
 * record:
 *
 * - the callback receives the collection document's links as stored, and no
 *   document those links reach is loaded;
 * - a deep read of the same collection does load them, which is what makes
 *   that absence a fact about the subscription rather than about the fixture;
 * - a server-pushed append reaches the callback, still without the appended
 *   element's own documents;
 * - the subscription follows the BASE instance of the document however the
 *   surrounding reads are scoped. A `user`-scoped cell resolves to the same
 *   URI, so a subscription on it reports base membership while a `user`-scoped
 *   read of the same cause reports the overlay's, and a change to the `user`
 *   instance produces no call at all. That is the silent one: no error, just
 *   membership belonging to a different read.
 *
 * Issue #6534 carries the problem these were written against.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { EntityDocument } from "@commonfabric/memory/v2";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { ISpaceReplica, URI } from "../src/storage/interface.ts";
import type { Cancel } from "../src/cancel.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("raw-document-subscription");
const space = signer.did();

const bodySchema = {
  type: "object",
  properties: { text: { type: "string" } },
} as const satisfies JSONSchema;

const entrySchema = {
  type: "object",
  properties: { title: { type: "string" }, body: bodySchema },
} as const satisfies JSONSchema;

const collectionSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    items: { type: "array", items: entrySchema },
  },
} as const satisfies JSONSchema;

const COLLECTION = "raw-subscription-collection";
const BASE_ITEMS = 3;

/** A raw collection document, as `sinkDocument` hands it over. */
type RawCollection = {
  value?: { name?: string; items?: unknown[] };
};

const membershipOf = (document: unknown): unknown[] =>
  (document as RawCollection | undefined)?.value?.items ?? [];

const nameOf = (document: unknown): string | undefined =>
  (document as RawCollection | undefined)?.value?.name;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** A raw-document subscription, as the v2 replica offers one. */
type SinkDocument = (
  uri: URI,
  callback: (document: EntityDocument | undefined) => void,
) => Cancel;

/**
 * `replica`'s raw-document subscription, bound.
 *
 * `sinkDocument` belongs to the v2 replica and to no interface. Putting it on
 * `ISpaceReplica` so a test could name it would oblige every future replica
 * implementation to supply one for a test's benefit, so this file reaches past
 * the interface instead — here, and nowhere else. This is the one place the
 * file claims a capability no interface declares, and the claim is guarded: a
 * replica without the method is reported by name from `beforeEach` rather than
 * left to throw a bare `TypeError` from whichever case happened to run first.
 * Everything `ISpaceReplica` already covers goes through it directly.
 */
const rawDocumentSink = (replica: ISpaceReplica): SinkDocument => {
  const { sinkDocument } = replica as ISpaceReplica & {
    sinkDocument?: SinkDocument;
  };
  if (typeof sinkDocument !== "function") {
    throw new Error(
      "no `sinkDocument` on this replica: these cases describe the v2 " +
        "implementation, whose raw-document subscription they reach for past " +
        "`ISpaceReplica`",
    );
  }
  return sinkDocument.bind(replica);
};

describe("raw document subscription", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let writerRt: Runtime;
  let readerStorage: EmulatedStorageManager;
  let readerRt: Runtime;
  let readerReplica: ISpaceReplica;
  let sinkDocument: SinkDocument;
  let collectionUri: URI;

  /** The element and body cells `label` names, created inside `tx`. */
  const writeEntry = (
    tx: ReturnType<Runtime["edit"]>,
    label: string,
  ) => {
    const body = writerRt.getCell(space, `${label}-body`, bodySchema, tx);
    body.set({ text: `body of ${label}` });
    const entry = writerRt.getCell(space, `${label}-entry`, entrySchema, tx);
    entry.set({ title: label, body });
    return entry;
  };

  const bodyUri = (label: string): URI =>
    writerRt.getCell(space, `${label}-body`, bodySchema)
      .getAsNormalizedFullLink().id as URI;

  beforeEach(async () => {
    server = newSharedServer();
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writerRt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });

    const tx = writerRt.edit();
    const collection = writerRt.getCell(
      space,
      COLLECTION,
      collectionSchema,
      tx,
    );
    collection.set({
      name: "base",
      items: Array.from(
        { length: BASE_ITEMS },
        (_unused, index) => writeEntry(tx, `base-${index}`),
      ),
    });
    // The SAME document under the `user` instance: a different collection with
    // a different membership, reached by the same URI.
    const overlay = writerRt.getCell(
      space,
      COLLECTION,
      collectionSchema,
      tx,
      "user",
    );
    overlay.set({ name: "overlay", items: [writeEntry(tx, "overlay-0")] });
    const commit = await tx.commit();
    expect(commit.error).toBeUndefined();
    await writerStorage.synced();
    await writerRt.idle();

    collectionUri = writerRt.getCell(space, COLLECTION, collectionSchema)
      .getAsNormalizedFullLink().id as URI;

    readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    readerRt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    readerReplica = readerStorage.open(space).replica;
    sinkDocument = rawDocumentSink(readerReplica);
  });

  afterEach(async () => {
    await readerRt?.dispose();
    await readerStorage?.close();
    await writerRt?.dispose();
    await writerStorage?.close();
    await server?.close();
  });

  it("hands the callback the collection's raw links and loads no element document", async () => {
    const seen: unknown[] = [];
    const cancel = sinkDocument(
      collectionUri,
      (document) => seen.push(document),
    );
    await readerRt.idle();
    await readerStorage.synced();
    await readerRt.idle();
    cancel();

    expect(seen.length).toBeGreaterThan(0);
    expect(membershipOf(seen.at(-1)).length).toBe(BASE_ITEMS);
    expect(readerReplica.getDocument(bodyUri("base-0"))).toBeUndefined();
  });

  it("loads the element documents when the same collection is read deeply, which is the cost the raw subscription avoids", async () => {
    // The control for the absence above: the body document is reachable from
    // this collection and a deep read does fetch it, so a raw subscription
    // leaving it absent is a fact about the subscription.

    const collection = readerRt.getCell(space, COLLECTION, collectionSchema);
    await collection.sync();
    const cancel = collection.sink(() => {});
    await readerRt.idle();
    await readerStorage.synced();
    await readerRt.idle();
    cancel();

    expect(readerReplica.getDocument(bodyUri("base-0"))).toBeDefined();
  });

  it("fires with the new membership when the server pushes an append", async () => {
    const appended = deferred<unknown[]>();
    const cancel = sinkDocument(collectionUri, (document) => {
      const membership = membershipOf(document);
      if (membership.length === BASE_ITEMS + 1) appended.resolve(membership);
    });
    await readerRt.idle();
    await readerStorage.synced();
    await readerRt.idle();

    const tx = writerRt.edit();
    writerRt.getCell(space, COLLECTION, collectionSchema, tx)
      .key("items")
      .push(writeEntry(tx, "base-appended"));
    const commit = await tx.commit();
    expect(commit.error).toBeUndefined();
    await writerStorage.synced();
    await writerRt.idle();

    const membership = await appended.promise;
    await readerRt.idle();
    cancel();

    expect(membership.length).toBe(BASE_ITEMS + 1);
    // The appended element's body rides in no frame the membership rides in:
    // a fan-out frame carries the documents this session watches, so one
    // carrying the collection carries every element it was going to send.
    expect(readerReplica.getDocument(bodyUri("base-appended")))
      .toBeUndefined();
  });

  it("hands over the base instance's membership while a `user`-scoped read of the same URI sees the overlay's", async () => {
    const seen: unknown[] = [];
    const cancel = sinkDocument(
      collectionUri,
      (document) => seen.push(document),
    );
    const overlay = readerRt.getCell(
      space,
      COLLECTION,
      collectionSchema,
      undefined,
      "user",
    );
    await overlay.sync();
    const cancelOverlay = overlay.sink(() => {});
    await readerRt.idle();
    await readerStorage.synced();
    await readerRt.idle();
    cancel();
    cancelOverlay();

    expect(nameOf(seen.at(-1))).toBe("base");
    expect(membershipOf(seen.at(-1)).length).toBe(BASE_ITEMS);
    expect(overlay.get()?.name).toBe("overlay");
    expect(overlay.get()?.items?.length).toBe(1);
  });

  it("stays silent when the `user` instance of the same URI changes", async () => {
    const seen: unknown[] = [];
    const cancel = sinkDocument(
      collectionUri,
      (document) => seen.push(document),
    );
    await readerRt.idle();
    await readerStorage.synced();
    await readerRt.idle();
    const before = seen.length;

    // The overlay grows first, the base second. The base change is the
    // ordered barrier: once the raw sink has reported it, any firing the
    // overlay change was going to produce has already happened.
    const overlayCommit = writerRt.edit();
    writerRt.getCell(space, COLLECTION, collectionSchema, overlayCommit, "user")
      .key("items")
      .push(writeEntry(overlayCommit, "overlay-appended"));
    expect((await overlayCommit.commit()).error).toBeUndefined();
    await writerStorage.synced();
    await writerRt.idle();

    const barrier = deferred<void>();
    const cancelBarrier = sinkDocument(
      collectionUri,
      (document) => {
        if (membershipOf(document).length === BASE_ITEMS + 1) barrier.resolve();
      },
    );
    const baseCommit = writerRt.edit();
    writerRt.getCell(space, COLLECTION, collectionSchema, baseCommit)
      .key("items")
      .push(writeEntry(baseCommit, "base-appended"));
    expect((await baseCommit.commit()).error).toBeUndefined();
    await writerStorage.synced();
    await writerRt.idle();

    await barrier.promise;
    await readerRt.idle();
    cancel();
    cancelBarrier();

    // One firing since the arm, and it carries the base membership: the
    // overlay's append produced none.
    expect(seen.length - before).toBe(1);
    expect(nameOf(seen.at(-1))).toBe("base");
    expect(membershipOf(seen.at(-1)).length).toBe(BASE_ITEMS + 1);
  });
});
