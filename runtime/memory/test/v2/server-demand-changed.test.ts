import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { toDirtyKey } from "../../v2.ts";
import {
  type DemandChangeReason,
  Server,
  SessionRegistry,
} from "../../v2/server.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenServerOptions,
} from "../v2-auth-test-helpers.ts";

describe("Server", () => {
  describe("instance members", () => {
    describe("syncSessionForConnection()", () => {
      it("notifies the session principal when a full refresh changes demand and stays silent when only content changes", async () => {
        // Manual refresh keeps each commit's demand change pending until
        // the explicit sync, whose omitted dirty set requests a full walk.

        const sessions = new SessionRegistry();
        const server = new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://full-refresh-demand"),
          sessions,
          subscriptionRefreshDelayMs: "manual",
        });
        const space = "did:key:z6Mk-full-refresh-demand";
        const { sessionId } = sessions.open(
          space,
          {},
          0,
          "full-refresh-demand",
          TEST_SESSION_OPEN_PRINCIPAL,
        );
        const notifications: Array<{
          space: string;
          reason?: DemandChangeReason;
          principal?: string;
        }> = [];
        server.setServerExecutionObserver({
          demandChanged: (space, reason, principal) => {
            notifications.push({ space, reason, principal });
          },
        });
        try {
          const seeded = await server.transact({
            type: "transact",
            requestId: "seed",
            space,
            sessionId,
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [
                { op: "set", id: "of:root", value: { value: { child: null } } },
                { op: "set", id: "of:a", value: { value: { name: "A" } } },
                { op: "set", id: "of:b", value: { value: { name: "B" } } },
              ],
            },
          });
          expect(seeded.error).toBeUndefined();
          const watched = await server.watchSet({
            type: "session.watch.set",
            requestId: "watch",
            space,
            sessionId,
            watches: [{
              id: "root",
              kind: "graph",
              query: {
                roots: [{
                  id: "of:root",
                  selector: { path: [], schema: true },
                }],
              },
            }],
          });
          expect(watched.error).toBeUndefined();

          let localSeq = 1;
          for (
            const [target, changed] of [
              ["of:a", true],
              ["of:b", true],
              ["of:b", false],
              [null, true],
            ] as const
          ) {
            notifications.length = 0;
            const written = await server.transact({
              type: "transact",
              requestId: `write-${++localSeq}`,
              space,
              sessionId,
              commit: {
                localSeq,
                reads: { confirmed: [], pending: [] },
                operations: [{
                  op: "set",
                  id: "of:root",
                  value: {
                    value: {
                      revision: localSeq,
                      child: target === null ? null : {
                        "/": { "link@1": { id: target, path: [], space } },
                      },
                    },
                  },
                }],
              },
            });
            expect(written.error).toBeUndefined();
            expect(notifications).toEqual([]);
            const sync = await server.syncSessionForConnection(
              space,
              sessionId,
            );
            expect(sync?.effect.upserts.map((entry) => entry.id))
              .toContain("of:root");
            for (const id of ["of:root", "of:a", "of:b"]) {
              expect(server.sessionTracksAny(
                space,
                sessionId,
                new Set([
                  toDirtyKey(id),
                ]),
              )).toBe(id === "of:root" || id === target);
            }
            expect(notifications).toEqual(
              changed
                ? [{
                  space,
                  reason: "push-growth",
                  principal: TEST_SESSION_OPEN_PRINCIPAL,
                }]
                : [],
            );
          }
        } finally {
          await server.close();
        }
      });
    });
  });
});
