import { assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { connect, loopback } from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";

import env from "@/env.ts";
import { stats as statsRoute } from "@/routes/health/health.routes.ts";
import createApp from "@/lib/create-app.ts";
import router from "@/routes/health/health.index.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

const app = createApp().route("/", router);

Deno.test("health routes", async (t) => {
  await t.step("GET /_health returns 200 with health status", async () => {
    const response = await app.request("/_health");
    assertEquals(response.status, 200);

    const json = await response.json();
    assertEquals(json.status, "OK");
    assertEquals(typeof json.timestamp, "number");
    // Test env: no baked metadata and no COMMIT_SHA, so the commit is
    // unknown — null in the body, and the header (the CLI's capture
    // channel) is omitted rather than sent empty.
    assertEquals(json.gitSha, null);
    assertEquals(response.headers.get("x-cf-git-sha"), null);
  });

  await t.step(
    "GET /api/health/stats reports the memory server's document caches",
    async () => {
      // The provider is registered by the Server constructor (newest live
      // server reported), so a server constructed here stands in for the
      // co-hosted one; it has opened no space yet.
      const server = new Server({
        store: new URL("memory://health-stats-document-caches"),
        authorizeSessionOpen: () => "did:key:z6Mk-health-stats-principal",
        sessionOpenAuth: { audience: "did:key:z6Mk-health-stats-audience" },
      });
      try {
        const declared = (statsRoute.responses as Record<
          number,
          {
            content: {
              "application/json": {
                schema: { safeParse(value: unknown): { success: boolean } };
              };
            };
          }
        >)[200].content["application/json"].schema;
        const stats = async () => {
          const response = await app.request("/api/health/stats");
          assertEquals(response.status, 200);
          const json = await response.json();
          assertEquals(json.documentCaches, server.documentCachesDiagnostics());
          // The declared response schema admits the live response.
          assertEquals(declared.safeParse(json).success, true);
          return json;
        };
        const empty = await stats();
        assertEquals(typeof empty.documentCaches.totalBudgetBytes, "number");
        assertEquals(empty.documentCaches.bytes, 0);
        assertEquals(empty.documentCaches.totalBudgetEvictions, 0);
        assertEquals(empty.documentCaches.spaces, {});
        // Any read opens a space; its record carries every per-space field
        // the schema declares, and the schema refuses a malformed one.
        const space = "did:key:z6Mk-health-stats-space";
        await server.evaluateGraphQuery(space, {
          roots: [{ id: "of:doc:1", selector: { path: [], schema: true } }],
        });
        const populated = await stats();
        const cache = populated.documentCaches.spaces[space];
        assertEquals(
          Object.keys(cache).sort(),
          [
            "budgetBytes",
            "bytes",
            "entries",
            "evictions",
            "hits",
            "maxEntries",
            "misses",
            "patchReplays",
            "resumes",
          ],
        );
        assertEquals(
          declared.safeParse({
            ...populated,
            documentCaches: {
              ...populated.documentCaches,
              spaces: { [space]: { ...cache, hits: "wrong" } },
            },
          }).success,
          false,
        );
      } finally {
        await server.close();
      }
    },
  );

  await t.step(
    "GET /api/health/stats reports the memory server's commit rates",
    async () => {
      const principal = "did:key:z6Mk-health-stats-commit-principal";
      const server = new Server({
        store: new URL("memory://health-stats-commit-rates"),
        authorizeSessionOpen: () => principal,
        sessionOpenAuth: { audience: "did:key:z6Mk-health-stats-audience" },
        subscriptionRefreshDelayMs: "manual",
      });
      try {
        const declared = (statsRoute.responses as Record<
          number,
          {
            content: {
              "application/json": {
                schema: { safeParse(value: unknown): { success: boolean } };
              };
            };
          }
        >)[200].content["application/json"].schema;
        const stats = async () => {
          const response = await app.request("/api/health/stats");
          assertEquals(response.status, 200);
          const json = await response.json();
          expect(json.commitRates).toEqual(server.commitRates());
          // The declared response schema admits the live response.
          expect(declared.safeParse(json).success).toBe(true);
          return json;
        };
        const empty = await stats();
        expect(empty.commitRates).toEqual({
          storm: empty.commitRates.storm,
          activeSpaces: 0,
          storms: 0,
          spaces: [],
        });
        expect(empty.commitRates.storm.commitsPerMinute).toBeGreaterThan(0);
        expect(empty.commitRates.storm.sustainedSeconds).toBeGreaterThan(0);
        // One commit through an opened session reports its space and its
        // writer, keyed by the session and the principal it was opened as.
        const space = "did:key:z6Mk-health-stats-commit-space";
        const client = await connect({ transport: loopback(server) });
        const mounted = await client.mount(space, {}, (_space, _session, {
          audience,
          challenge,
        }) => ({
          invocation: { aud: audience, challenge: challenge.value },
          authorization: {},
        }));
        await mounted.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:health-stats-commit",
            value: { value: { written: true } },
          }],
        });
        const populated = await stats();
        expect(populated.commitRates.activeSpaces).toBe(1);
        const [rates] = populated.commitRates.spaces;
        expect(Object.keys(rates).sort()).toEqual([
          "activeWriters",
          "minute",
          "space",
          "tenMinutes",
          "writers",
        ]);
        expect(rates.space).toBe(space);
        expect(rates.minute).toEqual({
          accepted: 1,
          rejected: 0,
          operations: 1,
        });
        expect(
          rates.writers.map((writer: { principal?: string }) =>
            writer.principal
          ),
        ).toEqual([principal]);
        // The schema refuses a malformed count.
        expect(
          declared.safeParse({
            ...populated,
            commitRates: {
              ...populated.commitRates,
              spaces: [{ ...rates, minute: { ...rates.minute, accepted: -1 } }],
            },
          }).success,
        ).toBe(false);
      } finally {
        await server.close();
      }
    },
  );
});
