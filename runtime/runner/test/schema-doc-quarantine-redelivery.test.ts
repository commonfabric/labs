/**
 * What becomes of a document the arrival validator quarantined
 * (docs/specs/content-addressed-schemas.md): the replica asks for it again, a
 * read waits for that rather than taking it for absent, and a copy that cannot
 * be applied ends in a failed read rather than another request.
 *
 * The defect is placed at the wire: a loopback transport drops the `cid:`
 * upserts of the frames it is told to, so the replica gets exactly what a
 * replica that lost them would have, and the server's own delivery is untouched.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import type { FabricValue } from "@commonfabric/api";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type ServerMessage,
  type SessionSync,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { DocumentLoadError, loadDocument } from "../src/document-readiness.ts";
import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG, type URI } from "../src/sigil-types.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import type { SessionFactory, SpaceReplica } from "../src/storage/v2.ts";
import { TestStorageManager } from "./memory-v2-test-utils.ts";

/** How many re-deliveries prove a loop, past which the transport stops dropping. */
const LOOP_BOUND = 4;

const DOCUMENT_ID = "of:quarantine-redelivery-document";
const ABSENT_ID = "of:quarantine-redelivery-absent";

const leafSchema = { type: "string", title: "redelivery-leaf" } as const;
const leafHash = internSchemaAsTaggedHashString(leafSchema);

/**
 * A loopback session factory that drops the `cid:` upserts of as many frames as
 * `dropsLeft` allows, and counts the watch sets its client sends.
 */
class CidDroppingFactory implements SessionFactory {
  /** How many more frames lose their `cid:` upserts. */
  dropsLeft: number;

  /** How many `session.watch.set` requests the client has sent. */
  watchSets = 0;

  /** Whether the server appears not to take declared holdings. */
  hidesHoldings = false;

  /** Resolves when the client first sends a `session.watch.set`. */
  readonly firstWatchSet = Promise.withResolvers<void>();

  readonly #server: MemoryV2Server.Server;

  /** Constructs an instance over `server` that drops from `drops` frames. */
  constructor(server: MemoryV2Server.Server, drops: number) {
    this.#server = server;
    this.dropsLeft = drops;
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
      send: (payload) => {
        const sent = decodeMemoryBoundary(payload) as { type?: string };
        if (sent.type === "session.watch.set") {
          this.watchSets += 1;
          this.firstWatchSet.resolve();
          if (this.watchSets >= LOOP_BOUND) this.dropsLeft = 0;
        }
        return inner.send(payload);
      },
      setReceiver: (next) =>
        inner.setReceiver((payload) =>
          next(
            encodeMemoryBoundary(
              this.#filter(
                decodeMemoryBoundary(payload) as unknown as ServerMessage,
              ) as unknown as FabricValue,
            ),
          )
        ),
    };
  }

  #filter(message: ServerMessage): ServerMessage {
    const frame = message as ServerMessage & {
      effect?: SessionSync;
      ok?: { sync?: SessionSync };
      flags?: Record<string, unknown>;
    };
    if (frame.type === "hello.ok" && this.hidesHoldings) {
      return {
        ...(frame as object),
        flags: { ...frame.flags, sessionHoldings: false },
      } as unknown as ServerMessage;
    }
    if (frame.type === "session/effect" && frame.effect?.type === "sync") {
      return {
        ...(frame as object),
        effect: this.#filterSync(frame.effect),
      } as unknown as ServerMessage;
    }
    if (frame.type === "response" && frame.ok?.sync?.type === "sync") {
      return {
        ...(frame as object),
        ok: { ...(frame.ok as object), sync: this.#filterSync(frame.ok.sync) },
      } as unknown as ServerMessage;
    }
    return message;
  }

  #filterSync(sync: SessionSync): SessionSync {
    const upserts = sync.upserts.filter((upsert) =>
      !upsert.id.startsWith("cid:")
    );
    if (upserts.length === sync.upserts.length || this.dropsLeft === 0) {
      return sync;
    }
    this.dropsLeft -= 1;
    return { ...sync, upserts };
  }
}

/** How many unhealed-quarantine errors this process has logged. */
const unhealedErrors = (): number => {
  const counts = getLoggerCountsBreakdown()["storage.v2"] as unknown as
    | Record<string, { error?: number }>
    | undefined;
  return counts?.["schema-doc-quarantine-unhealed"]?.error ?? 0;
};

