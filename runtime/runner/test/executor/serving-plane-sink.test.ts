import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { Operation } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";

import {
  ServingPlane,
  servingPlaneEndpoint,
} from "../../src/executor/serving-port-plane.ts";
import { ServingPortBridge } from "../../src/executor/serving-port-bridge.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

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

  it("reads the paths written to a document and whether anything intruded on it since a seq, from the worker's own engine", async () => {
    const seeded = commit(
      [{ op: "set", id, value: { value: { name: "", bio: "" } } }],
      { principal: "did:key:seeder", sessionId: "seeder-session" },
    );
    const sink = plane.createWaveCommitSink({
      space,
      engine,
      foreignEngineFor: () => engine,
      sessionId: "holder",
      localSeqRef: { value: 0 },
    });
    const doc = { id, scopeKey: "space" };
    expect(await sink.concurrentWritePaths(space, doc, seeded)).toEqual([]);
    expect(await sink.intrusionSince?.(space, doc, seeded, "holder"))
      .toBe(false);

    commit(
      [{
        op: "patch",
        id,
        patches: [{ op: "replace", path: "/value/bio", value: "Hopper" }],
      }],
      firing,
    );
    expect(await sink.concurrentWritePaths(space, doc, seeded)).toEqual([
      ["value", "bio"],
    ]);
    expect(await sink.intrusionSince?.(space, doc, seeded, "holder"))
      .toBe(true);
    expect(await sink.intrusionSince?.(space, doc, seeded + 1, "holder"))
      .toBe(false);
  });

  it("carries a failure notice to the memory server, which patches the source entry only while its map names the holder", async () => {
    const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const bridge = new ServingPortBridge({ server, port: channel.port2 });
    try {
      const own = await server.engineForSpace(space);
      Engine.applyCommit(own, {
        sessionId: "seeder-session",
        principal: "did:key:seeder",
        space,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id,
            value: {
              value: {
                entries: [{ eventId: "other" }, { eventId: "source" }],
              },
            },
          }],
        },
      });
      const holder = "did:key:service#worker";
      const notice = (
        localSeq: number,
        eventId: string,
        sourceEventId = "source",
      ) =>
        plane.server.commitDeliveryFailureNotice({
          space,
          holder,
          localSeq,
          sourceEvent: { sidecarId: id, eventId: sourceEventId },
          failure: { eventId, targetSpace: "did:key:target", reason: "no" },
        });
      const entries = () =>
        (Engine.read(own, { id })?.value as { entries: unknown[] }).entries;
      const refused = {
        eventId: "refused",
        targetSpace: "did:key:target",
        reason: "no",
      };

      await expect(notice(1, "refused")).rejects.toThrow("execution lease");

      expect(await plane.server.executionLeases.acquire(space, holder))
        .toBe(true);
      expect(server.executionLeases.holderOf(space)).toBe(holder);
      await notice(1, "refused");
      expect(entries()).toEqual([
        { eventId: "other" },
        { eventId: "source", deliveryFailures: [refused] },
      ]);

      // A notice already on the entry, and an entry compacted away, write
      // nothing.
      const head = Engine.serverSeq(own);
      await notice(2, "refused");
      await notice(3, "other-refused", "compacted-away");
      expect(Engine.serverSeq(own)).toBe(head);

      await plane.server.executionLeases.release(space, holder);
      expect(server.executionLeases.holderOf(space)).toBeUndefined();
      await expect(notice(4, "later")).rejects.toThrow("execution lease");
      expect(Engine.serverSeq(own)).toBe(head);
    } finally {
      bridge.close();
      await server.close();
    }
  });
});
