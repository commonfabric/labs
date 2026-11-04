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
  type ResponseMessage,
  type ServerMessage,
  type SessionSync,
} from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import {
  createDocumentReadiness,
  DocumentLoadError,
  DocumentPending,
  loadDocument,
} from "../src/document-readiness.ts";
import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import { Runtime } from "../src/runtime.ts";
import { LINK_V1_TAG, type URI } from "../src/sigil-types.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import type {
  NativeStorageCommit,
  SealedCommitVerdict,
} from "../src/storage/interface.ts";
import type { SessionFactory, SpaceReplica } from "../src/storage/v2.ts";
import { TestStorageManager } from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

/** How many re-deliveries prove a loop, past which the transport stops dropping. */
const LOOP_BOUND = 4;

const DOCUMENT_ID = "of:quarantine-redelivery-document";
const ABSENT_ID = "of:quarantine-redelivery-absent";
const PLAIN_ID = "of:quarantine-redelivery-plain";
const OWN_ID = "of:quarantine-redelivery-own";
const OUTPUT_ID = "of:quarantine-redelivery-output";
const TRIGGER_ID = "of:quarantine-redelivery-trigger";

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

  /** The ids each `session.watch.set` declared as held, in order. */
  readonly watchSetHoldings: string[][] = [];

  /** Each `session.watch.set`'s response frame as the client got it, in order. */
  readonly watchSetResponses: SessionSync[] = [];

  /** Every session frame the client got, in order, after any dropping. */
  readonly frames: SessionSync[] = [];

  /** Rewrites a `session.watch.set` response on its way to the client. */
  rewriteWatchSetResponse:
    | ((response: ServerMessage) => ServerMessage)
    | undefined;

  /** The request types whose responses wait for `releaseResponses()`. */
  readonly heldTypes = new Set<string>();

  /** Resolves when the client next gets a `session/effect`. */
  nextEffect = Promise.withResolvers<void>();

  /** Resolves when a response is first held. */
  readonly responseHeld = Promise.withResolvers<void>();

  readonly #requestTypes = new Map<string, string>();

  #held: (() => void)[] = [];

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

  /** Delivers the held responses, and holds no more. */
  releaseResponses(): void {
    this.heldTypes.clear();
    for (const deliver of this.#held.splice(0)) deliver();
  }

  #transport(): MemoryV2Client.Transport {
    const inner = MemoryV2Client.loopback(this.#server);
    return {
      ...inner,
      send: (payload) => {
        const sent = decodeMemoryBoundary(payload) as {
          type?: string;
          requestId?: string;
          holdings?: { id: string }[];
        };
        if (sent.requestId !== undefined && sent.type !== undefined) {
          this.#requestTypes.set(sent.requestId, sent.type);
        }
        if (sent.type === "session.watch.set") {
          this.watchSetHoldings.push(
            (sent.holdings ?? []).map(({ id }) => id),
          );
          this.watchSets += 1;
          this.firstWatchSet.resolve();
          if (this.watchSets >= LOOP_BOUND) this.dropsLeft = 0;
        }
        return inner.send(payload);
      },
      setReceiver: (next) =>
        inner.setReceiver((payload) => {
          const message = this.#filter(
            decodeMemoryBoundary(payload) as unknown as ServerMessage,
          );
          const encoded = encodeMemoryBoundary(
            message as unknown as FabricValue,
          );
          const requestType = message.type === "response"
            ? this.#requestTypes.get(message.requestId)
            : undefined;
          if (requestType !== undefined && this.heldTypes.has(requestType)) {
            this.#held.push(() => next(encoded));
            this.responseHeld.resolve();
            return;
          }
          next(encoded);
          if (message.type === "session/effect") {
            const reached = this.nextEffect;
            this.nextEffect = Promise.withResolvers<void>();
            reached.resolve();
          }
        }),
    };
  }

  #filter(arriving: ServerMessage): ServerMessage {
    const message = arriving.type === "response" &&
        this.#requestTypes.get(arriving.requestId) === "session.watch.set"
      ? this.rewriteWatchSetResponse?.(arriving) ?? arriving
      : arriving;
    const filtered = this.#dropped(message);
    const { effect, ok } = filtered as {
      effect?: SessionSync;
      ok?: { sync?: SessionSync };
    };
    const sync = effect ?? ok?.sync;
    if (sync?.type === "sync") {
      this.frames.push(sync);
      if (
        filtered.type === "response" &&
        this.#requestTypes.get(filtered.requestId) === "session.watch.set"
      ) {
        this.watchSetResponses.push(sync);
      }
    }
    return filtered;
  }

  #dropped(message: ServerMessage): ServerMessage {
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

