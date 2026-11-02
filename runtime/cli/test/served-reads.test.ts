/**
 * The CLI's reads and calls against a real serving loop: nothing starts a piece
 * in the command's process, a read asks the server for what it returns, and
 * `run: false` returns what the store holds.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";
import { createSession, Identity, type Session } from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import {
  confirmServedInstantiate,
  PiecesController,
  servedInstantiatePiece,
} from "@commonfabric/piece/ops";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import type { ExecutorHost } from "@commonfabric/runner/executor/host";
import {
  type ServingMemoryServer,
  startServingMemoryServer,
} from "@commonfabric/runner/executor/serving-memory-server.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

import { parseCellSelectionOptions } from "../lib/cell-selection.ts";
import {
  executePieceCallable,
  getCellValue,
  type PieceConfig,
  PieceVerbReadError,
  stepPiece,
} from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";
import { captureStderr } from "./utils.ts";

const spaceSigner = await Identity.fromPassphrase("cli served reads space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("cli served reads service");
const aliceSigner = await Identity.fromPassphrase("cli served reads alice");

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
>((event, state) => {
  state.name.set(event.name);
  return { saved: event.name };
});

export default pattern<{ seed?: string }>(() => {
  const name = new Writable<string>("initial").for("name");
  const upper = computed(() => name.get().toUpperCase());
  return { [NAME]: "Served reads", name, upper, setName: setName({ name }) };
});
`,
  }],
};

describe("served reads and calls", () => {
  let serving: ServingMemoryServer;
  let host: ExecutorHost;
  let session: Session;
  let cleanups: Array<() => Promise<void>>;
  let pieceId: string;
  let config: PieceConfig;

  /** While set, the serving runtime's wave commits wait for it to settle. */
  let held: Promise<void> | undefined;

  /** Resolves when a wave commit reaches the sink while one is held. */
  let waveHeld: PromiseWithResolvers<void>;

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

  /** The dependencies that point a CLI operation at `pieces`. */
  const depsFor = (pieces: PiecesController) => ({
    loadPieces: () => Promise.resolve(pieces),
    resolvePieceAddress: (_pieces: unknown, token: string) =>
      Promise.resolve(token),
  });

  /** Calls `setName` as `cf piece call` does, naming an invocation. */
  const callSetName = async (pieces: PiecesController, name: string) =>
    await executePieceCallable(config, "setName", ["--name", name], {
      ...depsFor(pieces),
      invocation: { id: crypto.randomUUID(), session: "test-session" },
    });

  beforeEach(async () => {
    held = undefined;
    waveHeld = Promise.withResolvers();
    serving = await startServingMemoryServer({
      apiUrl: new URL(import.meta.url),
      serviceIdentity: serviceSigner,
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
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
    session = createSession({
      identity: serviceSigner,
      spaceDid: space as DID,
    });
    cleanups = [];
    ({ pieceId } = await host.runLifecycleVerb(space, {
      name: "instantiate",
      run: (runtime) =>
        servedInstantiatePiece(
          new PiecesController(session, runtime, { deferSpaceCellSync: true }),
          { source: { program: PROGRAM }, actingUser: aliceSigner.did() },
        ),
      confirm: (runtime, receipt) =>
        confirmServedInstantiate(runtime, space, receipt, aliceSigner.did()),
    }));
    config = {
      apiUrl: "http://localhost:1",
      space,
      identity: "/nonexistent/keyfile",
      piece: pieceId,
    };
  });

  afterEach(async () => {
    await host.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
    await serving.close();
  });

  describe("executePieceCallable()", () => {
    it("returns the handler's result without starting the piece here", async () => {
      const pieces = await clientPieces();
      const start = spy(pieces.runtime, "start");

      const { invocation } = await callSetName(pieces, "alice");

      expect(invocation?.status).toBe("settled");
      expect(invocation?.result).toEqual({ saved: "alice" });
      expect(start.calls).toHaveLength(0);
    });
  });

  describe("getCellValue()", () => {
    it("returns the value the server derives, once it has arrived", async () => {
      const sender = await clientPieces();
      await getCellValue(config, ["upper"], {}, depsFor(sender));
      const release = Promise.withResolvers<void>();
      held = release.promise;
      await executePieceCallable(config, "setName", ["--name", "alice"], {
        ...depsFor(sender),
        invocation: { id: crypto.randomUUID(), session: "test-session" },
        skipReadback: true,
      });
      await waveHeld.promise;

      const reader = await clientPieces();
      let read = false;
      const reading = getCellValue(config, ["upper"], {}, depsFor(reader)).then(
        (value) => {
          read = true;
          return value;
        },
      );
      const stored = await clientPieces();

      expect(
        await getCellValue(
          config,
          ["upper"],
          { run: false },
          depsFor(stored),
        ),
      ).toBe("INITIAL");
      expect(read).toBe(false);

      release.resolve();

      expect(await reading).toBe("ALICE");
    });

    it("returns `undefined` under `run: false` for a value nothing has derived", async () => {
      const pieces = await clientPieces();

      expect(
        await getCellValue(config, ["upper"], { run: false }, depsFor(pieces)),
      ).toBeUndefined();
    });

    it("returns `undefined` under `run: false` for a selection of a value nothing has derived", async () => {
      const pieces = await clientPieces();

      expect(
        await getCellValue(config, ["upper"], {
          run: false,
          selection: (await parseCellSelectionOptions({
            schema: '{"type":"string"}',
          }))!,
        }, depsFor(pieces)),
      ).toBeUndefined();
    });

    it("refuses a verb's path under `run: false` as it does for any read", async () => {
      const pieces = await clientPieces();

      await expect(
        getCellValue(config, ["setName"], { run: false }, depsFor(pieces)),
      ).rejects.toThrow(PieceVerbReadError);
    });

    it("starts nothing for a read with `step`", async () => {
      const pieces = await clientPieces();
      const start = spy(pieces.runtime, "start");

      expect(
        await getCellValue(config, ["upper"], { step: true }, depsFor(pieces)),
      ).toBe("INITIAL");
      expect(start.calls).toHaveLength(0);
    });
  });

  describe("stepPiece()", () => {
    it("starts nothing and names no write", async () => {
      resetWriteReceipts();
      const pieces = await clientPieces();
      const start = spy(pieces.runtime, "start");

      const lines = await captureStderr(() =>
        stepPiece(config, depsFor(pieces))
      );

      expect(start.calls).toHaveLength(0);
      expect(lines).not.toContain(`wrote to space ${space}`);
    });
  });
});
