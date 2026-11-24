import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { FabricValue } from "@commonfabric/api";
import { isFabricPlainObject } from "@commonfabric/data-model";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG, type URI } from "../src/sigil-types.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import type { SessionFactory } from "../src/storage/v2.ts";
import {
  mountOver,
  ResponseHolder,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";
import { captureLogs } from "./support/captured-logs.ts";

const FIRST_ID: URI = "of:quarantine-arrival-first";
const SECOND_ID: URI = "of:quarantine-arrival-second";

const firstSchema = { type: "string", title: "quarantine-arrival-1" } as const;
const firstHash = internSchemaAsTaggedHashString(firstSchema);
const secondSchema = { type: "number", title: "quarantine-arrival-2" } as const;
const secondHash = internSchemaAsTaggedHashString(secondSchema);

/** A document at `revision` whose link's schema names the document `hash`. */
const naming = (revision: number, hash: string): FabricValue => ({
  revision,
  linked: {
    "/": {
      [LINK_V1_TAG]: {
        id: "of:quarantine-arrival-target",
        path: [],
        schema: { $ref: `cid:${hash}` },
      },
    },
  },
});

/**
 * A loopback session factory that drops the `cid:` upserts of as many frames
 * as `dropsLeft` allows, and holds the responses to its client's
 * `session.watch.set` requests as `watchSets` says.
 */
class QuarantiningFactory implements SessionFactory {
  /** How many more frames lose their `cid:` upserts. */
  dropsLeft = 0;

  /** The holder of the responses to `session.watch.set` requests. */
  readonly watchSets = new ResponseHolder("session.watch.set");

  /** Resolves when the client next gets a `session/effect`. */
  nextEffect = Promise.withResolvers<void>();

  readonly #server: MemoryV2Server.Server;

  /** Constructs an instance over `server`. */
  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  /** @inheritDoc */
  create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions?: MemoryV2Client.MountOptions,
  ) {
    const inner = MemoryV2Client.loopback(this.#server);
    return mountOver(
      this.watchSets.wrap({
        ...inner,
        setReceiver: (next) =>
          inner.setReceiver((payload) => next(this.#received(payload))),
      }),
      space,
      signer,
      mountOptions,
    );
  }

  /**
   * Helper for `create()`, which returns what the client receives in place of
   * `payload`.
   */
  #received(payload: string): string {
    const frame = decodeMemoryBoundary(payload);
    if (!isFabricPlainObject(frame)) return payload;
    if (frame.type === "session/effect") {
      const reached = this.nextEffect;
      this.nextEffect = Promise.withResolvers<void>();
      reached.resolve();
      const effect = this.#filtered(frame.effect);
      if (effect !== frame.effect) {
        return encodeMemoryBoundary({ ...frame, effect });
      }
    } else if (frame.type === "response" && isFabricPlainObject(frame.ok)) {
      const sync = this.#filtered(frame.ok.sync);
      if (sync !== frame.ok.sync) {
        return encodeMemoryBoundary({ ...frame, ok: { ...frame.ok, sync } });
      }
    }
    return payload;
  }

  /**
   * Helper for `#received()`, which returns `sync` without its `cid:` upserts
   * while `dropsLeft` allows, and as it is otherwise.
   */
  #filtered(sync: FabricValue): FabricValue {
    if (
      !isFabricPlainObject(sync) || sync.type !== "sync" ||
      !Array.isArray(sync.upserts)
    ) {
      return sync;
    }
    const upserts = sync.upserts.filter((upsert) =>
      !isFabricPlainObject(upsert) || typeof upsert.id !== "string" ||
      !upsert.id.startsWith("cid:")
    );
    if (upserts.length === sync.upserts.length || this.dropsLeft === 0) {
      return sync;
    }
    this.dropsLeft -= 1;
    return { ...sync, upserts };
  }
}

describe("storage/v2", () => {
  let server: MemoryV2Server.Server;
  let signer: Identity;
  let space: MemorySpace;
  let writerStorage: EmulatedStorageManager;
  let writer: Runtime;
  let readerStorage: TestStorageManager;
  let factory: QuarantiningFactory;

  const write = async (values: Record<string, FabricValue>): Promise<void> => {
    const tx = writer.edit();
    for (const [id, value] of Object.entries(values)) {
      tx.writeValueOrThrow(
        { space, id: id as URI, scope: "space", path: [] },
        value,
      );
    }
    expect((await tx.commit().settled).ok).toBeDefined();
  };

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("storage-v2 quarantine arrival");
    space = signer.did();
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      storageManager: writerStorage,
      apiUrl: new URL(import.meta.url),
    });
    factory = new QuarantiningFactory(server);
    readerStorage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://"),
    }, factory);
  });

  afterEach(async () => {
    await readerStorage.close();
    await writer.dispose();
    await writerStorage.close();
    await server.close();
  });

  it("asks again for a document quarantined while the re-delivery of another is outstanding", async () => {
    // The second document's quarantine lands while the first's re-delivery
    // request is in flight, so that request did not ask for it: it is asked
    // for by a request of its own rather than dropped from the quarantine
    // with no copy delivered.

    await write({
      [`cid:${firstHash}`]: firstSchema,
      [FIRST_ID]: naming(1, firstHash),
      [SECOND_ID]: { revision: 1 },
    });
    const provider = readerStorage.open(space);
    const replica = readerStorage.accessForTestingOnly.openReplica(space);
    const revision = (id: URI) => {
      const value = replica.getDocument(id)?.value;
      return isFabricPlainObject(value) ? value.revision : undefined;
    };
    expect((await provider.sync(SECOND_ID, { path: [], schema: false })).error)
      .toBeUndefined();
    expect(revision(SECOND_ID)).toBe(1);

    factory.dropsLeft = 1;
    factory.watchSets.holding = true;
    await provider.sync(FIRST_ID, { path: [], schema: false });
    await factory.watchSets.firstHeld;
    expect(factory.watchSets.sent).toBe(1);

    factory.dropsLeft = 1;
    const effect = factory.nextEffect.promise;
    await write({
      [`cid:${secondHash}`]: secondSchema,
      [SECOND_ID]: naming(2, secondHash),
    });
    await effect;
    using logs = captureLogs("storage.v2");

    factory.watchSets.release();
    await replica.inputSynced();

    expect(factory.watchSets.sent).toBe(2);
    expect(revision(FIRST_ID)).toBe(1);
    expect(revision(SECOND_ID)).toBe(2);
    expect(logs.textsOf("schema-doc-quarantine-unhealed")).toEqual([]);
  });
});
