// Server-execution v2 — the EXPLICIT WARM REQUEST (serving-loop.md §1's
// third activation trigger; RULED 2026-08-21):
//
// A serving-side provisioning run that stages authored SETUP into another
// space (program materialization via `replicatePatternToSpace`, a served
// `.inSpace()` create's piece scaffolding — the wave's foreign
// provisioning batches, protocol.md §2b) issues a warm request for the
// target with the staged doc instances. The host activates a parked,
// SESSIONLESS target on it (the sibling of the carries-events admission
// arm), and the target's serving loop takes the staged instances as
// identity-less warm demand, so the setup derives.
//
// T11.Q7 stays as designed: the admission hook alone still activates
// nothing — an authored admission into a lease-less space with no live
// session and no events leaves it parked. The warm request is a separate,
// deliberate signal from the run that KNOWS it staged setup needing
// derivation, never a blanket write-trigger.
//
// The pin reproduces the home-profile reload residual (the §2b
// derivation-carriage report §4's ordering race): setup lands AFTER the
// target's transient tenure parked, the creating client's sessions are
// gone, and — before this fix — nothing ever re-demands it, so the
// staged piece's computed stays underived forever.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { SpaceServer } from "../src/executor/space-server.ts";
import {
  ArrivalLog,
  awaitAdmitted,
  awaitEach,
} from "./support/serving-waits.ts";
import {
  stampWaveRunContext,
  warmWritesOf,
  type WaveSpaceCommit,
} from "../src/executor/wave.ts";
import {
  applyCommit,
  type Engine,
  read as readDoc,
  serverSeq,
} from "@commonfabric/memory/v2/engine";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

class SharedServerStorageManager extends EmulatedStorageManager {
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    return super.connectTo(server, options) as SharedServerStorageManager;
  }
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

const homeSigner = await Identity.fromPassphrase("warm request home");
const homeSpace = homeSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("warm request service");
const aliceSigner = await Identity.fromPassphrase("warm request alice");

