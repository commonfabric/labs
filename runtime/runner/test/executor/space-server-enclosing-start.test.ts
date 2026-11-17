import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { sendEvent } from "../../src/cell.ts";
import { ExecutorHost } from "../../src/executor/host.ts";
import { STRUCTURE_LOAD_STUCK_AFTER } from "../../src/executor/space-server.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { getMetaLink, parseLink } from "../../src/link-utils.ts";
import { setResultCell } from "../../src/result-utils.ts";
import { PieceStateMovedError } from "../../src/stored-setup-build.ts";
import { rawMetaWriteAuthorization } from "../../src/meta-seam.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { captureLogs } from "../support/captured-logs.ts";
import { ArrivalLog, awaitEach } from "../support/serving-waits.ts";
import { sessionDemandOf } from "../support/session-demand.ts";

const spaceSigner = await Identity.fromPassphrase(
  "space-server enclosing start space",
);
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "space-server enclosing start service",
);
const setupSigner = await Identity.fromPassphrase(
  "space-server enclosing start setup",
);
const aliceSigner = await Identity.fromPassphrase(
  "space-server enclosing start alice",
);
const bobSigner = await Identity.fromPassphrase(
  "space-server enclosing start bob",
);

// A handler a nested pattern defines, whose input the pattern enclosing it
// derives: the event's stream belongs to the nested instance, and `doubled` is
// written only by the enclosing instance's `computed`. The handler records -1
// where it finds no `doubled`, and what the store holds where nothing in the
// serving runtime derives `doubled` again. `local` is a document of the nested
// instance alone, which a demand can name without naming anything of the
// enclosing instance's, and `shown` is a value of the nested instance's
// derived from `doubled`.
const NESTED_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, Default, handler, pattern, Stream, Writable } from 'commonfabric';",
      "",
      "type Seen = Writable<number | Default<0>>;",
      "",
      "const record = handler<unknown, { doubled?: number; seen: Seen }>(",
      "  (_event, { doubled, seen }) => {",
      "    seen.set(doubled ?? -1);",
      "  },",
      ");",
      "",
      "const recorder = pattern<",
      "  { doubled?: number; seen: Seen },",
      "  { record: Stream<unknown>; local: number; shown: number }",
      ">(({ doubled, seen }) => ({",
      "  record: record({ doubled, seen }),",
      "  local: Writable.of<number>(7),",
      "  shown: computed(() => (doubled ?? -1) + 1000),",
      "}));",
      "",
      "export default pattern<",
      "  { value: number; seen?: Seen },",
      "  { record: Stream<unknown>; local: number; shown: number }",
      ">(({ value, seen }) => {",
      "  const doubled = computed(() => value * 2);",
      "  return recorder({ doubled, seen: seen! });",
      "});",
    ].join("\n"),
  }],
};

// A hub whose nested instance takes its input from a producer, a piece of its
// own: the nested instance's argument links, through the hub's, to what the
// producer derives.
const PRODUCER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "",
      "export default pattern<{ value: number }, { out: number }>(",
      "  ({ value }) => ({ out: computed(() => value * 3) }),",
      ");",
    ].join("\n"),
  }],
};

const HUB_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, Writable } from 'commonfabric';",
      "",
      "const shown = pattern<{ input: number }, { input: number; local: number }>(",
      "  ({ input }) => ({ input, local: Writable.of<number>(7) }),",
      ");",
      "",
      "export default pattern<{ input: number }, { input: number; local: number }>(",
      "  ({ input }) => shown({ input }),",
      ");",
    ].join("\n"),
  }],
};

// Three levels: the outermost pattern derives `tripled`, the middle one passes
// it on, and the innermost one's handler records it.
const DEEP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, Default, handler, pattern, Stream, Writable } from 'commonfabric';",
      "",
      "type Seen = Writable<number | Default<0>>;",
      "type Inner = { record: Stream<unknown>; local: number };",
      "",
      "const record = handler<unknown, { tripled?: number; seen: Seen }>(",
      "  (_event, { tripled, seen }) => {",
      "    seen.set(tripled ?? -1);",
      "  },",
      ");",
      "",
      "const inner = pattern<{ tripled?: number; seen: Seen }, Inner>(",
      "  ({ tripled, seen }) => ({",
      "    record: record({ tripled, seen }),",
      "    local: Writable.of<number>(7),",
      "  }),",
      ");",
      "",
      "const middle = pattern<{ tripled?: number; seen: Seen }, Inner>(",
      "  ({ tripled, seen }) => inner({ tripled, seen }),",
      ");",
      "",
      "export default pattern<{ value: number; seen?: Seen }, Inner>(",
      "  ({ value, seen }) => {",
      "    const tripled = computed(() => value * 3);",
      "    return middle({ tripled, seen: seen! });",
      "  },",
      ");",
    ].join("\n"),
  }],
};