describe("storage/v2", () => {
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

  const writeAs = async (
    runtime: Runtime,
    values: Record<string, FabricValue>,
  ): Promise<void> => {
    const tx = runtime.edit();
    for (const [id, value] of Object.entries(values)) {
      tx.writeValueOrThrow(
        { space, id: id as URI, scope: "space", path: [] },
        value,
      );
    }
    expect((await tx.commit().settled).ok).toBeDefined();
  };

  const write = (values: Record<string, FabricValue>): Promise<void> =>
    writeAs(writer, values);

  /** A schema no reader has been sent, and a `cid:` document's value for it. */
  const otherSchema = { type: "number", title: "redelivery-other" } as const;
  const otherHash = internSchemaAsTaggedHashString(otherSchema);

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
    let closed: Promise<void> | undefined;
    const close = (): Promise<void> =>
      closed ??= (async () => {
        await runtime.dispose();
        await storage.close();
      })();
    cleanups.push(close);
    const replica = storage.open(space).replica as SpaceReplica;
    const cellOf = (id: string) =>
      runtime.getCellFromLink({
        space,
        id: id as URI,
        scope: "space",
        path: [],
        schema: { type: "unknown" },
      });
    const revision = (id = DOCUMENT_ID) =>
      (replica.getDocument(id as URI) as
        | { value?: { revision?: number } }
        | undefined)?.value?.revision;
    /** Syncs `id` with no load waiting on what becomes of it. */
    const syncOf = (id: string) =>
      storage.open(space).sync(id as URI, { path: [], schema: false });
    return {
      factory,
      runtime,
      storage,
      replica,
      cellOf,
      revision,
      syncOf,
      close,
    };
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

    it("declares what it holds, so its response carries only the document and its closure", async () => {
      await write({ [PLAIN_ID]: { revision: 1 } });
      const { factory, runtime, cellOf } = readerDropping(0);
      await loadDocument(runtime, cellOf(PLAIN_ID));
      factory.dropsLeft = 1;

      await loadDocument(runtime, cellOf(DOCUMENT_ID));

      expect(factory.watchSetHoldings).toEqual([[PLAIN_ID]]);
      const [response] = factory.watchSetResponses;
      expect(response.upserts.map(({ id }) => id).toSorted()).toEqual(
        [`cid:${leafHash}`, DOCUMENT_ID].toSorted(),
      );
      expect(response.removes).toEqual([]);
    });

    it("leaves a commit free to settle while its response is outstanding", async () => {
      await write({ [PLAIN_ID]: { revision: 1 } });
      const { factory, runtime, replica, cellOf, syncOf, revision } =
        readerDropping(0);
      await loadDocument(runtime, cellOf(PLAIN_ID));
      factory.dropsLeft = 1;
      factory.heldTypes.add("session.watch.set");
      await syncOf(DOCUMENT_ID);
      await factory.firstWatchSet.promise;
      const effect = factory.nextEffect.promise;
      const tx = runtime.edit();
      tx.writeValueOrThrow(
        { space, id: PLAIN_ID as URI, scope: "space", path: [] },
        { revision: 2 },
      );
      const receipt = tx.commit();
      expect((await receipt.verdict).ok).toBeDefined();
      await effect;
      expect((await receipt.settled).ok).toBeDefined();

      factory.releaseResponses();
      await replica.inputSynced();

      expect(revision(PLAIN_ID)).toBe(2);
      expect(revision()).toBe(1);
    });

    it("keeps a retracted document's value for its holder", async () => {
      await write({ [PLAIN_ID]: { revision: 1 } });
      const { factory, runtime, replica, cellOf, revision } = readerDropping(0);
      await loadDocument(runtime, cellOf(PLAIN_ID));
      const release = replica.sinkDocument(PLAIN_ID as URI, () => {});
      factory.dropsLeft = 1;
      factory.rewriteWatchSetResponse = (response) => {
        const { ok } = response as ResponseMessage<{ sync: SessionSync }>;
        return {
          ...response,
          ok: {
            ...ok,
            sync: {
              ...ok!.sync,
              removes: [{ branch: "", id: PLAIN_ID, scope: "space" }],
            },
          },
        } as ServerMessage;
      };

      await loadDocument(runtime, cellOf(DOCUMENT_ID));

      expect(replica.holdings().map(({ id }) => id)).not.toContain(PLAIN_ID);
      expect(revision(PLAIN_ID)).toBe(1);
      release();
    });

    it("heals a later copy with a request of its own", async () => {
      const { factory, runtime, replica, cellOf, revision } = readerDropping(1);
      await loadDocument(runtime, cellOf(DOCUMENT_ID));
      factory.dropsLeft = 1;

      const effect = factory.nextEffect.promise;
      await write({
        [`cid:${otherHash}`]: otherSchema as unknown as FabricValue,
        [DOCUMENT_ID]: naming(2, otherHash),
      });
      await effect;
      await replica.framesApplied();

      expect(factory.watchSets).toBe(2);
      expect(revision()).toBe(2);
    });

    it("has applied it by the time `inputSynced()` resolves, with no load waiting", async () => {
      const { factory, syncOf, replica, revision } = readerDropping(1);
      await syncOf(DOCUMENT_ID);

      await replica.inputSynced();

      expect(factory.dropsLeft).toBe(0);
      expect(revision()).toBe(1);
    });

    it("has applied it by the time `synced()` resolves, with no load waiting", async () => {
      const { factory, syncOf, replica, revision } = readerDropping(1);
      await syncOf(DOCUMENT_ID);

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

  describe("a re-delivery under way", () => {
    /** A reader whose re-delivery of the document has gone out unanswered. */
    const healingReader = () => {
      const reader = readerDropping(1);
      reader.factory.heldTypes.add("session.watch.set");
      return reader;
    };

    it("is not ended by another frame carrying the same copy", async () => {
      const before = unhealedErrors();
      const { factory, replica, runtime, cellOf, revision } = healingReader();
      const load = loadDocument(runtime, cellOf(DOCUMENT_ID));
      await factory.firstWatchSet.promise;
      const { seq } = factory.frames[0].upserts.find(({ id }) =>
        id === DOCUMENT_ID
      )!;

      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 0,
        toSeq: seq,
        upserts: [{
          branch: "",
          id: DOCUMENT_ID,
          scope: "space",
          seq,
          doc: { value: naming(1) },
        }],
        removes: [],
      }, "integrate");
      factory.releaseResponses();

      expect(await load).toBe(true);
      expect(revision()).toBe(1);
      expect(unhealedErrors()).toBe(before);
    });

    it("runs no computed while its input's load waits, so no absent value is stored", async () => {
      const { factory, runtime, replica, cellOf } = healingReader();
      const load = loadDocument(runtime, cellOf(DOCUMENT_ID));
      await factory.firstWatchSet.promise;
      const { commonfabric: cf } = createTrustedBuilder(runtime);
      const seen: unknown[] = [];
      // deno-lint-ignore no-explicit-any -- the builder's lift type is untyped
      const computeName = (cf as any).lift(
        (value: { revision?: number } | undefined) => {
          seen.push(value?.revision);
          return value?.revision ?? "absent";
        },
      );
      // deno-lint-ignore no-explicit-any -- the page's input is untyped
      const page = (cf as any).pattern(({ source }: any) => ({
        name: computeName(source),
      }));
      const tx = runtime.edit();
      const result = runtime.run(
        tx,
        page,
        { source: cellOf(DOCUMENT_ID).withTx(tx) },
        runtime.getCell(space, "quarantine-redelivery-page", undefined, tx),
      );
      expect((await tx.commit().verdict).ok).toBeDefined();
      const shown: unknown[] = [];
      const cancel = result.key("name").sink((value: unknown) => {
        shown.push(value);
      });
      await runtime.idle();
      await server.idle();
      await runtime.idle();

      /** What a runtime with no quarantine finds stored for the computed. */
      const stored = async (): Promise<unknown> => {
        const link = result.key("name").resolveAsCell()
          .getAsNormalizedFullLink();
        const fresh = readerDropping(0);
        const cell = fresh.runtime.getCellFromLink({
          ...link,
          schema: { type: "unknown" },
        });
        await loadDocument(fresh.runtime, cell);
        return cell.getRaw();
      };

      expect(seen).toEqual([]);
      expect(await stored()).toBeUndefined();

      factory.releaseResponses();
      expect(await load).toBe(true);
      await replica.synced();
      await runtime.idle();
      await replica.synced();
      await server.idle();
      await runtime.idle();

      expect(seen).toEqual([1]);
      expect(shown.at(-1)).toBe(1);
      expect(await stored()).toBe(1);
      cancel();
    });

    it("stores nothing from a computed's absent read, and repairs it when the document arrives", async () => {
      await write({ [TRIGGER_ID]: { revision: 1 } });
      const { factory, runtime, replica, cellOf } = readerDropping(0);
      const { commonfabric: cf } = createTrustedBuilder(runtime);
      // deno-lint-ignore no-explicit-any -- the builder's lift type is untyped
      const compute = (cf as any).lift(
        ({ trigger, source }: {
          trigger?: { revision?: number };
          source?: { revision?: number };
        }) => `${trigger?.revision}:${source?.revision ?? "absent"}`,
      );
      // deno-lint-ignore no-explicit-any -- the page's input is untyped
      const page = (cf as any).pattern(({ trigger, source }: any) => ({
        name: compute({ trigger, source }),
      }));
      const tx = runtime.edit();
      const result = runtime.run(
        tx,
        page,
        {
          trigger: cellOf(TRIGGER_ID).withTx(tx),
          source: cellOf(ABSENT_ID).withTx(tx),
        },
        runtime.getCell(space, "quarantine-redelivery-two", undefined, tx),
      );
      expect((await tx.commit().settled).ok).toBeDefined();
      const shown: unknown[] = [];
      const cancel = result.key("name").sink((value: unknown) => {
        shown.push(value);
      });
      const settle = async () => {
        await runtime.idle();
        await replica.synced();
        await server.idle();
        await runtime.idle();
      };
      /** What a runtime with no quarantine finds stored for the computed. */
      const stored = async (): Promise<unknown> => {
        const link = result.key("name").resolveAsCell()
          .getAsNormalizedFullLink();
        const fresh = readerDropping(0);
        const cell = fresh.runtime.getCellFromLink({
          ...link,
          schema: { type: "unknown" },
        });
        await loadDocument(fresh.runtime, cell);
        return cell.getRaw();
      };
      await settle();
      expect(await stored()).toBe("1:absent");

      // The second input changes while the first is held back, so the computed
      // runs again and reads the first as absent.
      factory.dropsLeft = 1;
      factory.heldTypes.add("session.watch.set");
      await write({ [ABSENT_ID]: naming(1) });
      await factory.firstWatchSet.promise;
      const effect = factory.nextEffect.promise;
      await write({ [TRIGGER_ID]: { revision: 2 } });
      await effect;
      await runtime.idle();
      await server.idle();
      await runtime.idle();

      expect(replica.isQuarantined(ABSENT_ID as URI, "space")).toBe(true);
      expect(shown.at(-1)).toBe("2:absent");
      expect(await stored()).toBe("1:absent");

      factory.releaseResponses();
      await settle();

      expect(shown.at(-1)).toBe("2:1");
      expect(await stored()).toBe("2:1");
      cancel();
    });

    it("waits for no sealed commit, which the input barriers must not", async () => {
      const { factory, syncOf, replica, revision } = healingReader();
      const verdict = Promise.withResolvers<SealedCommitVerdict>();
      const sealed = replica.sealNative(
        {
          operations: [{
            op: "set",
            id: "of:quarantine-redelivery-sealed" as URI,
            type: "application/json",
            value: { value: 1 },
          }],
        } as unknown as NativeStorageCommit,
        undefined,
        verdict.promise,
        { reads: { confirmed: [], pending: [] } },
      );
      await syncOf(DOCUMENT_ID);
      await factory.firstWatchSet.promise;

      factory.releaseResponses();
      await replica.inputSynced();

      expect(revision()).toBe(1);
      verdict.resolve({ withdrawn: { message: "done with this case" } });
      await sealed.settled;
    });

    it("ends with `close()`, logging nothing about the document", async () => {
      const before = unhealedErrors();
      const { factory, runtime, cellOf, close } = healingReader();
      const load = loadDocument(runtime, cellOf(DOCUMENT_ID));
      const failure = load.then(() => undefined, (error: Error) => error);
      await factory.firstWatchSet.promise;

      await close();

      expect(await failure).toBeInstanceOf(DocumentLoadError);
      expect(unhealedErrors()).toBe(before);
    });

    it("applies nothing from a response that lands as the replica closes", async () => {
      const { factory, replica, syncOf, close } = healingReader();
      await syncOf(DOCUMENT_ID);
      await factory.responseHeld.promise;

      factory.releaseResponses();
      const closing = replica.close();
      await closing;
      await close();

      expect(factory.watchSetResponses.length).toBe(1);
      expect(replica.isConfirmedDocument(DOCUMENT_ID as URI, "space"))
        .toBe(false);
    });

    it("reads what was held when the request goes out, not when it was queued", async () => {
      await write({
        [PLAIN_ID]: { revision: 1 },
        [OUTPUT_ID]: { revision: 1 },
      });
      const { factory, runtime, replica, cellOf, syncOf } = readerDropping(0);
      await loadDocument(runtime, cellOf(PLAIN_ID));
      expect(replica.holdings().map(({ id }) => id)).toContain(PLAIN_ID);

      // An earlier mutation holds the re-delivery's turn while a frame retracts
      // the document, and the quarantine comes in during that wait.
      factory.heldTypes.add("session.watch.add");
      const earlier = syncOf(OUTPUT_ID);
      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 900_000,
        toSeq: 900_001,
        upserts: [{
          branch: "",
          id: DOCUMENT_ID,
          scope: "space",
          seq: 900_001,
          doc: { value: naming(1) },
        }],
        removes: [],
      }, "integrate");
      // Past the re-delivery's own wait on the session, which started first.
      await Promise.resolve();
      await replica.ensureSession();
      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 900_001,
        toSeq: 900_002,
        upserts: [],
        removes: [{ branch: "", id: PLAIN_ID, scope: "space" }],
      }, "integrate");

      factory.releaseResponses();
      await earlier;
      await replica.inputSynced();

      expect(factory.watchSetHoldings.length).toBe(1);
      expect(factory.watchSetHoldings[0]).not.toContain(PLAIN_ID);
    });
  });

  describe("a re-delivery the server refuses", () => {
    /** A reader whose re-delivery comes back as `refusal`. */
    const refusedReader = (refusal: Record<string, unknown>) => {
      const reader = readerDropping(1);
      reader.factory.rewriteWatchSetResponse = (response) =>
        ({
          type: "response",
          requestId: (response as ResponseMessage<unknown>).requestId,
          error: { name: "AuthorizationError", message: "refused", ...refusal },
        }) as unknown as ServerMessage;
      return reader;
    };

    it("fails the load with the refusal, and records the denial", async () => {
      const { runtime, storage, cellOf } = refusedReader({});

      const failure = await loadDocument(runtime, cellOf(DOCUMENT_ID))
        .then(() => undefined, (error: Error) => error);

      expect(failure).toBeInstanceOf(DocumentLoadError);
      expect((failure?.cause as Error).message).toContain("refused");
      expect(storage.authorizationError(space)).toBeDefined();
    });

    it("loads as absent when the refusal is of a deleted space", async () => {
      const { runtime, cellOf } = refusedReader({ deleted: true });

      expect(await loadDocument(runtime, cellOf(DOCUMENT_ID))).toBe(false);
    });
  });

  describe("a quarantine a space's existence depends on", () => {
    const writeSpaceCell = () =>
      write({
        [writer.getSpaceCell(space).getAsNormalizedFullLink().id]: naming(1),
      });

    it("reads as existing once the re-delivery applies", async () => {
      await writeSpaceCell();
      const { runtime, factory } = readerDropping(1);

      expect(await runtime.spaceExists(space)).toBe(true);
      expect(factory.watchSets).toBe(1);
    });

    it("rejects rather than reading as absent when no re-delivery can apply", async () => {
      await writeSpaceCell();
      const { runtime } = readerDropping(Infinity);

      await expect(runtime.spaceExists(space)).rejects.toThrow();
    });
  });

  describe("a document a reader confirmed absent, then quarantined", () => {
    it("loads it again once a frame ends the quarantine its load failed on", async () => {
      const cancels: (() => void)[] = [];
      const { factory, runtime, replica, cellOf } = readerDropping(Infinity);
      const readiness = createDocumentReadiness(
        runtime,
        (cancel) => cancels.push(cancel),
      );
      const cell = cellOf(ABSENT_ID);
      const presence = () => {
        const tx = runtime.edit();
        try {
          return readiness.requireDocument(cell, tx);
        } finally {
          tx.abort();
        }
      };
      expect(presence).toThrow(DocumentPending);
      await runtime.storageManager.synced();
      await write({ [ABSENT_ID]: naming(1) });
      await factory.firstWatchSet.promise;
      await replica.quarantineFailure(ABSENT_ID as URI, "space");
      expect(presence).toThrow(DocumentPending);
      await runtime.storageManager.synced();
      expect(presence).toThrow(DocumentLoadError);

      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 900_000,
        toSeq: 900_001,
        upserts: [],
        removes: [{ branch: "", id: ABSENT_ID, scope: "space" }],
      }, "integrate");

      factory.dropsLeft = 0;
      expect(presence).toThrow(DocumentPending);
      for (const cancel of cancels) cancel();
    });

    it("stops reading as absent, and reports the failed load", async () => {
      const cancels: (() => void)[] = [];
      const { factory, runtime, replica, cellOf } = readerDropping(Infinity);
      const readiness = createDocumentReadiness(
        runtime,
        (cancel) => cancels.push(cancel),
      );
      const cell = cellOf(ABSENT_ID);
      const presence = () => {
        const tx = runtime.edit();
        try {
          return readiness.requireDocument(cell, tx);
        } finally {
          tx.abort();
        }
      };
      expect(presence).toThrow(DocumentPending);
      await runtime.storageManager.synced();
      expect(presence()).toBe(false);

      await write({ [ABSENT_ID]: naming(1) });
      await factory.firstWatchSet.promise;
      await replica.quarantineFailure(ABSENT_ID as URI, "space");

      expect(presence).toThrow(DocumentPending);
      await runtime.storageManager.synced();
      expect(presence).toThrow(DocumentLoadError);
      for (const cancel of cancels) cancel();
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

    it("stops failing its load once a frame applies a deletion", async () => {
      const { replica } = await failedReader();

      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 900_000,
        toSeq: 900_001,
        upserts: [{
          branch: "",
          id: DOCUMENT_ID,
          scope: "space",
          seq: 900_001,
          deleted: true,
        }],
        removes: [],
      }, "integrate");

      expect(await replica.quarantineFailure(DOCUMENT_ID as URI, "space"))
        .toBeUndefined();
    });

    it("stops failing its load once the replica resets", async () => {
      const { replica } = await failedReader();

      replica.reset();

      expect(replica.isQuarantined(DOCUMENT_ID as URI, "space")).toBe(false);
      expect(await replica.quarantineFailure(DOCUMENT_ID as URI, "space"))
        .toBeUndefined();
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

  describe("a newer copy no re-delivery can apply, over the replica's own write", () => {
    it("leaves the write to read, and loads as present", async () => {
      const own = readerDropping(0);
      expect(await loadDocument(own.runtime, own.cellOf(OWN_ID))).toBe(false);
      await writeAs(own.runtime, { [OWN_ID]: naming(1) });
      await server.idle();
      expect(own.revision(OWN_ID)).toBe(1);

      const other = readerDropping(0);
      expect(await loadDocument(other.runtime, other.cellOf(OWN_ID))).toBe(
        true,
      );
      own.factory.dropsLeft = Infinity;
      await writeAs(other.runtime, {
        [`cid:${otherHash}`]: otherSchema as unknown as FabricValue,
        [OWN_ID]: naming(2, otherHash),
      });
      await own.factory.firstWatchSet.promise;

      expect(await own.replica.quarantineFailure(OWN_ID as URI, "space"))
        .toBeUndefined();
      expect(await loadDocument(own.runtime, own.cellOf(OWN_ID))).toBe(true);
      expect(own.revision(OWN_ID)).toBe(1);
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
