import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  acquireServerExecutionEnabler,
  type Operation,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import { ExecutionLeases } from "@commonfabric/memory/v2/execution-lease";

import {
  ServingPlane,
  servingPlaneEndpoint,
} from "../../src/executor/serving-port-plane.ts";
import {
  type BridgeNotices,
  type BridgeRequests,
  type PlaneNotices,
  type PlaneRequests,
  PortEndpoint,
} from "../../src/executor/serving-port-protocol.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";

const space = "did:key:z6MkServingPlaneSinkReads" as MemorySpace;
const id = "of:plane-sink-target";
const firing = { principal: "did:key:alice", sessionId: "alice-session" };

describe("serving-plane-sink", () => {
  let path: string;
  let engine: Engine.Engine;
  let channel: MessageChannel;
  let plane: ServingPlane;
  let localSeq = 0;

  const commit = (
    operations: Operation[],
    by: { principal: string; sessionId: string },
  ): number =>
    Engine.applyCommit(engine, {
      ...by,
      space,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations,
      },
    }).seq;

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await Engine.open({ url: toFileUrl(path) });
    channel = new MessageChannel();
    plane = new ServingPlane(servingPlaneEndpoint(channel.port1));
    localSeq = 0;
  });

  afterEach(async () => {
    await plane.close();
    channel.port2.close();
    Engine.close(engine);
    await Deno.remove(path);
  });

  it("reports the paths a firing session overwrote after an event, so its consequence is superseded in the worker", async () => {
    // The seed stands for the event's durable entry: what the firing session
    // wrote after it is what supersedes the handler's writes.
    const entry = commit(
      [{ op: "set", id, value: { value: { name: "", bio: "" } } }],
      { principal: "did:key:seeder", sessionId: "seeder-session" },
    );
    commit(
      [{
        op: "patch",
        id,
        patches: [{ op: "replace", path: "/value/name", value: "Grace" }],
      }],
      firing,
    );
    const sink = plane.createWaveCommitSink({
      space,
      engine,
      foreignEngineFor: () => engine,
      sessionId: "holder",
      localSeqRef: { value: 0 },
    });
    const doc = { id, scopeKey: "space" };
    expect(
      await sink.sessionOverwritePathsSince?.(space, doc, entry, firing),
    ).toEqual([["value", "name"]]);
    expect(
      await sink.sessionOverwritePathsSince?.(space, doc, entry, {
        principal: "did:key:bob",
        sessionId: "bob-session",
      }),
    ).toEqual([]);
  });

  it("admits a derived commit on the worker's own connection only while the memory server's map names its loop", async () => {
    // The outbox's failure notice is such a commit, and the only one.
    const leases = new ExecutionLeases();
    const bridge = new PortEndpoint<
      BridgeRequests,
      BridgeNotices,
      PlaneRequests,
      PlaneNotices
    >(channel.port2, () => {});
    bridge.onRequest("space.open", () => ({ url: toFileUrl(path).href }));
    bridge.onRequest(
      "server.acquireExecutionLease",
      ({ space, holder }) => leases.acquire(space, holder),
    );
    bridge.onRequest(
      "server.releaseExecutionLease",
      ({ space, holder }) => leases.release(space, holder),
    );
    const releaseServerExecution = acquireServerExecutionEnabler();
    try {
      const own = await plane.server.engineForSpace(space);
      const holder = "did:key:service#worker";
      const notice = (seq: number) => () =>
        Engine.applyCommit(own, {
          sessionId: holder,
          space,
          commitClass: "derived",
          holder,
          commit: {
            localSeq: seq,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id, value: { value: { seq } } }],
          },
        });

      expect(notice(1)).toThrow("execution lease");

      leases.acquire(space, "did:key:service#rival");
      expect(await plane.server.executionLeases.acquire(space, holder))
        .toBe(false);
      expect(notice(1)).toThrow("execution lease");
      leases.release(space, "did:key:service#rival");

      expect(await plane.server.executionLeases.acquire(space, holder))
        .toBe(true);
      expect(leases.holderOf(space)).toBe(holder);
      expect(notice(1)).not.toThrow();

      await plane.server.executionLeases.release(space, holder);
      expect(leases.holderOf(space)).toBeUndefined();
      expect(notice(2)).toThrow("execution lease");
    } finally {
      releaseServerExecution();
      bridge.close();
    }
  });
});
