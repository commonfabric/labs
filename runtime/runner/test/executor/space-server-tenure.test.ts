import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import * as Engine from "@commonfabric/memory/v2/engine";
import { executionLeaseHolder } from "@commonfabric/memory/v2/execution-lease";
import { insertExecutionOutboxRows } from "@commonfabric/memory/v2/execution-outbox";
import { replaceSchedulerBasisRows } from "@commonfabric/memory/v2/scheduler-basis";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EngineWaveCommitSink } from "../../src/executor/engine-wave-sink.ts";
import {
  awaitDisposeTimeboxed,
  demandersOfRoots,
  SpaceServer,
  type WaveCommitSinkDeps,
} from "../../src/executor/space-server.ts";
import {
  stampWaveRunContext,
  waveRunContextOf,
} from "../../src/executor/wave.ts";
import {
  emptyServingLoopStats,
  type ServingLoopStats,
  SETTLE_SERIES_MAX,
} from "../../src/executor/stats.ts";
import { Runtime, type ServerRunInfo } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { PieceStateMovedError } from "../../src/stored-setup-build.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { ArrivalLog, awaitEach } from "../support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("space-server activation");
const serviceSigner = await Identity.fromPassphrase(
  "space-server activation service",
);
const space = spaceSigner.did() as MemorySpace;
const foreignSigner = await Identity.fromPassphrase(
  "space-server activation foreign",
);
const foreignSpace = foreignSigner.did() as MemorySpace;

const logger = getLogger("space-server");

/** How many times `key` has been logged as a warning so far. */
const warned = (key: string): number => logger.countsByKey[key]?.warn ?? 0;

