import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ServedAclChange } from "@commonfabric/memory/v2/server";
import type { RoutedScope } from "../../src/executor/routed-plane.ts";
import { routedWaveCommitSink } from "../../src/executor/routed-wave-sink.ts";
import {
  type ServedAclChangeData,
  servedAclChangeOf,
} from "../../src/executor/served-acl-change.ts";
import type {
  WaveCommitSink,
  WaveSpaceCommit,
} from "../../src/executor/wave.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";

const home = "did:key:z6MkRoutedSinkHome" as MemorySpace;
const foreign = "did:key:z6MkRoutedSinkForeign" as MemorySpace;
const actor = "did:key:z6MkRoutedSinkActor";
const doc = { id: "of:routed-sink-doc", scopeKey: "space" };

const aclChangeData = (space: MemorySpace): ServedAclChangeData => ({
  space,
  actingPrincipal: actor,
  capabilityRef: "event-consequence:event-1",
  sourceEvent: { space: home, sidecarId: "of:sidecar", eventId: "event-1" },
  changes: [{ principal: "did:key:z6MkReader", level: "READ", actor }],
});

const aclChange = (space: MemorySpace): ServedAclChange =>
  servedAclChangeOf(aclChangeData(space));

const batchInto = (space: MemorySpace): WaveSpaceCommit => ({
  space,
  home: space === home,
  basisSeq: 0,
  rebasedHeads: [],
  operations: [],
  preconditions: [],
  annotations: [],
  consequenceOf: [],
  basisInstances: [],
  holder: undefined,
});

/** An error as the routed plane hands back the owner's refusal. */
const servedRefusal = (code: string): Error =>
  Object.assign(new Error(`refused: ${code}`), {
    name: "ServedRequestRefusal",
    code,
  });

/** A route that fails with `failure` where given, recording what it sent. */
const recordingRoute = (failure?: unknown): {
  route: RoutedScope;
  commits: Array<{ space: MemorySpace; batch: WaveSpaceCommit }>;
  acls: Array<{ space: MemorySpace; change: ServedAclChangeData }>;
} => {
  const commits: Array<{ space: MemorySpace; batch: WaveSpaceCommit }> = [];
  const acls: Array<{ space: MemorySpace; change: ServedAclChangeData }> = [];
  const route: RoutedScope = {
    append: () => Promise.reject(new Error("no append is expected")),
    commit: (space, batch) => {
      commits.push({ space, batch });
      return failure === undefined
        ? Promise.resolve({ seq: 7 })
        : Promise.reject(failure);
    },
    acl: (space, change) => {
      acls.push({ space, change });
      return failure === undefined
        ? Promise.resolve({ seq: 8 })
        : Promise.reject(failure);
    },
    watchDocument: () => Promise.reject(new Error("no watch is expected")),
    dispose: () => {},
  };
  return { route, commits, acls };
};

/**
 * A sink whose every member answers with something recognizable and records
 * its call, with `commitSpaceAccessChange` only where `canCommitAcl`.
 */
const recordingInner = (canCommitAcl: boolean): {
  inner: WaveCommitSink;
  calls: string[];
} => {
  const calls: string[] = [];
  const inner: WaveCommitSink = {
    reportsCommits: true,
    currentHeads: () => {
      calls.push("currentHeads");
      return Promise.resolve(new Map([["head", 3]]));
    },
    concurrentWritePaths: () => {
      calls.push("concurrentWritePaths");
      return Promise.resolve([["value", "a"]]);
    },
    intrusionSince: (_space, _doc, sinceSeq, holder) => {
      calls.push(`intrusionSince ${sinceSeq} ${holder}`);
      return Promise.resolve(true);
    },
    staleReads: () => {
      calls.push("staleReads");
      return Promise.resolve([]);
    },
    sessionOverwritePathsSince: () => {
      calls.push("sessionOverwritePathsSince");
      return Promise.resolve([["value", "b"]]);
    },
    commitWave: (batch) => {
      calls.push(`commitWave ${batch.space}`);
      return Promise.resolve({ ok: { seq: 5 } });
    },
    ...(canCommitAcl
      ? {
        commitSpaceAccessChange: (change: ServedAclChange) => {
          calls.push(`commitSpaceAccessChange ${change.space}`);
          return Promise.resolve({ ok: { seq: 6 } });
        },
      }
      : {}),
  };
  return { inner, calls };
};

const emptyStats = () => ({
  routed: { appends: 0, batches: 0, aclChanges: 0 },
});

