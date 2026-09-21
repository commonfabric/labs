// The served lifecycle verbs, end to end: a serving host over a real
// in-process memory server runs each verb on the space's serving runtime,
// and a client runtime opened afterwards reads what the verb left in the
// store. What is pinned is the store's state, never the serving runtime's
// own view of it.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity, type Session } from "@commonfabric/identity";
import { streamEntriesDocId } from "@commonfabric/memory/v2";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Cell,
  entityIdFrom,
  getPatternIdentityRef,
  getPieceSourceRevisions,
  type NormalizedFullLink,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { loadVerifiedSourceClosure } from "../../runner/src/compilation-cache/cell-cache.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { pieceId } from "../src/piece-id.ts";
import { resolveSlugTargetCell } from "../src/slugs.ts";
import {
  completeServedRegistration,
  confirmServedInstantiate,
  confirmServedRegistration,
  confirmServedSetSource,
  finishServedRegistration,
  prepareServedRegistration,
  servedInstantiatePiece,
  ServedLifecycleRefusal,
  type ServedPatternSource,
  servedSetPieceSource,
  type ServedSetSourceRequest,
  servedUploadPattern,
} from "../src/ops/served-lifecycle.ts";

const spaceSigner = await Identity.fromPassphrase("served lifecycle space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "served lifecycle service",
);
const aliceSigner = await Identity.fromPassphrase("served lifecycle alice");

const TEST_AUDIENCE = "did:key:z6Mk-served-lifecycle-audience";

function programOf(contents: string): RuntimeProgram {
  return { main: "/main.tsx", files: [{ name: "/main.tsx", contents }] };
}

/** One optional input, one output. */
const BASE_PROGRAM = programOf([
  "import { NAME, pattern } from 'commonfabric';",
  "export default pattern<{ seed?: string }, { label: string }>(",
  "  ({ seed }) => ({",
  "    [NAME]: 'Served lifecycle',",
  "    label: seed ?? 'unset',",
  "  }),",
  ");",
  "",
].join("\n"));

const BROKEN_PROGRAM = programOf(
  "import { pattern } from 'commonfabric';\nexport default pattern<{}, {}>(() => ({ label: undefinedName }));\n",
);

/** `BASE_PROGRAM` with its `seed` argument narrowed to a number. */
const NUMERIC_SEED_PROGRAM = programOf([
  "import { NAME, pattern } from 'commonfabric';",
  "export default pattern<{ seed?: number }, { label: string }>(",
  "  ({ seed }) => ({",
  "    [NAME]: 'Served lifecycle',",
  "    label: seed === undefined ? 'unset' : String(seed),",
  "  }),",
  ");",
  "",
].join("\n"));

/**
 * A handler whose write is authorized by its own module, over a field it
 * binds — the shape a source update must carry writer authority across.
 */
function authorizedWriterProgram(version: string): RuntimeProgram {
  return {
    main: "/app/main.tsx",
    files: [
      {
        name: "/app/main.tsx",
        contents: `/// <cts-enable />
import {
  handler,
  pattern,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import { revision } from "../shared/revision.ts";

const setName = handler<
  { name: string },
  { name: Writable<string> }
>((event, state) => {
  state.name.set(revision + ":" + event.name);
});

export default pattern<{ seed?: string }>(() => {
  const name = new Writable<
    WriteAuthorizedBy<string, typeof setName>
  >("initial").for("name");
  return { name, setName: setName({ name }) };
});
`,
      },
      {
        name: "/shared/revision.ts",
        contents: `/// <cts-enable />
export const revision = ${JSON.stringify(version)};
`,
      },
    ],
  };
}