// A handler of the outer pattern makes the child, handing it what the outer
// pattern derives; the child is held behind a value-link slot, not set up by
// the outer pattern's graph.
const HANDLER_MADE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { type Cell, computed, Default, handler, pattern, Stream, Writable } from 'commonfabric';",
      "",
      "type Seen = Writable<number | Default<0>>;",
      "type Child = { record: Stream<unknown>; local: number };",
      "",
      "const record = handler<unknown, { base?: number; seen: Seen }>(",
      "  (_event, { base, seen }) => {",
      "    seen.set(base ?? -1);",
      "  },",
      ");",
      "",
      "const child = pattern<{ base?: number; seen: Seen }, Child>(",
      "  ({ base, seen }) => ({",
      "    record: record({ base, seen }),",
      "    local: Writable.of<number>(7),",
      "  }),",
      ");",
      "",
      "const make = handler<",
      "  unknown,",
      "  { slot: Writable<{ child?: Cell<Child> }>; doubled: Cell<number>; seen: Seen }",
      ">((_event, { slot, doubled, seen }) => {",
      "  if (slot.get().child !== undefined) return;",
      "  slot.set({ child: child({ base: doubled, seen }) });",
      "});",
      "",
      "export default pattern<",
      "  { value: number; seen?: Seen },",
      "  { make: Stream<unknown>; slot: { child?: Cell<Child> } }",
      ">(({ value, seen }) => {",
      "  const doubled = computed(() => value * 2);",
      "  const slot = Writable.of<{ child?: Cell<Child> }>({});",
      "  return { make: make({ slot, doubled, seen: seen! }), slot };",
      "});",
    ].join("\n"),
  }],
};

// The rows a `map` builds take what the pattern that builds them derives.
const MAP_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, Default, handler, pattern, Stream, Writable } from 'commonfabric';",
      "",
      "type Seen = Writable<number | Default<0>>;",
      "type Row = { record: Stream<unknown>; local: number };",
      "",
      "const record = handler<unknown, { doubled?: number; seen: Seen }>(",
      "  (_event, { doubled, seen }) => {",
      "    seen.set(doubled ?? -1);",
      "  },",
      ");",
      "",
      "const row = pattern<{ n: number; doubled?: number; seen: Seen }, Row>(",
      "  ({ doubled, seen }) => ({",
      "    record: record({ doubled, seen }),",
      "    local: Writable.of<number>(7),",
      "  }),",
      ");",
      "",
      "export default pattern<{ value: number; seen?: Seen }, { rows: Row[] }>(",
      "  ({ value, seen }) => {",
      "    const doubled = computed(() => value * 2);",
      "    const items = computed(() => [1]);",
      "    const rows = items.map((n) => row({ n, doubled, seen: seen! }));",
      "    return { rows };",
      "  },",
      ");",
    ].join("\n"),
  }],
};

/** The addresses of a piece set up before any serving loop runs. */
interface Piece {
  /** The enclosing instance's root. */
  enclosing: NormalizedFullLink;

  /** The nested instance's root. */
  nested: NormalizedFullLink;

  /** The nested instance's `local` document. */
  local: NormalizedFullLink;
}

