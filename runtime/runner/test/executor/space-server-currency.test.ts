import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { resolveScopeKey, type ScopeKey } from "@commonfabric/memory/v2";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  judgeCurrencyRoots,
  selectCurrencyPiece,
} from "@commonfabric/memory/v2/currency-index";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { stub } from "@std/testing/mock";
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
        });
        servingRuntime = runtime;
        if (followOutcome !== undefined) {
          stub(runtime.sourceReconciler, "reconcile", (cell) => {
            follows.push({
              id: cell.getAsNormalizedFullLink().id,
              running: runtime.runner.isRunning(cell),
            });
            return Promise.resolve(followOutcome!);
          });
        }
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
  const setUpTripler = async (): Promise<
    { root: NormalizedFullLink; out: NormalizedFullLink }
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
    setup.run(tx, compiled, argument, result);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    const out = result.key("out").resolveAsCell().getAsNormalizedFullLink();
    setup.runner.stop(result);
    await setup.idle();
    await setup.storageManager.synced();
    await closeLastRuntime();
    return {
      root: result.getAsNormalizedFullLink(),
      out: { ...out, path: [] } as NormalizedFullLink,
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

      it("starts a recorded piece, and seeds the session, when a session demands an owned cell it holds no instance of, under `skip`", async () => {
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
      });
    });
  });
});