describe("space-server", () => {
  describe("awaitDisposeTimeboxed()", () => {
    const timeboxed = (pending: Promise<void>, stats: ServingLoopStats) =>
      awaitDisposeTimeboxed(pending, {
        policy: {
          flushDeadlineMs: 2_000,
          idleParkMs: 600_000,
          parkDisposeTimeoutMs: 10,
        },
        stats,
        space,
        overrun: (timeoutMs) => `overran ${timeoutMs}ms`,
      });

    it("returns at the timeout, and reports a dispose that later completes as late", async () => {
      const stats = emptyServingLoopStats();
      const dispose = Promise.withResolvers<void>();
      const late = warned("park-dispose-late");
      const lateFailed = warned("park-dispose-late-failed");

      await timeboxed(dispose.promise, stats);
      expect(stats.parkDisposeTimeouts).toBe(1);
      expect(warned("park-dispose-late")).toBe(late);

      dispose.resolve();
      await dispose.promise;
      expect(warned("park-dispose-late")).toBe(late + 1);
      expect(warned("park-dispose-late-failed")).toBe(lateFailed);
    });

    it("returns at the timeout, and reports a dispose that later fails as a late failure", async () => {
      const stats = emptyServingLoopStats();
      const dispose = Promise.withResolvers<void>();
      const late = warned("park-dispose-late");
      const lateFailed = warned("park-dispose-late-failed");

      await timeboxed(dispose.promise, stats);
      expect(stats.parkDisposeTimeouts).toBe(1);
      expect(warned("park-dispose-late-failed")).toBe(lateFailed);

      dispose.reject(new Error("dispose failed late"));
      await dispose.promise.catch(() => {});
      expect(warned("park-dispose-late-failed")).toBe(lateFailed + 1);
      expect(warned("park-dispose-late")).toBe(late);
    });
  });

  describe("demandersOfRoots()", () => {
    const alice = { principal: "did:key:alice" };
    const aliceSession = {
      principal: "did:key:alice",
      sessionId: "session-1",
    };
    const bob = { principal: "did:key:bob" };
    const byRootId = new Map([
      ["of:piece", new Set(["space\0of:piece", "user\0of:piece"])],
    ]);
    const byResolvedRoot = new Map([
      ["of:piece", new Set(["space\0of:argument", "space\0of:retired"])],
    ]);
    const demandersByKey = new Map([
      ["space\0of:piece", new Map([["did:key:alice\0", alice]])],
      [
        "user\0of:piece",
        new Map([["did:key:alice\0", alice], [
          "did:key:alice\0session-1",
          aliceSession,
        ]]),
      ],
      ["space\0of:argument", new Map([["did:key:bob\0", bob]])],
    ]);

    it("returns each pair demanding a root by its own id or a resolved one once, skipping a key with no pairs left", () => {
      expect(
        demandersOfRoots(
          ["of:piece"],
          [byRootId, byResolvedRoot],
          demandersByKey,
          [],
        ),
      ).toEqual([alice, aliceSession, bob]);
    });

    it("returns nothing for a root no index files a key under", () => {
      expect(
        demandersOfRoots(
          ["of:other"],
          [byRootId, byResolvedRoot],
          demandersByKey,
          [],
        ),
      ).toEqual([]);
    });

    it("adds the transient demanders after the recorded ones, each pair once", () => {
      const carol = { principal: "did:key:carol" };
      expect(
        demandersOfRoots(
          ["of:piece"],
          [byRootId],
          demandersByKey,
          [alice, carol, carol],
        ),
      ).toEqual([alice, aliceSession, carol]);
    });
  });

  describe("SpaceServer", () => {
    let server: MemoryV2Server.Server;
    let engine: Engine.Engine;
    let stats: ServingLoopStats;
    let runtimes: Runtime[];
    let serving: SpaceServer | undefined;
    /** Every wave cycle a server built with `onWaveCycle: cycles.record`
     * completes. */
    let cycles: ArrivalLog<void>;

    beforeEach(async () => {
      server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
      engine = await server.engineForSpace(space);
      stats = emptyServingLoopStats();
      runtimes = [];
      serving = undefined;
      cycles = new ArrivalLog();
    });

    afterEach(async () => {
      try {
        await serving?.park("test-teardown");
      } finally {
        await server.close();
      }
    });

    const newSpaceServer = (
      options: {
        policy?: ConstructorParameters<typeof SpaceServer>[0]["policy"];
        serverFacade?: MemoryV2Server.Server;
        onWaveCycle?: () => void;
        createWaveCommitSink?: ConstructorParameters<
          typeof SpaceServer
        >[0]["createWaveCommitSink"];
      } = {},
    ): SpaceServer => {
      serving = new SpaceServer({
        space,
        server: options.serverFacade ?? server,
        engine,
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
          runtimes.push(runtime);
          return Promise.resolve({
            runtime,
            dispose: async () => {
              await runtime.dispose();
              await manager.close();
            },
          });
        },
        localSeqRef: { value: 0 },
        stats,
        onWaveCycle: options.onWaveCycle,
        createWaveCommitSink: options.createWaveCommitSink,
        policy: options.policy ??
          { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
      });
      return serving;
    };

    describe("activate()", () => {
      it("builds one runtime for calls made while the first is in flight and after it", async () => {
        const activated = newSpaceServer();
        expect(
          await Promise.all([activated.activate(), activated.activate()]),
        ).toEqual([true, true]);
        expect(await activated.activate()).toBe(true);

        expect(runtimes.length).toBe(1);
        expect(stats.lease.held).toBe(1);
        expect(stats.activeSpaces).toBe(1);
        expect(activated.active).toBe(true);
      });

      it("does not serve again once parked", async () => {
        const parked = newSpaceServer();
        expect(await parked.activate()).toBe(true);
        await parked.park("test-park");

        expect(await parked.activate()).toBe(true);
        expect(parked.active).toBe(false);
        expect(runtimes.length).toBe(1);
        expect(stats.lease.held).toBe(1);
        expect(engine.executionLeases.holderOf(space)).toBeUndefined();
      });

      it("answers `false` again after a refusal, without taking the lease once it is free", async () => {
        const rival = executionLeaseHolder("did:key:space-server-rival");
        expect(engine.executionLeases.acquire(space, rival)).toBe(true);
        const refused = newSpaceServer();
        expect(await refused.activate()).toBe(false);

        engine.executionLeases.release(space, rival);
        expect(await refused.activate()).toBe(false);
        expect(refused.active).toBe(false);
        expect(runtimes.length).toBe(0);
        expect(engine.executionLeases.holderOf(space)).toBeUndefined();
      });

      it("activates, and logs the failure, when the outbox it re-sends from cannot be read", async () => {
        insertExecutionOutboxRows(engine, {
          branch: "",
          createdSeq: 1,
          rows: [{
            targetSpace: foreignSpace,
            targetStream: "of:unreadable-stream",
            targetStreamLink: { id: "of:unreadable-stream", path: [] },
            eventId: "event-unreadable",
            payload: { n: 1 },
            capabilityRef: "capability",
          }],
        });
        engine.database.prepare(
          "UPDATE execution_outbox SET target_stream_link = 'not json'",
        ).run();
        const failed = warned("activation-resend-failed");

        expect(await newSpaceServer().activate()).toBe(true);
        expect(stats.activeSpaces).toBe(1);
        expect(warned("activation-resend-failed")).toBe(failed + 1);
        // The unreadable row stays for a later drain.
        expect(
          engine.database.prepare(
            "SELECT count(*) AS n FROM execution_outbox",
          ).get(),
        ).toEqual({ n: 1 });
      });

      describe("over a basis that recorded a read of another space", () => {
        beforeEach(async () => {
          // The read is behind the document's head in the other space.
          const written = await server.writeDocument(
            foreignSpace,
            "of:foreign-input",
            { n: 1 },
          );
          replaceSchedulerBasisRows(engine, {
            branch: "",
            action: "action-reading-foreign",
            actionScopeKey: "space",
            rows: [{
              entitySpace: foreignSpace,
              entity: "of:foreign-input",
              entityScopeKey: "space",
              seq: written.seq - 1,
            }],
          });
        });

        it("judges the read against the other space's engine", async () => {
          const engineRequests: string[] = [];
          const facade = new Proxy(server, {
            get(target, property) {
              if (property === "engineForSpace") {
                return (requested: MemorySpace) => {
                  engineRequests.push(requested);
                  return target.engineForSpace(requested);
                };
              }
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          const failed = warned("basis-foreign-remark-failed");

          expect(await newSpaceServer({ serverFacade: facade }).activate())
            .toBe(true);
          expect(engineRequests).toContain(foreignSpace);
          expect(warned("basis-foreign-remark-failed")).toBe(failed);
        });

        it("activates, and logs the failure, when the other space's engine cannot be opened", async () => {
          const facade = new Proxy(server, {
            get(target, property) {
              if (property === "engineForSpace") {
                return (requested: MemorySpace) =>
                  requested === foreignSpace
                    ? Promise.reject(new Error("foreign engine unavailable"))
                    : target.engineForSpace(requested);
              }
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          const failed = warned("basis-foreign-remark-failed");

          expect(await newSpaceServer({ serverFacade: facade }).activate())
            .toBe(true);
          expect(stats.activeSpaces).toBe(1);
          expect(warned("basis-foreign-remark-failed")).toBe(
            failed + 1,
          );
        });
      });
    });

    describe("enqueueCommit()", () => {
      const authored = (seq: number) => ({
        space,
        seq,
        class: "authored" as const,
        sessionId: "session:settle",
        writes: [],
      });

      it("counts a late notice again once 1024 later ones have pushed it out of the window that deduplicates it", async () => {
        const active = newSpaceServer({ onWaveCycle: cycles.record });
        expect(await active.activate()).toBe(true);
        const notices = [];
        for (let index = 0; index < 1026; index++) {
          const id = `of:late-window-${index}`;
          const { seq } = await server.writeDocument(space, id, { index });
          notices.push({
            ...authored(seq),
            writes: [{ id, scopeKey: "space" as const }],
          });
        }
        const before = stats.authoredSeen;
        for (const notice of notices) active.enqueueCommit(notice);
        await awaitEach(cycles, () => stats.authoredSeen >= before + 1026);
        expect(stats.authoredSeen).toBe(before + 1026);

        // Both are late: the third is the oldest the window holds, and the
        // second the newest it has let go.
        active.enqueueCommit(notices[2]);
        active.enqueueCommit(notices[1]);
        await awaitEach(cycles, () => stats.authoredSeen >= before + 1027);
        await cycles.reached(cycles.entries.length + 1);
        expect(stats.authoredSeen).toBe(before + 1027);
      });

      it("tracks at most 4096 uncovered authored inputs, dropping the oldest past that", async () => {
        const active = newSpaceServer();
        expect(await active.activate()).toBe(true);
        const head = Engine.serverSeq(engine);

        for (let index = 1; index <= 4096; index++) {
          active.enqueueCommit(authored(head + index));
        }
        expect(stats.settle.dropped).toBe(0);

        active.enqueueCommit(authored(head + 4097));
        expect(stats.settle.dropped).toBe(1);
      });
    });

    describe("the settle series", () => {
      it("keeps the newest SETTLE_SERIES_MAX samples, dropping the oldest", async () => {
        const filler = (seq: number) => ({
          space,
          seq,
          admittedAt: 0,
          coveredAt: 0,
          ms: 0,
          waves: 0,
          cycles: 0,
          growthWakes: 0,
          class: "value-only" as const,
          eventAppend: false,
        });
        for (let index = 0; index < SETTLE_SERIES_MAX; index++) {
          stats.settle.series.push(filler(-index - 1));
        }
        const active = newSpaceServer({ onWaveCycle: cycles.record });
        expect(await active.activate()).toBe(true);
        const written = await server.writeDocument(space, "of:settle-input", {
          n: 1,
        });

        active.enqueueCommit({
          space,
          seq: written.seq,
          class: "authored",
          sessionId: "session:settle",
          writes: [{ id: "of:settle-input", scopeKey: "space" }],
        });
        await awaitEach(cycles, () => stats.settle.dropped > 0);

        expect(stats.settle.dropped).toBe(1);
        expect(stats.settle.series.length).toBe(SETTLE_SERIES_MAX);
        expect(stats.settle.series[0].seq).toBe(-2);
        expect(stats.settle.series.at(-1)?.seq).toBe(written.seq);
      });
    });

    describe("the wave commit sink's dependencies", () => {
      it("refuse an engine for a foreign space no wave has resolved", async () => {
        let deps: WaveCommitSinkDeps | undefined;
        const active = newSpaceServer({
          createWaveCommitSink: (given) => {
            deps = given;
            return new EngineWaveCommitSink({
              engineFor: (s) =>
                s === given.space ? given.engine : given.foreignEngineFor(s),
              sessionId: given.sessionId,
              localSeqRef: given.localSeqRef,
            });
          },
        });
        expect(await active.activate()).toBe(true);

        expect(deps?.engine).toBe(engine);
        expect(() => deps!.foreignEngineFor(foreignSpace)).toThrow(
          `no resolved co-hosted engine for foreign space ${foreignSpace}`,
        );
      });
    });

    describe("whenQuiescent()", () => {
      it("resolves at once on a server that has never been activated", async () => {
        const idle = newSpaceServer();
        await idle.whenQuiescent();
        expect(idle.active).toBe(false);
        expect(idle.quiescent).toBe(false);
        expect(runtimes.length).toBe(0);
      });
    });

    describe("deferSealedEffects()", () => {
      it("declines the effects of a transaction that sealed into no wave, and takes those of one that did", async () => {
        const active = newSpaceServer();
        expect(await active.activate()).toBe(true);
        const runtime = runtimes[0];

        expect(active.deferSealedEffects(runtime.edit(), [])).toBe(false);

        const probe = runtime.getCell<number>(space, "sealed-probe", undefined);
        await probe.sync();
        const tx = runtime.edit();
        stampWaveRunContext(tx, {
          actionId: "test/sealed-probe",
          kind: "derivation",
        });
        probe.withTx(tx).set(1);
        expect((await tx.commit().settled).error).toBeUndefined();
        expect(active.deferSealedEffects(tx, [])).toBe(true);
      });
    });

    describe("the wave a seal opens", () => {
      it("refuses and counts a write that declares no run context, and accepts one that does", async () => {
        const active = newSpaceServer();
        expect(await active.activate()).toBe(true);
        const runtime = runtimes[0];
        const probe = runtime.getCell<number>(
          space,
          "unstamped-probe",
          undefined,
        );
        await probe.sync();

        const unstamped = runtime.edit();
        probe.withTx(unstamped).set(1);
        await expect(unstamped.commit().settled).rejects.toThrow(
          "unstamped transaction sealed into a wave",
        );
        expect(stats.unstampedSealRefusals).toBe(1);

        const stamped = runtime.edit();
        stampWaveRunContext(stamped, {
          actionId: "test/unstamped-probe",
          kind: "derivation",
        });
        probe.withTx(stamped).set(2);
        expect((await stamped.commit().settled).error).toBeUndefined();
        expect(stats.unstampedSealRefusals).toBe(1);
      });
    });

    describe("the own derived commits it records", () => {
      it("holds the newest 4096, dropping the oldest past that", () => {
        const { accessForTestingOnly } = newSpaceServer();

        for (let seq = 1; seq <= 4096; seq++) {
          accessForTestingOnly.recordOwnDerivedCommit(seq, false);
        }
        expect(accessForTestingOnly.ownDerivedSeqs.size).toBe(4096);
        expect(accessForTestingOnly.ownDerivedSeqs.has(1)).toBe(true);

        accessForTestingOnly.recordOwnDerivedCommit(4097, false);
        expect(accessForTestingOnly.ownDerivedSeqs.size).toBe(4096);
        expect(accessForTestingOnly.ownDerivedSeqs.has(1)).toBe(false);
        expect(accessForTestingOnly.ownDerivedSeqs.has(2)).toBe(true);
        expect(accessForTestingOnly.ownDerivedSeqs.has(4097)).toBe(true);
      });
    });

    describe("the run stamper it installs", () => {
      const capabilityRefOf = (info: ServerRunInfo): string | undefined => {
        const tx = runtimes[0].edit();
        runtimes[0].stampServerRun(tx, info);
        return waveRunContextOf(tx)?.capabilityRef;
      };
      const alice = { user: "did:key:alice" };

      it("carries an acting event handler's consequence grant, named by its event", async () => {
        expect(await newSpaceServer().activate()).toBe(true);
        expect(
          capabilityRefOf({
            actionId: "handler",
            kind: "event-handler",
            eventId: "event-1",
            acting: alice,
          }),
        ).toBe("event-consequence:event-1");
        expect(
          capabilityRefOf({
            actionId: "handler",
            kind: "event-handler",
            acting: alice,
          }),
        ).toBe("event-consequence:unidentified");
      });

      it("carries an acting derivation's demanded-run grant, named by its actor", async () => {
        expect(await newSpaceServer().activate()).toBe(true);
        expect(
          capabilityRefOf({
            actionId: "derivation",
            kind: "derivation",
            acting: alice,
          }),
        ).toBe("demanded-run:did:key:alice");
      });

      it("carries no grant for a run with no actor, or for bookkeeping", async () => {
        expect(await newSpaceServer().activate()).toBe(true);
        expect(
          capabilityRefOf({
            actionId: "handler",
            kind: "event-handler",
            eventId: "event-1",
          }),
        ).toBeUndefined();
        expect(
          capabilityRefOf({
            actionId: "bookkeeping",
            kind: "bookkeeping",
            acting: alice,
          }),
        ).toBeUndefined();
      });
    });

    describe("the serving runtime's piece-start failure observer", () => {
      it("counts a start refused for a piece whose state moved as refused, and logs nothing", async () => {
        await newSpaceServer().activate();
        const failed = warned("piece-start-commit-failed");

        runtimes[0].pieceStartCommitFailureObserver!({
          actionId: "start/of:moved-piece",
          error: new PieceStateMovedError(
            "of:moved-piece",
            { identity: "pattern-identity", symbol: "default" },
            [],
            [],
          ),
          refused: true,
        });

        expect(stats.structureLoadRefused).toBe(1);
        expect(stats.structureLoadFailures).toBe(0);
        expect(warned("piece-start-commit-failed")).toBe(failed);
      });

      it("counts any other failed start as a failure, and logs it", async () => {
        await newSpaceServer().activate();
        const failed = warned("piece-start-commit-failed");

        runtimes[0].pieceStartCommitFailureObserver!({
          actionId: "start/of:failed-piece",
          error: new Error("commit rejected"),
        });

        expect(stats.structureLoadFailures).toBe(1);
        expect(stats.structureLoadRefused).toBe(0);
        expect(warned("piece-start-commit-failed")).toBe(failed + 1);
      });
    });
  });
});
