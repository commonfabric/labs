/**
 * A client under server execution that runs nothing of a piece: it sends an
 * event without an echo, reads the handling's outcome off the receipt the event
 * names, and asks the server for a derived value with `pullFromServer()`.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy, stub } from "@std/testing/mock";
import { createSession, Identity, type Session } from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import type { ViewInterest } from "@commonfabric/memory/v2";
import {
  type Cell,
  pullFromServer,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import type { ExecutorHost } from "@commonfabric/runner/executor/host";
import {
  type ServingMemoryServer,
  startServingMemoryServer,
} from "@commonfabric/runner/executor/serving-memory-server.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import {
  confirmServedInstantiate,
  servedInstantiatePiece,
} from "../src/ops/served-lifecycle.ts";
import { sendVerbEvent, type VerbEventCommitted } from "../src/verb-call.ts";

const spaceSigner = await Identity.fromPassphrase("served read space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("served read service");
const aliceSigner = await Identity.fromPassphrase("served read alice");

/** A verb that returns a value or throws, and a value derived from its write. */
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import { computed, handler, NAME, pattern, Writable } from "commonfabric";

const setName = handler<
  { name: string },
  { name: Writable<string> },
  { saved: string }
>(
  (event, state) => {
    if (event.name === "boom") throw new Error("served boom");
    state.name.set(event.name);
    return { saved: event.name };
  },
);