describe("served lifecycle verbs", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost;
  let session: Session;
  let cleanups: Array<() => Promise<void>>;

  beforeEach(async () => {
    server = new MemoryV2Server.Server({
      store: new URL(`memory://served-lifecycle-${crypto.randomUUID()}`),
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: TEST_AUDIENCE },
      subscriptionRefreshDelayMs: 0,
    });
    session = await createSession({
      identity: serviceSigner,
      spaceDid: space as DID,
    });
    host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: (servedSpace) => {
        const manager = LoopbackStorageManager.connect(server, {
          as: serviceSigner,
          servingHomeSpace: servedSpace,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      ensureSpaceRoots: false,
    });
    cleanups = [];
  });

  afterEach(async () => {
    await host.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  /** A client's view of the space, opened as alice after the verb ran. */
  const clientPieces = async (): Promise<PiecesController> => {
    const manager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await manager.close();
    });
    const pieces = new PiecesController(session, runtime, {
      deferSpaceCellSync: true,
    });
    await pieces.ready;
    return pieces;
  };

  const served = <T>(
    name: string,
    run: (pieces: PiecesController) => Promise<T>,
    confirm?: (runtime: Runtime, receipt: T) => Promise<void>,
  ): Promise<T> =>
    host.runLifecycleVerb(space, {
      name,
      run: (runtime) =>
        run(
          new PiecesController(session, runtime, { deferSpaceCellSync: true }),
        ),
      ...(confirm === undefined ? {} : { confirm }),
    });

  const instantiate = (
    source: ServedPatternSource,
    argument?: object,
    naming: {
      slug?: string;
      force?: boolean;
      register?: boolean;
      requestKey?: string;
    } = {},
  ) =>
    served(
      "instantiate",
      (pieces) =>
        servedInstantiatePiece(pieces, {
          source,
          ...(argument === undefined ? {} : { argument }),
          ...naming,
          actingUser: aliceSigner.did(),
        }),
      (runtime, receipt) =>
        confirmServedInstantiate(runtime, space, receipt, aliceSigner.did()),
    );

  const refusalOf = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      expect(error).toBeInstanceOf(ServedLifecycleRefusal);
      return error as ServedLifecycleRefusal;
    }
    throw new Error("expected a refusal");
  };

  describe("instantiate", () => {
    it("refuses registration without a matching durable creation record", async () => {
      const created = await instantiate({ program: BASE_PROGRAM }, undefined, {
        register: true,
      });
      const pieces = await clientPieces();
      const missing = { ...created, requestKey: "absent-creation" };
      for (const phase of ["prepare", "finish"] as const) {
        await expect(
          phase === "prepare"
            ? prepareServedRegistration(pieces, missing, aliceSigner.did())
            : finishServedRegistration(
              pieces,
              { receipt: missing },
              aliceSigner.did(),
              {},
            ),
        )
          .rejects.toThrow("Could not retain the registration");
      }
      const record = pieces.runtime.getCell(pieces.getSpace(), {
        purpose: "piece-instantiation-receipt",
        principal: aliceSigner.did(),
        requestKey: missing.requestKey,
      });
      expect(await record.pull()).toBeUndefined();
      const other = await instantiate({ program: BASE_PROGRAM });
      await expect(
        prepareServedRegistration(pieces, {
          ...created,
          pieceId: other.pieceId,
        }, aliceSigner.did()),
      )
        .rejects.toThrow("Could not retain the registration");
      expect(await pieces.getDefaultPattern(false)).toBeUndefined();
    });

    it("retains a recoverable failure when the root has no registration handler", async () => {
      const root = await instantiate({ program: BASE_PROGRAM });
      const pending = await instantiate({ program: BASE_PROGRAM }, undefined, {
        register: true,
      });
      const pieces = await clientPieces();
      await pieces.linkDefaultPattern(
        (await pieces.get(root.pieceId)).getCell(),
      );
      const prepared = await prepareServedRegistration(
        pieces,
        pending,
        aliceSigner.did(),
      );
      expect(prepared.delivery).toBeUndefined();
      expect(prepared.error).toBe(
        "The default pattern has no addPiece handler",
      );
      const failed = await finishServedRegistration(
        pieces,
        prepared,
        aliceSigner.did(),
        {},
      );
      expect(failed.registration.status).toBe("failed");
      expect(failed.registration.terminal).toBeUndefined();
      await confirmServedRegistration(
        pieces.runtime,
        space,
        failed,
        aliceSigner.did(),
      );
      await expect(confirmServedRegistration(pieces.runtime, space, {
        ...failed,
        requestKey: "unknown-creation",
      }, aliceSigner.did())).rejects.toThrow(
        "Registration receipt was not retained",
      );
      await expect(confirmServedRegistration(pieces.runtime, space, {
        ...failed,
        registration: { status: "handled" },
      }, aliceSigner.did())).rejects.toThrow(
        "Registration outcome was not retained",
      );
      await expect(confirmServedRegistration(pieces.runtime, space, {
        ...failed,
        registration: { ...failed.registration, terminal: true },
      }, aliceSigner.did())).rejects.toThrow(
        "Registration outcome was not retained",
      );
    });

    it("leaves skipped registration unchanged and refuses completion inside a serving wave", async () => {
      const skipped = await instantiate({ program: BASE_PROGRAM });
      const pieces = await clientPieces();
      const prepared = await prepareServedRegistration(
        pieces,
        skipped,
        aliceSigner.did(),
      );
      expect(
        await finishServedRegistration(pieces, prepared, aliceSigner.did(), {}),
      ).toEqual(skipped);
      const pending = await instantiate({ program: BASE_PROGRAM }, undefined, {
        register: true,
      });
      await expect(
        served(
          "unsafe-completion",
          (controller) =>
            completeServedRegistration(controller, pending, aliceSigner.did()),
        ),
      )
        .rejects.toThrow(
          "Registration completion requires a client runtime outside the serving wave",
        );
      const incomplete = await finishServedRegistration(
        pieces,
        { receipt: pending },
        aliceSigner.did(),
        {},
      );
      expect(incomplete.registration.error).toBe(
        "Registration has no delivery plan",
      );
      expect(incomplete.registration.terminal).toBeUndefined();
    });

    it("retries a terminal registration failure after repair without creating another piece", async () => {
      const rootReceipt = await instantiate({
        program: programOf(`
import { computed, handler, pattern, Writable } from "commonfabric";
const addPiece = handler<{piece: Writable<unknown>}, {blocked: Writable<boolean>, panels: Writable<Writable<unknown>[]>}>(
  ({piece}, {blocked, panels}) => { if (blocked.get()) throw new Error("Registration blocked"); panels.addUnique(piece); },
);
export default pattern(() => {
  const blocked = new Writable(true);
  const panels = new Writable<Writable<unknown>[]>([]);
  return { blocked, panels, pieceRegistry: computed(() => panels.get().map(piece => piece)), addPiece: addPiece({blocked, panels}) };
});
`),
      });
      const pieces = await clientPieces();
      const root = await pieces.get(rootReceipt.pieceId);
      await pieces.linkDefaultPattern(root.getCell());
      const pending = await instantiate({ program: BASE_PROGRAM }, undefined, {
        register: true,
      });
      const events: string[] = [];
      const options = {
        append: async (
          { stream, eventId, piece }: {
            stream: NormalizedFullLink;
            eventId: string;
            piece: Cell<unknown>;
          },
        ) => {
          events.push(eventId);
          await server.commitDelegatedAppend({
            targetSpace: stream.space,
            targetStream: streamEntriesDocId(stream),
            targetStreamLink: stream,
            eventId,
            payload: { piece: piece.getAsLink() },
            actingPrincipal: aliceSigner.did(),
            actingSession: aliceSigner.did(),
            capabilityRef: `stream-append:${streamEntriesDocId(stream)}`,
            sessionId: `repair:${crypto.randomUUID()}`,
            localSeq: 1,
          });
        },
      };
      const failed = await completeServedRegistration(
        pieces,
        pending,
        aliceSigner.did(),
        options,
      );
      expect(failed.registration.status).toBe("failed");
      const repair = await pieces.runtime.editWithRetry((tx) =>
        root.getCell().withTx(tx).key("blocked").set(false)
      );
      expect(repair.error).toBeUndefined();
      const retried = await instantiate({ program: BASE_PROGRAM }, undefined, {
        register: true,
        requestKey: pending.requestKey,
      });
      const [handled, concurrent] = await Promise.all([
        completeServedRegistration(pieces, retried, aliceSigner.did(), options),
        completeServedRegistration(pieces, retried, aliceSigner.did(), options),
      ]);
      expect(handled.registration.status).toBe("handled");
      expect(concurrent.registration.status).toBe("handled");
      expect(handled.pieceId).toBe(pending.pieceId);
      expect(events.length).toBe(3);
      expect(events[0]).not.toBe(events[1]);
      expect(events[1]).toBe(events[2]);
      const registry = await pieces.getRegisteredPieces();
      expect(registry.length).toBe(1);
    });

    it("retries a committed no-op registration after repair without creating another piece", async () => {
      const rootReceipt = await instantiate({
        program: programOf(`
import { computed, handler, pattern, Writable } from "commonfabric";
const addPiece = handler<{piece: Writable<unknown>}, {blocked: Writable<boolean>, panels: Writable<Writable<unknown>[]>}>(
  ({piece}, {blocked, panels}) => { if (blocked.get()) return; panels.addUnique(piece); },
);
export default pattern(() => {
  const blocked = new Writable(true);
  const panels = new Writable<Writable<unknown>[]>([]);
  return { blocked, panels, pieceRegistry: computed(() => panels.get().map(piece => piece)), addPiece: addPiece({blocked, panels}) };
});
`),
      });
      const pieces = await clientPieces();
      const root = await pieces.get(rootReceipt.pieceId);
      await pieces.linkDefaultPattern(root.getCell());
      const pending = await instantiate({ program: BASE_PROGRAM }, undefined, {
        register: true,
      });
      const events: string[] = [];
      const options = {
        append: async (
          { stream, eventId, piece }: {
            stream: NormalizedFullLink;
            eventId: string;
            piece: Cell<unknown>;
          },
        ) => {
          events.push(eventId);
          await server.commitDelegatedAppend({
            targetSpace: stream.space,
            targetStream: streamEntriesDocId(stream),
            targetStreamLink: stream,
            eventId,
            payload: { piece: piece.getAsLink() },
            actingPrincipal: aliceSigner.did(),
            actingSession: aliceSigner.did(),
            capabilityRef: `stream-append:${streamEntriesDocId(stream)}`,
            sessionId: `repair:${crypto.randomUUID()}`,
            localSeq: 1,
          });
        },
      };
      const appended = Promise.withResolvers<void>();
      const releaseAcknowledgment = Promise.withResolvers<void>();
      const uncertainCompletion = completeServedRegistration(
        pieces,
        pending,
        aliceSigner.did(),
        {
          append: async (input: Parameters<typeof options.append>[0]) => {
            await options.append(input);
            appended.resolve();
            await releaseAcknowledgment.promise;
            throw new Error("Lost delayed append acknowledgment");
          },
        },
      );
      await appended.promise;
      const failed = await completeServedRegistration(
        pieces,
        pending,
        aliceSigner.did(),
        options,
      ).finally(() => releaseAcknowledgment.resolve());
      const uncertain = await uncertainCompletion;
      expect(uncertain.registration.terminal).toBe(true);
      expect(failed.registration.status).toBe("failed");
      expect(failed.registration.error).toBe(
        "The addPiece handler committed without registering the piece",
      );
      const repair = await pieces.runtime.editWithRetry((tx) =>
        root.getCell().withTx(tx).key("blocked").set(false)
      );
      expect(repair.error).toBeUndefined();
      const retried = await instantiate({ program: BASE_PROGRAM }, undefined, {
        register: true,
        requestKey: pending.requestKey,
      });
      const [handled, concurrent] = await Promise.all([
        completeServedRegistration(pieces, retried, aliceSigner.did(), options),
        completeServedRegistration(pieces, retried, aliceSigner.did(), options),
      ]);
      expect(handled.registration.status).toBe("handled");
      expect(handled.registration.attempt).toBe(1);
      expect(concurrent.registration.status).toBe("handled");
      expect(handled.pieceId).toBe(pending.pieceId);
      expect(events.length).toBe(4);
      expect(events[0]).toBe(events[1]);
      expect(events[1]).not.toBe(events[2]);
      expect(events[2]).toBe(events[3]);
      const registry = await pieces.getRegisteredPieces();
      expect(registry.length).toBe(1);
    });

    for (
      const mode of [
        "client event",
        "trusted delegated ingress",
        "lost append acknowledgment",
      ]
    ) {
      const delegated = mode !== "client event";
      it(`registers through the computed root action using ${mode}`, async () => {
        const rootReceipt = await instantiate({
          program: programOf(`
import { computed, handler, pattern, Writable } from "commonfabric";
const addPiece = handler<{piece: Writable<unknown>}, {panels: Writable<Writable<unknown>[]>}>(
  ({piece}, {panels}) => { panels.addUnique(piece); },
);
const removePiece = handler<{piece: Writable<unknown>}, {panels: Writable<Writable<unknown>[]>}>(
  ({piece}, {panels}) => { panels.set(panels.get().filter(member => !member.equals(piece))); },
);
export default pattern(() => {
  const panels = new Writable<Writable<unknown>[]>([]);
  return { panels, pieceRegistry: computed(() => panels.get().map(piece => piece)), addPiece: addPiece({panels}), removePiece: removePiece({panels}) };
});
`),
        });
        const pieces = await clientPieces();
        const root = await pieces.get(rootReceipt.pieceId);
        await pieces.linkDefaultPattern(root.getCell());
        const pending = await instantiate(
          { program: BASE_PROGRAM },
          undefined,
          { register: true },
        );
        let appends = 0;
        const options = delegated
          ? {
            append: async (
              { stream, eventId, piece }: {
                stream: NormalizedFullLink;
                eventId: string;
                piece: Cell<unknown>;
              },
            ) => {
              appends++;
              await server.commitDelegatedAppend({
                targetSpace: stream.space,
                targetStream: streamEntriesDocId(stream),
                targetStreamLink: stream,
                eventId,
                payload: { piece: piece.getAsLink() },
                actingPrincipal: aliceSigner.did(),
                actingSession: aliceSigner.did(),
                capabilityRef: `stream-append:${streamEntriesDocId(stream)}`,
                sessionId: `lifecycle-test:${crypto.randomUUID()}`,
                localSeq: 1,
              });
              if (mode === "lost append acknowledgment" && appends === 1) {
                throw new Error("Lost append acknowledgment");
              }
            },
          }
          : {};
        const created = await completeServedRegistration(
          pieces,
          pending,
          aliceSigner.did(),
          options,
        );
        if (mode === "client event") {
          expect(created.registration.error).toBeUndefined();
        }
        const retried = await instantiate(
          { program: BASE_PROGRAM },
          undefined,
          { requestKey: pending.requestKey, register: true },
        );
        expect(
          (await completeServedRegistration(
            pieces,
            retried,
            aliceSigner.did(),
            options,
          )).registration,
        ).toMatchObject({ status: "handled" });
        if (delegated) {
          expect(appends).toBe(mode === "lost append acknowledgment" ? 2 : 1);
        }
        expect(created.registration.status).toBe(
          mode === "lost append acknowledgment" ? "failed" : "handled",
        );
        const panels = root.getCell().asSchema({
          type: "object",
          required: ["panels"],
          properties: {
            panels: {
              type: "array",
              items: { type: "unknown", asCell: ["cell"] },
            },
          },
        }).key("panels");
        await panels.pull();
        expect(panels.get().length).toBe(1);
        expect(
          panels.key(0).resolveAsCell().equals(
            pieces.runtime.getCellFromEntityId(
              space,
              entityIdFrom(created.pieceId),
            ),
          ),
        ).toBe(true);
        expect(await pieces.remove(created.pieceId)).toBe(true);
        await panels.pull();
        expect(panels.get().length).toBe(0);
      });
    }

    it("confirms only the caller's retained creation identity and original receipt", async () => {
      const created = await instantiate({ program: BASE_PROGRAM }, undefined, {
        slug: "original",
      });
      const other = await instantiate({ program: BASE_PROGRAM });
      const pieces = await clientPieces();
      for (
        const altered of [
          { ...created, requestKey: "missing-creation" },
          { ...created, pieceId: other.pieceId },
          { ...created, slug: "changed" },
          { ...created, pattern: { ...created.pattern, symbol: "other" } },
          { ...created, pattern: { ...created.pattern, identity: "other" } },
        ]
      ) {
        await expect(
          confirmServedInstantiate(
            pieces.runtime,
            space,
            altered,
            aliceSigner.did(),
          ),
        )
          .rejects.toThrow("Creation receipt was not retained");
      }
      await expect(
        confirmServedInstantiate(
          pieces.runtime,
          space,
          created,
          serviceSigner.did(),
        ),
      )
        .rejects.toThrow("Creation receipt was not retained");
    });

    it("resumes failed creation registration after a legitimate source update", async () => {
      const pending = await instantiate({ program: BASE_PROGRAM }, {
        seed: "retained",
      }, {
        requestKey: "registration-after-setsrc",
        register: true,
      });
      const pieces = await clientPieces();
      const failed = await completeServedRegistration(
        pieces,
        pending,
        aliceSigner.did(),
      );
      expect(failed.registration.status).toBe("failed");
      const successor = programOf(
        BASE_PROGRAM.files[0]!.contents.replace(
          "Served lifecycle",
          "Updated lifecycle",
        ),
      );
      const { ref } = await served(
        "upload",
        (controller) => servedUploadPattern(controller, successor),
      );
      await served(
        "setsrc",
        (controller) =>
          servedSetPieceSource(controller, {
            pieceId: pending.pieceId,
            pattern: ref,
            actingUser: aliceSigner.did(),
          }),
        (runtime, receipt) => confirmServedSetSource(runtime, space, receipt),
      );
      const rootReceipt = await instantiate({
        program: programOf(`
import { computed, handler, pattern, Writable } from "commonfabric";
const addPiece = handler<{piece: Writable<unknown>}, {panels: Writable<Writable<unknown>[]>}>(
  ({piece}, {panels}) => { panels.addUnique(piece); },
);
export default pattern(() => {
  const panels = new Writable<Writable<unknown>[]>([]);
  return { panels, pieceRegistry: computed(() => panels.get().map(piece => piece)), addPiece: addPiece({panels}) };
});
`),
      });
      const root = await pieces.get(rootReceipt.pieceId);
      await pieces.linkDefaultPattern(root.getCell());
      const replay = await instantiate({ program: BASE_PROGRAM }, {
        seed: "replacement refused",
      }, {
        requestKey: pending.requestKey,
        register: true,
      });
      expect(replay.pieceId).toBe(pending.pieceId);
      expect(replay.pattern).toEqual(pending.pattern);
      const handled = await completeServedRegistration(
        pieces,
        replay,
        aliceSigner.did(),
      );
      expect(handled.registration.status).toBe("handled");
      const updated = await (await clientPieces()).get(pending.pieceId);
      expect(getPatternIdentityRef(updated.getCell())).toEqual(ref);
      const argument = pieces.getArgument<{ seed: string }>(updated.getCell());
      await argument.sync();
      expect(argument.get().seed).toBe("retained");
      const registry = await pieces.getRegisteredPieces();
      expect(registry.map((piece) => piece.id)).toEqual([pending.pieceId]);
    });

    it("retries one request key without creating another piece or resetting its argument", async () => {
      const first = await instantiate({ program: BASE_PROGRAM }, {
        seed: "first",
      }, {
        requestKey: "same-creation",
      });
      const second = await instantiate({ program: BASE_PROGRAM }, {
        seed: "retry",
      }, {
        requestKey: "same-creation",
      });
      expect(second.pieceId).toBe(first.pieceId);
      const pieces = await clientPieces();
      const piece = await pieces.get(first.pieceId, false);
      const argument = pieces.getArgument<{ seed: string }>(piece.getCell());
      await argument.sync();
      expect(argument.get().seed).toBe("first");
    });

    it("creates a piece a later client reads with the pattern pointer and argument the verb wrote", async () => {
      const receipt = await instantiate({ program: BASE_PROGRAM }, {
        seed: "planted",
      });
      expect(receipt.pattern.symbol).toBe("default");

      const pieces = await clientPieces();
      const piece = await pieces.get(receipt.pieceId);
      expect(getPatternIdentityRef(piece.getCell())).toEqual(receipt.pattern);
      const argument = pieces.getArgument<{ seed?: string }>(piece.getCell());
      await argument.sync();
      expect(argument.get()).toEqual({ seed: "planted" });
      expect(getPieceSourceRevisions(piece.getCell())).toHaveLength(1);
      expect(host.stats().lifecycleVerbs).toEqual({ runs: 1, failures: 0 });
    });

    it("takes a pattern an earlier upload left in the space", async () => {
      const { ref } = await served(
        "upload",
        (pieces) => servedUploadPattern(pieces, BASE_PROGRAM),
      );
      const receipt = await instantiate({ pattern: ref });
      expect(receipt.pattern).toEqual(ref);
      const pieces = await clientPieces();
      const piece = await pieces.get(receipt.pieceId);
      expect(getPatternIdentityRef(piece.getCell())).toEqual(ref);
    });

    it("refuses a pattern the space does not hold", async () => {
      const refusal = await refusalOf(instantiate({
        pattern: { identity: "no-such-identity", symbol: "default" },
      }));
      expect(refusal.code).toBe("pattern-not-found");
    });

    it("claims the slug with the creation, refuses a taken name, and takes it under force", async () => {
      const first = await instantiate({ program: BASE_PROGRAM }, undefined, {
        slug: "named-piece",
      });
      expect(first.slug).toBe("named-piece");
      const pieces = await clientPieces();
      expect(pieceId(await resolveSlugTargetCell(pieces, "named-piece")))
        .toBe(first.pieceId);

      const refusal = await refusalOf(
        instantiate({ program: BASE_PROGRAM }, undefined, {
          slug: "named-piece",
        }),
      );
      expect(refusal.code).toBe("slug-taken");
      expect(refusal.message).toContain("nothing was created");

      const taken = await instantiate({ program: BASE_PROGRAM }, undefined, {
        slug: "named-piece",
        force: true,
      });
      // A client opened after the forced claim: the earlier one holds the
      // name's document from before it moved.
      const later = await clientPieces();
      expect(pieceId(await resolveSlugTargetCell(later, "named-piece")))
        .toBe(taken.pieceId);
    });

    it("refuses to register a piece in a space with no root", async () => {
      const pending = await instantiate({ program: BASE_PROGRAM }, undefined, {
        register: true,
      });
      const pieces = await clientPieces();
      const receipt = await completeServedRegistration(
        pieces,
        pending,
        aliceSigner.did(),
      );
      expect(receipt.registration.status).toBe("failed");
      expect(receipt.registration.error).toContain("no default pattern");
      expect(receipt.pieceId).toBe(pending.pieceId);
      const retried = await instantiate({ program: BASE_PROGRAM }, undefined, {
        requestKey: pending.requestKey,
        register: true,
      });
      expect(retried.pieceId).toBe(pending.pieceId);
    });

    it("refuses a program that does not compile, naming the failure", async () => {
      const refusal = await refusalOf(instantiate({ program: BROKEN_PROGRAM }));
      expect(refusal.code).toBe("compile-failed");
      expect(refusal.message).toContain("undefinedName");
      expect(host.stats().lifecycleVerbs).toEqual({ runs: 1, failures: 1 });
    });
  });

  describe("setsrc", () => {
    // The served source update commits its setup transaction directly to
    // the store, outside the cycle's wave, so the update's module authority
    // registers from a durable verdict on the serving runtime and a later
    // runtime reads it from the stored closure.

    // A program is uploaded as a verb of its own, the way the route does
    // it, so its closure is durable before the update reads it.
    const patternOf = async (source: ServedPatternSource) =>
      source.pattern ?? (await served(
        "upload",
        (pieces) => servedUploadPattern(pieces, source.program),
      )).ref;

    const setSource = async (
      pieceId: string,
      source: ServedPatternSource,
      options: Omit<
        ServedSetSourceRequest,
        "pieceId" | "pattern" | "actingUser"
      > = {},
    ) => {
      const pattern = await patternOf(source);
      return await served(
        "setsrc",
        (pieces) =>
          servedSetPieceSource(pieces, {
            pieceId,
            pattern,
            ...options,
            actingUser: aliceSigner.did(),
          }),
        (runtime, receipt) => confirmServedSetSource(runtime, space, receipt),
      );
    };

    it("replaces the source a later client reads, with the revision the receipt names, and authorizes the successor over the predecessor", async () => {
      const created = await instantiate({
        program: authorizedWriterProgram("v1"),
      });
      const candidate = await patternOf({
        program: authorizedWriterProgram("v2"),
      });
      // Registered on the serving runtime from the committed transaction:
      // read inside the verb, before the cycle's wave could commit.
      let granted: boolean | undefined;
      const receipt = await served(
        "setsrc",
        async (pieces) => {
          const receipt = await servedSetPieceSource(pieces, {
            pieceId: created.pieceId,
            pattern: candidate,
            actingUser: aliceSigner.did(),
          });
          granted = pieces.runtime.grantsModuleDelegation(
            space,
            receipt.pattern.identity,
            created.pattern.identity,
          );
          return receipt;
        },
        (runtime, receipt) => confirmServedSetSource(runtime, space, receipt),
      );
      expect(receipt.pieceId).toBe(created.pieceId);
      expect(receipt.pattern.identity).not.toBe(created.pattern.identity);
      expect(receipt.seq).toBeGreaterThan(0);
      expect(receipt.detachedOrigin).toBeNull();
      expect(granted).toBe(true);

      const pieces = await clientPieces();
      const piece = await pieces.get(receipt.pieceId);
      expect(getPatternIdentityRef(piece.getCell())).toEqual(receipt.pattern);
      const revisions = getPieceSourceRevisions(piece.getCell());
      expect(revisions.at(-1)?.revisionId).toBe(receipt.revisionId);
      expect(revisions.at(-1)?.pattern).toEqual(receipt.pattern);
      // The stored closure carries the delegation a fresh runtime registers
      // from.
      const tx = pieces.runtime.edit();
      try {
        const closure = await loadVerifiedSourceClosure(
          pieces.runtime,
          space,
          receipt.pattern.identity,
          tx,
        );
        expect(
          closure?.get(receipt.pattern.identity)?.delegatedModuleIdentities,
        ).toContain(created.pattern.identity);
      } finally {
        tx.abort();
      }
      expect(host.stats().lifecycleVerbs).toEqual({ runs: 3, failures: 0 });
    });

    it("refuses a source whose argument schema is not backward compatible, and applies it under the dangerous override", async () => {
      // Created without a seed, so the stored argument satisfies either
      // schema and only the declared contract stands between the two.
      const created = await instantiate({ program: BASE_PROGRAM });
      const refusal = await refusalOf(
        setSource(created.pieceId, { program: NUMERIC_SEED_PROGRAM }),
      );
      expect(refusal.code).toBe("incompatible");
      expect(refusal.message).toContain("not backward compatible");
      const unchanged = await clientPieces();
      expect(
        getPatternIdentityRef((await unchanged.get(created.pieceId)).getCell()),
      ).toEqual(created.pattern);

      const receipt = await setSource(
        created.pieceId,
        { program: NUMERIC_SEED_PROGRAM },
        { dangerouslyAllowIncompatibleSchema: true },
      );
      const pieces = await clientPieces();
      expect(
        getPatternIdentityRef((await pieces.get(created.pieceId)).getCell()),
      ).toEqual(receipt.pattern);
    });

    it("refuses a piece the space does not hold, and an address that names none", async () => {
      const refusal = await refusalOf(
        setSource("no-such-piece", { program: BASE_PROGRAM }),
      );
      expect(refusal.code).toBe("piece-not-found");
      const malformed = await refusalOf(
        setSource("", { program: BASE_PROGRAM }),
      );
      expect(malformed.code).toBe("piece-not-found");
    });

    it("refuses an update proved against a pattern the piece is no longer on", async () => {
      const created = await instantiate({ program: BASE_PROGRAM });
      const refusal = await refusalOf(
        setSource(created.pieceId, { program: BASE_PROGRAM }, {
          expectedPattern: { identity: "elsewhere", symbol: "default" },
        }),
      );
      expect(refusal.code).toBe("source-moved");
    });

    it("refuses a pattern the space does not hold", async () => {
      const created = await instantiate({ program: BASE_PROGRAM });
      const refusal = await refusalOf(
        setSource(created.pieceId, {
          pattern: { identity: "no-such-identity", symbol: "default" },
        }),
      );
      expect(refusal.code).toBe("pattern-not-found");
    });

    it("reports the refresh as deferred on the receipt the served update is built on", async () => {
      // The served option on the client's own runtime: the commit is the
      // store's as always there, and the piece is left to whoever runs it.
      const created = await instantiate({ program: BASE_PROGRAM });
      const candidate = await patternOf({ program: NUMERIC_SEED_PROGRAM });
      const pieces = await clientPieces();
      const pattern = await pieces.runtime.patternManager
        .loadPatternByIdentity(candidate.identity, candidate.symbol, space);
      const piece = await pieces.get(created.pieceId);
      const receipt = await piece.setCompiledPattern(pattern!, {
        dangerouslyAllowIncompatibleSchema: true,
        served: { actingUser: aliceSigner.did() },
      });
      expect(receipt.status).toBe("committed");
      expect(receipt.refresh).toEqual({ status: "deferred" });
      expect(getPatternIdentityRef(piece.getCell())).toEqual(receipt.ref);
    });
  });
});
