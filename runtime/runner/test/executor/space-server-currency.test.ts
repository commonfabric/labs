import { expect } from "@std/expect";
import { valueEqual } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import { resolveScopeKey, type ScopeKey } from "@commonfabric/memory/v2";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  judgeCurrencyRoots,
  selectCurrencyPiece,
  selectCurrencyWriters,
} from "@commonfabric/memory/v2/currency-index";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { clock } from "@commonfabric/test-support/fake-clock";

import { spy, stub } from "@std/testing/mock";
import { ExecutorHost } from "../../src/executor/host.ts";
import { DEFAULT_CURRENCY_EPOCH } from "../../src/executor/space-server.ts";
import { readWatermarkSeq } from "../../src/executor/watermark-engine.ts";
import type { CurrencyIndexMode } from "../../src/executor/store-currency.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { rawMetaWriteAuthorization } from "../../src/meta-seam.ts";
import { Runtime } from "../../src/runtime.ts";
import type { ReconcileOutcome } from "../../src/source-reconciler.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { ArrivalLog, awaitEach } from "../support/serving-waits.ts";
import { sessionDemandOf } from "../support/session-demand.ts";

const spaceSigner = await Identity.fromPassphrase(
  "space-server currency space",
);
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "space-server currency service",
);
const setupSigner = await Identity.fromPassphrase(
  "space-server currency setup",
);
const aliceSigner = await Identity.fromPassphrase(
  "space-server currency alice",
);
const bobSigner = await Identity.fromPassphrase(
  "space-server currency bob",
);

// A piece with one derived output, `out`, three times its `value`.
const TRIPLER_PROGRAM: RuntimeProgram = {
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

// A piece that owns a per-session cell with a default, as a draft a viewer
// types into is.
const DRAFT_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, Writable } from 'commonfabric';",
      "interface Draft { title: string; members: string }",
      "const EMPTY_DRAFT: Draft = { title: '', members: '' };",
      "export default pattern<",
      "  { n?: number },",
      "  { draft: Writable<Draft>; echo: string }",
      ">(() => {",
      "  const draft = new Writable.perSession<Draft>(EMPTY_DRAFT);",
      "  return { draft, echo: computed(() => 'echo:' + draft.get().title) };",
      "});",
    ].join("\n"),
  }],
};

/**
 * A piece that owns a per-session note with a scalar default, beside a
 * derived output that reads none of it, as a board with a per-session field
 * a viewer types into is.
 */
const NOTE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, Writable } from 'commonfabric';",
      "export default pattern<",
      "  { n: number },",
      "  { note: Writable<string>; doubled: number }",
      ">(({ n }) => {",
      "  const note = new Writable.perSession<string>('');",
      "  return { note, doubled: computed(() => n * 2) };",
      "});",
    ].join("\n"),
  }],
};

/**
 * A piece whose per-session `note`, with a scalar default, is the output of a
 * computation.
 */
const COMPUTED_NOTE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import {",
      "  computed,",
      "  type Default,",
      "  lift,",
      "  pattern,",
      "  type PerSession,",
      "} from 'commonfabric';",
      "const noteOf = lift(",
      "  (n: number): PerSession<Default<string, ''>> => 'n is ' + n,",
      ");",
      "export default pattern<",
      "  { n: number },",
      "  { note: string; doubled: number }",
      ">(({ n }) => ({ note: noteOf(n), doubled: computed(() => n * 2) }));",
    ].join("\n"),
  }],
};

/**
 * A piece that encloses another whose result is each session's own: the
 * inner pattern is instantiated at the session's scope, so every session
 * holds an instance of its result document.
 */
const NESTED_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "const Inner = pattern<{ value: number }, { doubled: number }>(",
      "  ({ value }) => ({ doubled: computed(() => value * 2) }),",
      ");",
      "export default pattern<",
      "  { value: number },",
      "  { inner: { doubled: number }; tripled: number }",
      ">(({ value }) => ({",
      "  inner: Inner.asScope('session')({ value }),",
      "  tripled: computed(() => value * 3),",
      "}));",
    ].join("\n"),
  }],
};

/**
 * A piece that encloses another in the space, each with one derived output
 * from an input of its own: the outer piece's start instantiates the inner
 * one, and a change to `extra` is a change to the outer piece alone.
 */
const ENCLOSING_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "const Inner = pattern<{ value: number }, { doubled: number }>(",
      "  ({ value }) => ({ doubled: computed(() => value * 2) }),",
      ");",
      "export default pattern<",
      "  { value: number; extra: number },",
      "  { inner: { doubled: number }; tripled: number }",
      ">(({ value, extra }) => ({",
      "  inner: Inner({ value }),",
      "  tripled: computed(() => extra * 3),",
      "}));",
    ].join("\n"),
  }],
};

/**
 * A piece with one derived output, `items`, a list of two rows computed from
 * its `value`. The lift writes each row through `Writable.for(...).set()`,
 * which stores it as a document of its own that carries neither a back-link
 * nor a pattern pointer.
 */
const LIST_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { lift, pattern, Writable } from 'commonfabric';",
      "type Row = { n: number };",
      "const rowsOf = lift((value: number): Row[] => {",
      "  const rows: unknown[] = [];",
      "  for (const factor of [1, 2]) {",
      "    rows.push(Writable.for<Row>(`row ${factor}`).set({ n: value * factor }));",
      "  }",
      "  return rows as Row[];",
      "});",
      "export default pattern<{ value: number }, { items: Row[] }>(",
      "  ({ value }) => ({ items: rowsOf(value) }),",
      ");",
    ].join("\n"),
  }],
};

/**
 * One demanded document: a watch root, or a document a selector reaches, at
 * the space's instance unless `scopeKey` names another, demanded by the
 * session `viewer` of alice unless `session` names another session or
 * `principal` another viewer.
 */
type Demanded = {
  link: NormalizedFullLink;
  root: boolean;
  scopeKey?: ScopeKey;
  session?: string;
  principal?: string;
};

/** The epoch the hosts of these tests record under. */
const EPOCH = "test-epoch";

/** How many warnings the serving loop has logged under `key`. */
const warnings = (key: string): number =>
  getLogger("space-server").countsByKey[key]?.warn ?? 0;

