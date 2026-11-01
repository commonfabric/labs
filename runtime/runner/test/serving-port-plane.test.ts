/**
 * The worker's end of the serving port: what it sends the server's thread on
 * the host's behalf, and in what order relative to the commits it sends.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  getLoggerCountsBreakdown,
  getTimingStatsBreakdown,
} from "@commonfabric/logger";
import type * as Engine from "@commonfabric/memory/v2/engine";

import {
  type BridgeNotices,
  type BridgeRequests,
  type PlaneNotices,
  type PlaneRequests,
  PortEndpoint,
} from "../src/executor/serving-port-protocol.ts";
import {
  ServingPlane,
  servingPlaneEndpoint,
} from "../src/executor/serving-port-plane.ts";
import { emptyServingLoopStats } from "../src/executor/stats.ts";
import type { WaveSpaceCommit } from "../src/executor/wave.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

const space = "did:key:z6MkservingPortPlaneTestSpace" as MemorySpace;

describe("serving-port-plane", () => {
  let channel: MessageChannel;
  let plane: ServingPlane;
  let bridge: PortEndpoint<
    BridgeRequests,
    BridgeNotices,
    PlaneRequests,
    PlaneNotices
  >;
  // What the server's thread received, in arrival order.
  let crossed: string[];

  beforeEach(() => {
    channel = new MessageChannel();
    plane = new ServingPlane(servingPlaneEndpoint(channel.port1));
    bridge = new PortEndpoint(channel.port2, (error) => {
      throw error;
    });
    crossed = [];
    bridge.onNotice("host.stats", ({ stats }) => {
      crossed.push(`host.stats appended=${stats.events.appended}`);
    });
    bridge.onRequest("sink.commitWave", () => {
      crossed.push("sink.commitWave");
      return { result: { ok: { seq: 1 } }, homeRefused: false };
    });
  });

  afterEach(async () => {
    await plane.close();
    bridge.close();
    channel.port1.close();
    channel.port2.close();
  });

  it("posts the host's counters ahead of each wave commit it sends", async () => {
    // A client that observes a wave's consequence reads the health route
    // next; the counters it finds there have to count that wave already.
    // Both cross the same port, so posting first is what orders them.

    const stats = emptyServingLoopStats();
    stats.events.appended = 3;
    plane.serve({
      stats: () => stats,
      diagnostics: () => ({
        loggerCounts: getLoggerCountsBreakdown(),
        timingStats: getTimingStatsBreakdown(),
      }),
      runLifecycleVerb: () => Promise.reject(new Error("no verbs here")),
      close: () => Promise.resolve(),
    });
    const sink = plane.createWaveCommitSink({
      space,
      engine: {} as Engine.Engine,
      foreignEngineFor: () => {
        throw new Error("no foreign engines here");
      },
      sessionId: "session",
      localSeqRef: { value: 0 },
      onHomeRefused: () => {},
    });

    const outcome = await sink.commitWave(
      { space, home: true } as unknown as WaveSpaceCommit,
    );

    expect(outcome).toEqual({ ok: { seq: 1 } });
    expect(crossed).toEqual(["host.stats appended=3", "sink.commitWave"]);
  });
});
