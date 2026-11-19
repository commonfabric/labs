import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { WatchSetResult } from "../v2.ts";
import { Server } from "../v2/server.ts";
import {
  connectPeer,
  openSession,
  request,
  type WirePeer,
} from "./support/wire-peer.ts";

const SPACE = "did:key:z6Mk-anonymous-demand";
const SHARED = "of:anonymous-demand-shared";

describe("Server", () => {
  // Sessions open without an issuer, so the server admits them anonymous:
  // with no principal, a session owns no scoped instance and watches
  // space-scoped roots alone.

  let server: Server;
  let peer: WirePeer;
  let sessionId: string;

  beforeEach(async () => {
    server = new Server({
      store: new URL(`memory://anonymous-demand-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: "manual",
      authorizeSessionOpen: (message) =>
        typeof message.invocation?.iss === "string"
          ? message.invocation.iss
          : undefined,
      sessionOpenAuth: { audience: "did:key:z6Mk-anonymous-demand-audience" },
    });
    peer = await connectPeer(server);
    ({ sessionId } = await openSession(peer, SPACE));
    const watched = await request<WatchSetResult>(peer, {
      type: "session.watch.set",
      space: SPACE,
      sessionId,
      watches: [{
        id: "shared",
        kind: "graph",
        query: {
          roots: [{ id: SHARED, selector: { path: [], schema: false } }],
        },
      }],
    });
    expect(watched.error).toBeUndefined();
  });

  afterEach(async () => {
    await server.close();
  });

  describe("watchedRootsForSpace()", () => {
    it("returns an anonymous session's space-scoped root with no identity", () => {
      expect(server.watchedRootsForSpace(SPACE)).toEqual([{ id: SHARED }]);
    });

    it("returns one row for a space-scoped root two anonymous sessions watch", async () => {
      const other = await openSession(peer, SPACE);
      await request<WatchSetResult>(peer, {
        type: "session.watch.set",
        space: SPACE,
        sessionId: other.sessionId,
        watches: [{
          id: "shared",
          kind: "graph",
          query: {
            roots: [{ id: SHARED, selector: { path: [], schema: false } }],
          },
        }],
      });

      expect(server.watchedRootsForSpace(SPACE)).toEqual([{ id: SHARED }]);
    });
  });

  describe("demandForSessions()", () => {
    it("returns the shares of the sessions it holds and leaves out an id it does not hold", () => {
      expect(
        server.demandForSessions(SPACE, ["session:not-open", sessionId]).map(
          (share) => share.sessionId,
        ),
      ).toEqual([sessionId]);
    });
  });
});
