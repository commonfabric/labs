import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import {
  getLoggerCountsBreakdown,
  getTimingStatsBreakdown,
} from "@commonfabric/logger";
import {
  decodeTrustedMemoryBoundary,
  type SessionViewInterest,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import type { ServerExecutionObserver } from "@commonfabric/memory/v2/server";
import type { HostOccupancy } from "../../src/executor/host.ts";
import {
  ServingPlane,
  type ServingPlaneEndpoint,
  servingPlaneEndpoint,
  type ServingPlaneHost,
} from "../../src/executor/serving-port-plane.ts";
import {
  type BridgeNotices,
  type BridgeRequests,
  type PlaneNotices,
  type PlaneRequests,
  PortEndpoint,
} from "../../src/executor/serving-port-protocol.ts";
import type { ServedAclChangeData } from "../../src/executor/served-acl-change.ts";
import {
  emptyServingLoopStats,
  type ServingLoopCounters,
} from "../../src/executor/stats.ts";
import type { WaveSpaceCommit } from "../../src/executor/wave.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";

const space = "did:key:z6MkServingPortPlane" as MemorySpace;
const alice = "did:key:z6MkServingPortPlaneAlice";

const aclChange: ServedAclChangeData = {
  space,
  actingPrincipal: alice,
  capabilityRef: "event-consequence:evt",
  sourceEvent: { space, sidecarId: "of:sidecar", eventId: "evt" },
  changes: [{ principal: "did:key:z6MkBob", level: "READ", actor: alice }],
};

const batch: WaveSpaceCommit = {
  space,
  home: true,
  basisSeq: 0,
  rebasedHeads: [],
  operations: [],
  preconditions: [],
  annotations: [],
  consequenceOf: [],
  basisInstances: [],
  holder: undefined,
};

/** How many times `key` was logged at warn by the plane's logger. */
const planeWarnings = (key: string): number =>
  getLoggerCountsBreakdown()["serving-port-plane"]?.[key]?.warn ?? 0;

/** The counters a host with nothing counted reports ahead of a commit. */
const emptyCounters = (): ServingLoopCounters => {
  const { settle: _settle, settleAdvances: _settleAdvances, ...counters } =
    emptyServingLoopStats();
  return counters;
};

/** A host whose answers each case sets, standing for the worker's host. */
const fakeHost = (
  occupancy: () => HostOccupancy,
  overrides: Partial<ServingPlaneHost> = {},
): ServingPlaneHost & { closes: number } => {
  const diagnostics = {
    loggerCounts: getLoggerCountsBreakdown(),
    timingStats: getTimingStatsBreakdown(),
  };
  const host = {
    closes: 0,
    stats: emptyServingLoopStats,
    counters: emptyCounters,
    diagnostics: () => diagnostics,
    collectedMemory: () => ({ heapUsed: 0, external: 0 }),
    runLifecycleVerb: () => Promise.reject(new Error("no verbs")),
    occupancy,
    noteSpaceAclChanged: () => {},
    close: () => {
      host.closes += 1;
      return Promise.resolve();
    },
    ...overrides,
  };
  return host;
};

describe("serving-port-plane", () => {
  let channel: MessageChannel;
  let endpoint: ServingPlaneEndpoint;
  let plane: ServingPlane;
  let bridge: PortEndpoint<
    BridgeRequests,
    BridgeNotices,
    PlaneRequests,
    PlaneNotices
  >;

  /**
   * Settles once the plane has handled every message the bridge sent before
   * the call: the port delivers in order, and the request is answered after
   * them.
   */
  const handled = () => bridge.request("host.stats", null);

  /** Opens session `sessionId` of `principal` on `space` in the mirror. */
  const openSession = (sessionId: string, principal?: string) =>
    bridge.notify("observer.sessionChanged", {
      event: {
        kind: "opened",
        space,
        sessionId,
        ...(principal === undefined ? {} : { principal }),
      },
    });

  beforeEach(() => {
    channel = new MessageChannel();
    endpoint = servingPlaneEndpoint(channel.port1);
    plane = new ServingPlane(endpoint);
    bridge = new PortEndpoint(channel.port2, () => {});
    endpoint.onRequest("host.stats", emptyServingLoopStats);
  });

  afterEach(async () => {
    await plane.close();
    bridge.close();
    channel.port1.close();
    channel.port2.close();
  });

  describe("servingPlaneEndpoint()", () => {
    it("logs a notice the plane has no handler for as a port fault, and keeps reading", async () => {
      const before = planeWarnings("port-fault");
      // The host installs this notice's handler; no host serves yet.
      bridge.notify("observer.spaceAclChanged", { space });
      await handled();
      expect(planeWarnings("port-fault")).toBe(before + 1);
      await handled();
      expect(planeWarnings("port-fault")).toBe(before + 1);
    });
  });

  describe("server", () => {
    it("carries access-list checks and commits to the server's thread as data, and returns its verdicts", async () => {
      const crossed: unknown[] = [];
      bridge.onRequest("server.checkServedAclChange", (params) => {
        crossed.push(params);
        return { admitted: true };
      });
      bridge.onRequest("server.commitServedAclChange", (params) => {
        crossed.push(params);
        return { refused: "not an owner" };
      });
      const apply = () => ({});

      expect(
        await plane.server.checkServedAclChange({
          ...aclChange,
          change: apply,
        }),
      ).toEqual({ admitted: true });
      expect(
        await plane.server.commitServedAclChange({
          ...aclChange,
          change: apply,
          sessionId: "tenure",
          localSeq: 7,
        }),
      ).toEqual({ refused: "not an owner" });
      expect(crossed).toEqual([
        { change: aclChange },
        { change: aclChange, sessionId: "tenure", localSeq: 7 },
      ]);

      // A change that carries no list of changes cannot cross at all.
      const { changes: _changes, ...unlisted } = aclChange;
      expect(() =>
        plane.server.checkServedAclChange({ ...unlisted, change: apply })
      ).toThrow("carries no change list");
      await handled();
      expect(crossed).toHaveLength(2);
    });

    it("carries a delegated append in the memory boundary's encoding, and returns the server's answer", async () => {
      const entry = {
        targetSpace: space,
        targetStream: "of:sidecar",
        targetStreamLink: { id: "of:stream", path: [] },
        eventId: "evt",
        payload: { count: 1 },
        actingPrincipal: alice,
        actingSession: "alice-session",
        capabilityRef: "cap",
        sessionId: "tenure",
        localSeq: 3,
      };
      const received: unknown[] = [];
      bridge.onRequest("server.commitDelegatedAppend", ({ entry }) => {
        received.push(decodeTrustedMemoryBoundary(entry));
        return { seq: 9, deduped: false };
      });
      expect(await plane.server.commitDelegatedAppend(entry)).toEqual({
        seq: 9,
        deduped: false,
      });
      expect(received).toEqual([entry]);
    });

    it("asks the server's thread for foreign write and read authority, naming the space and principal", async () => {
      const asked: string[] = [];
      bridge.onRequest(
        "server.foreignWriteAuthorityFor",
        ({ space, principal }) => {
          asked.push(`write ${space} ${principal}`);
          return { granted: true };
        },
      );
      bridge.onRequest(
        "server.foreignReadAuthorityFor",
        ({ space, principal }) => {
          asked.push(`read ${space} ${principal}`);
          return { granted: false, reason: "no READ" };
        },
      );
      expect(await plane.server.foreignWriteAuthorityFor(space, alice))
        .toEqual({ granted: true });
      expect(await plane.server.foreignReadAuthorityFor(space, undefined))
        .toEqual({ granted: false, reason: "no READ" });
      expect(asked).toEqual([
        `write ${space} ${alice}`,
        `read ${space} undefined`,
      ]);
    });

    it("returns whether a session is live for a principal from the sessions the server reported", async () => {
      openSession("alice-session", alice);
      await handled();
      expect(plane.server.hasLiveSessionFor(space, alice, "alice-session"))
        .toBe(true);
      expect(
        plane.server.hasLiveSessionFor(space, "did:key:other", "alice-session"),
      ).toBe(false);
      expect(plane.server.hasLiveSessionFor(space, alice, "other-session"))
        .toBe(false);

      bridge.notify("observer.sessionChanged", {
        event: { kind: "removed", space, sessionId: "alice-session" },
      });
      await handled();
      expect(plane.server.hasLiveSessionFor(space, alice, "alice-session"))
        .toBe(false);
    });

    describe("setViewSelection()", () => {
      const handle = {
        sessionId: "a",
        sessionEpoch: "session",
        viewEpoch: "view",
        viewId: "view",
        revision: 1,
      };
      const interest: SessionViewInterest = {
        handle,
        attached: true,
        view: { id: "view", revision: 1 } as SessionViewInterest["view"],
      };

      it("holds the generation of a selection the server installed, and keeps the held one for a selection it refused", async () => {
        let reads = 0;
        bridge.onRequest("server.viewInterestsForSpace", () => {
          reads++;
          return [interest];
        });
        // The server refuses the first selection and installs the second.
        let installs = 0;
        bridge.onRequest("server.setViewSelection", ({ selection }) => {
          expect(selection.delivery).toEqual([]);
          return ++installs === 2;
        });
        openSession("a");
        await handled();
        expect(await plane.server.viewInterestsForSpace(space)).toEqual([
          interest,
        ]);

        expect(
          await plane.server.setViewSelection(space, handle, {
            generation: 2,
            delivery: [],
          }),
        ).toBe(false);
        expect(await plane.server.viewInterestsForSpace(space)).toEqual([
          interest,
        ]);

        expect(
          await plane.server.setViewSelection(space, handle, {
            generation: 3,
            delivery: [],
          }),
        ).toBe(true);
        expect(await plane.server.viewInterestsForSpace(space)).toEqual([
          { ...interest, selectionGeneration: 3 },
        ]);
        expect(reads).toBe(1);
      });
    });

    it("reports a view change to the installed observer and reads the space's view interests again", async () => {
      let reads = 0;
      bridge.onRequest("server.viewInterestsForSpace", () => {
        reads++;
        return [];
      });
      const changes: string[] = [];
      const observer: ServerExecutionObserver = {
        viewsChanged: (space, sessionId) =>
          changes.push(`${space} ${sessionId}`),
      };
      plane.server.setServerExecutionObserver(observer);
      expect(plane.observer).toBe(observer);
      openSession("a");
      await handled();
      await plane.server.viewInterestsForSpace(space);
      await plane.server.viewInterestsForSpace(space);
      expect(reads).toBe(1);

      bridge.notify("observer.viewsChanged", { space, sessionId: "a" });
      await handled();
      expect(changes).toEqual([`${space} a`]);
      await plane.server.viewInterestsForSpace(space);
      expect(reads).toBe(2);

      plane.server.setServerExecutionObserver(undefined);
      expect(plane.observer).toBeUndefined();
      bridge.notify("observer.viewsChanged", { space, sessionId: "a" });
      await handled();
      expect(changes).toHaveLength(1);
    });
  });

  describe("createWaveCommitSink()", () => {
    let engine: Engine.Engine;

    beforeEach(async () => {
      engine = await Engine.open({ url: new URL("memory:serving-port-plane") });
    });

    afterEach(() => {
      Engine.close(engine);
    });

    /** The worker's sink for a tenure on `space`, counting with `localSeqRef`. */
    const sink = (localSeqRef: { value: number }) =>
      plane.createWaveCommitSink({
        space,
        engine,
        foreignEngineFor: () => engine,
        sessionId: "tenure",
        localSeqRef,
      });

    it("posts the host's counters ahead of each commit once a host serves, and none before", async () => {
      const seen: string[] = [];
      bridge.onNotice("host.counters", ({ counters }) => {
        seen.push(`events ${counters.events.processed}`);
      });
      bridge.onRequest(
        "sink.commitWave",
        ({ sessionId, localSeq, batch: encoded }) => {
          seen.push(`commit ${sessionId} ${localSeq}`);
          expect(decodeTrustedMemoryBoundary(encoded)).toEqual(batch);
          return { ok: { seq: localSeq + 10 } };
        },
      );
      const localSeqRef = { value: 0 };
      const worker = sink(localSeqRef);

      expect(await worker.commitWave(batch)).toEqual({ ok: { seq: 11 } });
      const counters = emptyCounters();
      counters.events.processed = 5;
      plane.serve(fakeHost(() => "busy", { counters: () => counters }));
      expect(await worker.commitWave(batch)).toEqual({ ok: { seq: 12 } });
      expect(seen).toEqual([
        "commit tenure 1",
        "events 5",
        "commit tenure 2",
      ]);
      expect(localSeqRef.value).toBe(2);
    });

    it("carries an access-list change under the next number of the tenure's counter", async () => {
      const crossed: unknown[] = [];
      bridge.onRequest("sink.commitSpaceAccessChange", (params) => {
        crossed.push(params);
        return { ok: { seq: 4 } };
      });
      const localSeqRef = { value: 5 };
      expect(
        await sink(localSeqRef).commitSpaceAccessChange?.({
          ...aclChange,
          change: () => ({}),
        }),
      ).toEqual({ ok: { seq: 4 } });
      expect(crossed).toEqual([
        { sessionId: "tenure", localSeq: 6, change: aclChange },
      ]);
      expect(localSeqRef.value).toBe(6);
    });

    it("returns a commit the server's thread failed as a rejection rather than throwing", async () => {
      bridge.onRequest("sink.commitWave", () => {
        throw new Error("the store is gone");
      });
      bridge.onRequest("sink.commitSpaceAccessChange", () => {
        throw new Error("the list is gone");
      });
      const worker = sink({ value: 0 });
      expect(await worker.commitWave(batch)).toEqual({
        error: { name: "WaveCommitRejected", message: "the store is gone" },
      });
      expect(
        await worker.commitSpaceAccessChange?.({
          ...aclChange,
          change: () => ({}),
        }),
      ).toEqual({
        error: { name: "WaveCommitRejected", message: "the list is gone" },
      });
    });
  });

  describe("serve()", () => {
    it("retires a vacant host, and declines while it is busy, or parked unless asked to retire a parked one", async () => {
      let occupancy: HostOccupancy = "busy";
      const host = fakeHost(() => occupancy);
      plane.serve(host);

      expect(await bridge.request("host.retire", { evenIfParked: true }))
        .toBeNull();
      occupancy = "parked";
      expect(await bridge.request("host.retire", { evenIfParked: false }))
        .toBeNull();
      expect(host.closes).toBe(0);

      expect(await bridge.request("host.retire", { evenIfParked: true }))
        .toEqual({
          stats: emptyServingLoopStats(),
          diagnostics: host.diagnostics(),
        });
      expect(host.closes).toBe(1);
      occupancy = "vacant";
      expect(await bridge.request("host.retire", { evenIfParked: false }))
        .not.toBeNull();
      expect(host.closes).toBe(2);
    });

    it("hands the host each space whose access list changed", async () => {
      const changed: string[] = [];
      plane.serve(
        fakeHost(() => "busy", {
          noteSpaceAclChanged: (space) => changed.push(space),
        }),
      );
      bridge.notify("observer.spaceAclChanged", { space });
      await handled();
      expect(changed).toEqual([space]);
    });
  });

  describe("engineForSpace()", () => {
    it("opens the file the server's thread names once, and asks again after an open that failed", async () => {
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      try {
        let asked = 0;
        bridge.onRequest("space.open", () => {
          asked++;
          if (asked === 1) throw new Error("not yet");
          return { url: toFileUrl(path).href };
        });
        await expect(plane.engineForSpace(space)).rejects.toThrow("not yet");
        const [first, second] = await Promise.all([
          plane.engineForSpace(space),
          plane.engineForSpace(space),
        ]);
        expect(first).toBe(second);
        expect(first.url.href).toBe(toFileUrl(path).href);
        expect(asked).toBe(2);
        await plane.close();
      } finally {
        await Deno.remove(path);
      }
    });
  });

  describe("close()", () => {
    it("loses every loopback connection still open, once", async () => {
      bridge.onRequest("loopback.open", () => {});
      const losses: (Error | undefined)[] = [];
      const transport = plane.loopback.createTransport();
      transport.setCloseReceiver?.((error) => losses.push(error));
      await handled();

      await plane.close();
      await plane.close();
      expect(losses.map((error) => error?.message)).toEqual([
        "the serving plane closed",
      ]);
      await expect(transport.send("frame")).rejects.toThrow(
        "memory transport closed",
      );
    });

    it("finishes closing when a space's engine failed to open while it closed, and logs the failure", async () => {
      const opened = Promise.withResolvers<{ url: string }>();
      bridge.onRequest("space.open", () => opened.promise);
      const engine = plane.engineForSpace(space);
      await handled();
      const before = planeWarnings("engine-close-failed");
      const closing = plane.close();
      opened.reject(new Error("the store is gone"));
      await closing;
      await expect(engine).rejects.toThrow("the store is gone");
      expect(planeWarnings("engine-close-failed")).toBe(before + 1);
    });
  });

  describe("loopback", () => {
    it("loses a connection the server's thread refused to open, as a connection error", async () => {
      bridge.onRequest("loopback.open", () => {
        throw new Error("no connections");
      });
      const lost = Promise.withResolvers<Error | undefined>();
      const transport = plane.loopback.createTransport();
      transport.setCloseReceiver?.(lost.resolve);
      const error = await lost.promise;
      expect(error?.name).toBe("ConnectionError");
      expect(error?.message).toBe("opening a loopback connection failed");
      expect(String(error?.cause)).toBe("Error: no connections");
    });

    it("rejects a frame the server's thread refused with its error, and with a connection error once the port closed under it", async () => {
      bridge.onRequest("loopback.open", () => {});
      const held = Promise.withResolvers<void>();
      let sends = 0;
      bridge.onRequest("loopback.send", () => {
        sends++;
        if (sends === 1) throw new Error("bad frame");
        held.resolve();
        return new Promise<void>(() => {});
      });
      const transport = plane.loopback.createTransport();

      const refused = await transport.send("first").then(
        () => undefined,
        (error: Error) => error,
      );
      expect(refused?.name).toBe("Error");
      expect(refused?.message).toBe("bad frame");

      const pending = transport.send("second").then(
        () => undefined,
        (error: Error) => error,
      );
      await held.promise;
      endpoint.close(new Error("the port went away"));
      const lost = await pending;
      expect(lost?.name).toBe("ConnectionError");
      expect(lost?.message).toBe("the serving port closed");
      expect(String(lost?.cause)).toBe("Error: the port went away");
    });
  });
});