describe("routedWaveCommitSink()", () => {
  describe("reads", () => {
    it("forwards every read the inner sink makes to it, and offers none it lacks", async () => {
      const { inner, calls } = recordingInner(true);
      const sink = routedWaveCommitSink(
        inner,
        recordingRoute().route,
        home,
        emptyStats(),
      );
      expect(sink.reportsCommits).toBe(true);
      expect(await sink.currentHeads(foreign, [doc])).toEqual(
        new Map([["head", 3]]),
      );
      expect(await sink.concurrentWritePaths(foreign, doc, 1)).toEqual([
        ["value", "a"],
      ]);
      expect(await sink.intrusionSince?.(foreign, doc, 2, "holder")).toBe(true);
      expect(await sink.staleReads?.(foreign, [], "holder")).toEqual([]);
      expect(
        await sink.sessionOverwritePathsSince?.(foreign, doc, 1, {
          principal: actor,
          sessionId: "session",
        }),
      ).toEqual([["value", "b"]]);
      expect(calls).toEqual([
        "currentHeads",
        "concurrentWritePaths",
        "intrusionSince 2 holder",
        "staleReads",
        "sessionOverwritePathsSince",
      ]);

      const bare = routedWaveCommitSink(
        {
          currentHeads: inner.currentHeads,
          concurrentWritePaths: inner.concurrentWritePaths,
          commitWave: inner.commitWave,
        },
        recordingRoute().route,
        home,
        emptyStats(),
      );
      expect(bare.reportsCommits).toBeUndefined();
      expect(bare.intrusionSince).toBeUndefined();
      expect(bare.staleReads).toBeUndefined();
      expect(bare.sessionOverwritePathsSince).toBeUndefined();
    });
  });

  describe("commitWave", () => {
    it("commits a home batch through the inner sink and routes a foreign one to its owner, counting only the routed one", async () => {
      const { inner, calls } = recordingInner(true);
      const { route, commits } = recordingRoute();
      const stats = emptyStats();
      const sink = routedWaveCommitSink(inner, route, home, stats);

      expect(await sink.commitWave(batchInto(home))).toEqual({
        ok: { seq: 5 },
      });
      expect(calls).toEqual([`commitWave ${home}`]);
      expect(commits).toEqual([]);
      expect(stats.routed.batches).toBe(0);

      expect(await sink.commitWave(batchInto(foreign))).toEqual({
        ok: { seq: 7 },
      });
      expect(calls).toEqual([`commitWave ${home}`]);
      expect(commits).toEqual([{ space: foreign, batch: batchInto(foreign) }]);
      expect(stats.routed.batches).toBe(1);
    });

    it("returns a rejection naming the owner's failure for a foreign batch, counting nothing", async () => {
      const { inner } = recordingInner(true);
      const stats = emptyStats();
      const sink = routedWaveCommitSink(
        inner,
        recordingRoute(new Error("owner unreachable")).route,
        home,
        stats,
      );
      const result = await sink.commitWave(batchInto(foreign));
      expect(result.error?.name).toBe("WaveCommitRejected");
      expect(result.error?.message).toContain(
        `foreign wave batch into ${foreign} failed at its owner`,
      );
      expect(result.error?.message).toContain("owner unreachable");
      expect(stats.routed.batches).toBe(0);
    });
  });

  describe("commitSpaceAccessChange", () => {
    it("commits a change to the home's list through the inner sink, sending nothing to an owner", async () => {
      const { inner, calls } = recordingInner(true);
      const { route, acls } = recordingRoute();
      const stats = emptyStats();
      const sink = routedWaveCommitSink(inner, route, home, stats);
      expect(await sink.commitSpaceAccessChange?.(aclChange(home))).toEqual({
        ok: { seq: 6 },
      });
      expect(calls).toEqual([`commitSpaceAccessChange ${home}`]);
      expect(acls).toEqual([]);
      expect(stats.routed.aclChanges).toBe(0);
    });

    it("refuses a change to the home's list when the inner sink cannot commit one, sending nothing to an owner", async () => {
      const { inner, calls } = recordingInner(false);
      const { route, acls } = recordingRoute();
      const sink = routedWaveCommitSink(inner, route, home, emptyStats());
      const result = await sink.commitSpaceAccessChange?.(aclChange(home));
      expect(result?.error).toEqual({
        name: "AclDocumentWriteRefused",
        message: `access-list change to ${home} refused: ` +
          "this sink cannot commit one",
      });
      expect(calls).toEqual([]);
      expect(acls).toEqual([]);
    });

    it("routes a change to a foreign list to its owner as data, and counts it", async () => {
      const { inner, calls } = recordingInner(true);
      const { route, acls } = recordingRoute();
      const stats = emptyStats();
      const sink = routedWaveCommitSink(inner, route, home, stats);
      expect(await sink.commitSpaceAccessChange?.(aclChange(foreign))).toEqual(
        { ok: { seq: 8 } },
      );
      expect(calls).toEqual([]);
      expect(acls).toEqual([{
        space: foreign,
        change: aclChangeData(foreign),
      }]);
      expect(stats.routed.aclChanges).toBe(1);
    });

    it("returns the owner's refusal of a foreign change as the refusal a local admission returns, counting nothing", async () => {
      const { inner } = recordingInner(true);
      const stats = emptyStats();
      const sink = routedWaveCommitSink(
        inner,
        recordingRoute(servedRefusal("refused")).route,
        home,
        stats,
      );
      const result = await sink.commitSpaceAccessChange?.(aclChange(foreign));
      expect(result?.error?.name).toBe("AclDocumentWriteRefused");
      expect(result?.error?.message).toContain(
        `access-list change to ${foreign} failed at its owner`,
      );
      expect(result?.error?.message).toContain("refused: refused");
      expect(stats.routed.aclChanges).toBe(0);
    });

    it("returns any other failure of a foreign change as a rejected wave commit", async () => {
      for (
        const failure of [
          servedRefusal("served-unsupported"),
          new Error("owner unreachable"),
        ]
      ) {
        const { inner } = recordingInner(true);
        const stats = emptyStats();
        const sink = routedWaveCommitSink(
          inner,
          recordingRoute(failure).route,
          home,
          stats,
        );
        const result = await sink.commitSpaceAccessChange?.(
          aclChange(foreign),
        );
        expect(result?.error?.name).toBe("WaveCommitRejected");
        expect(result?.error?.message).toContain(failure.message);
        expect(stats.routed.aclChanges).toBe(0);
      }
    });
  });
});