describe("SpaceServer", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let servingRuntime: Runtime | undefined;
  let cycles: ArrivalLog<unknown>;
  let demanded: NormalizedFullLink[];
  let demanders: Identity[];
  let onServingRuntime: ((runtime: Runtime) => void) | undefined;
  const opened: { runtime: Runtime; manager: EmulatedStorageManager }[] = [];

  /** A runtime over the shared server, acting for `as`. */
  const openRuntime = (serverExecution: boolean, as: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution },
    });
    opened.push({ runtime, manager });
    return runtime;
  };

  /** Disposes the runtime `openRuntime()` returned last. */
  const closeLastRuntime = async () => {
    const { runtime, manager } = opened.pop()!;
    await runtime.dispose();
    await manager.close();
  };

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    servingRuntime = undefined;
    cycles = new ArrivalLog();
    demanded = [];
    demanders = [aliceSigner];
    onServingRuntime = undefined;
    // The demand is the documents each case names, each demanded by one
    // session of each of `demanders`, alice unless the case says otherwise: a
    // demand that reaches a nested instance without reaching anything of its
    // enclosing instance's.
    const scopeKey = resolveScopeKey("space", {
      principal: serviceSigner.did(),
    });
    (server as { demandForSpace: unknown }).demandForSpace = () =>
      sessionDemandOf(
        demanders.flatMap((who, session) =>
          demanded.map(({ id }) => ({
            id,
            scope: "space" as const,
            scopeKey,
            root: true,
            identity: { principal: who.did(), sessionId: `viewer-${session}` },
          }))
        ),
      );
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    for (const { runtime, manager } of opened.splice(0)) {
      await runtime.dispose();
      await manager.close();
    }
    await server.close();
  });

  /** A host serving the space, whose runtime `onServingRuntime` sees first. */
  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntime = runtime;
        onServingRuntime?.(runtime);
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy: { idleParkMs: 600_000 },
      onWaveCycle: cycles.record,
    });

  /**
   * Makes `links` the space's whole demand, once the host serves the space,
   * and has its serving loop read it.
   */
  const demand = async (...links: NormalizedFullLink[]) => {
    await awaitEach(cycles, () => host?.spaceServer(space) !== undefined);
    demanded = links;
    host!.spaceServer(space)!.noteDemandChanged();
  };

  /** Whether the serving runtime runs the piece rooted at `root`. */
  const serves = (root: NormalizedFullLink, runtime = servingRuntime) =>
    runtime?.runner.isRunning(runtime.getCellFromLink(root)) === true;

  /**
   * Sets up `program` (`NESTED_PROGRAM` by default) with `value` 1, then stops
   * it and moves `value` to 5 with nothing running, so that what its
   * outermost instance derives now is what a run of it in the serving runtime
   * derives. With `origin`, the outermost instance records that origin.
   * Returns the innermost instance as `nested`, with its argument, and the
   * pattern pointer of the outermost one.
   */
  const setUpNested = async (
    { origin, program = NESTED_PROGRAM }: {
      origin?: string;
      program?: RuntimeProgram;
    } = {},
  ): Promise<
    Piece & {
      stream: NormalizedFullLink;
      nestedArgument: NormalizedFullLink;
      enclosingPattern: { identity: string; symbol: string };

      /** `NESTED_PROGRAM`'s nested `shown`, for that program alone. */
      shown?: NormalizedFullLink;

      /** `DEEP_PROGRAM`'s middle piece, for that program alone. */
      middle?: NormalizedFullLink;
    }
  > => {
    const setup = openRuntime(false, setupSigner);
    const compiled = await setup.patternManager.compilePattern(
      program,
      { space },
    );
    const argument = setup.getCell<{ value: number; seen?: number }>(
      space,
      "enclosing start argument",
      compiled.argumentSchema,
    );
    const result = setup.getCell<{ local: number }>(
      space,
      "enclosing start result",
      compiled.resultSchema,
    );
    {
      const tx = setup.edit();
      argument.withTx(tx).set({ value: 1 });
      setup.run(tx, compiled, argument, result);
      if (origin !== undefined) {
        result.withTx(tx).setMetaRaw(
          "patternSource",
          origin,
          rawMetaWriteAuthorization,
        );
      }
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await result.pull();
    const stream = result.key("record").resolveAsCell()
      .getAsNormalizedFullLink();
    const nested = {
      ...getMetaLink(setup.getCellFromLink(stream), "result")!,
      path: [],
    } as NormalizedFullLink;
    const local = setup.getCellFromLink(nested).key("local" as never)
      .resolveAsCell().getAsNormalizedFullLink();
    // The pieces between the outermost and the innermost, each the root a
    // whole-value link of the one before names.
    const between: NormalizedFullLink[] = [];
    {
      let next = parseLink(result.getRaw(), result);
      while (next !== undefined && next.id !== nested.id) {
        const cell = setup.getCellFromLink({ ...next, path: [] });
        await cell.sync();
        if (cell.getMetaRaw("patternIdentity") !== undefined) {
          between.push({ ...next, path: [] } as NormalizedFullLink);
        }
        next = parseLink(cell.getRaw(), cell);
      }
    }
    const middle = between[0];
    const shown = program === NESTED_PROGRAM
      ? setup.getCellFromLink(nested).key("shown" as never).resolveAsCell()
        .getAsNormalizedFullLink()
      : undefined;
    const nestedArgument = getMetaLink(
      setup.getCellFromLink(nested),
      "argument",
    )!;
    const enclosingPattern = result.getMetaRaw("patternIdentity") as {
      identity: string;
      symbol: string;
    };
    setup.runner.stop(result);
    {
      const tx = setup.edit();
      argument.withTx(tx).key("value").set(5);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    await setup.idle();
    await setup.storageManager.synced();
    await closeLastRuntime();
    return {
      stream,
      enclosing: result.getAsNormalizedFullLink(),
      nested,
      local,
      nestedArgument,
      enclosingPattern,
      shown,
      middle,
    };
  };

  let touches = 0;

  /** Commits a write to the space as a runtime that runs nothing. */
  const touchSpace = async () => {
    const writer = openRuntime(false, setupSigner);
    const cell = writer.getCell<number>(space, "enclosing start touch", {
      type: "number",
    });
    await cell.sync();
    const tx = writer.edit();
    cell.withTx(tx).set(++touches);
    expect((await tx.commit().settled).error).toBeUndefined();
    await writer.storageManager.synced();
    await closeLastRuntime();
  };

  /**
   * Sends an event to `stream` as alice and returns what the served handler
   * recorded of the `doubled` it read, as a runtime that runs none of the
   * piece reads it: the sender's own speculative run records what that
   * runtime derives.
   */
  const recordedOnEvent = async (
    stream: NormalizedFullLink,
  ): Promise<number> => {
    const client = openRuntime(true, aliceSigner);
    // The link's own schema names a schema document this runtime has not
    // synced, and a send needs only to know the cell is a stream.
    const target = client.getCellFromLink({
      ...stream,
      schema: { asCell: ["stream"] },
    } as NormalizedFullLink);
    await target.sync();
    sendEvent(target, {});
    const reader = openRuntime(false, aliceSigner);
    const argument = reader.getCell<{ seen?: number }>(
      space,
      "enclosing start argument",
      { type: "object", properties: { seen: { type: "number" } } },
    );
    await argument.sync();
    return await waitForCellValue(
      reader,
      argument.key("seen"),
      (seen: number | undefined) => seen !== undefined && seen !== 0,
      { stuckLabel: "the served handler to record what it read" },
    ) as number;
  };

  describe("instance members", () => {
    describe("noteDemandChanged()", () => {
      it("starts the piece that encloses a nested piece a demand reaches alone, so a served handler there reads what the enclosing piece derives now", async () => {
        host = newHost();
        const { stream, enclosing, nested, local } = await setUpNested();
        await demand(local);

        await awaitEach(cycles, () => serves(nested));
        expect(await recordedOnEvent(stream)).toBe(10);
        expect(serves(enclosing)).toBe(true);
      });

      it("starts every piece enclosing a piece nested two levels deep", async () => {
        host = newHost();
        const { stream, enclosing, nested, local } = await setUpNested({
          program: DEEP_PROGRAM,
        });
        await demand(local);

        await awaitEach(cycles, () => serves(nested));
        expect(await recordedOnEvent(stream)).toBe(15);
        expect(serves(enclosing)).toBe(true);
      });

      it("starts the enclosing piece again in the tenure after a park, and leaves none running in the parked one", async () => {
        host = newHost();
        const { stream, enclosing, nested, local } = await setUpNested();
        await demand(local);
        await awaitEach(cycles, () => serves(nested) && serves(enclosing));
        const parked = servingRuntime;
        await host.spaceServer(space)!.park("test-park");

        expect(serves(enclosing, parked)).toBe(false);
        expect(serves(nested, parked)).toBe(false);
        // A write reactivates the space, and the next tenure's demand pass
        // starts both before any event could.
        await touchSpace();
        await awaitEach(
          cycles,
          () => servingRuntime !== parked && serves(nested),
        );
        expect(serves(enclosing)).toBe(true);
        expect(await recordedOnEvent(stream)).toBe(10);
      });

      it("follows the origin of an enclosing piece before starting it, holding the nested piece back until it has", async () => {
        const followed: { id: string; nestedRunning: boolean }[] = [];
        onServingRuntime = (runtime) => {
          runtime.sourceReconciler.reconcile = (cell) => {
            followed.push({
              id: cell.getAsNormalizedFullLink().id,
              nestedRunning: serves(nested, runtime),
            });
            return Promise.resolve("current" as const);
          };
        };
        host = newHost();
        const { stream, enclosing, nested, local } = await setUpNested({
          origin: "system:system/probe/probe.tsx",
        });
        await demand(local);

        await awaitEach(cycles, () => serves(nested));
        expect(followed).toEqual([{ id: enclosing.id, nestedRunning: false }]);
        expect(serves(enclosing)).toBe(true);
        expect(await recordedOnEvent(stream)).toBe(10);
      });

      it("holds a nested piece back while its enclosing piece's start throws, counts the failure, and starts both on a later cycle", async () => {
        const failing: { id?: string; left: number } = { left: 1 };
        onServingRuntime = (runtime) => {
          const start = runtime.start.bind(runtime);
          runtime.start = (cell, options) => {
            if (
              cell.getAsNormalizedFullLink().id === failing.id &&
              failing.left > 0
            ) {
              failing.left -= 1;
              return Promise.reject(
                new Error("test failure of the enclosing start"),
              );
            }
            return start(cell, options);
          };
        };
        using logs = captureLogs("space-server");
        host = newHost();
        const { stream, enclosing, nested, local } = await setUpNested();
        failing.id = enclosing.id;
        await demand(local);

        // Whichever comes first, so that a nested piece started alone fails
        // the case rather than leaving it waiting.
        await awaitEach(
          cycles,
          () => host!.stats().structureLoadFailures > 0 || serves(nested),
        );
        expect(failing.left).toBe(0);
        expect(serves(nested)).toBe(false);
        expect(logs.textsOf("structure-load-failed")).toEqual([
          `demanded root ${local.id} did not load The start of ` +
          `${enclosing.id}, which the start of ${nested.id} requires, failed`,
        ]);
        await touchSpace();
        await awaitEach(cycles, () => serves(nested));
        expect(serves(enclosing)).toBe(true);
        expect(await recordedOnEvent(stream)).toBe(10);
      });

      it("holds a nested piece back while the links naming its enclosing piece cannot be read, and starts both on a later cycle", async () => {
        const failing: { id?: string; left: number } = { left: 1 };
        onServingRuntime = (runtime) => {
          const manager = runtime.storageManager;
          const syncCell = manager.syncCell.bind(manager);
          manager.syncCell = (cell, options) => {
            if (
              cell.getAsNormalizedFullLink().id === failing.id &&
              failing.left > 0
            ) {
              failing.left -= 1;
              return Promise.reject(
                new Error("test failure of the argument's read"),
              );
            }
            return syncCell(cell, options);
          };
        };
        host = newHost();
        const { stream, enclosing, nested, local, nestedArgument } =
          await setUpNested();
        failing.id = nestedArgument.id;
        await demand(local);

        // Whichever comes first, so that a nested piece started alone fails
        // the case rather than leaving it waiting.
        await awaitEach(
          cycles,
          () => host!.stats().structureLoadFailures > 0 || serves(nested),
        );
        expect(failing.left).toBe(0);
        expect(serves(nested)).toBe(false);
        await touchSpace();
        await awaitEach(cycles, () => serves(nested));
        expect(serves(enclosing)).toBe(true);
        expect(await recordedOnEvent(stream)).toBe(10);
      });

      it("counts a nested piece whose enclosing piece's start is refused as refused, and leaves it unstarted", async () => {
        const refusing: { id?: string } = {};
        onServingRuntime = (runtime) => {
          const start = runtime.start.bind(runtime);
          runtime.start = (cell, options) =>
            cell.getAsNormalizedFullLink().id === refusing.id
              ? Promise.reject(
                new PieceStateMovedError(
                  refusing.id,
                  { identity: "enclosing start pattern", symbol: "default" },
                  [],
                  [],
                ),
              )
              : start(cell, options);
        };
        host = newHost();
        const { enclosing, nested, local } = await setUpNested();
        refusing.id = enclosing.id;
        await demand(local);

        await awaitEach(
          cycles,
          () => host!.stats().structureLoadRefused > 0 || serves(nested),
        );
        expect(serves(nested)).toBe(false);
        expect(serves(enclosing)).toBe(false);
        expect(host.stats().structureLoadFailures).toBe(0);
      });

      it("parks every demanded document of a nested piece once its enclosing piece's start commit fails, a second one included", async () => {
        using logs = captureLogs("space-server");
        host = newHost();
        const { enclosing, nested, local, nestedArgument } =
          await setUpNested();
        await demand(local);
        await awaitEach(cycles, () => serves(nested));
        const reconciled = host.stats().demand.demandKeysReconciled;
        // The second document resolves to the nested piece, already running.
        await demand(local, nestedArgument);
        await awaitEach(
          cycles,
          () => host!.stats().demand.demandKeysReconciled > reconciled,
        );

        servingRuntime!.pieceStartCommitFailureObserver!({
          actionId: `piece-start/${enclosing.id}`,
          error: new Error("test failure of the enclosing start's commit"),
        });
        expect(logs.textsOf("structure-load-start-failed")).toEqual([
          `piece ${enclosing.id}'s start commit failed; its 2 demanded ` +
          "document(s) parked until a commit touches the piece",
        ]);
      });

      it("supplies the runs of the enclosing piece the demanders of the nested piece's demanded document", async () => {
        const supplied: { roots: string[]; principals: string[] }[] = [];
        onServingRuntime = (runtime) => {
          const demandersFor = runtime.serverRunDemandersFor.bind(runtime);
          runtime.serverRunDemandersFor = (roots) => {
            const demanders = demandersFor(roots);
            supplied.push({
              roots: [...roots],
              principals: (demanders ?? []).map(({ principal }) =>
                String(principal)
              ),
            });
            return demanders;
          };
        };
        host = newHost();
        const { enclosing, nested, local, shown } = await setUpNested();
        await demand(local, shown!);

        // No event is queued, whose sender would be a demander of its own:
        // the runs are the ones `shown`, which alice demands, pulls.
        await awaitEach(
          cycles,
          () =>
            serves(nested) &&
            supplied.some(({ roots }) =>
              roots.length === 1 && roots[0] === enclosing.id
            ),
        );
        const forEnclosing = supplied.filter(({ roots }) =>
          roots.length === 1 && roots[0] === enclosing.id
        );
        expect(
          forEnclosing.some(({ principals }) =>
            principals.includes(aliceSigner.did())
          ),
        ).toBe(true);
      });

      it("holds a nested piece back for good while its enclosing piece's pattern never loads, warning that it is stuck, and starts it alone for an event", async () => {
        const unloadable: { identity?: string; symbol?: string } = {};
        onServingRuntime = (runtime) => {
          const load = runtime.patternManager.loadPatternByIdentity.bind(
            runtime.patternManager,
          );
          runtime.patternManager.loadPatternByIdentity = (
            identity,
            symbol,
            ...rest
          ) =>
            identity === unloadable.identity && symbol === unloadable.symbol
              ? Promise.resolve(undefined)
              : load(identity, symbol, ...rest);
        };
        using logs = captureLogs("space-server");
        host = newHost();
        const { stream, enclosing, nested, local, enclosingPattern } =
          await setUpNested();
        Object.assign(unloadable, enclosingPattern);
        await demand(local);
        for (let cycle = 0; cycle < STRUCTURE_LOAD_STUCK_AFTER; cycle++) {
          const deferred = host.stats().structureLoadDeferred;
          await touchSpace();
          await awaitEach(
            cycles,
            () => host!.stats().structureLoadDeferred > deferred,
          );
        }

        expect(host.stats().structureLoadStuck).toBe(1);
        expect(serves(nested)).toBe(false);
        expect(logs.textsOf("structure-load-stuck")[0]).toContain(
          `(pattern-unloadable held back by ${enclosing.id})`,
        );
        // An event to the nested piece's stream starts it alone, as the event
        // path starts a piece whose sources do not start, and its handler
        // reads what the enclosing piece derived last.
        // TODO(danfuzz): Expect the event held back with the demand, once an
        // event's auto-load of a nested piece on a serving runtime requires
        // the pieces enclosing it, as the demand start does.
        expect(await recordedOnEvent(stream)).toBe(2);
        expect(serves(nested)).toBe(true);
        expect(serves(enclosing)).toBe(false);
      });

      it("parks both demanded documents of a nested piece demanded together once its enclosing piece's start commit fails", async () => {
        using logs = captureLogs("space-server");
        host = newHost();
        const { enclosing, nested, local, nestedArgument } =
          await setUpNested();
        await demand(local, nestedArgument);
        await awaitEach(cycles, () => serves(nested));
        await awaitEach(
          cycles,
          () => host!.stats().demand.demandKeysReconciled >= 2,
        );

        servingRuntime!.pieceStartCommitFailureObserver!({
          actionId: `piece-start/${enclosing.id}`,
          error: new Error("test failure of the enclosing start's commit"),
        });
        expect(logs.textsOf("structure-load-start-failed")).toEqual([
          `piece ${enclosing.id}'s start commit failed; its 2 demanded ` +
          "document(s) parked until a commit touches the piece",
        ]);
      });

      it("re-arms the enclosing piece's runs for a demander who arrives at a demanded document later", async () => {
        const rearmed: string[][] = [];
        onServingRuntime = (runtime) => {
          const invalidate = runtime.scheduler.invalidateActionsForDemandRoots
            .bind(runtime.scheduler);
          runtime.scheduler.invalidateActionsForDemandRoots = (roots) => {
            rearmed.push([...roots]);
            return invalidate(roots);
          };
        };
        host = newHost();
        const { enclosing, nested, local } = await setUpNested();
        await demand(local);
        await awaitEach(cycles, () => serves(nested));
        const arrivals = host.stats().demandArrivals;
        const before = rearmed.length;
        demanders = [aliceSigner, bobSigner];
        host.spaceServer(space)!.noteDemandChanged();
        await awaitEach(cycles, () => host!.stats().demandArrivals > arrivals);

        expect(
          rearmed.slice(before).some((roots) => roots.includes(enclosing.id)),
        ).toBe(true);
      });

      for (
        const [shape, chain] of [
          ["a document eleven `result` hops deep", 12],
          ["one of two documents naming each other by `result`", 2],
        ] as const
      ) {
        it(`serves a piece whose argument links to ${shape}`, async () => {
          host = newHost();
          const setup = openRuntime(false, setupSigner);
          const compiled = await setup.patternManager.compilePattern(
            PRODUCER_PROGRAM,
            { space },
          );
          const piece = setup.getCell<{ out: number }>(
            space,
            "enclosing start producer",
            compiled.resultSchema,
          );
          {
            const tx = setup.edit();
            setup.run(tx, compiled, { value: 2 }, piece);
            expect((await tx.commit().settled).error).toBeUndefined();
          }
          await piece.pull();
          // Documents each but the last carrying a `result` backlink to the
          // next, the last naming the first where there are two.
          const argument = setup.getCellFromLink(
            getMetaLink(piece, "argument")!,
          );
          await argument.sync();
          {
            const tx = setup.edit();
            const cells = Array.from(
              { length: chain },
              (_, i) => setup.getCell<unknown>(space, `chain ${i}`, {}, tx),
            );
            for (const cell of cells) cell.setRaw({});
            for (let i = 0; i + 1 < chain; i++) {
              setResultCell(cells[i], cells[i + 1]);
            }
            if (chain === 2) setResultCell(cells[1], cells[0]);
            argument.withTx(tx).setRaw({
              ...(argument.getRaw() as Record<string, unknown>),
              linked: cells[0].getAsLink(),
            } as never);
            expect((await tx.commit().settled).error).toBeUndefined();
          }
          setup.runner.stop(piece);
          await setup.idle();
          await setup.storageManager.synced();
          await closeLastRuntime();
          await demand(piece.getAsNormalizedFullLink());

          await awaitEach(
            cycles,
            () => serves(piece.getAsNormalizedFullLink()),
          );
        });
      }

      it("parks the key of a piece between the outermost and the demanded one once the outermost piece's start commit fails", async () => {
        using logs = captureLogs("space-server");
        host = newHost();
        const { enclosing, nested, local, middle } = await setUpNested({
          program: DEEP_PROGRAM,
        });
        await demand(local);
        await awaitEach(cycles, () => serves(nested) && serves(middle!));
        const reconciled = host.stats().demand.demandKeysReconciled;
        // The middle piece's key arrives once it runs, so no walk is made
        // for it.
        await demand(local, middle!);
        await awaitEach(
          cycles,
          () => host!.stats().demand.demandKeysReconciled > reconciled,
        );

        servingRuntime!.pieceStartCommitFailureObserver!({
          actionId: `piece-start/${enclosing.id}`,
          error: new Error("test failure of the outer start's commit"),
        });
        expect(logs.textsOf("structure-load-start-failed")).toEqual([
          `piece ${enclosing.id}'s start commit failed; its 2 demanded ` +
          "document(s) parked until a commit touches the piece",
        ]);
      });

      it("indexes no key of a nested piece that started as its enclosing piece's child, before any walk for it", async () => {
        // TODO(danfuzz): Expect both keys parked, once the pieces enclosing a
        // piece that started without a walk are known for its keys.
        using logs = captureLogs("space-server");
        host = newHost();
        const { enclosing, nested, local } = await setUpNested();
        await demand(enclosing);
        await awaitEach(cycles, () => serves(enclosing) && serves(nested));
        const reconciled = host.stats().demand.demandKeysReconciled;
        await demand(enclosing, local);
        await awaitEach(
          cycles,
          () => host!.stats().demand.demandKeysReconciled > reconciled,
        );

        servingRuntime!.pieceStartCommitFailureObserver!({
          actionId: `piece-start/${enclosing.id}`,
          error: new Error("test failure of the enclosing start's commit"),
        });
        expect(logs.textsOf("structure-load-start-failed")).toEqual([
          `piece ${enclosing.id}'s start commit failed; its 1 demanded ` +
          "document(s) parked until a commit touches the piece",
        ]);
      });

      it("starts a child a handler made alone, so its handler reads no value its maker derives", async () => {
        // TODO(danfuzz): Expect 10, as for a nested piece, once the demand
        // start finds the piece whose handler made a demanded piece.
        host = newHost();
        const setup = openRuntime(false, setupSigner);
        const compiled = await setup.patternManager.compilePattern(
          HANDLER_MADE_PROGRAM,
          { space },
        );
        const argument = setup.getCell<{ value: number; seen?: number }>(
          space,
          "enclosing start argument",
          compiled.argumentSchema,
        );
        const maker = setup.getCell<{ slot: { child?: unknown } }>(
          space,
          "enclosing start maker",
          compiled.resultSchema,
        );
        {
          const tx = setup.edit();
          argument.withTx(tx).set({ value: 1 });
          setup.run(tx, compiled, argument, maker);
          expect((await tx.commit().settled).error).toBeUndefined();
        }
        await maker.pull();
        sendEvent(maker.key("make" as never), {});
        await setup.idle();
        await setup.storageManager.synced();
        const child = maker.key("slot").key("child" as never).resolveAsCell();
        await child.pull();
        const childRoot = {
          ...child.getAsNormalizedFullLink(),
          path: [],
        } as NormalizedFullLink;
        const stream = child.key("record" as never).resolveAsCell()
          .getAsNormalizedFullLink();
        const local = child.key("local" as never).resolveAsCell()
          .getAsNormalizedFullLink();
        setup.runner.stop(child);
        setup.runner.stop(maker);
        {
          const tx = setup.edit();
          argument.withTx(tx).key("value").set(5);
          expect((await tx.commit().settled).error).toBeUndefined();
        }
        await setup.idle();
        await setup.storageManager.synced();
        await closeLastRuntime();
        await demand(local);

        await awaitEach(cycles, () => serves(childRoot));
        expect(serves(maker.getAsNormalizedFullLink())).toBe(false);
        expect(await recordedOnEvent(stream)).toBe(-1);
      });

      it("starts a row a `map` built after the piece that built it, in its own right, with its key parked by no failure of that piece", async () => {
        // TODO(danfuzz): Expect the row to stop with the piece that built it,
        // once a demanded row starts as the child of the `map` that builds it,
        // and its document parked by that piece's failed start commit, once a
        // row's key is indexed under the pieces enclosing the `map`'s callback.
        using logs = captureLogs("space-server");
        host = newHost();
        const setup = openRuntime(false, setupSigner);
        const compiled = await setup.patternManager.compilePattern(
          MAP_PROGRAM,
          { space },
        );
        const argument = setup.getCell<{ value: number; seen?: number }>(
          space,
          "enclosing start argument",
          compiled.argumentSchema,
        );
        const builder = setup.getCell<{ rows: unknown[] }>(
          space,
          "enclosing start builder",
          compiled.resultSchema,
        );
        {
          const tx = setup.edit();
          argument.withTx(tx).set({ value: 1 });
          setup.run(tx, compiled, argument, builder);
          expect((await tx.commit().settled).error).toBeUndefined();
        }
        await builder.pull();
        const rowValue = builder.key("rows").key(0 as never);
        const local = rowValue.key("local" as never).resolveAsCell()
          .getAsNormalizedFullLink();
        const stream = rowValue.key("record" as never).resolveAsCell()
          .getAsNormalizedFullLink();
        const row = {
          ...getMetaLink(setup.getCellFromLink(local), "result")!,
          path: [],
        } as NormalizedFullLink;
        setup.runner.stop(builder);
        {
          const tx = setup.edit();
          argument.withTx(tx).key("value").set(5);
          expect((await tx.commit().settled).error).toBeUndefined();
        }
        await setup.idle();
        await setup.storageManager.synced();
        await closeLastRuntime();
        await demand(local);

        await awaitEach(cycles, () => serves(row));
        expect(serves(builder.getAsNormalizedFullLink())).toBe(true);
        expect(await recordedOnEvent(stream)).toBe(10);
        servingRuntime!.pieceStartCommitFailureObserver!({
          actionId: `piece-start/${builder.getAsNormalizedFullLink().id}`,
          error: new Error("test failure of the builder's start commit"),
        });
        expect(logs.textsOf("structure-load-start-failed")).toEqual([]);
        servingRuntime!.runner.stop(
          servingRuntime!.getCellFromLink(builder.getAsNormalizedFullLink()),
        );
        expect(serves(builder.getAsNormalizedFullLink())).toBe(false);
        expect(serves(row)).toBe(true);
      });

      it("starts a nested piece alone whose enclosing piece carries no pattern pointer, which nothing can start", async () => {
        host = newHost();
        const { enclosing, nested, local } = await setUpNested();
        // A pattern without a durable identity sets its piece up with an
        // `internal` record and no `patternIdentity`.
        {
          const writer = openRuntime(false, setupSigner);
          const root = writer.getCellFromLink(enclosing);
          await root.sync();
          const tx = writer.edit();
          root.withTx(tx).setMetaRaw(
            "patternIdentity",
            undefined,
            rawMetaWriteAuthorization,
          );
          expect((await tx.commit().settled).error).toBeUndefined();
          await writer.storageManager.synced();
          await closeLastRuntime();
        }
        await demand(local);

        await awaitEach(cycles, () => serves(nested));
        expect(serves(enclosing)).toBe(false);
      });

      it("leaves unstarted a producer a hub's nested piece takes its input from", async () => {
        host = newHost();
        const setup = openRuntime(false, setupSigner);
        const producerPattern = await setup.patternManager.compilePattern(
          PRODUCER_PROGRAM,
          { space },
        );
        const hubPattern = await setup.patternManager.compilePattern(
          HUB_PROGRAM,
          { space },
        );
        const producer = setup.getCell<{ out: number }>(
          space,
          "enclosing start producer",
          producerPattern.resultSchema,
        );
        const hub = setup.getCell<{ input: number; local: number }>(
          space,
          "enclosing start hub",
          hubPattern.resultSchema,
        );
        {
          const tx = setup.edit();
          setup.run(tx, producerPattern, { value: 2 }, producer);
          setup.run(tx, hubPattern, { input: producer.key("out") }, hub);
          expect((await tx.commit().settled).error).toBeUndefined();
        }
        await hub.pull();
        const nested = {
          ...getMetaLink(
            setup.getCellFromLink(
              hub.key("local").resolveAsCell().getAsNormalizedFullLink(),
            ),
            "result",
          )!,
          path: [],
        } as NormalizedFullLink;
        const local = hub.key("local").resolveAsCell()
          .getAsNormalizedFullLink();
        setup.runner.stop(hub);
        setup.runner.stop(producer);
        await setup.idle();
        await setup.storageManager.synced();
        await closeLastRuntime();
        await demand(local);

        await awaitEach(cycles, () => serves(nested));
        expect(serves(hub.getAsNormalizedFullLink())).toBe(true);
        expect(serves(producer.getAsNormalizedFullLink())).toBe(false);
      });
    });
  });
});