describe("schema-doc-quarantine-redelivery", () => {
  let server: MemoryV2Server.Server;
  let signer: Identity;
  let space: MemorySpace;
  let writerStorage: EmulatedStorageManager;
  let writer: Runtime;
  const cleanups: (() => Promise<void>)[] = [];

  const naming = (revision: number, hash = leafHash): FabricValue => ({
    revision,
    linked: {
      "/": {
        [LINK_V1_TAG]: {
          id: "of:quarantine-redelivery-target",
          path: [],
          schema: { $ref: `cid:${hash}` },
        },
      },
    },
  });

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

  /** A reader over a transport that drops `cid:` upserts from `drops` frames. */
  const readerDropping = (drops: number) => {
    const factory = new CidDroppingFactory(server, drops);
    const storage = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("memory://"),
    }, factory);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await storage.close();
    });
    const replica = storage.open(space).replica as SpaceReplica;
    const cellOf = (id: string) =>
      runtime.getCellFromLink({
        space,
        id: id as URI,
        scope: "space",
        path: [],
        schema: { type: "unknown" },
      });
    const revision = () =>
      (replica.getDocument(DOCUMENT_ID as URI) as
        | { value?: { revision?: number } }
        | undefined)?.value?.revision;
    return { factory, runtime, storage, replica, cellOf, revision };
  };

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("quarantine-redelivery");
    space = signer.did();
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      storageManager: writerStorage,
      apiUrl: new URL(import.meta.url),
    });
    await write({
      [`cid:${leafHash}`]: leafSchema as unknown as FabricValue,
      [DOCUMENT_ID]: naming(1),
    });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    await writer.dispose();
    await writerStorage.close();
    await server.close();
  });

  describe("a copy the re-delivery can apply", () => {
    it("loads as present, with one request for it", async () => {
      const { factory, runtime, cellOf, revision } = readerDropping(1);

      const present = await loadDocument(runtime, cellOf(DOCUMENT_ID));

      expect(factory.dropsLeft).toBe(0);
      expect(present).toBe(true);
      expect(revision()).toBe(1);
      expect(factory.watchSets).toBe(1);
    });

    it("has applied it by the time `inputSynced()` resolves, with no load waiting", async () => {
      const { factory, storage, replica, revision } = readerDropping(1);
      await storage.open(space).sync(DOCUMENT_ID as URI, {
        path: [],
        schema: false,
      });

      await replica.inputSynced();

      expect(factory.dropsLeft).toBe(0);
      expect(revision()).toBe(1);
    });

    it("has applied it by the time `synced()` resolves, with no load waiting", async () => {
      const { factory, storage, replica, revision } = readerDropping(1);
      await storage.open(space).sync(DOCUMENT_ID as URI, {
        path: [],
        schema: false,
      });

      await replica.synced();

      expect(factory.dropsLeft).toBe(0);
      expect(revision()).toBe(1);
    });

    it("logs no unhealed quarantine", async () => {
      const before = unhealedErrors();
      const { runtime, cellOf } = readerDropping(1);

      await loadDocument(runtime, cellOf(DOCUMENT_ID));

      expect(unhealedErrors()).toBe(before);
    });
  });

  describe("a copy no re-delivery can apply", () => {
    it("fails the load instead of reading as absent", async () => {
      const { runtime, cellOf, revision } = readerDropping(Infinity);

      await expect(loadDocument(runtime, cellOf(DOCUMENT_ID))).rejects.toThrow(
        DocumentLoadError,
      );
      expect(revision()).toBeUndefined();
    });

    it("asks once, however often it is read", async () => {
      const { factory, runtime, cellOf } = readerDropping(Infinity);

      for (let reads = 0; reads < 3; reads++) {
        await expect(loadDocument(runtime, cellOf(DOCUMENT_ID))).rejects
          .toThrow(DocumentLoadError);
      }
      await server.idle();

      expect(factory.watchSets).toBe(1);
    });

    it("logs one error saying the document stays quarantined", async () => {
      const before = unhealedErrors();
      const { runtime, cellOf } = readerDropping(Infinity);

      await expect(loadDocument(runtime, cellOf(DOCUMENT_ID))).rejects.toThrow(
        DocumentLoadError,
      );
      await expect(loadDocument(runtime, cellOf(DOCUMENT_ID))).rejects.toThrow(
        DocumentLoadError,
      );

      expect(unhealedErrors()).toBe(before + 1);
    });

    it("loads once a newer copy applies", async () => {
      const { factory, runtime, storage, cellOf, revision } = readerDropping(
        Infinity,
      );
      await expect(loadDocument(runtime, cellOf(DOCUMENT_ID))).rejects.toThrow(
        DocumentLoadError,
      );
      factory.dropsLeft = 0;

      const arrived = Promise.withResolvers<void>();
      storage.subscribe({
        next() {
          if (revision() !== 2) return undefined;
          arrived.resolve();
          return { done: true };
        },
      });
      await write({ [DOCUMENT_ID]: naming(2) });
      await arrived.promise;

      expect(await loadDocument(runtime, cellOf(DOCUMENT_ID))).toBe(true);
      expect(revision()).toBe(2);
    });
  });

  describe("a quarantined document a later frame settles", () => {
    /** A reader whose read of the document has failed, and stopped dropping. */
    const failedReader = async () => {
      const reader = readerDropping(Infinity);
      await expect(
        loadDocument(reader.runtime, reader.cellOf(DOCUMENT_ID)),
      ).rejects.toThrow(DocumentLoadError);
      reader.factory.dropsLeft = 0;
      return reader;
    };

    it("loads as present once a frame applies a newer copy", async () => {
      const { factory, replica, runtime, cellOf, revision } =
        await failedReader();

      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 900_000,
        toSeq: 900_001,
        upserts: [{
          branch: "",
          id: `cid:${leafHash}`,
          scope: "space",
          seq: 900_001,
          doc: { value: leafSchema },
        }, {
          branch: "",
          id: DOCUMENT_ID,
          scope: "space",
          seq: 900_001,
          doc: { value: naming(3) },
        }],
        removes: [],
      }, "integrate");

      expect(await loadDocument(runtime, cellOf(DOCUMENT_ID))).toBe(true);
      expect(revision()).toBe(3);
      expect(factory.watchSets).toBe(1);
    });

    it("stops failing its load once a frame removes it", async () => {
      const { replica } = await failedReader();

      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 900_000,
        toSeq: 900_001,
        upserts: [],
        removes: [{ branch: "", id: DOCUMENT_ID, scope: "space" }],
      }, "integrate");

      expect(await replica.quarantineFailure(DOCUMENT_ID as URI, "space"))
        .toBeUndefined();
    });
  });

  describe("a newer copy no re-delivery can apply", () => {
    it("leaves the copy already applied to read, and loads as present", async () => {
      const before = unhealedErrors();
      const { factory, replica, runtime, cellOf, revision } = readerDropping(0);
      expect(await loadDocument(runtime, cellOf(DOCUMENT_ID))).toBe(true);
      const otherSchema = {
        type: "number",
        title: "redelivery-other",
      } as const;
      const otherHash = internSchemaAsTaggedHashString(otherSchema);
      factory.dropsLeft = Infinity;

      await write({
        [`cid:${otherHash}`]: otherSchema as unknown as FabricValue,
        [DOCUMENT_ID]: naming(2, otherHash),
      });
      await factory.firstWatchSet.promise;
      await replica.quarantineFailure(DOCUMENT_ID as URI, "space");

      expect(unhealedErrors()).toBe(before + 1);
      expect(await loadDocument(runtime, cellOf(DOCUMENT_ID))).toBe(true);
      expect(revision()).toBe(1);
    });
  });

  describe("a copy no re-delivery can apply, over an applied deletion", () => {
    it("fails the load instead of reading as absent", async () => {
      const { replica, runtime, cellOf } = readerDropping(Infinity);
      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 0,
        toSeq: 1,
        upserts: [{
          branch: "",
          id: DOCUMENT_ID,
          scope: "space",
          seq: 1,
          deleted: true,
        }],
        removes: [],
      }, "integrate");

      await expect(loadDocument(runtime, cellOf(DOCUMENT_ID))).rejects.toThrow(
        DocumentLoadError,
      );
    });
  });

  describe("a quarantine on a server that takes no declared holdings", () => {
    it("fails the load without asking, and logs that it stays quarantined", async () => {
      const before = unhealedErrors();
      const reader = readerDropping(Infinity);
      reader.factory.hidesHoldings = true;

      await expect(
        loadDocument(reader.runtime, reader.cellOf(DOCUMENT_ID)),
      ).rejects.toThrow(DocumentLoadError);

      expect(reader.factory.watchSets).toBe(0);
      expect(unhealedErrors()).toBe(before + 1);
    });
  });

  describe("a document nothing quarantined", () => {
    it("loads as absent when the server does not hold it", async () => {
      const { factory, runtime, cellOf } = readerDropping(0);

      expect(await loadDocument(runtime, cellOf(ABSENT_ID))).toBe(false);
      expect(factory.watchSets).toBe(0);
    });
  });
});
