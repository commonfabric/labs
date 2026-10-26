import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { SessionViewInterest } from "@commonfabric/memory/v2";
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
import { emptyServingLoopStats } from "../../src/executor/stats.ts";

const space = "did:key:z6MkPlaneSessionExpiry";

describe("serving-plane-sessions", () => {
  it("invalidates cached view interests when a detached session expires without a notice", async () => {
    const channel = new MessageChannel();
    const endpoint = servingPlaneEndpoint(channel.port1);
    const plane = new ServingPlane(endpoint);
    const bridge = new PortEndpoint<
      BridgeRequests,
      BridgeNotices,
      PlaneRequests,
      PlaneNotices
    >(channel.port2, () => {});
    let now = Date.now();
    using _now = stub(Date, "now", () => now);
    endpoint.onRequest("host.stats", emptyServingLoopStats);
    let reads = 0;
    const interest: SessionViewInterest = {
      handle: {
        sessionId: "a",
        sessionEpoch: "session",
        viewEpoch: "view",
        viewId: "view",
        revision: 1,
      },
      attached: false,
      view: { id: "view", revision: 1 } as SessionViewInterest["view"],
    };
    bridge.onRequest("server.viewInterestsForSpace", () => {
      reads++;
      return reads === 1 ? [interest] : [];
    });
    try {
      bridge.notify("observer.sessionChanged", {
        event: { kind: "opened", space, sessionId: "a" },
      });
      bridge.notify("observer.sessionChanged", {
        event: {
          kind: "detached",
          space,
          sessionId: "a",
          expiresAt: now + 100,
        },
      });
      await bridge.request("host.stats", null);
      expect(await plane.server.viewInterestsForSpace(space)).toEqual([
        interest,
      ]);
      expect(await plane.server.viewInterestsForSpace(space)).toEqual([
        interest,
      ]);
      expect(reads).toBe(1);
      now += 101;
      expect(await plane.server.viewInterestsForSpace(space)).toEqual([]);
      expect(reads).toBe(2);
      expect(plane.server.hasLiveSessionsForSpace(space)).toBe(false);
    } finally {
      await plane.close();
      bridge.close();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("forgets a space's view interests once its last session is removed", async () => {
    const channel = new MessageChannel();
    const endpoint = servingPlaneEndpoint(channel.port1);
    const plane = new ServingPlane(endpoint);
    const bridge = new PortEndpoint<
      BridgeRequests,
      BridgeNotices,
      PlaneRequests,
      PlaneNotices
    >(channel.port2, () => {});
    endpoint.onRequest("host.stats", emptyServingLoopStats);
    bridge.onRequest("server.viewInterestsForSpace", () => []);
    try {
      for (const sessionId of ["a", "b"]) {
        bridge.notify("observer.sessionChanged", {
          event: { kind: "opened", space, sessionId },
        });
      }
      await bridge.request("host.stats", null);
      await plane.server.viewInterestsForSpace(space);
      expect(plane.heldViewInterestSpaces).toBe(1);

      bridge.notify("observer.sessionChanged", {
        event: { kind: "removed", space, sessionId: "a" },
      });
      await bridge.request("host.stats", null);
      await plane.server.viewInterestsForSpace(space);
      expect(plane.heldViewInterestSpaces).toBe(1);
      bridge.notify("observer.sessionChanged", {
        event: { kind: "removed", space, sessionId: "b" },
      });
      await bridge.request("host.stats", null);

      expect(plane.heldViewInterestSpaces).toBe(0);
    } finally {
      await plane.close();
      bridge.close();
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("keeps no view interests for a space whose last session lapsed", async () => {
    const channel = new MessageChannel();
    const endpoint = servingPlaneEndpoint(channel.port1);
    const plane = new ServingPlane(endpoint);
    const bridge = new PortEndpoint<
      BridgeRequests,
      BridgeNotices,
      PlaneRequests,
      PlaneNotices
    >(channel.port2, () => {});
    let now = Date.now();
    using _now = stub(Date, "now", () => now);
    endpoint.onRequest("host.stats", emptyServingLoopStats);
    bridge.onRequest("server.viewInterestsForSpace", () => []);
    try {
      bridge.notify("observer.sessionChanged", {
        event: { kind: "opened", space, sessionId: "a" },
      });
      bridge.notify("observer.sessionChanged", {
        event: {
          kind: "detached",
          space,
          sessionId: "a",
          expiresAt: now + 100,
        },
      });
      await bridge.request("host.stats", null);
      await plane.server.viewInterestsForSpace(space);
      expect(plane.heldViewInterestSpaces).toBe(1);

      now += 101;
      expect(await plane.server.viewInterestsForSpace(space)).toEqual([]);
      expect(plane.heldViewInterestSpaces).toBe(0);
      bridge.notify("observer.sessionChanged", {
        event: { kind: "removed", space, sessionId: "a" },
      });
      await bridge.request("host.stats", null);

      expect(plane.heldViewInterestSpaces).toBe(0);
    } finally {
      await plane.close();
      bridge.close();
      channel.port1.close();
      channel.port2.close();
    }
  });
});