export default pattern<{ seed?: string }>(() => {
  const name = new Writable<string>("initial").for("name");
  const upper = computed(() => name.get().toUpperCase());
  return { [NAME]: "Served read", name, upper, setName: setName({ name }) };
});
`,
  }],
};

/** How many settlements a test has the flush deadline cut. */
const CUT_SETTLEMENTS = 6;

describe("served dispatch and read", () => {
  let serving: ServingMemoryServer;
  let host: ExecutorHost;
  let session: Session;
  let cleanups: Array<() => Promise<void>>;

  /** While set, the serving runtime's wave commits wait for it to settle. */
  let held: Promise<void> | undefined;

  /** Resolves when a wave commit reaches the sink while one is held. */
  let waveHeld: PromiseWithResolvers<void>;

  /** Starts the serving server the test's clients and lifecycle verbs use. */
  const startServing = async (
    policy: Parameters<typeof startServingMemoryServer>[0]["policy"],
  ): Promise<void> => {
    serving = await startServingMemoryServer({
      apiUrl: new URL(import.meta.url),
      serviceIdentity: serviceSigner,
      policy,
      worker: false,
      decorateWaveCommitSink: (sink) =>
        new Proxy(sink, {
          get: (target, property) => {
            if (property === "commitWave") {
              return async (...args: Parameters<typeof target.commitWave>) => {
                if (held !== undefined) {
                  waveHeld.resolve();
                  await held;
                }
                return await target.commitWave(...args);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    host = serving.host.host!;
  };

  beforeEach(async () => {
    held = undefined;
    waveHeld = Promise.withResolvers();
    await startServing({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });
    session = createSession({
      identity: serviceSigner,
      spaceDid: space as DID,
    });
    cleanups = [];
  });

  afterEach(async () => {
    await host.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
    await serving.close();
  });

  const clientPieces = async (): Promise<PiecesController> => {
    const manager = EmulatedStorageManager.connectTo(serving.server, {
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

  const instantiate = () =>
    host.runLifecycleVerb(space, {
      name: "instantiate",
      run: (runtime) =>
        servedInstantiatePiece(
          new PiecesController(session, runtime, { deferSpaceCellSync: true }),
          { source: { program: PROGRAM }, actingUser: aliceSigner.did() },
        ),
      confirm: (runtime, receipt) =>
        confirmServedInstantiate(runtime, space, receipt, aliceSigner.did()),
    });

  /** The result cell of the piece `id`, opened without starting it. */
  const openResult = async (
    pieces: PiecesController,
    id: string,
  ): Promise<Cell<unknown>> =>
    pieces.getResult(
      await pieces.getPieceCell(id, { reconcile: false, start: false }),
    );

  /** Sends `name` to the piece's verb without an echo. */
  const sendName = async (
    result: Cell<unknown>,
    name: string,
  ): Promise<VerbEventCommitted> => {
    const stream = result.key("setName" as never)
      .asSchemaFromLinks() as Cell<unknown>;
    const sent = await sendVerbEvent(stream, { name }, {
      invocation: { id: crypto.randomUUID(), session: "test-session" },
      echo: false,
    });
    if (sent.status !== "committed") {
      throw new Error(`The send failed: ${sent.error.message}`);
    }
    return sent;
  };

  describe("a send with no echo", () => {
    it("runs the handler on the server without starting the piece here", async () => {
      const { pieceId } = await instantiate();
      const sender = await clientPieces();
      const start = spy(sender.runtime, "start");
      const result = await openResult(sender, pieceId);

      const sent = await sendName(result, "alice");

      expect(await sent.handled()).toEqual({ status: "handled" });
      expect(start.calls).toHaveLength(0);
      const reader = await clientPieces();
      const name = (await openResult(reader, pieceId)).key("name" as never);
      await name.sync();
      expect(name.get()).toBe("alice");
    });

    it("names the receipt the server writes the handler's result to", async () => {
      const { pieceId } = await instantiate();
      const sender = await clientPieces();

      const sent = await sendName(await openResult(sender, pieceId), "alice");
      await sent.handled();

      expect(sent.receipt).toBeDefined();
      const receipt = sender.runtime.getCellFromLink(sent.receipt!);
      expect(await receipt.pull()).toEqual({ saved: "alice" });
    });

    it("reports a handler that throws on the server as a failed handling", async () => {
      const { pieceId } = await instantiate();
      const sender = await clientPieces();

      const sent = await sendName(await openResult(sender, pieceId), "boom");

      const handling = await sent.handled();
      expect(handling.status).toBe("failed");
      expect(handling.status === "failed" && handling.error.message)
        .toContain("served boom");
    });
  });

  describe("pullFromServer()", () => {
    it("returns `true` once the value the server derives has arrived", async () => {
      const { pieceId } = await instantiate();
      const sender = await clientPieces();
      const senderResult = await openResult(sender, pieceId);
      await pullFromServer(
        sender.runtime,
        senderResult.key("upper" as never) as Cell<unknown>,
      );
      const release = Promise.withResolvers<void>();
      held = release.promise;
      await sendName(senderResult, "alice");
      await waveHeld.promise;

      const reader = await clientPieces();
      const piece = await reader.getPieceCell(pieceId, {
        reconcile: false,
        start: false,
      });
      const upper = reader.getResult(piece).key("upper" as never) as Cell<
        unknown
      >;
      let pulled = false;
      const pulling = pullFromServer(reader.runtime, upper).then((answer) => {
        pulled = true;
        return answer;
      });
      // A read that asks for nothing returns what the store holds, which does
      // not have the held wave's write in it.
      const plain = await clientPieces();
      const plainUpper = (await openResult(plain, pieceId))
        .key("upper" as never);
      expect(await plainUpper.pull()).toBe("INITIAL");
      expect(pulled).toBe(false);

      release.resolve();

      expect(await pulling).toBe(true);
      expect(upper.get()).toBe("ALICE");
    });

    it("settles a read only after a demand pass that listed its view", async () => {
      const { pieceId } = await instantiate();
      const reader = await clientPieces();
      const upper = (await openResult(reader, pieceId))
        .key("upper" as never) as Cell<unknown>;
      const server = serving.server;
      const log: string[] = [];
      // The first list holding the view is answered without it, as one read
      // just ahead of the view's registration is.
      let hidden = false;
      const list = server.viewInterestsForSpace.bind(server);
      const listing = stub(server, "viewInterestsForSpace", (...args) => {
        const interests = list(...args);
        const reads = interests.some(({ view }) => view.mode === "read");
        if (reads && !hidden) {
          hidden = true;
          log.push("listed without");
          return interests.filter(({ view }) => view.mode !== "read");
        }
        log.push(reads ? "listed" : "listed without");
        return interests;
      });
      const demand = server.demandForSpace.bind(server);
      const demanding = stub(server, "demandForSpace", (...args) => {
        log.push("demanded");
        return demand(...args);
      });
      const select = server.setViewSelection.bind(server);
      const selecting = stub(server, "setViewSelection", (...args) => {
        if (args[2].settled === true) log.push("settled");
        return select(...args);
      });

      try {
        expect(await pullFromServer(reader.runtime, upper)).toBe(true);
      } finally {
        selecting.restore();
        demanding.restore();
        listing.restore();
      }

      const settledAt = log.indexOf("settled");
      expect(settledAt).toBeGreaterThan(0);
      const passes = log.slice(0, settledAt).flatMap((entry, index, entries) =>
        entries[index + 1] === "demanded" ? [entry] : []
      );
      expect(passes.at(-1)).toBe("listed");
      expect(upper.get()).toBe("INITIAL");
    });

    it("answers a read whose settlement the flush deadline cut", async () => {
      // Every settlement is held past the deadline once a pass has listed the
      // view, for more cycles than anything but the read asks for, so the only
      // thing left to run them is the read itself. The idle window outlasts
      // the test.
      let holding = false;
      let listed = false;
      let cuts = 0;
      const release = Promise.withResolvers<void>();
      await host.close();
      await serving.close();
      await startServing({
        flushDeadlineMs: 50,
        flushDeadlineMaxMs: 400,
        idleParkMs: 600_000,
        storeReadThrough: false,
        onSettleEnded: (exhausted) => {
          if (!exhausted || !holding || !listed) return;
          cuts += 1;
          if (cuts === CUT_SETTLEMENTS) {
            holding = false;
            release.resolve();
          }
        },
      });
      const { pieceId } = await instantiate();
      const reader = await clientPieces();
      const upper = (await openResult(reader, pieceId))
        .key("upper" as never) as Cell<unknown>;
      const server = serving.server;
      const list = server.viewInterestsForSpace.bind(server);
      const listing = stub(server, "viewInterestsForSpace", (...args) => {
        const interests = list(...args);
        listed ||= interests.some(({ view }) => view.mode === "read");
        return interests;
      });
      const idle = server.idle.bind(server);
      const idling = stub(server, "idle", async () => {
        if (holding) await release.promise;
        await idle();
      });
      holding = true;

      try {
        expect(await pullFromServer(reader.runtime, upper)).toBe(true);
      } finally {
        idling.restore();
        listing.restore();
      }

      expect(cuts).toBe(CUT_SETTLEMENTS);
      expect(upper.get()).toBe("INITIAL");
    });

    it("leaves the session able to read after a server refuses a mode it does not know", async () => {
      // What `pullFromServer()` meets on a server that predates `read` views,
      // which it recognizes by this error and answers by releasing the view.

      const { pieceId } = await instantiate();
      const reader = await clientPieces();
      const result = await openResult(reader, pieceId);
      const { space: readerSpace } = result.getAsNormalizedFullLink();
      const replica = reader.runtime.storageManager.open(readerSpace).replica;

      const refusal = await replica.setViewInterests!([{
        id: "unknown-mode",
        revision: 0,
        mode: "a mode from a later build" as ViewInterest["mode"],
        componentContractVersion: "1",
        query: { roots: [{ id: "of:any", selector: { path: [] } }] },
      }]).then(() => undefined, (error: Error) => error);

      expect(refusal?.name).toBe("InvalidMessageError");
      await replica.setViewInterests!([]);
      const name = result.key("name" as never);
      await name.sync();
      expect(name.get()).toBe("initial");
    });

    it("makes the server derive a value nothing has demanded", async () => {
      const { pieceId } = await instantiate();
      const plain = await clientPieces();
      const undemanded = (await openResult(plain, pieceId))
        .key("upper" as never);
      expect(await undemanded.pull()).toBeUndefined();

      const reader = await clientPieces();
      const upper = (await openResult(reader, pieceId))
        .key("upper" as never) as Cell<unknown>;

      expect(await pullFromServer(reader.runtime, upper)).toBe(true);
      expect(upper.get()).toBe("INITIAL");
    });

    it("returns `true` for a value with nothing left to derive", async () => {
      const { pieceId } = await instantiate();
      const reader = await clientPieces();
      const upper = (await openResult(reader, pieceId)).key("upper" as never);
      await pullFromServer(reader.runtime, upper as Cell<unknown>);

      expect(await pullFromServer(reader.runtime, upper as Cell<unknown>))
        .toBe(true);
      expect(upper.get()).toBe("INITIAL");
    });

    it("leaves a later plain read of the same runtime able to read", async () => {
      const { pieceId } = await instantiate();
      const reader = await clientPieces();
      const result = await openResult(reader, pieceId);
      const upper = result.key("upper" as never) as Cell<unknown>;

      await pullFromServer(reader.runtime, upper);
      await pullFromServer(reader.runtime, upper);

      const name = result.key("name" as never);
      await name.sync();
      expect(name.get()).toBe("initial");
    });
  });
});
