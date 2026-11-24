/** Exercises ordinary queries while a connected transport restores its session. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  connect,
  loopback,
  type SpaceSession,
  type Transport,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import { decodeMemoryBoundary } from "../v2.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

describe("v2-query-reconnect", () => {
  const cases: {
    name: string;
    type: string;
    query: (session: SpaceSession) => Promise<unknown>;
  }[] = [
    {
      name: "graph query",
      type: "graph.query",
      query: (session) => session.queryGraph({ roots: [] }),
    },
    {
      name: "entity listing",
      type: "entity-id.list",
      query: (session) => session.listEntityIds(),
    },
    {
      name: "entity lookup",
      type: "entity-id.exists",
      query: (session) => session.entityIdExists("of:absent"),
    },
  ];
  for (const { name, type, query: invoke } of cases) {
    for (const outcome of ["restored", "closed", "revoked"]) {
      it(`handles ${name} when its restoring session is ${outcome}`, async () => {
        const server = new Server({
          ...testSessionOpenServerOptions,
          store: new URL("memory://query-during-reopen"),
        });
        let active = loopback(server);
        let receiver = (_payload: string) => {};
        let disconnected = (_error?: Error) => {};
        let opening = false;
        let prematureQueries = 0;
        let queries = 0;
        const transport: Transport = {
          send(payload) {
            const message = decodeMemoryBoundary(payload) as { type: string };
            if (message.type === type) {
              queries++;
              if (opening) prematureQueries++;
            }
            return active.send(payload);
          },
          close: () => active.close(),
          setReceiver(next) {
            receiver = next;
            active.setReceiver(next);
          },
          setCloseReceiver(next) {
            disconnected = next;
          },
        };
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const client = await connect({ transport });
        let opened = false;
        try {
          const session = await client.mount(
            "did:key:z6Mk-query-reconnect",
            {},
            async (...args) => {
              if (opened) {
                opening = true;
                entered.resolve();
                await release.promise;
                opening = false;
              }
              opened = true;
              return testSessionOpenAuthFactory(...args);
            },
          );
          await active.close();
          active = loopback(server);
          active.setReceiver(receiver);
          disconnected(new Error("synthetic outage"));
          await entered.promise;
          expect(client.isConnected()).toBe(true);
          const query = invoke(session);
          query.catch(() => {});
          if (outcome === "closed") await session.close();
          if (outcome === "revoked") session.handleRevoked("taken-over");
          // request() yields once at its connected-transport guard before send().
          await Promise.resolve();
          release.resolve();
          if (outcome === "restored") {
            await query;
            expect(prematureQueries).toBe(0);
            expect(queries).toBe(1);
            await invoke(session);
            expect(queries).toBe(2);
          } else {
            await expect(query).rejects.toThrow(
              outcome === "closed"
                ? "memory session closed"
                : "memory session revoked",
            );
            expect(queries).toBe(0);
          }
        } finally {
          release.resolve();
          await client.close();
          await server.close();
        }
      });
    }
  }
});
