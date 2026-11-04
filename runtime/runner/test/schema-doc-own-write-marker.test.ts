/**
 * What a replica does with a frame that overtakes the marker frame covering its
 * own write. The server records a session's own accepted writes as delivered,
 * `cid:` documents included, and tells the session with a frame that carries
 * only a marker, so a watch mutation's response can leave such a document out
 * and still reach the wire first. The replica has to find the document anyway,
 * in the write it has not yet promoted (docs/specs/memory-v2/04-protocol.md,
 * section 4.3.6).
 *
 * The case holds the refresh's return, which is the moment between the server's
 * recording the write and its sending the marker, and adds the watch there. That
 * moment is a few microtasks long in production, so only holding it makes the
 * order deterministic.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import type { FabricValue } from "@commonfabric/api";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  type ServerMessage,
  type SessionSync,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG, type URI } from "../src/sigil-types.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import type { SessionFactory, SpaceReplica } from "../src/storage/v2.ts";
import { TestStorageManager } from "./memory-v2-test-utils.ts";

const WATCHED_ID = "of:own-write-marker-watched";
const OTHER_ID = "of:own-write-marker-other";

const leafSchema = { type: "string", title: "own-write-marker-leaf" } as const;
const leafHash = internSchemaAsTaggedHashString(leafSchema);
const LEAF_ID = `cid:${leafHash}`;

/** A document value naming the leaf schema through a link's schema position. */
const naming: FabricValue = {
  linked: {
    "/": {
      [LINK_V1_TAG]: {
        id: "of:own-write-marker-target",
        path: [],
        schema: { $ref: LEAF_ID },
      },
    },
  },
};

/** A loopback session factory that records the frames its client receives. */
class FrameRecordingFactory implements SessionFactory {
  /** The session frames received, in order. */
  readonly frames: SessionSync[] = [];

  readonly #server: MemoryV2Server.Server;

  /** Constructs an instance over `server`. */
  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  /** @inheritDoc */
  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryV2Client.MountOptions = {},
  ) {
    const client = await MemoryV2Client.connect({
      transport: this.#transport(),
      instanceNames: namesInstancesByDefault(),
    });
    const session = await client.mount(
      space,
      mountOptions,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    return { client, session };
  }

  #transport(): MemoryV2Client.Transport {
    const inner = MemoryV2Client.loopback(this.#server);
    return {
      ...inner,
      setReceiver: (next) =>
        inner.setReceiver((payload) => {
          const message = decodeMemoryBoundary(payload) as
            & ServerMessage
            & { effect?: SessionSync; ok?: { sync?: SessionSync } };
          const sync = message.type === "session/effect"
            ? message.effect
            : message.ok?.sync;
          if (sync?.type === "sync") this.frames.push(sync);
          next(payload);
        }),
    };
  }
}

/** How many quarantine errors this process has logged. */
const quarantineErrors = (): number => {
  const counts = getLoggerCountsBreakdown()["storage.v2"] as unknown as
    | Record<string, { error?: number }>
    | undefined;
  return counts?.["schema-doc-quarantine"]?.error ?? 0;
};

describe("schema-doc-own-write-marker", () => {
  let server: MemoryV2Server.Server;
  let space: MemorySpace;
  let factory: FrameRecordingFactory;
  let authorStorage: TestStorageManager;
  let author: Runtime;
  let otherStorage: EmulatedStorageManager;
  let other: Runtime;

  const edit = (runtime: Runtime, values: Record<string, FabricValue>) => {
    const tx = runtime.edit();
    for (const [id, value] of Object.entries(values)) {
      tx.writeValueOrThrow(
        { space, id: id as URI, scope: "space", path: [] },
        value,
      );
    }
    return tx.commit();
  };

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("own-write-marker");
    space = signer.did();
    server = newLoopbackServer({ subscriptionRefreshDelayMs: "manual" });
    factory = new FrameRecordingFactory(server);
    authorStorage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://"),
    }, factory);
    author = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: authorStorage,
    });
    otherStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    other = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: otherStorage,
    });
  });

  afterEach(async () => {
    await author.dispose();
    await authorStorage.close();
    await other.dispose();
    await otherStorage.close();
    await server.close();
  });

  it("finds a left-out `cid:` document among the writes the marker has yet to promote", async () => {
    const storage = authorStorage.open(space);
    const replica = storage.replica as SpaceReplica;
    await storage.sync(WATCHED_ID as URI, { path: [], schema: false });

    // The author's commit carries the leaf and a document naming it, both on
    // the author's watch, so its refresh holds back both as the author's own.
    const receipt = edit(author, {
      [LEAF_ID]: leafSchema as unknown as FabricValue,
      [WATCHED_ID]: naming,
    });
    expect((await receipt.verdict).ok).toBeDefined();
    expect((await edit(other, { [OTHER_ID]: naming }).verdict).ok)
      .toBeDefined();

    const reached = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const refresh = server.syncSessionForConnection.bind(server);
    let held = false;
    server.syncSessionForConnection = async (...args) => {
      const result = await refresh(...args);
      if (!held && result !== null && result.effect.upserts.length === 0) {
        held = true;
        reached.resolve();
        await released.promise;
      }
      return result;
    };
    const flushed = server.flushSessions([space]);
    await reached.promise;

    const from = factory.frames.length;
    const quarantinedBefore = quarantineErrors();
    await storage.sync(OTHER_ID as URI, { path: [], schema: false });

    // The response leaves the leaf out, and the write holding it is unpromoted.
    const [response, ...rest] = factory.frames.slice(from);
    expect(rest).toEqual([]);
    expect(response.upserts.map(({ id }) => id)).toEqual([OTHER_ID]);
    expect(replica.isContentAddressedDocPersisted(leafHash)).toBe(false);
    expect(quarantineErrors()).toBe(quarantinedBefore);
    expect(replica.getDocument(OTHER_ID as URI)).toBeDefined();

    released.resolve();
    await flushed;
    expect((await receipt.settled).ok).toBeDefined();

    const [marker] = factory.frames.slice(from + 1);
    expect(marker.upserts).toEqual([]);
    expect(marker.caughtUpLocalSeq).toBeDefined();
    expect(replica.isContentAddressedDocPersisted(leafHash)).toBe(true);
  });
});