describe("SpaceServer", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let servingRuntime: Runtime | undefined;
  let cycles: ArrivalLog<unknown>;
  let demanded: Demanded[];

  /**
   * What following a piece's origin answers on each serving runtime made
   * from here on, or `undefined` to follow origins for real.
   */
  let followOutcome: ReconcileOutcome | undefined;

  /** The pieces whose origin a serving runtime followed, and whether each ran. */
  let follows: Array<{ id: string; running: boolean }>;

  /**
   * The pattern identity a serving runtime's patterns route advertises for
   * any origin a real follow asks about, or `undefined` to fetch as usual.
   */
  let advertised: string | undefined;
  const opened: { runtime: Runtime; manager: EmulatedStorageManager }[] = [];

  /** A runtime over the shared server, acting for `as`, that runs nothing. */
  const openRuntime = (as: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: false },
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
    followOutcome = undefined;
    follows = [];
    advertised = undefined;
    // The demand is the documents each case names, as one session of alice's
    // demands them.
    (server as { demandForSpace: unknown }).demandForSpace = () =>
      sessionDemandOf(
        demanded.map(({ link, root, scopeKey, session, principal }) => ({
          id: link.id,
          scope: link.scope ?? "space",
          scopeKey: scopeKey ?? "space",
          root,
          identity: {
            principal: principal ?? aliceSigner.did(),
            sessionId: session ?? "viewer",
          },
        })),
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

  /**
   * A host serving the space, keeping the currency index as `mode` says and
   * under `epoch`, or with no epoch named where it is `null`.
   */
  const newHost = (
    mode: CurrencyIndexMode | undefined,
    epoch: string | null = EPOCH,
  ): ExecutorHost =>
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
          fetch: (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input);
            return advertised !== undefined &&
                url.searchParams.has("identity")
              ? Promise.resolve(new Response(advertised))
              : fetch(input, init);
          },
        });
        servingRuntime = runtime;
        const reconcile = runtime.sourceReconciler.reconcile.bind(
          runtime.sourceReconciler,
        );
        stub(runtime.sourceReconciler, "reconcile", (cell, ...rest) => {
          follows.push({
            id: cell.getAsNormalizedFullLink().id,
            running: runtime.runner.isRunning(cell),
          });
          return followOutcome === undefined
            ? reconcile(cell, ...rest)
            : Promise.resolve(followOutcome);
        });
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy: {
        idleParkMs: 600_000,
        ...(mode !== undefined && { currencyIndex: mode }),
        ...(mode !== undefined && epoch !== null &&
          { currencyEpoch: epoch }),
      },
      onWaveCycle: cycles.record,
    });

  /**
   * Makes `documents` the space's whole demand, once the host serves the
   * space, and has its serving loop read it.
   */
  const demand = async (...documents: Demanded[]) => {
    await awaitEach(cycles, () => host?.spaceServer(space) !== undefined);
    demanded = documents;
    host!.spaceServer(space)!.noteDemandChanged();
  };

  /** Whether the serving runtime runs the piece rooted at `root`. */
  const serves = (root: NormalizedFullLink) =>
    servingRuntime?.runner.isRunning(servingRuntime.getCellFromLink(root)) ===
      true;

  /** What the currency index holds of the piece rooted at `root`. */
  const recordOf = async (root: NormalizedFullLink) =>
    selectCurrencyPiece(await server.engineForSpace(space), {
      piece: root.id,
    });

  /** Resolves once the serving loop is at rest with its records stored. */
  const settled = async () => {
    await host!.whenQuiescent();
  };

  /**
   * Sets up the tripler with `value` 2 as a runtime that then stops it, so
   * the store holds `out` as 6 with nothing running. Returns its root and
   * the document that holds `out`.
   */
  const setUpTripler = async (origin?: string): Promise<
    { root: NormalizedFullLink; out: NormalizedFullLink; identity: string }
  > => {
    const setup = openRuntime(setupSigner);
    const compiled = await setup.patternManager.compilePattern(
      TRIPLER_PROGRAM,
      { space },
    );
    const argument = setup.getCell<{ value: number }>(
      space,
      "currency tripler argument",
      compiled.argumentSchema,
    );
    const result = setup.getCell<{ out: number }>(
      space,
      "currency tripler result",
      compiled.resultSchema,
    );
    const tx = setup.edit();
    argument.withTx(tx).set({ value: 2 });
    setup.run(
      tx,
      compiled,
      argument,
      result,
      origin === undefined ? undefined : { sourceOrigin: origin },
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    const out = result.key("out").resolveAsCell().getAsNormalizedFullLink();
    const identity = setup.patternManager.getArtifactEntryRef(compiled)!
      .identity;
    setup.runner.stop(result);
    await setup.idle();
    await setup.storageManager.synced();
    await closeLastRuntime();
    return {
      root: result.getAsNormalizedFullLink(),
      out: { ...out, path: [] } as NormalizedFullLink,
      identity,
    };
  };

  /** Sets the tripler's `value`, as a runtime that runs nothing. */
  const setValue = async (value: number) => {
    const writer = openRuntime(setupSigner);
    const argument = writer.getCell<{ value: number }>(
      space,
      "currency tripler argument",
      { type: "object", properties: { value: { type: "number" } } },
    );
    await argument.sync();
    const tx = writer.edit();
    argument.withTx(tx).key("value").set(value);
    expect((await tx.commit().settled).error).toBeUndefined();
    await writer.storageManager.synced();
    await closeLastRuntime();
  };

  /** Sets the list piece's `value`, as a runtime that runs nothing. */
  const setListValue = async (value: number) => {
    const writer = openRuntime(setupSigner);
    const argument = writer.getCell<{ value: number }>(
      space,
      "currency list argument",
      { type: "object", properties: { value: { type: "number" } } },
    );
    await argument.sync();
    const tx = writer.edit();
    argument.withTx(tx).key("value").set(value);
    expect((await tx.commit().settled).error).toBeUndefined();
    await writer.storageManager.synced();
    await closeLastRuntime();
  };

  /** Resolves with the tripler's stored `out` once it is `expected`. */
  const outIs = async (expected: number) => {
    const reader = openRuntime(aliceSigner);
    const result = reader.getCell<{ out: number }>(
      space,
      "currency tripler result",
      { type: "object", properties: { out: { type: "number" } } },
    );
    await result.sync();
    await waitForCellValue(
      reader,
      result.key("out"),
      (out: number | undefined) => out === expected,
      { stuckLabel: `the tripler's \`out\` to be ${expected}` },
    );
    await closeLastRuntime();
  };

  let touches = 0;

  /** Commits a write to a document no piece reads. */
  const touchSpace = async () => {
    const writer = openRuntime(setupSigner);
    const cell = writer.getCell<number>(space, "currency touch", {
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
   * Serves the tripler until it has settled with `out` demanded, then parks
   * the space, so the next tenure starts from what the first one recorded.
   */
  const serveAndPark = async (
    piece: { root: NormalizedFullLink; out: NormalizedFullLink },
  ) => {
    await demand(
      { link: piece.root, root: true },
      { link: piece.out, root: false },
    );
    await awaitEach(cycles, () => serves(piece.root));
    await settled();
    await host!.spaceServer(space)!.park("test-park");
  };

  describe("instance members", () => {
    describe("serving a session's own watches", () => {
      it("judges servable a settled piece that a session watches through its result schema, and finds no false judgment, under `record`", async () => {
        // The demand here is the memory server's own reading of a client's
        // watches, where every other case hands the loop its rows.

        delete (server as { demandForSpace?: unknown }).demandForSpace;
        host = newHost("record");
        const manager = EmulatedStorageManager.connectTo(server, {
          as: aliceSigner,
        });
        const alice = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          experimental: { serverExecution: true },
        });
        opened.push({ runtime: alice, manager });
        const compiled = await alice.patternManager.compilePattern(
          TRIPLER_PROGRAM,
          { space },
        );
        const argument = alice.getCell<{ value: number }>(
          space,
          "currency watched argument",
          compiled.argumentSchema,
        );
        const result = alice.getCell<{ out: number }>(
          space,
          "currency watched result",
          compiled.resultSchema,
        );
        await argument.sync();
        await result.sync();
        const tx = alice.edit();
        argument.withTx(tx).set({ value: 2 });
        alice.run(tx, compiled, argument, result);
        expect((await tx.commit().settled).error).toBeUndefined();
        const cancel = result.sink(() => {});
        const root = result.getAsNormalizedFullLink();
        await awaitEach(
          cycles,
          () => host!.stats().currency.recordsStored > 0 && serves(root),
        );
        await settled();
        expect(await recordOf(root)).toEqual({ mark: 0, epoch: EPOCH });
        await host.spaceServer(space)!.park("test-park");

        await touchSpace();
        await awaitEach(cycles, () => serves(root));
        await settled();

        // The session's watches make a root of the argument as well as of the
        // result, and both lead to the piece.
        expect(host.stats().currency.servable).toBeGreaterThan(0);
        expect(host.stats().currency.falseClean).toBe(0);
        cancel();
      });

      it("leaves unstarted a settled piece that a session watches through its result schema, under `skip`", async () => {
        delete (server as { demandForSpace?: unknown }).demandForSpace;
        host = newHost("skip");
        const manager = EmulatedStorageManager.connectTo(server, {
          as: aliceSigner,
        });
        const alice = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          experimental: { serverExecution: true },
        });
        opened.push({ runtime: alice, manager });
        const compiled = await alice.patternManager.compilePattern(
          TRIPLER_PROGRAM,
          { space },
        );
        const argument = alice.getCell<{ value: number }>(
          space,
          "currency skipped argument",
          compiled.argumentSchema,
        );
        const result = alice.getCell<{ out: number }>(
          space,
          "currency skipped result",
          compiled.resultSchema,
        );
        await argument.sync();
        await result.sync();
        const tx = alice.edit();
        argument.withTx(tx).set({ value: 2 });
        alice.run(tx, compiled, argument, result);
        expect((await tx.commit().settled).error).toBeUndefined();
        const cancel = result.sink(() => {});
        const root = result.getAsNormalizedFullLink();
        await awaitEach(
          cycles,
          () => host!.stats().currency.recordsStored > 0 && serves(root),
        );
        await settled();
        await host.spaceServer(space)!.park("test-park");

        await touchSpace();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore > 0,
        );
        await settled();

        expect(serves(root)).toBe(false);
        expect(host.stats().currency.rearmed).toBe(0);
        cancel();
      });

      it("leaves unstarted a settled piece that encloses one whose result is the session's own, under `skip`", async () => {
        // The session watches the outer piece through its result schema,
        // which reaches the session's instance of the inner piece's result.

        delete (server as { demandForSpace?: unknown }).demandForSpace;
        host = newHost("skip");
        const manager = EmulatedStorageManager.connectTo(server, {
          as: aliceSigner,
        });
        const alice = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          experimental: { serverExecution: true },
        });
        opened.push({ runtime: alice, manager });
        const compiled = await alice.patternManager.compilePattern(
          NESTED_PROGRAM,
          { space },
        );
        const argument = alice.getCell<{ value: number }>(
          space,
          "currency nested argument",
          compiled.argumentSchema,
        );
        const result = alice.getCell<
          { inner: { doubled: number }; tripled: number }
        >(
          space,
          "currency nested result",
          compiled.resultSchema,
        );
        await argument.sync();
        await result.sync();
        const tx = alice.edit();
        argument.withTx(tx).set({ value: 2 });
        alice.run(tx, compiled, argument, result);
        expect((await tx.commit().settled).error).toBeUndefined();
        const cancel = result.sink(() => {});
        const root = result.getAsNormalizedFullLink();
        await awaitEach(
          cycles,
          () => host!.stats().currency.recordsStored > 0 && serves(root),
        );
        await waitForCellValue(
          alice,
          result.key("inner").key("doubled"),
          (doubled: number | undefined) => doubled === 4,
          { stuckLabel: "the inner piece's `doubled` to be 4" },
        );
        await settled();
        expect(host.stats().currency.unvouched).toEqual({});
        await host.spaceServer(space)!.park("test-park");

        await touchSpace();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore > 0,
        );
        await settled();

        expect(serves(root)).toBe(false);
        expect(host.stats().currency.falseClean).toBe(0);
        cancel();
      });
    });

    describe("noteDemandChanged()", () => {
      it("records nothing of a piece it starts where the policy keeps no currency index", async () => {
        host = newHost(undefined);
        const piece = await setUpTripler();
        await demand(
          { link: piece.root, root: true },
          { link: piece.out, root: false },
        );

        await awaitEach(cycles, () => serves(piece.root));
        await settled();

        expect(await recordOf(piece.root)).toBeUndefined();
        expect(host.stats().currency).toEqual({
          recordsStored: 0,
          unvouched: {},
          judged: 0,
          servable: 0,
          refused: {},
          servedFromStore: 0,
          plainRoots: 0,
          rearmed: 0,
          indexWakes: 0,
          expiryWakes: 0,
          carried: 0,
          carriedRefused: 0,
          heldUpstream: 0,
          upstreamAbandoned: 0,
          falseClean: 0,
        });
      });

      it("records clean a piece that settled, under `record`", async () => {
        host = newHost("record");
        const piece = await setUpTripler();
        await demand(
          { link: piece.root, root: true },
          { link: piece.out, root: false },
        );

        await awaitEach(cycles, () => serves(piece.root));
        await settled();

        expect(await recordOf(piece.root)).toEqual({ mark: 0, epoch: EPOCH });
        expect(host.stats().currency.servable).toBe(0);
      });

      it("starts a piece the store could serve, counts it, and finds no false judgment, under `record`", async () => {
        host = newHost("record");
        const piece = await setUpTripler();
        await serveAndPark(piece);

        await touchSpace();
        await awaitEach(cycles, () => serves(piece.root));
        await settled();

        expect(host.stats().currency.servable).toBe(1);
        expect(host.stats().currency.servedFromStore).toBe(0);
        expect(host.stats().currency.falseClean).toBe(0);
      });

      it("records under the default epoch, and leaves unstarted a piece recorded under it, under `skip` with no epoch named", async () => {
        host = newHost("skip", null);
        const piece = await setUpTripler();
        await serveAndPark(piece);
        expect(await recordOf(piece.root)).toEqual({
          mark: 0,
          epoch: DEFAULT_CURRENCY_EPOCH,
        });

        await touchSpace();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore === 1,
        );
        await settled();

        expect(serves(piece.root)).toBe(false);
        await outIs(6);
      });

      it("starts a piece recorded under another epoch, under `skip` with no epoch named", async () => {
        host = newHost("skip", "earlier-epoch");
        const piece = await setUpTripler();
        await serveAndPark(piece);
        expect(await recordOf(piece.root)).toEqual({
          mark: 0,
          epoch: "earlier-epoch",
        });
        await host.close();

        host = newHost("skip", null);
        await touchSpace();
        await awaitEach(cycles, () => serves(piece.root));
        await settled();

        expect(host.stats().currency.servedFromStore).toBe(0);
        expect(host.stats().currency.refused).toEqual({ "other-epoch": 1 });
      });

      it("leaves unstarted a piece whose record is clean and vouches for what is demanded, under `skip`", async () => {
        host = newHost("skip");
        const piece = await setUpTripler();
        await serveAndPark(piece);

        await touchSpace();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore === 1,
        );
        await settled();

        expect(serves(piece.root)).toBe(false);
        await outIs(6);
      });

      it("starts a recorded piece whose input changed while nothing served the space, under `skip`", async () => {
        host = newHost("skip");
        const piece = await setUpTripler();
        await serveAndPark(piece);

        await setValue(5);
        await awaitEach(cycles, () => serves(piece.root));

        expect(host.stats().currency.servedFromStore).toBe(0);
        await outIs(15);
      });

      it("starts a piece left unstarted when an input of it changes, under `skip`", async () => {
        host = newHost("skip");
        const piece = await setUpTripler();
        await serveAndPark(piece);
        await touchSpace();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore === 1,
        );
        expect(serves(piece.root)).toBe(false);

        await setValue(5);
        // The watermark, read at the end of each cycle the root is still
        // unstarted in, never reaches the commit that changed the input.
        const engine = await server.engineForSpace(space);
        const changedAt = Engine.serverSeq(engine);
        const covered: number[] = [];
        await awaitEach(cycles, () => {
          if (serves(piece.root)) return true;
          covered.push(readWatermarkSeq(engine));
          return false;
        });

        expect(covered.every((seq) => seq < changedAt)).toBe(true);
        expect(host.stats().currency.rearmed).toBe(1);
        await outIs(15);
      });

      it("starts a recorded piece, and seeds the session, when a session demands an owned cell with an object default it holds no instance of, under `skip`", async () => {
        host = newHost("skip");
        const setup = openRuntime(setupSigner);
        const compiled = await setup.patternManager.compilePattern(
          DRAFT_PROGRAM,
          { space },
        );
        const argument = setup.getCell<{ n?: number }>(
          space,
          "currency draft argument",
          compiled.argumentSchema,
        );
        const result = setup.getCell<{ echo: string }>(
          space,
          "currency draft result",
          compiled.resultSchema,
        );
        const tx = setup.edit();
        argument.withTx(tx).set({ n: 1 });
        setup.run(tx, compiled, argument, result);
        expect((await tx.commit().settled).error).toBeUndefined();
        await result.pull();
        const root = result.getAsNormalizedFullLink();
        const draft = {
          ...result.key("draft" as never).resolveAsCell()
            .getAsNormalizedFullLink(),
          path: [],
        } as NormalizedFullLink;
        setup.runner.stop(result);
        await setup.idle();
        await setup.storageManager.synced();
        await closeLastRuntime();
        const sessionKey = (session: string) =>
          resolveScopeKey("session", {
            principal: aliceSigner.did(),
            sessionId: session,
          });
        const first = [
          { link: root, root: true },
          { link: draft, root: false, scopeKey: sessionKey("viewer") },
        ];
        await demand(...first);
        await awaitEach(
          cycles,
          () => serves(root) && host!.stats().demand.ownedDefaultSeeds > 0,
        );
        await settled();
        await host.spaceServer(space)!.park("test-park");
        await touchSpace();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore === 1,
        );
        expect(serves(root)).toBe(false);
        const seeds = host.stats().demand.ownedDefaultSeeds;

        await demand(
          ...first,
          { link: root, root: true, session: "second" },
          {
            link: draft,
            root: false,
            scopeKey: sessionKey("second"),
            session: "second",
          },
        );

        await awaitEach(
          cycles,
          () => host!.stats().demand.ownedDefaultSeeds > seeds,
        );
        expect(serves(root)).toBe(true);
        expect(host.stats().currency.rearmed).toBe(1);
      });

      it("leaves a piece unstarted for a returning viewer whose record another viewer's visit left in place, under `skip`", async () => {
        host = newHost("skip");
        const setup = openRuntime(setupSigner);
        const compiled = await setup.patternManager.compilePattern(
          DRAFT_PROGRAM,
          { space },
        );
        const argument = setup.getCell<{ n?: number }>(
          space,
          "currency viewers argument",
          compiled.argumentSchema,
        );
        const result = setup.getCell<{ echo: string }>(
          space,
          "currency viewers result",
          compiled.resultSchema,
        );
        const tx = setup.edit();
        argument.withTx(tx).set({ n: 1 });
        setup.run(tx, compiled, argument, result);
        expect((await tx.commit().settled).error).toBeUndefined();
        await result.pull();
        const root = result.getAsNormalizedFullLink();
        const documentOf = (key: string) =>
          ({
            ...result.key(key as never).resolveAsCell()
              .getAsNormalizedFullLink(),
            path: [],
          }) as NormalizedFullLink;
        const draft = documentOf("draft");
        const echo = documentOf("echo");
        setup.runner.stop(result);
        await setup.idle();
        await setup.storageManager.synced();
        await closeLastRuntime();

        /** What one session of `principal` demands of the piece. */
        const viewOf = (principal: string): Demanded[] => {
          const identity = { principal, sessionId: "viewer" };
          const session = resolveScopeKey("session", identity);
          return [
            { link: root, root: true, principal },
            { link: draft, root: false, scopeKey: session, principal },
            // The derived document is declared in the space and computed
            // for each session, so a session demands its shared slot, its
            // user's and its own.
            { link: { ...echo, scope: "space" }, root: false, principal },
            {
              link: { ...echo, scope: "user" },
              root: false,
              scopeKey: resolveScopeKey("user", identity),
              principal,
            },
            {
              link: { ...echo, scope: "session" },
              root: false,
              scopeKey: session,
              principal,
            },
          ];
        };
        /** The mark of the piece's slice for the session of `principal`. */
        const sessionMarkOf = async (principal: string) =>
          selectCurrencyPiece(await server.engineForSpace(space), {
            piece: root.id,
            slice: resolveScopeKey("session", {
              principal,
              sessionId: "viewer",
            }),
          })?.mark;

        await demand(...viewOf(aliceSigner.did()));
        await awaitEach(cycles, () => serves(root));
        await settled();
        expect(await sessionMarkOf(aliceSigner.did())).toBe(0);
        await host.spaceServer(space)!.park("test-park");

        // Bob holds no instance of the piece, so his visit starts it.
        demanded = viewOf(bobSigner.did());
        await touchSpace();
        await awaitEach(cycles, () => serves(root));
        await settled();
        expect(await sessionMarkOf(bobSigner.did())).toBe(0);
        expect(await sessionMarkOf(aliceSigner.did())).toBe(0);
        await host.spaceServer(space)!.park("test-park");
        const served = host.stats().currency.servedFromStore;

        demanded = viewOf(aliceSigner.did());
        await touchSpace();

        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore > served,
        );
        await settled();
        expect(serves(root)).toBe(false);
      });

      describe("with a piece that owns a per-session cell", () => {
        /**
         * Sets up `program` with `argument` as a runtime that then stops it,
         * and returns its root and the document that holds `note`.
         */
        const setUpNote = async (
          program: RuntimeProgram,
          argument: Record<string, unknown>,
        ): Promise<{ root: NormalizedFullLink; note: NormalizedFullLink }> => {
          const setup = openRuntime(setupSigner);
          const compiled = await setup.patternManager.compilePattern(program, {
            space,
          });
          const input = setup.getCell<Record<string, unknown>>(
            space,
            "currency note argument",
            compiled.argumentSchema,
          );
          const result = setup.getCell<{ doubled: number }>(
            space,
            "currency note result",
            compiled.resultSchema,
          );
          const tx = setup.edit();
          input.withTx(tx).set(argument);
          setup.run(tx, compiled, input, result);
          expect((await tx.commit().settled).error).toBeUndefined();
          await result.pull();
          const note = {
            ...result.key("note" as never).resolveAsCell()
              .getAsNormalizedFullLink(),
            path: [],
          } as NormalizedFullLink;
          setup.runner.stop(result);
          await setup.idle();
          await setup.storageManager.synced();
          await closeLastRuntime();
          return { root: result.getAsNormalizedFullLink(), note };
        };

        /** What the session `session` of alice demands of the piece. */
        const viewOf = (
          piece: { root: NormalizedFullLink; note: NormalizedFullLink },
          session: string,
        ): Demanded[] => [
          { link: piece.root, root: true, session },
          {
            link: piece.note,
            root: false,
            scopeKey: resolveScopeKey("session", {
              principal: aliceSigner.did(),
              sessionId: session,
            }),
            session,
          },
        ];

        /**
         * Serves the piece to alice's session `first` until it has settled
         * and the session is seeded, parks the space, and has the next
         * tenure leave the piece unstarted for that session.
         */
        const serveFirstSession = async (
          piece: { root: NormalizedFullLink; note: NormalizedFullLink },
        ) => {
          await demand(...viewOf(piece, "first"));
          await awaitEach(
            cycles,
            () =>
              serves(piece.root) &&
              host!.stats().demand.ownedDefaultSeeds > 0,
          );
          await settled();
          await host!.spaceServer(space)!.park("test-park");
          await touchSpace();
          await awaitEach(
            cycles,
            () => host!.stats().currency.servedFromStore === 1,
          );
          expect(serves(piece.root)).toBe(false);
        };

        it("leaves a piece unstarted for a new session whose instance of a cell with a scalar default the store does not hold, under `skip`", async () => {
          host = newHost("skip");
          const piece = await setUpNote(NOTE_PROGRAM, { n: 2 });
          await serveFirstSession(piece);
          const { servable } = host.stats().currency;
          const seeds = host.stats().demand.ownedDefaultSeeds;

          await demand(
            ...viewOf(piece, "first"),
            ...viewOf(piece, "second"),
          );

          await awaitEach(
            cycles,
            () => host!.stats().currency.servable > servable,
          );
          await settled();
          expect(serves(piece.root)).toBe(false);
          expect(host.stats().currency.refused["absent-owned"]).toBeUndefined();
          expect(host.stats().currency.rearmed).toBe(0);
          expect(host.stats().demand.ownedDefaultSeeds).toBe(seeds);
          expect(host.stats().currency.falseClean).toBe(0);
        });

        it("reads the default of a cell with a scalar default, in a session whose instance of it the store does not hold", async () => {
          host = newHost("skip");
          const piece = await setUpNote(NOTE_PROGRAM, { n: 2 });
          await serveFirstSession(piece);

          // A client in a session of its own, which holds no instance of
          // the note, reads it through the piece's result.
          const reader = openRuntime(aliceSigner);
          const result = reader.getCellFromLink<{ note: string }>(piece.root);
          await result.sync();
          const note = result.key("note").resolveAsCell();
          await note.sync();

          expect(note.getAsNormalizedFullLink().scope).toBe("session");
          expect(note.getRaw()).toBeUndefined();
          expect(note.get()).toBe("");
        });

        it("starts a piece for a new session whose instance of a cell with a scalar default that a computation writes the store does not hold, under `skip`", async () => {
          host = newHost("skip");
          const piece = await setUpNote(COMPUTED_NOTE_PROGRAM, { n: 2 });
          await serveFirstSession(piece);
          const writers = selectCurrencyWriters(
            await server.engineForSpace(space),
            { space, id: piece.note.id },
          );

          await demand(
            ...viewOf(piece, "first"),
            ...viewOf(piece, "second"),
          );

          await awaitEach(cycles, () => serves(piece.root));
          expect(writers).toEqual([piece.root.id]);
          expect(piece.note.scope).toBe("session");
          expect(host.stats().currency.refused["unvouched-instance"]).toBe(1);
        });
      });

      it("starts a recorded piece when a session demands an output it never vouched for, under `skip`", async () => {
        host = newHost("skip");
        const piece = await setUpTripler();
        await demand({ link: piece.root, root: true });
        await awaitEach(cycles, () => serves(piece.root));
        await settled();
        await host.spaceServer(space)!.park("test-park");

        await touchSpace();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore === 1,
        );
        expect(serves(piece.root)).toBe(false);
        await demand(
          { link: piece.root, root: true },
          { link: piece.out, root: false },
        );

        await awaitEach(cycles, () => serves(piece.root));
        expect(host.stats().currency.rearmed).toBe(1);
      });

      describe("with a demanded document a structure load starts no piece from", () => {
        /**
         * Writes, as a client, a document that carries neither a back-link
         * nor a pattern pointer, and returns its link.
         */
        const writeData = async (): Promise<NormalizedFullLink> => {
          const writer = openRuntime(setupSigner);
          const data = writer.getCell<{ title: string }>(
            space,
            "currency plain data",
            { type: "object", properties: { title: { type: "string" } } },
          );
          await data.sync();
          const tx = writer.edit();
          data.withTx(tx).set({ title: "typed" });
          expect((await tx.commit().settled).error).toBeUndefined();
          await writer.storageManager.synced();
          const link = data.getAsNormalizedFullLink();
          await closeLastRuntime();
          return link;
        };

        /** Gives the document at `data` a `result` back-link to `root`. */
        const linkToPiece = async (
          data: NormalizedFullLink,
          root: NormalizedFullLink,
        ) => {
          const writer = openRuntime(setupSigner);
          const document = writer.getCellFromLink(data);
          await document.sync();
          const tx = writer.edit();
          document.withTx(tx).setMetaRaw(
            "result",
            writer.getCellFromLink(root).getAsWriteRedirectLink({
              includeSchema: true,
            }),
            rawMetaWriteAuthorization,
          );
          expect((await tx.commit().settled).error).toBeUndefined();
          await writer.storageManager.synced();
          await closeLastRuntime();
        };

        it("parks it unloaded, as a load that finds no piece would, and brings it into the serving replica, under `skip`", async () => {
          host = newHost("skip");
          const data = await writeData();

          await demand({ link: data, root: true });
          await awaitEach(
            cycles,
            () => host!.stats().currency.plainRoots === 1,
          );
          await settled();

          const stats = host.stats();
          expect(stats.structureLoadTerminal).toBe(0);
          expect(stats.currency.servedFromStore).toBe(0);
          expect(stats.currency.refused).toEqual({});
          // A read that does not sync finds what the load's sync would have
          // put in the replica.
          expect(servingRuntime!.getCellFromLink(data).getRaw()).toEqual({
            title: "typed",
          });
        });

        it("loads it, and brings it into the serving replica, where syncing it for the park fails, under `skip`", async () => {
          host = newHost("skip");
          const data = await writeData();
          await awaitEach(cycles, () => host?.spaceServer(space) !== undefined);
          // The first sync of the document on the serving runtime fails, as
          // the pull before the pass's loads makes it.
          const runtime = servingRuntime!;
          const cellFor = runtime.getCellFromLink.bind(runtime);
          let failed = false;
          using _sync = stub(
            runtime,
            "getCellFromLink",
            ((...args: Parameters<typeof runtime.getCellFromLink>) => {
              const cell = cellFor(...args);
              if (failed || cell.getAsNormalizedFullLink().id !== data.id) {
                return cell;
              }
              failed = true;
              return new Proxy(cell, {
                get: (target, property, receiver) =>
                  property === "sync"
                    ? () => Promise.reject(new Error("sync failed"))
                    : Reflect.get(target, property, receiver),
              });
            }) as typeof runtime.getCellFromLink,
          );

          await demand({ link: data, root: true });
          await awaitEach(
            cycles,
            () => host!.stats().structureLoadTerminal === 1,
          );

          expect(failed).toBe(true);
          expect(host.stats().currency.plainRoots).toBe(1);
          expect(runtime.getCellFromLink(data).getRaw()).toEqual({
            title: "typed",
          });
        });

        it("parks it unloaded where the space holds no instance of it, under `skip`", async () => {
          host = newHost("skip");
          const absent = {
            ...await writeData(),
            id: "of:currency-plain-absent",
          } as NormalizedFullLink;

          await demand({ link: absent, root: true });
          await awaitEach(
            cycles,
            () => host!.stats().currency.plainRoots === 1,
          );
          await settled();

          expect(host.stats().structureLoadTerminal).toBe(0);
          expect(host.stats().currency.refused).toEqual({});
        });

        it("parks unloaded an element a lift writes in the loop's derivation, where the one piece recorded as writing it was marked, under `skip`", async () => {
          host = newHost("skip");
          const setup = openRuntime(setupSigner);
          const compiled = await setup.patternManager.compilePattern(
            LIST_PROGRAM,
            { space },
          );
          const argument = setup.getCell<{ value: number }>(
            space,
            "currency list argument",
            compiled.argumentSchema,
          );
          const result = setup.getCell<{ items: Array<{ n: number }> }>(
            space,
            "currency list result",
            compiled.resultSchema,
          );
          const tx = setup.edit();
          argument.withTx(tx).set({ value: 2 });
          setup.run(tx, compiled, argument, result);
          expect((await tx.commit().settled).error).toBeUndefined();
          await result.pull();
          const documentOf = (cell: { getAsNormalizedFullLink(): unknown }) =>
            ({
              ...cell.getAsNormalizedFullLink() as NormalizedFullLink,
              path: [],
            }) as NormalizedFullLink;
          const root = result.getAsNormalizedFullLink();
          const input = argument.getAsNormalizedFullLink().id;
          const items = documentOf(result.key("items").resolveAsCell());
          const element = documentOf(
            result.key("items").key(0).resolveAsCell(),
          );
          setup.runner.stop(result);
          await setup.idle();
          await setup.storageManager.synced();
          await closeLastRuntime();
          expect(element.id).not.toBe(items.id);
          expect(element.id.startsWith("computed:")).toBe(false);

          // The serving loop runs the piece, whose derivation writes the
          // element again for the new value.
          const engine = await server.engineForSpace(space);
          const stored = () =>
            Engine.read(engine, { id: element.id as never, scopeKey: "space" })
              ?.value;
          await demand(
            { link: root, root: true },
            { link: items, root: false },
            { link: element, root: false },
          );
          await awaitEach(cycles, () => serves(root));
          await setListValue(3);
          await awaitEach(cycles, () => valueEqual(stored(), { n: 3 }));
          await settled();
          await host.spaceServer(space)!.park("test-park");
          // A write made through `Writable.for()` is outside the lift's
          // declared surface, so the record names no writer of the element.
          // This one records the piece as its one writer.
          await server.storeCurrencyRecords(space, {
            asOf: Engine.serverSeq(engine),
            seen: [],
            epoch: EPOCH,
            records: [{
              piece: root.id,
              under: [],
              vouched: true,
              writes: [element.id],
              owned: [],
              slices: [{
                key: "space",
                vouched: true,
                reads: [{
                  space,
                  id: input,
                  scopeKey: "space",
                  derived: false,
                }],
                vouches: [element.id],
              }],
            }],
          });
          expect(selectCurrencyWriters(engine, { space, id: element.id }))
            .toEqual([root.id]);

          // A viewer demands the element alone, and the next commit marks the
          // piece that writes it.
          const before = structuredClone(host.stats());
          demanded = [{ link: element, root: true }];
          await setListValue(4);
          await awaitEach(
            cycles,
            () => host!.stats().currency.plainRoots === 1,
          );
          await settled();

          expect(serves(root)).toBe(false);
          expect((await recordOf(root))?.mark).toBeGreaterThan(0);
          expect(host.stats().structureLoadTerminal).toBe(
            before.structureLoadTerminal,
          );
          expect(host.stats().currency.refused).toEqual(
            before.currency.refused,
          );
        });

        it("loads it once a client commits to it, and starts the piece it then leads to, under `skip`", async () => {
          host = newHost("skip");
          const piece = await setUpTripler();
          const data = await writeData();
          await demand({ link: data, root: true });
          await awaitEach(
            cycles,
            () => host!.stats().currency.plainRoots === 1,
          );
          expect(serves(piece.root)).toBe(false);

          await linkToPiece(data, piece.root);

          await awaitEach(cycles, () => serves(piece.root));
          expect(host.stats().structureLoadRearmed).toBe(1);
        });

        it("loads it, and starts the piece it then leads to, where a client commits to it while the judgment runs, under `skip`", async () => {
          host = newHost("skip");
          const piece = await setUpTripler();
          const data = await writeData();
          await awaitEach(cycles, () => host?.spaceServer(space) !== undefined);
          const loop = host.spaceServer(space)!;
          // Resolves once the serving loop's feed holds a commit to `data`.
          const { promise: fed, resolve: feed } = Promise.withResolvers<void>();
          const enqueue = loop.enqueueCommit.bind(loop);
          using _feed = stub(loop, "enqueueCommit", (notice) => {
            enqueue(notice);
            if (notice.writes.some((write) => write.id === data.id)) feed();
          });
          const judge = server.judgeCurrencyRoots.bind(server);
          let raced = false;
          using _judge = stub(
            server,
            "judgeCurrencyRoots",
            async (...args: Parameters<typeof server.judgeCurrencyRoots>) => {
              const judged = await judge(...args);
              if (!raced && judged.plain?.includes(data.id) === true) {
                raced = true;
                await linkToPiece(data, piece.root);
                await fed;
              }
              return judged;
            },
          );

          await demand({ link: data, root: true });
          await awaitEach(cycles, () => serves(piece.root));

          expect(raced).toBe(true);
          expect(host.stats().structureLoadRearmed).toBe(0);
        });

        it("loads it, and parks it once the load finds no piece, where its demand is narrower than the space, under `skip`", async () => {
          host = newHost("skip");
          const data = await writeData();

          await demand({
            link: { ...data, scope: "user" } as NormalizedFullLink,
            root: true,
          });
          await awaitEach(
            cycles,
            () => host!.stats().structureLoadTerminal === 1,
          );

          expect(host.stats().currency.plainRoots).toBe(0);
        });

        it("loads it, and parks it once the load finds no piece, under `record`", async () => {
          host = newHost("record");
          const data = await writeData();

          await demand({ link: data, root: true });
          await awaitEach(
            cycles,
            () => host!.stats().structureLoadTerminal === 1,
          );

          expect(host.stats().currency.plainRoots).toBe(1);
        });
      });

      it("keeps the record of a piece an enclosing piece's start instantiates and no session demands, under `skip`", async () => {
        host = newHost("skip");
        const setup = openRuntime(setupSigner);
        const compiled = await setup.patternManager.compilePattern(
          ENCLOSING_PROGRAM,
          { space },
        );
        const argument = setup.getCell<{ value: number; extra: number }>(
          space,
          "currency enclosing argument",
          compiled.argumentSchema,
        );
        const result = setup.getCell<
          { inner: { doubled: number }; tripled: number }
        >(space, "currency enclosing result", compiled.resultSchema);
        const tx = setup.edit();
        argument.withTx(tx).set({ value: 2, extra: 1 });
        setup.run(tx, compiled, argument, result);
        expect((await tx.commit().settled).error).toBeUndefined();
        await result.pull();
        const documentOf = (cell: { getAsNormalizedFullLink(): unknown }) =>
          ({
            ...cell.getAsNormalizedFullLink() as NormalizedFullLink,
            path: [],
          }) as NormalizedFullLink;
        const outer = result.getAsNormalizedFullLink();
        const inner = documentOf(result.key("inner").resolveAsCell());
        const tripled = documentOf(result.key("tripled").resolveAsCell());
        const doubled = documentOf(
          result.key("inner").key("doubled").resolveAsCell(),
        );
        setup.runner.stop(result);
        await setup.idle();
        await setup.storageManager.synced();
        await closeLastRuntime();

        // The first viewer watches the inner piece as a root of its own, as
        // a board's viewer watches each piece the board lists.
        const innerView: Demanded[] = [
          { link: inner, root: true },
          { link: doubled, root: false },
        ];
        /** The roots the store can serve of the inner piece, for that view. */
        const innerServable = async () =>
          judgeCurrencyRoots(await server.engineForSpace(space), {
            space,
            roots: [inner.id],
            rows: innerView.map(({ link }) => ({
              id: link.id,
              scopeKey: "space",
            })),
            epoch: EPOCH,
          }).servable;
        await demand({ link: outer, root: true }, ...innerView);
        await awaitEach(cycles, () => serves(outer));
        await settled();
        expect(await innerServable()).toEqual([inner.id]);
        await host.spaceServer(space)!.park("test-park");

        // The second viewer demands nothing of the inner piece. The outer
        // piece never vouched for `tripled`, so it starts, and its start
        // instantiates the inner piece with none of its computations live.
        const stored = host.stats().currency.recordsStored;
        demanded = [
          { link: outer, root: true },
          { link: tripled, root: false },
        ];
        await touchSpace();
        await awaitEach(
          cycles,
          () => serves(outer) && host!.stats().currency.recordsStored > stored,
        );
        await settled();

        expect(await innerServable()).toEqual([inner.id]);
      });

      describe("with a piece that records a source origin", () => {
        /**
         * Sets up the tripler with a source origin recorded on its root, as
         * a piece created from a served source carries one.
         */
        const setUpTriplerWithOrigin = async () => {
          const piece = await setUpTripler();
          const writer = openRuntime(setupSigner);
          const root = writer.getCellFromLink(piece.root);
          await root.sync();
          const tx = writer.edit();
          root.withTx(tx).setMetaRaw(
            "patternSource",
            "system:system/probe/probe.tsx",
            rawMetaWriteAuthorization,
          );
          expect((await tx.commit().settled).error).toBeUndefined();
          await writer.storageManager.synced();
          await closeLastRuntime();
          return piece;
        };

        it("follows the origin while the piece is stopped and leaves the piece unstarted where the origin has not moved, under `skip`", async () => {
          followOutcome = "current";
          host = newHost("skip");
          const piece = await setUpTriplerWithOrigin();
          await serveAndPark(piece);
          follows.length = 0;

          await touchSpace();
          await awaitEach(
            cycles,
            () =>
              host!.stats().currency.servedFromStore === 1 &&
              follows.length === 1,
          );
          await settled();

          expect(follows).toEqual([{ id: piece.root.id, running: false }]);
          expect(serves(piece.root)).toBe(false);
          await outIs(6);
        });

        it("starts the piece where it adopted new source when its origin was followed, under `skip`", async () => {
          followOutcome = "current";
          host = newHost("skip");
          const piece = await setUpTriplerWithOrigin();
          await serveAndPark(piece);
          followOutcome = "updated";

          await touchSpace();
          await awaitEach(cycles, () => serves(piece.root));

          expect(serves(piece.root)).toBe(true);
        });

        it("leaves a piece created from its origin unstarted when its first follow finds what it runs, under `skip`", async () => {
          // The first tenure does not follow the origin, as a tenure that
          // never starts the piece does not. The second follows it for real,
          // and finds the source the piece was created with: creation
          // recorded that conclusion, so the follow writes nothing to the
          // result document every slice of the piece read.
          followOutcome = "current";
          host = newHost("skip");
          const piece = await setUpTripler("system:system/probe/probe.tsx");
          await serveAndPark(piece);
          followOutcome = undefined;
          advertised = piece.identity;
          follows.length = 0;

          await touchSpace();
          await awaitEach(
            cycles,
            () =>
              host!.stats().currency.servedFromStore === 1 &&
              follows.length === 1,
          );
          await settled();

          expect(follows).toEqual([{ id: piece.root.id, running: false }]);
          expect(serves(piece.root)).toBe(false);
          expect(await recordOf(piece.root)).toEqual({ mark: 0, epoch: EPOCH });
        });
      });
    });

    describe("park()", () => {
      // Each case holds one request the loop makes of the currency index
      // until the tenure that made it has parked. The parked tenure acts on
      // nothing the request returns, and the next tenure serves the space.

      /**
       * A gate for one request: `pass()` holds the first call made through
       * it until `release()`, and `entered` resolves once that call is made.
       */
      const gate = () => {
        const entered = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        let held = false;
        return {
          entered: entered.promise,
          release: () => released.resolve(),
          pass: async () => {
            if (held) return;
            held = true;
            entered.resolve();
            await released.promise;
          },
        };
      };

      /** Parks the space's tenure while `release` lets its request go. */
      const parkAcross = async (release: () => void) => {
        const loop = host!.spaceServer(space)!;
        const parking = loop.park("test-park");
        expect(loop.active).toBe(false);
        release();
        await parking;
        await loop.whenParked;
      };

      it("ends the demand pass on a judgment that returns after the tenure parked, under `skip`", async () => {
        host = newHost("skip");
        const piece = await setUpTripler();
        await serveAndPark(piece);
        const judging = gate();
        const judge = server.judgeCurrencyRoots.bind(server);
        using _judge = stub(
          server,
          "judgeCurrencyRoots",
          async (...args: Parameters<typeof server.judgeCurrencyRoots>) => {
            await judging.pass();
            return await judge(...args);
          },
        );
        const failures = warnings("structure-load-pass-failed");

        await touchSpace();
        await judging.entered;
        await parkAcross(judging.release);
        await touchSpace();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore === 2,
        );
        await settled();

        expect(warnings("structure-load-pass-failed")).toBe(failures);
        expect(serves(piece.root)).toBe(false);
        await outIs(6);
      });

      it("ends the wave on an advance of the marks that returns after the tenure parked, under `skip`", async () => {
        host = newHost("skip");
        const piece = await setUpTripler();
        await serveAndPark(piece);
        await touchSpace();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore === 1,
        );
        await settled();
        const advancing = gate();
        const advance = server.advanceCurrency.bind(server);
        using _advance = stub(
          server,
          "advanceCurrency",
          async (...args: Parameters<typeof server.advanceCurrency>) => {
            await advancing.pass();
            return await advance(...args);
          },
        );

        await setValue(5);
        await advancing.entered;
        const parked = servingRuntime!;
        using settles = spy(parked, "idle");
        await parkAcross(advancing.release);
        await clock.settle();

        // The parked tenure's wave settles nothing on its runtime.
        expect(settles.calls.length).toBe(0);
        await touchSpace();
        await awaitEach(cycles, () => serves(piece.root));
        await outIs(15);
      });
    });
  });
});