describe("executor-warm-request", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  /** Every activation attempt's space and outcome — activation finishes
   * on no admission or session edge of its own. */
  let activations: ArrivalLog<{ space: MemorySpace; outcome: string }>;
  /** Every park's space and reason. */
  let parks: ArrivalLog<{ space: MemorySpace; reason: string }>;
  /** Each firing of the one-shot activation-failure stub below. */
  let stubFirings: ArrivalLog<void>;
  let clientManager: SharedServerStorageManager | undefined;
  let clientRuntime: Runtime | undefined;
  let servingRuntime: Runtime | undefined;

  /** One-shot activation-failure stub (the post-drain failure pin): the
   * next runtime construction for this space THROWS — the activation
   * dies inside `server.activate()` and lands in the host's
   * activate-failed arm, the same landing as a lease-unavailable
   * refusal for the state under test. Cleared when consumed. */
  let failNextRuntimeFor: MemorySpace | undefined;

  /** One-shot loop-failure stub: the next wave cycle to read the flush
   * deadline throws, and its tenure parks `loop-failed`. Cleared when
   * consumed. */
  let failNextCycle = false;

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: (space) => {
        if (failNextRuntimeFor === space) {
          failNextRuntimeFor = undefined;
          stubFirings.record();
          return Promise.reject(
            new Error("stubbed one-shot activation failure (test)"),
          );
        }
        const manager = SharedServerStorageManager.connectTo(server, {
          as: serviceSigner,
          servingHomeSpace: space,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntime ??= runtime;
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy: {
        get flushDeadlineMs(): number {
          if (failNextCycle) {
            failNextCycle = false;
            throw new Error("stubbed one-shot loop failure (test)");
          }
          return 5_000;
        },
        idleParkMs: 600_000,
      },
      onActivationSettled: (space, outcome) =>
        activations.record({ space, outcome }),
      onSpaceParked: (space, reason) => parks.record({ space, reason }),
    });

  /** Resolves once `space` has an ACTIVE tenure, counting the ones that
   * settled before the call. */
  const activated = (space: MemorySpace): Promise<unknown> =>
    activations.matching((entry) =>
      entry.space === space && entry.outcome === "active"
    );

  /** Resolves once `space` has an ACTIVE tenure recorded after the first
   * `from` entries. A successor's activation is what the tests below
   * wait for, and its predecessor's is already in the log. */
  const activatedSince = (space: MemorySpace, from: number): Promise<void> =>
    awaitEach(
      activations,
      () =>
        activations.entries.slice(from).some((entry) =>
          entry.space === space && entry.outcome === "active"
        ),
    );

  /** The count of warm-demand captures across every tenure: each tenure
   * counts a warm notice once, when the notice reaches its feed. */
  const warmCaptures = (): number => host!.stats().demand.warmWakes;

  /** A fresh space to serve, and its engine. */
  const newTarget = async (
    passphrase: string,
  ): Promise<{ space: MemorySpace; engine: Engine }> => {
    const space = (await Identity.fromPassphrase(passphrase))
      .did() as MemorySpace;
    return { space, engine: await server.engineForSpace(space) };
  };

  /** Issue a warm request for `id` in `space`, as the serving-side
   * provisioning path does once it has staged setup there. */
  const requestWarm = (engine: Engine, space: MemorySpace, id: string) =>
    server.noteExecutorCommit({
      space,
      seq: serverSeq(engine),
      class: "authored",
      sessionId: "warm-issuer",
      writes: [{ id, scopeKey: "space" }],
      warm: true,
    });

  /** Whether `space` has a live session other than the service's own. */
  const hasClientSession = (space: MemorySpace): boolean =>
    server.hasLiveSessionsForSpace(space, {
      excludePrincipal: serviceSigner.did(),
    });

  beforeEach(() => {
    server = newSharedServer();
    servingRuntime = undefined;
    failNextRuntimeFor = undefined;
    failNextCycle = false;
    activations = new ArrivalLog();
    parks = new ArrivalLog();
    stubFirings = new ArrivalLog();
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    clientRuntime = undefined;
    await clientManager?.close();
    clientManager = undefined;
    await server.close();
  });

  it("activates a parked, sessionless target on staged setup and derives it — the serving-side provisioning path's warm request (serving-loop.md §1; T11.Q7's write-alone parking untouched)", async () => {
    host = newHost();

    // Alice's client demands a HOME doc so the home space activates and
    // its serving loop (the provisioning run's host) is live. The client
    // never touches the provisioned space: its genesis lands
    // ENGINE-DIRECT below and every later write reaches it through the
    // serving wave's foreign batches (service-principal machinery), so
    // no client session and no event ever exists for it — what
    // activates it below can only be the warm request.
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    const demandCell = clientRuntime.getCell<{ ping: number }>(
      homeSpace,
      "warm-demand",
      undefined,
    );
    const cancel = demandCell.sink(() => {});
    try {
      await activated(homeSpace);
      expect(servingRuntime).toBeDefined();
      const serving = servingRuntime!;

      // The pattern whose materialization is the staged SETUP: compiled
      // in the HOME space (the instantiating side), replicated into the
      // provisioned space under the triggering run's §2b carriage — the
      // OW31 S-A writeback, i.e. exactly the commit that landed in the
      // parked space in the home-profile residual.
      const compiled = await serving.patternManager.compilePattern({
        main: "/warm.tsx",
        files: [{
          name: "/warm.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { out: number }>(",
            "  ({ n }) => ({ out: computed(() => n + 1) }),",
            ");",
          ].join("\n"),
        }],
      }, { space: homeSpace });
      await serving.patternManager.flushCompileCacheWrites();

      // The provisioned target: genesis ACL landed engine-direct (the
      // B4 ordering — commit #1 IS the ACL), naming the acting user
      // OWNER. Engine-direct means NO session and no admission notice
      // ever reaches the host for this space.
      const pSigner = await Identity.fromPassphrase("warm provisioned space");
      const pSpace = pSigner.did() as MemorySpace;
      const pEngine = await server.engineForSpace(pSpace);
      applyCommit(pEngine, {
        sessionId: "warm-genesis",
        space: pSpace,
        principal: pSpace,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:${pSpace}`,
            value: {
              value: { [aliceSigner.did()]: "OWNER", "*": "WRITE" },
            },
          }],
        },
      });

      // The pre-setup INACTIVE probe: the provisioned space has no
      // SpaceServer — what activates it below must therefore be the
      // warm request carried by the staged setup, nothing earlier.
      expect(host!.spaceServer(pSpace)?.active ?? false).toBe(false);

      // Stage the setup, serving-side. (1) The program docs: the
      // delegated compile-cache writeback into the target's own store.
      serving.patternManager.replicatePatternToSpace(
        compiled,
        pSpace,
        homeSpace,
        {
          acting: { user: aliceSigner.did(), session: "sess-warm" },
          capabilityRef: "event-consequence:e-warm",
        },
      );
      await serving.patternManager.flushCompileCacheWrites();
      await awaitAdmitted(server, () => serverSeq(pEngine) > 1);

      // (2) The piece scaffolding: a served, stamped provisioning run —
      // the T11 `.inSpace()` shape — instantiates the piece INTO the
      // provisioned space (argument + result + wiring cross via the
      // wave's foreign provisioning batch under the carried actor).
      const argumentCell = serving.getCell<{ n: number }>(
        pSpace,
        "warm-argument",
        undefined,
      );
      const resultCell = serving.getCell<{ out: number }>(
        pSpace,
        "warm-result",
        compiled.resultSchema,
      );
      await argumentCell.sync();
      await resultCell.sync();
      const homeAnchor = serving.getCell<{ linked: boolean }>(
        homeSpace,
        "warm-home-link",
        undefined,
      );
      const tx = serving.edit();
      stampWaveRunContext(tx, {
        actionId: "warm-provision",
        kind: "event-handler",
        eventId: "e-warm",
        acting: { user: aliceSigner.did(), session: "sess-warm" },
        capabilityRef: "event-consequence:e-warm",
      });
      tx.enableMultiSpaceWrites?.([pSpace, homeSpace]);
      argumentCell.withTx(tx).set({ n: 42 });
      serving.run(tx, compiled, argumentCell, resultCell);
      homeAnchor.withTx(tx).set({ linked: true });
      expect((await tx.commit()).error).toBeUndefined();

      const resultId = resultCell.getAsNormalizedFullLink().id;
      const setupSeq = () => serverSeq(pEngine);
      await awaitAdmitted(server, () => setupSeq() > 2);

      // THE PIN. Before the warm request existed, this wait never
      // returned:
      // the setup is durably present, the space is lease-less with no
      // live session and no events, the admission hook activates
      // nothing (T11.Q7's designed parking), and nothing ever
      // re-demands the staged setup — the home-profile "Alan Turing"
      // inertness. WITH the warm request, the provisioning path's
      // signal activates the target's own serving loop.
      await activated(pSpace);

      // The demand half: the staged instances are the tenure's warm
      // demand, so the loop structure-loads the staged piece and its
      // derivation LANDS in the target's own store — a derived-class
      // commit (the target space's single deriver), with the computed's
      // value durably present.
      const derivedCommits = () =>
        (pEngine.database.prepare(
          `SELECT COUNT(*) AS n FROM "commit" WHERE class = 'derived'`,
        ).get() as { n: number }).n;
      await awaitAdmitted(server, () => derivedCommits() > 0);
      // The result doc's `out` is a LINK to the computed's own doc; the
      // derived VALUE lives there. Follow it and read 42 + 1 durably.
      const outLinkId = () => {
        const doc = readDoc(pEngine, { id: resultId }) as {
          value?: { out?: { "/"?: { "link@1"?: { id?: string } } } };
        } | null;
        return doc?.value?.out?.["/"]?.["link@1"]?.id;
      };
      await awaitAdmitted(server, () => {
        const id = outLinkId();
        return id !== undefined &&
          JSON.stringify(readDoc(pEngine, { id }) ?? {}).includes("43");
      });
      // The warm request is observable in the loop's own counters.
      expect(host!.stats().warmRequests).toBeGreaterThan(0);
    } finally {
      cancel();
    }
  });

  it("merges EVERY warm notice racing one park into the successor tenure's demand — a second notice in the park window is not dropped (PR #6191 review P1)", async () => {
    host = newHost();

    // A live target space: client demand activates it the ordinary way
    // (the race under test is downstream of activation mechanics, so
    // the plain session-open trigger is the cheapest live tenure).
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    const pSigner = await Identity.fromPassphrase("warm race space");
    const pSpace = pSigner.did() as MemorySpace;
    const demandCell = clientRuntime.getCell<{ ping: number }>(
      pSpace,
      "warm-race-demand",
      undefined,
    );
    const cancel = demandCell.sink(() => {});
    try {
      await activated(pSpace);
      const firstTenure = activations.entries.length;
      const target = host!.spaceServer(pSpace)!;
      const pEngine = await server.engineForSpace(pSpace);

      // park() makes the tenure inactive synchronously and tears it down
      // asynchronously, so both warm notices land while the server is
      // registered, inactive, and not yet re-activating. Each chains the
      // host's re-activation after the park, and one activation serves
      // them both.
      const parked = target.park("idle");
      requestWarm(pEngine, pSpace, "of:warm-race-c1");
      requestWarm(pEngine, pSpace, "of:warm-race-c2");
      const captured = warmCaptures();
      await parked;

      // The successor captures both notices as warm demand.
      await activatedSince(pSpace, firstTenure);
      expect(warmCaptures() - captured).toBe(2);
    } finally {
      cancel();
    }
  });

  it("re-buffers drained warm notices when the activation they were drained into FAILS — the warm demand reaches the eventual successor (OW46-family, no crash required)", async () => {
    // The target has no client session and no events, so once the
    // activation fails, the warm notice it drained is the only thing that
    // can bring the space back.
    host = newHost();
    const { space: pSpace, engine: pEngine } = await newTarget(
      "warm fail space",
    );
    failNextRuntimeFor = pSpace;
    requestWarm(pEngine, pSpace, "of:warm-fail-c1");
    await stubFirings.reached(1);
    await activations.matching((entry) =>
      entry.space === pSpace && entry.outcome === "failed"
    );

    await activated(pSpace);
    expect(hasClientSession(pSpace)).toBe(false);
    // The failed tenure and its successor each captured the notice.
    expect(warmCaptures()).toBe(2);
  });

  it("re-activates a sessionless space for the warm notices of an activation that threw before its server parked", async () => {
    // The first activation throws out of `activate()` without parking. The
    // target has no client session and no events, so the warm notice its
    // server drained is the only thing that can bring the space back.
    host = newHost();
    const { space: pSpace, engine: pEngine } = await newTarget(
      "warm throw space",
    );
    const activate = SpaceServer.prototype.activate;
    let throwNext = true;
    using _activate = stub(
      SpaceServer.prototype,
      "activate",
      function (this: SpaceServer) {
        if (!throwNext) return activate.call(this);
        throwNext = false;
        return Promise.reject(new Error("stubbed activation throw (test)"));
      },
    );
    requestWarm(pEngine, pSpace, "of:warm-throw-c1");
    await activations.matching((entry) =>
      entry.space === pSpace && entry.outcome === "failed"
    );

    await activated(pSpace);
    expect(hasClientSession(pSpace)).toBe(false);
    // The server that threw and its successor each captured the notice.
    expect(warmCaptures()).toBe(2);
  });

  it("re-activates a sessionless space for the warm request its tenure took and then parked `loop-failed` on (serving-loop.md §1)", async () => {
    // The warm notice activates the target and reaches the tenure's feed,
    // and the tenure's first wave cycle throws. The target has no client
    // session and no events, so the warm request is the only thing that
    // can bring it back.
    host = newHost();
    const { space: pSpace, engine: pEngine } = await newTarget(
      "warm loop failure space",
    );
    failNextCycle = true;
    requestWarm(pEngine, pSpace, "of:warm-loop-failure-c1");
    await activated(pSpace);
    const firstTenure = activations.entries.length;
    await parks.matching((entry) =>
      entry.space === pSpace && entry.reason === "loop-failed"
    );

    await activatedSince(pSpace, firstTenure);
    expect(hasClientSession(pSpace)).toBe(false);
    expect(warmCaptures()).toBe(2);
  });

  it("re-activates a sessionless space for a warm request that reached its serving tenure before the tenure parked `loop-failed`", async () => {
    // The second warm notice reaches the tenure's feed while it serves, and
    // the tenure's next wave cycle throws.
    host = newHost();
    const { space: pSpace, engine: pEngine } = await newTarget(
      "warm mid-tenure space",
    );
    requestWarm(pEngine, pSpace, "of:warm-mid-tenure-c1");
    await activated(pSpace);
    const firstTenure = activations.entries.length;
    expect(host.spaceServer(pSpace)?.active).toBe(true);
    failNextCycle = true;
    requestWarm(pEngine, pSpace, "of:warm-mid-tenure-c2");
    await parks.matching((entry) =>
      entry.space === pSpace && entry.reason === "loop-failed"
    );

    await activatedSince(pSpace, firstTenure);
    // The first tenure captured c1 and then c2, and its successor both.
    expect(warmCaptures()).toBe(4);
  });

  it("re-activates a sessionless space for the documents a lifecycle verb staged, when its tenure parks `loop-failed` after the verb", async () => {
    // The tenure takes the verb's staged documents as warm demand while
    // the verb runs, before the verb's warm notice names them again. The
    // verb's confirm step arms a failure for the cycle after its own.
    host = newHost();
    const { space: pSpace } = await newTarget("warm verb space");
    await host.runLifecycleVerb(pSpace, {
      name: "stage",
      run: async (runtime) => {
        const staged = runtime.getCell<{ staged: boolean }>(
          pSpace,
          "warm-verb-staged",
          undefined,
        );
        const outcome = await runtime.editWithRetry((tx) => {
          runtime.stampServerRun(tx, {
            actionId: "test-verb/stage",
            kind: "bookkeeping",
          });
          staged.withTx(tx).set({ staged: true });
        });
        expect(outcome.error).toBeUndefined();
        return staged.getAsNormalizedFullLink().id;
      },
      demandRoots: (id) => [id],
      confirm: () => {
        failNextCycle = true;
        return Promise.resolve();
      },
    });
    const firstTenure = activations.entries.length;
    await parks.matching((entry) =>
      entry.space === pSpace && entry.reason === "loop-failed"
    );

    await activatedSince(pSpace, firstTenure);
    expect(hasClientSession(pSpace)).toBe(false);
  });

  it("does not carry a warm request past a tenure that took it and parked idle", async () => {
    // A later warm request activates the space again, and its tenure
    // captures that request alone.
    host = newHost();
    const { space: pSpace, engine: pEngine } = await newTarget(
      "warm idle space",
    );
    requestWarm(pEngine, pSpace, "of:warm-idle-c1");
    await activated(pSpace);
    await host.spaceServer(pSpace)!.park("idle");
    expect(warmCaptures()).toBe(1);

    const firstTenure = activations.entries.length;
    requestWarm(pEngine, pSpace, "of:warm-idle-c2");
    await activatedSince(pSpace, firstTenure);
    expect(warmCaptures()).toBe(2);
  });
});

describe("warmWritesOf()", () => {
  // The warm request's payload contract in isolation: which staged doc
  // instances a foreign provisioning batch contributes as warm demand.
  const batchWith = (
    operations: WaveSpaceCommit["operations"],
    delegated?: WaveSpaceCommit["delegated"],
  ): WaveSpaceCommit => ({
    space: homeSpace,
    home: false,
    basisSeq: 0,
    rebasedHeads: [],
    operations,
    preconditions: [],
    annotations: [],
    consequenceOf: [],
    basisInstances: [],
    holder: undefined,
    ...(delegated === undefined ? {} : { delegated }),
  });
  const setOp = (
    id: string,
    scope?: "space" | "user" | "session",
  ): WaveSpaceCommit["operations"][number] =>
    ({
      op: "set",
      id,
      type: "application/json",
      value: {},
      ...(scope === undefined ? {} : { scope }),
    }) as WaveSpaceCommit["operations"][number];

  it("keys space-scope ops (explicit or default) as `space` and dedupes per (id, scopeKey)", () => {
    const writes = warmWritesOf(batchWith([
      setOp("of:a"),
      setOp("of:a", "space"),
      setOp("of:b", "space"),
    ]));
    expect(writes).toEqual([
      { id: "of:a", scopeKey: "space" },
      { id: "of:b", scopeKey: "space" },
    ]);
  });

  it("resolves scoped ops against the batch's carried delegated identity — the same keying as the engine's delegated admission", () => {
    const writes = warmWritesOf(batchWith(
      [setOp("of:u", "user"), setOp("of:s", "session")],
      {
        actingPrincipal: "did:key:alice",
        actingSession: "sess-1",
        capabilityRef: "event-consequence:e",
      },
    ));
    expect(writes.map((write) => write.id)).toEqual(["of:u", "of:s"]);
    expect(writes[0].scopeKey.startsWith("user:")).toBe(true);
    expect(writes[1].scopeKey.startsWith("session:")).toBe(true);
  });

  it("omits a scoped op the carried identity cannot name — a session-scope op with no acting session", () => {
    const writes = warmWritesOf(batchWith(
      [setOp("of:s", "session"), setOp("of:keep", "space")],
      {
        actingPrincipal: "did:key:alice",
        capabilityRef: "event-consequence:e",
      },
    ));
    expect(writes).toEqual([{ id: "of:keep", scopeKey: "space" }]);
  });

  it("omits scoped ops entirely when the batch carries no delegated identity", () => {
    const writes = warmWritesOf(batchWith([
      setOp("of:u", "user"),
      setOp("of:keep", "space"),
    ]));
    expect(writes).toEqual([{ id: "of:keep", scopeKey: "space" }]);
  });

  it("omits folded sqlite ops — they carry no doc instance", () => {
    const sqliteOp = {
      op: "sqlite",
    } as unknown as WaveSpaceCommit["operations"][number];
    const writes = warmWritesOf(batchWith([sqliteOp, setOp("of:keep")]));
    expect(writes).toEqual([{ id: "of:keep", scopeKey: "space" }]);
  });
});
