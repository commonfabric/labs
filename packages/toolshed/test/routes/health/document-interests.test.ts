import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { connect, loopback } from "@commonfabric/memory/v2/client";
import { getDocumentInterests, Server } from "@commonfabric/memory/v2/server";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import createApp from "@/lib/create-app.ts";
import router from "@/routes/health/health.index.ts";
import { documentInterests } from "@/routes/health/health.routes.ts";

const app = createApp().route("/", router);
const space = "did:key:health-document-interests";
const principal = "did:key:health-document-interests-owner";

/** Builds a query without changing identifier spelling through URL parsing. */
function url(id: string, limit = "100"): string {
  return `/api/health/document-interests?${new URLSearchParams({
    space,
    id,
    limit,
  })}`;
}

/** Creates a local server; production authentication is outside this test. */
function server(): Server {
  return new Server({
    store: new URL("memory://health-document-interests"),
    authorizeSessionOpen: () => principal,
    sessionOpenAuth: { audience: "did:key:health-document-interests-audience" },
    subscriptionRefreshDelayMs: "manual",
  });
}

describe("health document interests", () => {
  it("attributes direct and dependency-only schema retention to separate sessions", async () => {
    const memory = server();
    const client = await connect({ transport: loopback(memory) });
    try {
      const auth = (
        _space: string,
        _session: unknown,
        { audience, challenge }: {
          audience: string;
          challenge: { value: string };
        },
      ) => ({
        invocation: { aud: audience, challenge: challenge.value },
        authorization: {},
      });
      const direct = await client.mount(space, {}, auth);
      const dependent = await client.mount(space, {}, auth);
      const schema = {
        type: "string",
        title: "private schema contents",
      } as const;
      const id = `cid:${internSchemaAsTaggedHashString(schema)}`;
      const root = "of:document-interests-root";
      await direct.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id, value: { value: schema } },
          {
            op: "set",
            id: root,
            value: {
              value: {
                link: {
                  "/": {
                    "link@1": {
                      id: "of:target",
                      path: [],
                      schema: { $ref: id },
                    },
                  },
                },
              },
            },
          },
        ],
      });
      // A one-shot fetch returns the schema without installing a session
      // watch or retaining it in a session graph.
      const fetchOnly = await client.mount(space, {}, auth);
      const fetched = await fetchOnly.queryGraph({
        roots: [{ id, selector: { path: [], schema: false } }],
      });
      expect(fetched.entities.some((entity) => entity.id === id)).toBe(true);
      expect(getDocumentInterests({ space, id })?.totalMatches).toBe(0);

      for (
        const [session, rootId] of [[direct, id], [dependent, root]] as const
      ) {
        await session.watchSet([{
          id: "watch",
          kind: "graph",
          query: {
            roots: [{ id: rootId, selector: { path: [], schema: false } }],
          },
        }]);
      }
      const response = await app.request(url(id));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      const report = documentInterests.responses[200]
        .content["application/json"]
        .schema.parse(JSON.parse(text));
      expect(report.totalMatches).toBe(2);
      expect(report.sessions.map((row) => ({
        sessionId: row.sessionId,
        principal: row.principal,
        directWatchCount: row.directWatchCount,
        cached: row.cached,
        graphCount: row.graphCount,
      }))).toEqual([
        {
          sessionId: direct.sessionId,
          principal,
          directWatchCount: 1,
          cached: true,
          graphCount: 1,
        },
        {
          sessionId: dependent.sessionId,
          principal,
          directWatchCount: 0,
          cached: true,
          graphCount: 1,
        },
      ]);
      expect(report.sessions.every((row) => row.connectionId !== null)).toBe(
        true,
      );
      expect(text).not.toContain(schema.title);
      expect(text).not.toContain(direct.sessionToken!);
      expect(text).not.toContain(dependent.sessionToken!);
      const limited = await (await app.request(url(id, "1"))).json();
      expect(limited.totalMatches).toBe(2);
      expect(limited.truncated).toBe(true);
      expect(limited.sessions).toHaveLength(1);

      await direct.watchSet([]);
      const remaining = await (await app.request(url(id))).json();
      expect(
        remaining.sessions.map((row: { sessionId: string }) => row.sessionId),
      )
        .toEqual([dependent.sessionId]);
    } finally {
      await client.close();
      await memory.close();
    }
  });

  it("leaves unknown spaces unopened and validates bounded lookup inputs", async () => {
    const memory = server();
    try {
      expect(
        (await (await app.request(url("cid:unknown"))).json()).totalMatches,
      )
        .toBe(0);
      expect(memory.documentCachesDiagnostics().spaces).toEqual({});
      for (
        const path of [
          "/api/health/document-interests",
          url(""),
          url("cid:"),
          url("of:private-document"),
          url("cid:unknown", "0"),
          url("cid:unknown", "101"),
          url("cid:unknown", "1.5"),
        ]
      ) {
        expect((await app.request(path)).status).toBe(422);
      }
    } finally {
      await memory.close();
    }
  });

  it("withdraws closed providers and distinguishes unavailable from no matches", async () => {
    const original = server();
    const newest = server();
    const query = { space, id: "cid:unknown" };
    try {
      expect(getDocumentInterests(query)?.totalMatches).toBe(0);
      await original.close();
      expect(getDocumentInterests(query)?.totalMatches).toBe(0);
      await newest.close();
      expect(getDocumentInterests(query)).toBeUndefined();
      expect((await app.request(url(query.id))).status).toBe(503);
    } finally {
      await newest.close();
      await original.close();
    }
  });
});
