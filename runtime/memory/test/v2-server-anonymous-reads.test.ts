import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  type GraphQueryResult,
  resetServerExecutionConfig,
  type SessionSync,
  setServerExecutionConfig,
  toDocumentPath,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import {
  connectPeer,
  openSession,
  request,
  type WirePeer,
} from "./support/wire-peer.ts";

const SPACE = "did:key:z6Mk-anonymous-reads";

describe("Server", () => {
  // Sessions open without an issuer, so the server admits them anonymous:
  // with no principal, a session resolves no user-scoped instance.

  let server: Server;
  let peer: WirePeer;
  let sessionId: string;

  beforeEach(async () => {
    server = new Server({
      store: new URL(`memory://anonymous-reads-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: "manual",
      authorizeSessionOpen: (message) =>
        typeof message.invocation?.iss === "string"
          ? message.invocation.iss
          : undefined,
      sessionOpenAuth: { audience: "did:key:z6Mk-anonymous-reads-audience" },
    });
    peer = await connectPeer(server);
    ({ sessionId } = await openSession(peer, SPACE));
  });

  afterEach(async () => {
    await server.close();
  });

  describe("a `graph.query` naming an `entity_scope_key`", () => {
    it("is refused as not from the service identity, with no collapse, when another root of the address is one the session cannot resolve", async () => {
      setServerExecutionConfig(true);
      try {
        const queried = await request<GraphQueryResult>(peer, {
          type: "graph.query",
          space: SPACE,
          sessionId,
          query: {
            roots: [
              {
                id: "of:profile",
                scope: "user",
                entityScopeKey: "user:alice",
                selector: { path: [], schema: false },
              },
              {
                id: "of:profile",
                scope: "user",
                selector: { path: [], schema: false },
              },
            ],
          },
        });

        expect(queried.error).toEqual({
          name: "ProtocolError",
          message: "read naming an entity_scope_key rejected: the requester " +
            "is not the deployment's service identity and does not serve " +
            "this space on this memory server (protocol.md §2's read row)",
        });
      } finally {
        resetServerExecutionConfig();
      }
    });
  });

  describe("a conflicting `transact`", () => {
    it("is refused as a conflict, and the next flush sends the session its marker, when it read a user-scoped document", async () => {
      // A pending read naming a layer that never resolved conflicts before
      // the read's scope is resolved.
      const refused = await request(peer, {
        type: "transact",
        space: SPACE,
        sessionId,
        commit: {
          localSeq: 2,
          reads: {
            confirmed: [],
            pending: [{
              id: "of:private",
              scope: "user",
              path: toDocumentPath([]),
              localSeq: 1,
            }],
          },
          operations: [{ op: "set", id: "of:doc", value: { value: { n: 1 } } }],
        },
      });
      expect(refused.error?.name).toBe("ConflictError");
      peer.messages.length = 0;

      await server.flushSessions();

      expect(
        peer.messages.map((message) =>
          message.type === "session/effect"
            ? (message.effect as SessionSync).caughtUpLocalSeq
            : message.type
        ),
      ).toEqual([2]);
    });
  });
});
