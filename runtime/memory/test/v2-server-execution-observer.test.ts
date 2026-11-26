import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
  type WatchSetResult,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import type { SessionLifecycleEvent } from "../v2/session-registry.ts";
import { connectPeer, openSession, request } from "./support/wire-peer.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const SPACE = "did:key:z6Mk-execution-observer";
const DOC = "of:execution-observer-doc";

describe("Server", () => {
  let server: Server;

  beforeEach(() => {
    server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL(`memory://execution-observer-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: "manual",
    });
  });

  afterEach(async () => {
    server.setServerExecutionObserver(undefined);
    await server.close();
  });

  describe("setServerExecutionObserver()", () => {
    it("replays an `opened` event to a newly installed observer for every session already open", async () => {
      const peer = await connectPeer(server);
      const { sessionId } = await openSession(peer, SPACE);
      const events: SessionLifecycleEvent[] = [];

      server.setServerExecutionObserver({
        sessionChanged: (event) => events.push(event),
      });

      expect(events).toMatchObject([{
        kind: "opened",
        space: SPACE,
        sessionId,
      }]);
    });

    it("replays nothing to an observer without `sessionChanged`, and still attaches it", async () => {
      const peer = await connectPeer(server);
      await openSession(peer, SPACE);
      const opened: string[] = [];

      server.setServerExecutionObserver({
        sessionOpened: (space) => opened.push(space),
      });
      expect(opened).toEqual([]);
      await openSession(peer, SPACE);

      expect(opened).toEqual([SPACE]);
    });

    it("warns, and completes the open and the watch, when every observer callback throws", async () => {
      // A watch set carrying views, which raises `viewsChanged`, needs server
      // execution on.
      setServerExecutionConfig(true);
      const warnings: string[] = [];
      const warn = stub(console, "warn", (message: unknown) => {
        warnings.push(String(message));
      });
      try {
        const fail = () => {
          throw new Error("observer failure");
        };
        server.setServerExecutionObserver({
          sessionChanged: fail,
          sessionOpened: fail,
          viewsChanged: fail,
          demandChanged: fail,
        });
        const peer = await connectPeer(server);
        const { sessionId } = await openSession(peer, SPACE);
        const watched = await request<WatchSetResult>(peer, {
          type: "session.watch.set",
          space: SPACE,
          sessionId,
          watches: [],
          views: [{
            id: "screen",
            revision: 0,
            query: {
              roots: [{ id: DOC, selector: { path: [], schema: false } }],
            },
            mode: "speculate",
            componentContractVersion: "1",
          }],
        });

        expect(watched.error).toBeUndefined();
        expect(warnings).toEqual(expect.arrayContaining([
          "memory v2: server-execution observer threw on sessionChanged",
          "memory v2: server-execution observer threw on sessionOpened",
          "memory v2: server-execution observer threw on viewsChanged",
          "memory v2: server-execution observer threw on demandChanged",
        ]));
      } finally {
        warn.restore();
        resetServerExecutionConfig();
      }
    });
  });
});
