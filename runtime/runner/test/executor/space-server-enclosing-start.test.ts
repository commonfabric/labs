import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { sendEvent } from "../../src/cell.ts";
import { ExecutorHost } from "../../src/executor/host.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { getMetaLink } from "../../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../../src/meta-seam.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
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
const openLogger = getLogger("ensure-piece-running.open");

// A handler a nested pattern defines, whose input the pattern enclosing it
// derives: the event's stream belongs to the nested instance, and `doubled` is
// written only by the enclosing instance's `computed`. `local` is a document
// of the nested instance alone, which a demand can name without naming
// anything of the enclosing instance's.
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
      "  { record: Stream<unknown>; local: number }",
      ">(({ doubled, seen }) => ({",
      "  record: record({ doubled, seen }),",
      "  local: Writable.of<number>(7),",
      "}));",
      "",
      "export default pattern<",
      "  { value: number; seen?: Seen },",
      "  { record: Stream<unknown>; local: number }",
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
    onServingRuntime = undefined;
    // The demand is the one document each case names, demanded by one
    // session of alice's: a demand that reaches a nested instance without
    // reaching anything of its enclosing instance's.
    const scopeKey = resolveScopeKey("space", {
      principal: serviceSigner.did(),
    });
    (server as { demandForSpace: unknown }).demandForSpace = () =>
      sessionDemandOf(demanded.map(({ id }) => ({
        id,
        scope: "space" as const,
        scopeKey,
        root: true,
        identity: { principal: aliceSigner.did(), sessionId: "viewer" },
      })));
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
   * Sets up `NESTED_PROGRAM` with `value` 1, so the store holds `doubled` 2,
   * then stops it and moves `value` to 5 with nothing running to derive
   * `doubled` again. With `origin`, the enclosing instance records that
   * origin.
   */
  const setUpNested = async (
    { origin }: { origin?: string } = {},
  ): Promise<Piece & { stream: NormalizedFullLink }> => {
    const setup = openRuntime(false, setupSigner);
    const compiled = await setup.patternManager.compilePattern(
      NESTED_PROGRAM,
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
    };
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
        expect(serves(enclosing)).toBe(true);
        expect(await recordedOnEvent(stream)).toBe(10);
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
        // The event's append is what reactivates the space.
        expect(await recordedOnEvent(stream)).toBe(10);
        expect(servingRuntime).not.toBe(parked);
        expect(serves(enclosing)).toBe(true);
        expect(serves(nested)).toBe(true);
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

      it("starts a nested piece whose enclosing piece cannot start, warning that it did", async () => {
        const failing: { id?: string } = {};
        onServingRuntime = (runtime) => {
          const start = runtime.start.bind(runtime);
          runtime.start = (cell, options) =>
            cell.getAsNormalizedFullLink().id === failing.id
              ? Promise.reject(new Error("test failure of the enclosing start"))
              : start(cell, options);
        };
        const warnings = () =>
          openLogger.countsByKey["input-sources"]?.warn ?? 0;
        host = newHost();
        const { enclosing, nested, local } = await setUpNested();
        failing.id = enclosing.id;
        const warnedBefore = warnings();
        await demand(local);

        await awaitEach(cycles, () => serves(nested));
        expect(serves(enclosing)).toBe(false);
        expect(warnings()).toBeGreaterThan(warnedBefore);
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
