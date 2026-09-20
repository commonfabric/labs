// Server-execution v2 Phase 5 — cross-space serving
// (docs/specs/server-side-execution/serving-loop.md §3b's cross-space
// bullet; protocol.md §2, §2b; builtins.md §5's per-demanding-identity
// wish resolution):
//
// - a home derivation reads a FOREIGN doc through the serving runtime's
//   ordinary storage plane, and a foreign commit WAKES the home loop
//   (the server-internal wake — never home input: W stays put, the
//   derived value still updates);
// - home-space resolution on a serving runtime targets the RUN's
//   demanding identity, never the service identity (the lunch-wall
//   trap), and refuses loudly with no identity;
// - the producer-side fail-closed refusal: a serving manager's FOREIGN
//   providers refuse scoped reads (protocol.md §2's grant-scoped read
//   design — delegated scoped reads are fail-closed until grant
//   resolution lands).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import {
  Runtime,
  type ServerRunInfo,
  spaceCellSchema,
} from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
  URI,
} from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { ArrivalLog, awaitAdmitted } from "./support/serving-waits.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { selectForeignStaleInstances } from "../src/executor/space-server.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { ACLManager } from "../src/acl-manager.ts";
import { wish as wishBuiltin } from "../src/builtins/wish.ts";
import {
  replaceSchedulerBasisRows,
  selectForeignBasisRows,
} from "@commonfabric/memory/v2/scheduler-basis";
import {
  applyCommit,
  read as readDoc,
  selectDocHead,
  serverSeq,
} from "@commonfabric/memory/v2/engine";
import {
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { type Frame, UI } from "../src/builder/types.ts";
import { resolveEntryIdentity } from "../src/index.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

// The route the toolshed serves the profile-create surface from, which is what
// the surface's `system:` origin resolves against.
const SIDECAR_ROUTE = "/api/patterns/system/profile-create.tsx";

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

const homeSigner = await Identity.fromPassphrase("cross-space home");
const homeSpace = homeSigner.did() as MemorySpace;
const foreignSigner = await Identity.fromPassphrase("cross-space foreign");
const foreignSpace = foreignSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("cross-space service");
const aliceSigner = await Identity.fromPassphrase("cross-space alice");
const bobSigner = await Identity.fromPassphrase("cross-space bob");

describe("Phase 5 cross-space serving", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: SharedServerStorageManager;
  let clientRuntime: Runtime;
  let activations: ArrivalLog<{ space: string; outcome: string }>;
  let servingRuntime: Runtime | undefined;
  let onServingRuntime: ((runtime: Runtime) => Promise<void>) | undefined;

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: async (space) => {
        const manager = SharedServerStorageManager.connectTo(server, {
          as: serviceSigner,
          // Phase 5: the serving manager declares its home space so
          // its FOREIGN providers refuse scoped reads (the producer
          // half of the delegated-scoped-read fail-closed rule).
          servingHomeSpace: space,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntime = runtime;
        await onServingRuntime?.(runtime);
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      onActivationSettled: (activatedSpace, outcome) =>
        activations.record({ space: activatedSpace, outcome }),
    });

  /** Resolves once `activatedSpace` has an ACTIVE tenure — activation
   * finishes on no admission or session edge of its own. */
  const activated = (activatedSpace: MemorySpace): Promise<unknown> =>
    activations.matching((entry) =>
      entry.space === activatedSpace && entry.outcome === "active"
    );

  beforeEach(() => {
    server = newSharedServer();
    servingRuntime = undefined;
    onServingRuntime = undefined;
    activations = new ArrivalLog();
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  it("a foreign commit WAKES the home loop: the home derivation over a foreign doc re-derives without home input (serving-loop.md §3b's server-internal wake)", async () => {
    host = newHost();

    // Seed the FOREIGN input doc (bob's space) before the home loop
    // activates, so the first derivation reads a real value.
    const bobManager = SharedServerStorageManager.connectTo(server, {
      as: bobSigner,
    });
    const bobRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: bobManager,
    });
    const bobInput = bobRuntime.getCell<{ n: number }>(
      foreignSpace,
      "x-space-input",
      undefined,
    );
    {
      const tx = bobRuntime.edit();
      bobInput.withTx(tx).set({ n: 1 });
      const committed = await tx.commit();
      expect(committed.error).toBeUndefined();
    }
    await bobRuntime.storageManager.synced();

    // The serving graph: a HOME pattern whose argument is the FOREIGN
    // doc — the home derivation reads across the space boundary
    // (serving-loop.md §3b: reads cross freely; the result commits
    // HOME, protocol.md §2b's derive-from-foreign row).
    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { total: number }>(",
            "  ({ n }) => ({ total: computed(() => n + 100) }),",
            ");",
          ].join("\n"),
        }],
      }, { space: homeSpace });
      const foreignArgument = runtime.getCell<{ n: number }>(
        foreignSpace,
        "x-space-input",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        homeSpace,
        "x-space-result",
        compiled.resultSchema,
      );
      await foreignArgument.sync();
      await result.sync();
      // Flushed before the run commits, so the replica the commit reads
      // against is current and the commit has nothing to conflict with.
      await runtime.storageManager.synced();
      const tx = runtime.edit();
      runtime.run(tx, compiled, foreignArgument, result);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `serving pattern run failed: ${committed.error.message}`,
        );
      }
      await runtime.idle();
    };

    // The client's DEMAND on the HOME result activates the home space.
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    const clientResult = clientRuntime.getCell<{ total: number }>(
      homeSpace,
      "x-space-result",
      undefined,
    );
    const cancel = clientResult.sink(() => {});
    try {
      await waitForCellValue(
        clientRuntime,
        clientResult.key("total"),
        (total: number | undefined) => total === 101,
        { stuckLabel: "the client's total to reach 101" },
      );
      expect(host.spaceServer(homeSpace)?.active).toBe(true);

      // The FOREIGN commit: bob updates his own space. No home input
      // follows — the wake chain (foreign session frames → autonomous
      // scheduler re-run → seal-wake) must start the re-derivation
      // well before the idle window (10 minutes here) expires.
      {
        const tx = bobRuntime.edit();
        bobInput.withTx(tx).set({ n: 2 });
        const committed = await tx.commit();
        expect(committed.error).toBeUndefined();
      }
      await waitForCellValue(
        clientRuntime,
        clientResult.key("total"),
        (total: number | undefined) => total === 102,
        { stuckLabel: "the client's total to reach 102" },
      );
    } finally {
      cancel();
      await bobRuntime.dispose();
      await bobManager.close();
    }
  });

  it("home-space resolution on a serving runtime targets the RUN's demanding identity, never the service identity (builtins.md §5, RULED 2026-08-14)", async () => {
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
      servingHomeSpace: homeSpace,
    });
    const serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    try {
      // A stamped run acting for alice: home space = ALICE's DID space.
      const stamped = serving.edit();
      stampWaveRunContext(stamped, {
        actionId: "wish/test",
        kind: "derivation",
        scopeKeyIdentity: {
          principal: aliceSigner.did(),
          sessionId: "sess-1",
        },
      });
      expect(serving.homeSpacePrincipalFor(stamped)).toBe(aliceSigner.did());
      expect(serving.getHomeSpaceCell(stamped).space).toBe(aliceSigner.did());
      stamped.abort(new Error("test-only"));

      // A handler run's stamped ACTOR resolves the same way.
      const handler = serving.edit();
      stampWaveRunContext(handler, {
        actionId: "handler/test",
        kind: "event-handler",
        eventId: "e-1",
        acting: { user: bobSigner.did(), session: "sess-2" },
      });
      expect(serving.homeSpacePrincipalFor(handler)).toBe(bobSigner.did());
      handler.abort(new Error("test-only"));

      // MIXED carriage (the F6 pin): a handler run on user B's
      // INSTANCE fired by actor A carries both — the instance owner's
      // scopeKeyIdentity wins over the acting pair (builtins.md §5:
      // the run resolves the instance it runs AS, scopes.md §5).
      const mixed = serving.edit();
      stampWaveRunContext(mixed, {
        actionId: "handler/mixed",
        kind: "event-handler",
        eventId: "e-2",
        scopeKeyIdentity: {
          principal: bobSigner.did(),
          sessionId: "sess-b",
        },
        acting: { user: aliceSigner.did(), session: "sess-a" },
      });
      expect(serving.homeSpacePrincipalFor(mixed)).toBe(bobSigner.did());
      mixed.abort(new Error("test-only"));

      // NO demanding identity: undefined, and the cell resolution
      // REFUSES — never the service DID (the lunch-wall trap).
      const unstamped = serving.edit();
      expect(serving.homeSpacePrincipalFor(unstamped)).toBeUndefined();
      expect(() => serving.getHomeSpaceCell(unstamped)).toThrow(
        "per-demanding-identity",
      );
      unstamped.abort(new Error("test-only"));

      // A CLIENT runtime keeps today's behavior: its own user, tx or
      // not.
      const client = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: SharedServerStorageManager.connectTo(server, {
          as: aliceSigner,
        }),
      });
      try {
        expect(client.homeSpacePrincipalFor(undefined)).toBe(
          aliceSigner.did(),
        );
        expect(client.getHomeSpaceCell().space).toBe(aliceSigner.did());
      } finally {
        await client.storageManager.close();
        await client.dispose();
      }
    } finally {
      await serving.dispose();
      await manager.close();
    }
  });

  it("space-name resolution on a serving runtime requires the acting identity as genesis owner; a client stays owner-free (OW31, RULED 2026-08-18)", async () => {
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
      servingHomeSpace: homeSpace,
    });
    const serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    try {
      // No acting identity: the serving runtime REFUSES to resolve (and
      // therefore to register a bootstrap authority) — a served
      // `.inSpace()` with no actor must never mint a service-owned
      // space.
      await expect(serving.resolveSpaceName("ow31-refusal-probe")).rejects
        .toThrow("acting identity as genesis owner");

      // With the acting user supplied, resolution succeeds and the
      // cached DID resolves synchronously from then on (no repeated
      // refusal on the re-run path).
      const did = await serving.resolveSpaceName("ow31-granted-probe", {
        owner: aliceSigner.did(),
      });
      expect(serving.resolveSpaceNameSync("ow31-granted-probe")).toBe(did);

      // A CLIENT runtime keeps today's byte-identical shape: no owner
      // required, the genesis names the active user via the signer arm.
      const client = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: SharedServerStorageManager.connectTo(server, {
          as: aliceSigner,
        }),
      });
      try {
        const clientDid = await client.resolveSpaceName("ow31-client-probe");
        expect(clientDid.startsWith("did:")).toBe(true);
      } finally {
        await client.storageManager.close();
        await client.dispose();
      }

      // The RUNNER's owner derivation (review F1 on #6156): the genesis
      // owner comes from the run context's ACTING user ONLY. A context
      // carrying just a demand-supplied scopeKeyIdentity — the
      // resolution scaffolding of a scope-attributed derivation whose
      // acting settles (possibly to none) at the seal — must NOT
      // register that principal as owner: the resolution REFUSES, since
      // a provisioning crossing without acting would be refused
      // carriage-less anyway and the orphaned genesis would name a
      // principal the grant probe never sees.
      const resolvePending =
        serving.runner.accessForTestingOnly.resolvePendingSpaceNamesAndRetry;
      const scaffolding = serving.edit();
      stampWaveRunContext(scaffolding, {
        actionId: "f1/scaffolding-only",
        kind: "derivation",
        scopeKeyIdentity: {
          principal: aliceSigner.did(),
          sessionId: "sess-f1",
        },
      });
      await expect(
        resolvePending(
          { pendingSpaceNames: new Set(["ow31-f1-scaffolding"]) } as Frame,
          scaffolding,
        ),
      ).rejects.toThrow("acting identity as genesis owner");
      scaffolding.abort(new Error("test-only"));
      expect(serving.resolveSpaceNameSync("ow31-f1-scaffolding"))
        .toBeUndefined();

      // With a real ACTING user the same seam resolves and retries.
      const actingTx = serving.edit();
      stampWaveRunContext(actingTx, {
        actionId: "f1/acting",
        kind: "event-handler",
        eventId: "e-f1",
        acting: { user: aliceSigner.did(), session: "sess-f1" },
        capabilityRef: "event-consequence:e-f1",
      });
      await expect(
        resolvePending(
          { pendingSpaceNames: new Set(["ow31-f1-acting"]) } as Frame,
          actingTx,
        ),
      ).rejects.toThrow("Resolving in-space target spaces");
      actingTx.abort(new Error("test-only"));
      expect(serving.resolveSpaceNameSync("ow31-f1-acting")).toBeDefined();
    } finally {
      await serving.dispose();
      await manager.close();
    }
  });

  it("OW31 B4: a FAILED genesis forcing is isolated per space — the sink's INV-13 mirror refuses the batch, nothing lands, and the home space keeps serving", async () => {
    // The forcing loop's failure arm (space-server.ts): a throwing
    // `ensureSpaceInitialized` must not park the home space — the
    // contributions targeting the fresh space are refused by the sink
    // (foreign failure => home withheld => replay) and the loop keeps
    // serving. The fail-closed cousin of the F6 pin above.
    host = newHost();
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    const demandCell = clientRuntime.getCell<{ ping: number }>(
      homeSpace,
      "b4-fail-demand",
      undefined,
    );
    const cancel = demandCell.sink(() => {});
    try {
      await activated(homeSpace);
      expect(servingRuntime).toBeDefined();
      const serving = servingRuntime!;
      const attempts: MemorySpace[] = [];
      const forcingAttempts = new ArrivalLog<MemorySpace>();
      (serving.storageManager as unknown as {
        ensureSpaceInitialized(space: MemorySpace): Promise<void>;
      }).ensureSpaceInitialized = (space: MemorySpace) => {
        attempts.push(space);
        forcingAttempts.record(space);
        return Promise.reject(
          new Error("injected genesis-forcing failure (test)"),
        );
      };

      const pSigner = await Identity.fromPassphrase("b4 forcing-fail space");
      const pSpace = pSigner.did() as MemorySpace;
      const foreignCell = serving.getCell<{ value: number }>(
        pSpace,
        "b4-fail-provisioned",
        undefined,
      );
      const tx = serving.edit();
      stampWaveRunContext(tx, {
        actionId: "b4-fail-provision",
        kind: "event-handler",
        eventId: "e-b4-fail",
        acting: { user: aliceSigner.did(), session: "sess-b4f" },
        capabilityRef: "event-consequence:e-b4-fail",
      });
      tx.enableMultiSpaceWrites?.([pSpace, homeSpace]);
      foreignCell.withTx(tx).set({ value: 41 });
      expect((await tx.commit()).error).toBeUndefined();

      // The forcing was attempted and failed.
      await forcingAttempts.matching((attempted) => attempted === pSpace);
      const pEngine = await server.engineForSpace(pSpace);

      // Failure isolation: a plain home-space write STILL commits — the
      // loop was not parked by the misdirected provisioning.
      const homeProbe = serving.getCell<{ value: number }>(
        homeSpace,
        "b4-fail-home-probe",
        undefined,
      );
      const probeTx = serving.edit();
      stampWaveRunContext(probeTx, {
        actionId: "b4-fail-home-probe",
        kind: "bookkeeping",
      });
      homeProbe.withTx(probeTx).set({ value: 7 });
      expect((await probeTx.commit()).error).toBeUndefined();
      const homeEngine = await server.engineForSpace(homeSpace);
      const probeId = homeProbe.getAsNormalizedFullLink().id;
      await awaitAdmitted(
        server,
        () => selectDocHead(homeEngine, { id: probeId, scopeKey: "space" }) > 0,
      );

      // Read past that admission: the loop carried the refused batch and
      // then this write, so the sink having refused the creation-granted
      // batch (INV-13 mirror) — the fresh space EMPTY, no genesis and no
      // data — is a settled state rather than one these reads raced.
      expect(host!.spaceServer(homeSpace)?.active ?? false).toBe(true);
      expect(serverSeq(pEngine)).toBe(0);
    } finally {
      cancel();
    }
  });

  it("OW31 B4 end-to-end: the SpaceServer's OWN commit step forces a creation-granted target's genesis before the sink's data batch (review F6 on #6156)", async () => {
    // Drives the REAL SpaceServer loop (not a hand-built wave): a
    // provisioning-shaped tx seals into the LIVE wave, its crossing
    // resolves via the CREATION arm (the target store does not exist at
    // probe time), and the commit step's forcing loop is the ONLY
    // genesis source — `ensureSpaceInitialized` is instrumented to
    // stand in for the loopback mount's bootstrap (the emulated factory
    // has none) and to record the call. Neutering
    // `creationGrantedForeignSpaces` reddens this test (mutation-
    // witnessed in the build report): the sink's INV-13 mirror then
    // refuses the batch and the data never lands.
    host = newHost();
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    const demandCell = clientRuntime.getCell<{ ping: number }>(
      homeSpace,
      "b4-loop-demand",
      undefined,
    );
    const cancel = demandCell.sink(() => {});
    try {
      await activated(homeSpace);
      expect(servingRuntime).toBeDefined();
      const serving = servingRuntime!;

      const pSigner = await Identity.fromPassphrase("b4 loop-forced space");
      const pSpace = pSigner.did() as MemorySpace;
      const forced: MemorySpace[] = [];
      // Stand-in for the loopback bootstrap (the real serving manager's
      // mount-time `#createInitializedSession`): mint the genesis the
      // registered owner would get, engine-direct, and record the call.
      (serving.storageManager as unknown as {
        ensureSpaceInitialized(space: MemorySpace): Promise<void>;
      }).ensureSpaceInitialized = async (space: MemorySpace) => {
        forced.push(space);
        const engine = await server.engineForSpace(space);
        if (serverSeq(engine) === 0) {
          applyCommit(engine, {
            sessionId: "b4-loop-genesis",
            space,
            principal: space,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: `of:${space}`,
                value: {
                  value: { [aliceSigner.did()]: "OWNER", "*": "WRITE" },
                },
              }],
            },
          });
        }
      };

      // The provisioning-shaped crossing, sealed into the LIVE wave
      // (the SpaceServer installed the seal destination at activation):
      // acting user + capabilityRef, foreign + home writes — the W3/W4
      // shape of a served `.inSpace()` create.
      const foreignCell = serving.getCell<{ value: number }>(
        pSpace,
        "b4-loop-provisioned",
        undefined,
      );
      const homeCell = serving.getCell<{ value: number }>(
        homeSpace,
        "b4-loop-home-link",
        undefined,
      );
      const tx = serving.edit();
      stampWaveRunContext(tx, {
        actionId: "b4-loop-provision",
        kind: "event-handler",
        eventId: "e-b4-loop",
        acting: { user: aliceSigner.did(), session: "sess-b4" },
        capabilityRef: "event-consequence:e-b4-loop",
      });
      tx.enableMultiSpaceWrites?.([pSpace, homeSpace]);
      foreignCell.withTx(tx).set({ value: 31 });
      homeCell.withTx(tx).set({ value: 32 });
      expect((await tx.commit()).error).toBeUndefined();

      const pEngine = await server.engineForSpace(pSpace);
      await awaitAdmitted(server, () => serverSeq(pEngine) >= 2);
      expect(forced).toContain(pSpace);
      // Commit #1 IS the ACL, owner = the acting user, service nowhere.
      expect(
        selectDocHead(pEngine, { id: `of:${pSpace}`, scopeKey: "space" }),
      ).toBe(1);
      const acl = await server.readDocument(pSpace, `of:${pSpace}`);
      expect(acl?.value).toEqual({
        [aliceSigner.did()]: "OWNER",
        "*": "WRITE",
      });
      expect(
        Object.keys(acl?.value as Record<string, unknown>),
      ).not.toContain(serviceSigner.did());
      // The data batch rode the delegated admission under the actor.
      const meta = pEngine.database.prepare(
        `SELECT class, acting_principal FROM "commit"
         WHERE seq > 1 ORDER BY seq LIMIT 1`,
      ).get() as Record<string, string>;
      expect(meta.class).toBe("authored");
      expect(meta.acting_principal).toBe(aliceSigner.did());
    } finally {
      cancel();
    }
  });

  it("OW31 seat S-A: a cross-space compile-cache writeback rides the triggering run's delegated carriage — carriage-less it stays refused (protocol.md §2b; the render-stall §1 class)", async () => {
    host = newHost();

    // Activate the HOME space through a client demand (the ordinary
    // activation path — the wave and the REAL run stamper are then
    // live on the serving runtime).
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    const demandCell = clientRuntime.getCell<{ ping: number }>(
      homeSpace,
      "sa-demand",
      undefined,
    );
    const cancel = demandCell.sink(() => {});
    try {
      await activated(homeSpace);
      expect(servingRuntime).toBeDefined();
      const serving = servingRuntime!;
      const compiled = await serving.patternManager.compilePattern({
        main: "/sa.tsx",
        files: [{
          name: "/sa.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { out: number }>(",
            "  ({ n }) => ({ out: computed(() => n + 1) }),",
            ");",
          ].join("\n"),
        }],
      }, { space: homeSpace });
      await serving.patternManager.flushCompileCacheWrites();

      // The provisioned target: its GENESIS already landed (the B4
      // ordering — the .inSpace creation wave forces it), naming the
      // acting user OWNER with the client-shape wildcard.
      const pSigner = await Identity.fromPassphrase("sa provisioned space");
      const pSpace = pSigner.did() as MemorySpace;
      const pEngine = await server.engineForSpace(pSpace);
      applyCommit(pEngine, {
        sessionId: "sa-genesis",
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

      // CARRIAGE-LESS replication (the pre-fix shape, kept as the
      // fail-closed pin): every writeback into P is refused at the
      // wave's accept gate — the render-stall §1 refusals — and P's
      // store stays at its genesis.
      const refusalsBefore = host!.stats().foreignWriteRefusals;
      serving.patternManager.replicatePatternToSpace(
        compiled,
        pSpace,
        homeSpace,
      );
      await serving.patternManager.flushCompileCacheWrites().catch(() => {});
      await awaitAdmitted(
        server,
        () => host!.stats().foreignWriteRefusals > refusalsBefore,
      );
      expect(selectDocHead(pEngine, { id: `of:${pSpace}`, scopeKey: "space" }))
        .toBe(1);

      // WITH the triggering run's §2b carriage (OW31 seat S-A): the
      // writebacks seal with the acting user + capabilityRef, the
      // accept gate grants via P's ACL, and the program docs land in
      // P's OWN store — the served mirror of the client committing
      // the program under the user's session.
      serving.patternManager.replicatePatternToSpace(
        compiled,
        pSpace,
        homeSpace,
        {
          acting: { user: aliceSigner.did(), session: "sess-sa" },
          capabilityRef: "event-consequence:e-sa",
        },
      );
      await serving.patternManager.flushCompileCacheWrites();
      await awaitAdmitted(server, () => serverSeq(pEngine) > 1);
      const meta = pEngine.database.prepare(
        `SELECT class, acting_principal, capability_ref
         FROM "commit" WHERE seq > 1 ORDER BY seq LIMIT 1`,
      ).get() as Record<string, string>;
      expect(meta.class).toBe("authored");
      expect(meta.acting_principal).toBe(aliceSigner.did());
      expect(meta.capability_ref).toBe("event-consequence:e-sa");
    } finally {
      cancel();
    }
  });

  it("the ruled 3b close carries the §2b delegation across the heal: a delegated replication that failed for SUPPLY parks, and the re-issue a later matching persist record triggers lands in the provisioned space through the accept gate's delegated admission — long after the triggering wave committed (late-carriage admission, the OW45 3b close)", async () => {
    host = newHost();

    // Home space active through a client demand (the S-A shape above).
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    const demandCell = clientRuntime.getCell<{ ping: number }>(
      homeSpace,
      "lc-demand",
      undefined,
    );
    const cancel = demandCell.sink(() => {});
    try {
      await activated(homeSpace);
      expect(servingRuntime).toBeDefined();
      const serving = servingRuntime!;

      // The pattern OBJECT reaches the serving manager with NO persist it
      // can reach: the CLIENT compiles it into alice's own space (the
      // entry ref rides the module-level side table; the serving
      // manager's fallback map records only ITS OWN persists, so it
      // stays dry for this entry).
      const program = {
        main: "/lc.tsx",
        files: [{
          name: "/lc.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { out: number }>(",
            "  ({ n }) => ({ out: computed(() => n + 2) }),",
            ");",
          ].join("\n"),
        }],
      };
      const aliceSpace = aliceSigner.did() as MemorySpace;
      const compiled = await clientRuntime.patternManager.compilePattern(
        program,
        { space: aliceSpace },
      );
      await clientRuntime.patternManager.flushCompileCacheWrites();

      // The provisioned target, genesis already landed (the B4 ordering).
      const pSigner = await Identity.fromPassphrase("lc provisioned space");
      const pSpace = pSigner.did() as MemorySpace;
      const pEngine = await server.engineForSpace(pSpace);
      applyCommit(pEngine, {
        sessionId: "lc-genesis",
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

      // The DELEGATED replication out of the DRY home space — the lunch
      // shape (the child replication's origin is the wave's home, and no
      // supplier has persisted there yet). It fails loudly for SUPPLY and
      // PARKS, carrying the §2b delegation with it; nothing lands in P.
      serving.patternManager.replicatePatternToSpace(
        compiled,
        pSpace,
        homeSpace,
        {
          acting: { user: aliceSigner.did(), session: "sess-lc" },
          capabilityRef: "event-consequence:e-lc",
        },
      );
      await serving.patternManager.flushCompileCacheWrites();
      expect(serverSeq(pEngine)).toBe(1);

      // THE SUPPLIER ARRIVES — the serving runtime's own compile into the
      // HOME space (the sidecar/home-env supplier's shape, which records
      // into the parked replication's ORIGIN: a wake filter that skipped
      // fromSpace records would sleep through exactly the observed lunch
      // supplier). The record wakes the park; the re-issue reads the
      // now-supplied home space and writes into P under the ORIGINAL
      // delegated carriage — minutes-later in production, the same
      // admission shape: the accept gate validates completeness, not
      // freshness (engine-wave-sink's §2b row).
      await serving.patternManager.compilePattern(program, {
        space: homeSpace,
      });
      await serving.patternManager.flushCompileCacheWrites();
      await serving.patternManager.flushCompileCacheWrites();
      await awaitAdmitted(server, () => serverSeq(pEngine) > 1);
      const meta = pEngine.database.prepare(
        `SELECT class, acting_principal, capability_ref
         FROM "commit" WHERE seq > 1 ORDER BY seq LIMIT 1`,
      ).get() as Record<string, string>;
      expect(meta.class).toBe("authored");
      expect(meta.acting_principal).toBe(aliceSigner.did());
      expect(meta.capability_ref).toBe("event-consequence:e-lc");
    } finally {
      cancel();
    }
  });

  it("a served run's send to a FOREIGN stream cell crosses via the outbox: LT1's same-space axis is the WAVE's home space, never the sending cell's space (LT1/LT5; events.md §2; protocol.md §2b)", async () => {
    host = newHost();

    // Alice's client demands a home doc so the HOME space activates.
    // The client never touches the FOREIGN space: the foreign stream
    // doc is created ENGINE-DIRECT below, so no session and no
    // admission notice ever reaches the host for that space — it is
    // genuinely INACTIVE until the delivered append, and the
    // activation assertion at the end binds the carries-events
    // admission arm (host.ts #onCommitAdmitted), not a leftover
    // session-open activation. (Probe-verified: with a client session
    // creating the stream doc instead, the pre-send inactive probe
    // below fails — the space is already active before the send.)
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    const streamDocId = clientRuntime.getCell<unknown>(
      foreignSpace,
      "xspace-send-stream",
      undefined,
    ).getAsNormalizedFullLink().id;
    {
      const fEngine = await server.engineForSpace(foreignSpace);
      applyCommit(fEngine, {
        sessionId: "xspace-setup",
        space: foreignSpace,
        principal: aliceSigner.did(),
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: streamDocId,
            value: { value: { $stream: true } } as never,
          }],
        },
      });
    }
    const demandCell = clientRuntime.getCell<{ ping: number }>(
      homeSpace,
      "xspace-send-demand",
      undefined,
    );
    const cancel = demandCell.sink(() => {});
    try {
      await activated(homeSpace);
      expect(servingRuntime).toBeDefined();
      const serving = servingRuntime!;

      // The DIRECT FOREIGN HANDLE shape (a wish-result export's
      // `setName` stream): the sending cell's OWN space IS the foreign
      // target space, so cell.space === resolved.space === FOREIGN.
      // The serving runtime's own foreign read session is
      // service-principal and never activates the space.
      const servingStream = serving.getCell<unknown>(
        foreignSpace,
        "xspace-send-stream",
        undefined,
      );
      await servingStream.sync();
      const homeAnchor = serving.getCell<{ n: number }>(
        homeSpace,
        "xspace-send-anchor",
        undefined,
      );

      // The pre-send inactive probe: the foreign space has no
      // SpaceServer yet — what activates it below must therefore be
      // the DELIVERED APPEND, nothing earlier.
      expect(host!.spaceServer(foreignSpace)?.active ?? false).toBe(false);

      // A served event-handler run, HOME-anchored: the run's tx holds
      // the home writer before the handler body sends (the consequenced
      // mark's shape on a real dispatch).
      const tx = serving.edit();
      stampWaveRunContext(tx, {
        actionId: "xspace-send-handler",
        kind: "event-handler",
        eventId: "e-xspace-send",
        acting: { user: aliceSigner.did(), session: "sess-xspace" },
        capabilityRef: "event-consequence:e-xspace-send",
      });
      homeAnchor.withTx(tx).set({ n: 1 });
      // The routing axis under test: the emission's target space is
      // judged against the WAVE's home space, so this foreign-handle
      // send stages the outbox's cross-space append (events.md §2) —
      // never a raw entries write into a second space's writer, which
      // the one-tx-one-space rule refuses (protocol.md §2b).
      servingStream.withTx(tx).send({ hello: "across" });
      expect((await tx.commit()).error).toBeUndefined();

      // The outbox delivers the append into the FOREIGN stream's
      // sidecar, firedAt stamped from the CARRIED actor (LT5: the
      // envelope is the producing server's service identity;
      // admissibility and attribution from the validated carriage).
      const fEngine = await server.engineForSpace(foreignSpace);
      const sidecarId = streamEntriesDocId({
        id: servingStream.getAsNormalizedFullLink().id,
        path: [],
      });
      const deliveredEntries = () => {
        const value = readDoc(fEngine, { id: sidecarId })?.value as
          | StreamEventsDocValue
          | undefined;
        return (value?.entries ?? []).filter((entry) =>
          entry.firedAt?.user === aliceSigner.did()
        );
      };
      await awaitAdmitted(server, () => deliveredEntries().length > 0);
      // EXACTLY ONE delivery (the eventId dedupe holds), carrying the
      // full LT5/LT6 identity: the acting session travels with the
      // acting user.
      expect(deliveredEntries().length).toBe(1);
      expect(deliveredEntries()[0].firedAt?.session).toBe("sess-xspace");
      // The delivered append is an AUTHORED admission carrying an
      // event: the arrival activates the target space's own serving
      // loop (serving-loop.md §1's event-append criterion; the
      // carries-events arm activates even with no client session) —
      // the single deriver that consequences it (protocol.md §2b's
      // derived-into-foreign FORBIDDEN row stays intact).
      await activated(foreignSpace);
      // A later observation point (post-activation): the delivery is
      // STILL exactly one entry — no duplicate landed behind the first
      // probe.
      expect(deliveredEntries().length).toBe(1);
    } finally {
      cancel();
    }
  });

  it("OW31 read posture under enforce: a serving manager reads an OWNER-ONLY home space through the acting-as-owner binding; a non-serving manager as the same identity is denied", async () => {
    const enforceServer = new MemoryV2Server.Server({
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
      acl: {
        mode: "enforce",
        // The OW31 posture: the process identity is DELEGATING, never
        // OWNER-class.
        delegatingDids: [serviceSigner.did()],
      },
    });
    const aliceHome = aliceSigner.did() as MemorySpace;
    // Alice's own client claims her home space privately (the home-arm
    // genesis: principal === space, owner-only ACL — no wildcard).
    const aliceManager = SharedServerStorageManager.connectTo(enforceServer, {
      as: aliceSigner,
    });
    const aliceRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: aliceManager,
    });
    try {
      const acl = new ACLManager(aliceRuntime, aliceHome);
      await acl.set(aliceSigner.did(), "OWNER");
      await aliceRuntime.storageManager.synced();

      // The SERVING manager (the loopback plane): its mounts carry the
      // acting-as-owner binding, so its session on alice's OWNER-ONLY
      // home space opens and reads AS ALICE — the R2 shape that failed
      // `lacks READ` under the removed blanket.
      const servingManager = SharedServerStorageManager.connectTo(
        enforceServer,
        {
          as: serviceSigner,
          servingHomeSpace: homeSpace,
        },
      );
      try {
        const sync = await servingManager.open(aliceHome).sync(
          `of:${aliceHome}` as URI,
        );
        expect(sync.error).toBeUndefined();
      } finally {
        await servingManager.close();
      }

      // The same identity WITHOUT the serving marker (the toolshed's own
      // non-serving runtimes): no binding, envelope-only — denied. The
      // retired blanket stays retired.
      const plainManager = SharedServerStorageManager.connectTo(
        enforceServer,
        { as: serviceSigner },
      );
      try {
        const denied = await plainManager.open(aliceHome).sync(
          `of:${aliceHome}` as URI,
        );
        expect(denied.error).toBeDefined();
      } finally {
        await plainManager.close();
      }
    } finally {
      await aliceRuntime.dispose();
      await aliceManager.close();
      await enforceServer.close();
    }
  });

  it("the activation foreign re-mark judges recorded foreign inputs against their OWN space's head (serving-loop.md §6 step 2; the F5 pin)", async () => {
    // The re-mark's activation arm fail-degrades to a warn by design
    // (recovery correctness rides recompute-on-demand), so a breakage
    // is invisible there — the decision helper carries the test
    // surface: rows behind their foreign head re-mark, rows AT head do
    // not, home-scan findings are not double-added, and only foreign
    // rows are selected at all.
    const homeEngine = await server.engineForSpace(homeSpace);

    // A real foreign doc with a real head: bob writes it twice.
    const bobManager = SharedServerStorageManager.connectTo(server, {
      as: bobSigner,
    });
    const bobRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: bobManager,
    });
    try {
      const doc = bobRuntime.getCell<{ n: number }>(
        foreignSpace,
        "f5-foreign-input",
        undefined,
      );
      {
        const tx = bobRuntime.edit();
        doc.withTx(tx).set({ n: 1 });
        expect((await tx.commit()).error).toBeUndefined();
      }
      await bobRuntime.storageManager.synced();
      const docId = doc.getAsNormalizedFullLink().id;
      const foreignEngine = await server.engineForSpace(foreignSpace);
      const headAtRead = selectDocHead(foreignEngine, {
        id: docId,
        scopeKey: "space",
      });
      expect(headAtRead).toBeGreaterThan(0);

      // Recorded basis rows on the HOME engine: action-current read the
      // doc at its current head; action-behind at head-1; action-covered
      // is already in the home scan's stale set; action-home reads only
      // a home entity (never selected as foreign).
      const scope = { branch: "", space: homeSpace };
      replaceSchedulerBasisRows(homeEngine, {
        ...scope,
        action: "action-current",
        actionScopeKey: "space",
        rows: [{
          entitySpace: foreignSpace,
          entity: docId,
          entityScopeKey: "space",
          seq: headAtRead,
        }],
      });
      replaceSchedulerBasisRows(homeEngine, {
        ...scope,
        action: "action-behind",
        actionScopeKey: "space",
        rows: [{
          entitySpace: foreignSpace,
          entity: docId,
          entityScopeKey: "space",
          seq: headAtRead - 1,
        }],
      });
      replaceSchedulerBasisRows(homeEngine, {
        ...scope,
        action: "action-covered",
        actionScopeKey: "space",
        rows: [{
          entitySpace: foreignSpace,
          entity: docId,
          entityScopeKey: "space",
          seq: headAtRead - 1,
        }],
      });
      replaceSchedulerBasisRows(homeEngine, {
        ...scope,
        action: "action-home",
        actionScopeKey: "space",
        rows: [{
          entitySpace: homeSpace,
          entity: "of:f5-home-entity",
          entityScopeKey: "space",
          seq: 1,
        }],
      });

      // Only foreign rows are selected, all of them.
      const foreignRows = selectForeignBasisRows(homeEngine, scope);
      expect(foreignRows.map((row) => row.action).sort()).toEqual([
        "action-behind",
        "action-covered",
        "action-current",
      ]);

      const engineFor = (s: MemorySpace) => server.engineForSpace(s);

      // At-head rows do NOT re-mark; behind rows DO; home-scan-covered
      // rows are not double-added.
      expect(
        await selectForeignStaleInstances(homeEngine, scope, engineFor, [
          { action: "action-covered", actionScopeKey: "space" },
        ]),
      ).toEqual([{ action: "action-behind", actionScopeKey: "space" }]);

      // The foreign head MOVES (bob writes again): the at-head row is
      // now behind and re-marks — the park → foreign-move → reactivate
      // schedule's decision, judged against the foreign engine.
      {
        const tx = bobRuntime.edit();
        doc.withTx(tx).set({ n: 2 });
        expect((await tx.commit()).error).toBeUndefined();
      }
      await bobRuntime.storageManager.synced();
      expect(
        selectDocHead(foreignEngine, { id: docId, scopeKey: "space" }),
      ).toBeGreaterThan(headAtRead);
      expect(
        await selectForeignStaleInstances(homeEngine, scope, engineFor, [
          { action: "action-covered", actionScopeKey: "space" },
        ]),
      ).toEqual([
        { action: "action-behind", actionScopeKey: "space" },
        { action: "action-current", actionScopeKey: "space" },
      ]);
    } finally {
      await bobRuntime.dispose();
      await bobManager.close();
    }
  });

  it("a foreign space whose engine cannot resolve fails ONLY its contributions — the home space keeps serving instead of parking (protocol.md §2b; the F1b fix)", async () => {
    // Pre-fix, #resolveForeignEngines was awaited un-caught in the
    // commit step: ONE unresolvable foreign target threw out of the
    // cycle — loop-failed → park + backoff for the whole HOME space,
    // the exact outage class the RULED accumulation refusal exists to
    // prevent. The failure must be action-scoped: the crossing's own
    // contribution withdraws (counted), everything else commits.
    const badSigner = await Identity.fromPassphrase("x-space bad engine");
    const badSpace = badSigner.did() as MemorySpace;
    const proxiedServer = new Proxy(server, {
      get(target, prop, receiver) {
        if (prop === "engineForSpace") {
          return (s: string) =>
            s === badSpace
              ? Promise.reject(new Error("engine open failed (test)"))
              : target.engineForSpace(s);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as MemoryV2Server.Server;

    host = new ExecutorHost({
      server: proxiedServer,
      serviceIdentity: serviceSigner.did(),
      createRuntime: async (space) => {
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
        servingRuntime = runtime;
        await onServingRuntime?.(runtime);
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
    });

    // A served home derivation whose input the client can move — the
    // "everything else" that must keep committing.
    onServingRuntime = async (runtime) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { total: number }>(",
            "  ({ n }) => ({ total: computed(() => n + 500) }),",
            ");",
          ].join("\n"),
        }],
      }, { space: homeSpace });
      const argument = runtime.getCell<{ n: number }>(
        homeSpace,
        "f1b-arg",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        homeSpace,
        "f1b-result",
        compiled.resultSchema,
      );
      await argument.sync();
      await result.sync();
      // Flushed before the run commits, so the replica the commit reads
      // against is current and the commit has nothing to conflict with.
      await runtime.storageManager.synced();
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      const committed = await tx.commit();
      if (committed.error !== undefined) {
        throw new Error(
          `serving pattern run failed: ${committed.error.message}`,
        );
      }
      await runtime.idle();
    };

    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    {
      const tx = clientRuntime.edit();
      clientRuntime.getCell<{ n: number }>(homeSpace, "f1b-arg", undefined, tx)
        .set({ n: 1 });
      const committed = await tx.commit();
      expect(committed.error).toBeUndefined();
    }
    const clientResult = clientRuntime.getCell<{ total: number }>(
      homeSpace,
      "f1b-result",
      undefined,
    );
    const cancel = clientResult.sink(() => {});
    try {
      await waitForCellValue(
        clientRuntime,
        clientResult.key("total"),
        (total: number | undefined) => total === 501,
        { stuckLabel: "the client's total to reach 501" },
      );
      expect(host.spaceServer(homeSpace)?.active).toBe(true);

      // The misdirected crossing: full §2b carriage, owner-by-identity
      // grant (acting user IS the target space DID, so the accept gate
      // admits without touching the engine) — and the target's engine
      // cannot open.
      const serving = servingRuntime!;
      const badTx = serving.edit();
      stampWaveRunContext(badTx, {
        actionId: "provision-into-bad-space",
        kind: "event-handler",
        eventId: "e-bad-space",
        acting: { user: badSpace, session: "sess-bad" },
        capabilityRef: "cap:test-grant",
      });
      serving.getCell<{ value: number }>(
        badSpace,
        "f1b-bad-doc",
        undefined,
        badTx,
      ).set({ value: 1 });
      const badCommit = await badTx.commit();
      // Accepted into the wave (the gate admits it) — the failure is
      // decided at the commit step's engine resolution.
      expect(badCommit.error).toBeUndefined();

      // The home space must KEEP SERVING: the client moves the input
      // and the served derivation lands in a wave that also had to
      // resolve (and isolate) the bad foreign target.
      {
        const tx = clientRuntime.edit();
        clientRuntime.getCell<{ n: number }>(
          homeSpace,
          "f1b-arg",
          undefined,
          tx,
        ).set({ n: 2 });
        const committed = await tx.commit();
        expect(committed.error).toBeUndefined();
      }
      await waitForCellValue(
        clientRuntime,
        clientResult.key("total"),
        (total: number | undefined) => total === 502,
        { stuckLabel: "the client's total to reach 502" },
      );
      expect(host.spaceServer(homeSpace)?.active).toBe(true);
      await awaitAdmitted(
        server,
        () => host!.stats().foreignEngineFailures >= 1,
      );
    } finally {
      cancel();
    }
  });

  it("foreignWriteAuthorityFor: the structural grant supply — owner-by-identity, fresh-store creation (non-creating probe), the target's own ACL, fail-closed otherwise (protocol.md §2b; the F1 fix)", async () => {
    const aliceDid = aliceSigner.did();
    const bobDid = bobSigner.did();

    // Owner-by-identity: the target space IS the actor's DID (their
    // home space — the wish bootstrap's sanctioned target).
    expect(
      await server.foreignWriteAuthorityFor(aliceDid, aliceDid),
    ).toEqual({ granted: true, via: "owner" });

    // Creation: a well-formed, never-materialized space is §2b's
    // sanctioned provisioning...
    const freshSigner = await Identity.fromPassphrase(
      "x-space fresh provision target",
    );
    const fresh = freshSigner.did();
    expect(await server.foreignWriteAuthorityFor(fresh, aliceDid)).toEqual({
      granted: true,
      via: "creation",
    });
    // ...and the probe itself must NOT create the store: a second
    // probe still sees a fresh space (had the first probe materialized
    // it, this would now be exists-with-no-ACL → refused).
    expect(await server.foreignWriteAuthorityFor(fresh, bobDid)).toEqual({
      granted: true,
      via: "creation",
    });

    // A malformed space name never resolves (or provisions) a store —
    // the F1c arbitrary-store-creation arm.
    const garbage = await server.foreignWriteAuthorityFor(
      "junk-not-a-space",
      aliceDid,
    );
    expect(garbage.granted).toBe(false);
    // No acting principal: refused outright.
    expect(
      (await server.foreignWriteAuthorityFor(fresh, undefined)).granted,
    ).toBe(false);

    // An EXISTING space with no ACL document fails closed on the
    // serving plane (the client path's populated-legacy compat arm is
    // a rollout accommodation, not a grant).
    await server.engineForSpace(foreignSpace);
    const noAcl = await server.foreignWriteAuthorityFor(
      foreignSpace,
      aliceDid,
    );
    expect(noAcl.granted).toBe(false);

    // The target's OWN ACL document is a real grant: bob grants alice
    // WRITE on bob's space; carol (no row, no wildcard) stays refused.
    const bobManager = SharedServerStorageManager.connectTo(server, {
      as: bobSigner,
    });
    const bobRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: bobManager,
    });
    try {
      const acl = new ACLManager(bobRuntime, bobDid);
      await acl.set(bobDid, "OWNER");
      await acl.set(aliceDid, "WRITE");
      await bobRuntime.storageManager.synced();
      expect(await server.foreignWriteAuthorityFor(bobDid, aliceDid)).toEqual(
        { granted: true, via: "acl" },
      );
      const carolSigner = await Identity.fromPassphrase("x-space carol");
      const carol = await server.foreignWriteAuthorityFor(
        bobDid,
        carolSigner.did(),
      );
      expect(carol.granted).toBe(false);
    } finally {
      await bobRuntime.dispose();
      await bobManager.close();
    }
  });

  it("two demanders on one wish node get their OWN sidecar surfaces — no cross-user mixing (builtins.md §5; the F2 fix)", async () => {
    // The mixed-demand schedule the phase exists to serve: the scheduler
    // runs demanded instances over ONE singular wish node (same Action
    // closure, per-instance stamped txs — scheduler/run.ts), so the
    // builtin's per-node sidecar caches MUST key per demanding identity.
    // Pre-fix, demander #2 reused demander #1's create-surface result
    // cell and clobbered the shared pending input — cross-user mixing in
    // both directions.
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
      servingHomeSpace: homeSpace,
    });
    const serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });

    // Seed BOTH users' home spaces: a defaultPattern link with no
    // profiles, so a #profile wish falls to the create surface.
    const seedHome = async (signer: Identity) => {
      const did = signer.did() as MemorySpace;
      const m = SharedServerStorageManager.connectTo(server, { as: signer });
      const r = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: m,
      });
      const tx = r.edit();
      const homeCell = r.getCell(did, did, spaceCellSchema, tx);
      const defaultCell = r.getCell(
        did,
        "x-space-home-default",
        undefined,
        tx,
      );
      defaultCell.set({ profiles: [] });
      (homeCell as Cell<Record<string, unknown>>).key("defaultPattern").set(
        defaultCell as never,
      );
      const committed = await tx.commit();
      expect(committed.error).toBeUndefined();
      await r.storageManager.synced();
      await r.dispose();
      await m.close();
      return did;
    };
    const aliceDid = await seedHome(aliceSigner);
    const bobDid = await seedHome(bobSigner);

    // Serve the profile-create surface through a gated fetch stub: the test
    // controls when its source resolves, so both demanders run while the open
    // is pending — the exact schedule that clobbered the shared input holder.
    const sidecarSource = [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ profiles: unknown }, { echo: unknown }>(",
      "  ({ profiles }) => ({ echo: profiles }),",
      ");",
    ].join("\n");
    const sidecarIdentity = await resolveEntryIdentity(
      SIDECAR_ROUTE,
      () => Promise.resolve(sidecarSource),
    );
    const gate = Promise.withResolvers<void>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Request | URL | string) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === SIDECAR_ROUTE) {
        if (url.searchParams.has("identity")) {
          return new Response(sidecarIdentity, { status: 200 });
        }
        await gate.promise;
        return new Response(sidecarSource, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const cancels: (() => void)[] = [];
    try {
      // Preload the foreign home docs into the serving runtime (wish
      // reads are synchronous; the scheduler's re-trigger is not driven
      // in this direct-drive test).
      for (const did of [aliceDid, bobDid]) {
        const home = serving.getCell(did, did, spaceCellSchema);
        await home.sync();
        await (home as Cell<Record<string, unknown>>).key("defaultPattern")
          .resolveAsCell().sync();
      }

      // The wish node: ONE inputs cell, ONE parent, ONE cause — the
      // singular node — driven directly with per-demander stamped txs.
      const seedTx = serving.edit();
      const inputsCell = serving.getCell<{ query: string }>(
        homeSpace,
        "x-space-wish-inputs",
        undefined,
        seedTx,
      );
      inputsCell.set({ query: "#profile" });
      const parentCell = serving.getCell<Record<string, unknown>>(
        homeSpace,
        "x-space-wish-parent",
        undefined,
        seedTx,
      );
      const causeCell = serving.getCell<Record<string, unknown>>(
        homeSpace,
        "x-space-wish-cause",
        undefined,
        seedTx,
      );
      const seedCommitted = await seedTx.commit();
      expect(seedCommitted.error).toBeUndefined();

      const sent: {
        user: string;
        tx: IExtendedStorageTransaction;
        state: Cell<unknown>;
      }[] = [];
      const action = wishBuiltin(
        inputsCell as never,
        (tx, result) => {
          sent.push({
            user: "pending",
            tx,
            state: result as Cell<unknown>,
          });
        },
        (cancel) => cancels.push(cancel),
        [causeCell as never],
        parentCell as never,
        serving,
      );

      const runAs = async (
        principal: string,
        sessionId: string,
        actionId: string,
      ): Promise<Cell<unknown>> => {
        const tx = serving.edit();
        stampWaveRunContext(tx, {
          actionId,
          kind: "derivation",
          scopeKeyIdentity: { principal, sessionId },
          acting: { user: principal, session: sessionId },
        });
        sent.length = 0;
        action.action(tx);
        expect(sent.length).toBe(1);
        const state = sent[0].state;
        const sidecar = state.key(UI as never).key("props").key("$cell")
          .resolveAsCell();
        const committed = await tx.commit();
        expect(committed.error).toBeUndefined();
        return sidecar;
      };

      // Alice's instance runs first (fetch pending), then bob's.
      const aliceSidecar = await runAs(aliceDid, "sess-a", "wish/x-a");
      const bobSidecar = await runAs(bobDid, "sess-b", "wish/x-b");

      // Demander #2 must get their OWN create surface, not demander
      // #1's cell (pre-fix: the closure cache short-circuited on the
      // first demander's cell — bob typed into alice's surface).
      expect(bobSidecar.sourceURI).not.toBe(aliceSidecar.sourceURI);

      // Release the pattern fetch: each pending launch must run ITS OWN
      // demander's input into ITS OWN cell (pre-fix: the shared input
      // holder was clobbered with bob's home link, and alice's pending
      // launch ran bob's input into alice's cell).
      gate.resolve();
      // The landed echo resolves through the run's input `profiles`
      // link into the DEMANDER's home space; before the run lands the
      // key is unset and resolves within the served space.
      const echoSpaceOf = (sidecar: Cell<unknown>): string | undefined => {
        try {
          const echo = (sidecar as Cell<Record<string, unknown>>)
            .key("echo").resolveAsCell();
          const link = echo.getAsNormalizedFullLink();
          return link.space === homeSpace ? undefined : link.space;
        } catch {
          return undefined;
        }
      };
      await awaitAdmitted(
        server,
        () =>
          echoSpaceOf(aliceSidecar) !== undefined &&
          echoSpaceOf(bobSidecar) !== undefined,
      );
      expect(echoSpaceOf(aliceSidecar)).toBe(aliceDid);
      expect(echoSpaceOf(bobSidecar)).toBe(bobDid);
    } finally {
      gate.resolve();
      globalThis.fetch = originalFetch;
      for (const cancel of cancels) cancel();
      await serving.idle();
      await serving.dispose();
      await manager.close();
    }
  });

  it("a wish sidecar's OWN actions are demanded through the wish's OWNING piece root (fan-out stage B, design §B4 / the panel's Lens 5): the served per-user wish child runs as the outer root's demanders, never as the service identity", async () => {
    // The sidecar demand-root chain (`builtins/wish.ts` `sidecarRunOptions`
    // → `RunnerRunOptions.parentPieceRootId`, the map/filter/flatMap
    // shape): a sidecar piece is instantiated by the wish's run with its
    // OWN result doc as piece root, which no client watches — chained to
    // the wish's owning piece, its actions are demanded through the OUTER
    // root and run as that root's demanders. Cut the chain (mutation
    // MWISH: `sidecarRunOptions = {}`) and the sidecar's actions resolve
    // NO demanders and fall to the wave-level (service) identity — the
    // scoped state of a served `#profile` create surface keyed under the
    // service, unread by anyone.
    //
    // Harness: the F2 test's direct drive above (a serving runtime, the
    // wish node run per demander with stamped txs) plus the run-supply
    // seam `executor-run-supply.test.ts` pins the nested / list-builtin
    // chains with — a pass-through seal destination whose stamper records
    // every scheduler run's demanded identity and whose demander resolver
    // knows ONLY the outer (wish parent) root. Real clock: the sidecar's
    // fetch → compile → run continuation must actually land. Derivations
    // are pull-based (serving-loop.md §1: the sink is the demand), so the
    // test PULLS each sidecar's result — the client's read-through of the
    // served surface — to run them.
    //
    // NOT pinned (flagged in the register, OW29's row): whether a
    // per-demander sidecar's instance SET is exactly its own demander or
    // every demander of the outer root — the assertions hold under either.
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
      servingHomeSpace: homeSpace,
    });
    const serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });

    // Both users' home spaces: a defaultPattern link with no profiles, so
    // a #profile wish falls to the create surface (the sidecar).
    const seedHome = async (signer: Identity) => {
      const did = signer.did() as MemorySpace;
      const m = SharedServerStorageManager.connectTo(server, { as: signer });
      const r = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: m,
      });
      const tx = r.edit();
      const homeCell = r.getCell(did, did, spaceCellSchema, tx);
      const defaultCell = r.getCell(
        did,
        "x-space-chain-home-default",
        undefined,
        tx,
      );
      defaultCell.set({ profiles: [] });
      (homeCell as Cell<Record<string, unknown>>).key("defaultPattern").set(
        defaultCell as never,
      );
      const committed = await tx.commit();
      expect(committed.error).toBeUndefined();
      await r.storageManager.synced();
      await r.dispose();
      await m.close();
      return did;
    };
    const aliceDid = await seedHome(aliceSigner);
    const bobDid = await seedHome(bobSigner);
    const alice = { principal: aliceDid, sessionId: "sess-a" as never };
    const bob = { principal: bobDid, sessionId: "sess-b" as never };

    // The sidecar SOURCE: a derivation that reads a per-user slot of the
    // sidecar's own argument (the ordinary PerUser shape — reading it is
    // what narrows the node to user scope, D11: learned by running).
    const sidecarSource = [
      "import { computed, pattern, PerUser, Writable } from 'commonfabric';",
      "type Mine = Writable<number | undefined>;",
      "export default pattern<{ profiles: unknown; mine?: PerUser<Mine> }, { echo: unknown; probe: number }>(",
      "  ({ profiles, mine }) => ({ echo: profiles, probe: computed(() => 1 + ((mine!.get() as number | undefined) ?? 0)) }),",
      ");",
    ].join("\n");
    const sidecarIdentity = await resolveEntryIdentity(
      SIDECAR_ROUTE,
      () => Promise.resolve(sidecarSource),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: Request | URL | string) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === SIDECAR_ROUTE) {
        return Promise.resolve(
          new Response(
            url.searchParams.has("identity") ? sidecarIdentity : sidecarSource,
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as typeof fetch;

    const cancels: (() => void)[] = [];
    try {
      for (const did of [aliceDid, bobDid]) {
        const home = serving.getCell(did, did, spaceCellSchema);
        await home.sync();
        await (home as Cell<Record<string, unknown>>).key("defaultPattern")
          .resolveAsCell().sync();
      }

      const seedTx = serving.edit();
      const inputsCell = serving.getCell<{ query: string }>(
        homeSpace,
        "x-space-chain-wish-inputs",
        undefined,
        seedTx,
      );
      inputsCell.set({ query: "#profile" });
      // The wish's OWNING piece root — what a client watches, and the
      // root `sidecarRunOptions` chains the sidecar to.
      const parentCell = serving.getCell<Record<string, unknown>>(
        homeSpace,
        "x-space-chain-wish-parent",
        undefined,
        seedTx,
      );
      const parentRootId = parentCell.getAsNormalizedFullLink().id;
      const causeCell = serving.getCell<Record<string, unknown>>(
        homeSpace,
        "x-space-chain-wish-cause",
        undefined,
        seedTx,
      );
      const seedCommitted = await seedTx.commit();
      expect(seedCommitted.error).toBeUndefined();

      // The run-supply seam: every scheduler run's stamp (its demanded
      // identity; undefined = the wave-level service fallback) and every
      // demander query. The registry knows ONLY the outer root.
      const stamped: ServerRunInfo[] = [];
      const resolverQueries: string[][] = [];
      serving.installSealDestination(
        { seal: (tx: IExtendedStorageTransaction) => tx.tx.commit() },
        {
          runStamper: (tx, info) => {
            stamped.push(info);
            stampWaveRunContext(tx, {
              actionId: info.actionId,
              kind: info.kind,
              ...(info.scopeKeyIdentity !== undefined
                ? { scopeKeyIdentity: info.scopeKeyIdentity }
                : {}),
              ...(info.actionScopeKey !== undefined
                ? { actionScopeKey: info.actionScopeKey }
                : {}),
            });
          },
          runDemanderResolver: (pieceRootIds) => {
            resolverQueries.push([...pieceRootIds]);
            return pieceRootIds.includes(parentRootId) ? [alice, bob] : [];
          },
        },
      );

      const sent: { tx: IExtendedStorageTransaction; state: Cell<unknown> }[] =
        [];
      const action = wishBuiltin(
        inputsCell as never,
        (tx, result) => {
          sent.push({ tx, state: result as Cell<unknown> });
        },
        (cancel) => cancels.push(cancel),
        [causeCell as never],
        parentCell as never,
        serving,
      );
      const runAs = async (
        principal: string,
        sessionId: string,
        actionId: string,
      ): Promise<Cell<unknown>> => {
        const tx = serving.edit();
        stampWaveRunContext(tx, {
          actionId,
          kind: "derivation",
          scopeKeyIdentity: { principal, sessionId },
          acting: { user: principal, session: sessionId },
        });
        sent.length = 0;
        action.action(tx);
        expect(sent.length).toBe(1);
        const sidecar = sent[0].state.key(UI as never).key("props").key("$cell")
          .resolveAsCell();
        const committed = await tx.commit();
        expect(committed.error).toBeUndefined();
        return sidecar;
      };
      // Each demander's wish run launches THAT demander's create surface
      // (the F2 slots): two sidecar pieces, each chained to the outer root.
      const aliceSidecar = await runAs(aliceDid, "sess-a", "wish/x-chain-a");
      const bobSidecar = await runAs(bobDid, "sess-b", "wish/x-chain-b");

      // The sidecar's derivation (`computed` lifts to a `__cfLift_*`
      // derivation) — the runs the stamper saw, with each run's demanded
      // principal.
      const sidecarDerivations = () =>
        stamped.filter((info) =>
          info.kind === "derivation" &&
          (info.actionId.includes("__cfLift") ||
            info.actionId.includes("computed"))
        );
      const sidecarPrincipals = () =>
        sidecarDerivations().map((info) => info.scopeKeyIdentity?.principal);
      // Both sidecar pieces instantiated (the fetch → compile → run
      // continuation landed): the piece's setup-time `echo` link resolves
      // through the run's input `profiles` into the DEMANDER's home space;
      // before the run lands the key is unset and resolves within the
      // served space (the F2 test's idiom).
      const landed = (sidecar: Cell<unknown>): boolean => {
        try {
          const echo = (sidecar as Cell<Record<string, unknown>>)
            .key("echo").resolveAsCell();
          return echo.getAsNormalizedFullLink().space !== homeSpace;
        } catch {
          return false;
        }
      };
      await awaitAdmitted(
        server,
        () => landed(aliceSidecar) && landed(bobSidecar),
      );
      // The DEMAND (serving-loop.md §1's pull-based laziness): the
      // client's read-through of each served surface. The pull runs the
      // sidecar's derivation through the scheduler — the run supply
      // resolves its instances from the demand roots.
      await Promise.all([aliceSidecar.pull(), bobSidecar.pull()]);
      await awaitAdmitted(server, () => {
        const principals = new Set(sidecarPrincipals());
        return sidecarDerivations().length >= 2 &&
          (principals.has(undefined) ||
            (principals.has(aliceDid) && principals.has(bobDid)));
      });
      await serving.idle();
      const runs = sidecarDerivations();
      const principals = sidecarPrincipals();

      // 1. The chain: the sidecar's actions were resolved THROUGH the
      //    outer root — a demander query carrying the wish parent's root
      //    beside another (the sidecar's own) root. Chain cut → every
      //    query is the sidecar's own root alone.
      expect(
        resolverQueries.some((ids) =>
          ids.includes(parentRootId) && ids.length > 1
        ),
      ).toBe(true);
      // 2. Never the service identity: every sidecar derivation run is
      //    stamped with a demanded identity of the outer root. Chain cut
      //    → no demanders → the stamps carry no identity (the fallback).
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(principals.every((p) => p !== undefined)).toBe(true);
      expect(
        principals.every((p) => p === aliceDid || p === bobDid),
      ).toBe(true);
      // 3. Per demander: both demanding principals of the outer root ran
      //    the per-user wish child (the union across the sidecar pieces —
      //    true whether a per-demander sidecar's instance set is its own
      //    demander only or every demander of the outer root).
      expect(principals).toContain(aliceDid);
      expect(principals).toContain(bobDid);
    } finally {
      globalThis.fetch = originalFetch;
      for (const cancel of cancels) cancel();
      await serving.idle();
      serving.clearSealDestination();
      await serving.dispose();
      await manager.close();
    }
  });

  it("a serving manager's FOREIGN provider refuses scoped reads fail-closed (protocol.md §2's grant-scoped read design)", async () => {
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
      servingHomeSpace: homeSpace,
    });
    try {
      // Scoped read of a FOREIGN space: refused at the producer, before
      // any wire frame — the unnamed scoped root would resolve against
      // the delegating service envelope (a silently empty instance).
      const foreignScoped = await manager.open(foreignSpace).sync(
        "of:x-scoped" as never,
        { path: [], schema: false },
        "user",
      );
      expect(foreignScoped.error?.message ?? "").toContain(
        "foreign scoped read refused on the serving path",
      );

      // Space-scope foreign reads stay free (§2b's free-read row).
      const foreignSpaceScope = await manager.open(foreignSpace).sync(
        "of:x-plain" as never,
        { path: [], schema: false },
      );
      expect(foreignSpaceScope.error).toBeUndefined();

      // The F3 fix — refusal is ENTRY-scoped, decided at sync() entry
      // before the batch: a scoped read and an innocent SPACE-scope
      // read issued concurrently coalesce into ONE watch-refresh batch
      // with one shared pending promise, and pre-fix the scoped
      // refusal threw over the whole batch — the load-bearing §2b
      // free-read row failed alongside the offender (a persistently
      // retrying scoped reader degraded a space's legitimate foreign
      // reads into flake).
      const provider = manager.open(foreignSpace);
      const [poisoner, innocent] = await Promise.all([
        provider.sync(
          "of:x-batch-scoped" as never,
          { path: [], schema: false },
          "user",
        ),
        provider.sync(
          "of:x-batch-plain" as never,
          { path: [], schema: false },
        ),
      ]);
      expect(poisoner.error?.message ?? "").toContain(
        "foreign scoped read refused on the serving path",
      );
      expect(innocent.error).toBeUndefined();

      // HOME scoped reads keep today's behavior (the OW17 tolerated
      // collapsed view).
      const homeScoped = await manager.open(homeSpace).sync(
        "of:x-home-scoped" as never,
        { path: [], schema: false },
        "user",
      );
      expect(homeScoped.error).toBeUndefined();

      // A NON-serving manager (no servingHomeSpace) is untouched.
      const plain = SharedServerStorageManager.connectTo(server, {
        as: aliceSigner,
      });
      try {
        const clientScoped = await plain.open(foreignSpace).sync(
          "of:x-scoped" as never,
          { path: [], schema: false },
          "user",
        );
        expect(clientScoped.error).toBeUndefined();
      } finally {
        await plain.close();
      }
    } finally {
      await manager.close();
    }
  });
});
