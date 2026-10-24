import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { toValuePath, type WatchSpec } from "../v2.ts";
import { close, open } from "../v2/engine.ts";
import { toDocKey, trackGraph } from "../v2/query.ts";
import { cacheKeyForEntity } from "../v2/server-sync.ts";
import { SessionRegistry } from "../v2/session-registry.ts";

const space = "did:key:document-interests";
const id = "cid:historical-schema";

/** A root watch that need not load a document to represent an interest. */
function watch(branch = "", scope: "space" | "user" = "space"): WatchSpec {
  return {
    id: `${branch}-${scope}`,
    kind: "graph",
    query: {
      branch,
      roots: [{ id, scope, selector: { path: [], schema: false } }],
    },
  };
}

describe("document-interests", () => {
  it("separates spaces, branches and scope instances and bounds attribution", () => {
    const registry = new SessionRegistry();
    for (
      const [sessionSpace, branch, scope] of [
        [space, "", "space"],
        [space, "", "space"],
        [space, "other", "space"],
        [space, "", "user"],
        ["did:key:other-space", "", "space"],
      ] as const
    ) {
      const opened = registry.open(sessionSpace, {}, 0, "connection", "owner");
      const session = registry.peek(sessionSpace, opened.sessionId)!;
      session.watches = [watch(branch, scope)];
    }

    const report = registry.documentInterests({ space, id, limit: 1 });
    expect(report.totalMatches).toBe(2);
    expect(report.truncated).toBe(true);
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({
      principal: "owner",
      connectionId: "connection",
      watchCount: 1,
      directWatchCount: 1,
      cached: false,
      graphCount: 0,
    });
    expect(
      registry.documentInterests({ space, id, branch: "other" }).totalMatches,
    )
      .toBe(1);
    expect(registry.documentInterests({ space, id: "cid:absent" }).totalMatches)
      .toBe(0);
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) {
      expect(() => registry.documentInterests({ space, id, limit })).toThrow(
        RangeError,
      );
    }
  });

  it("reports cache-only and expired interests without pruning or reading payloads", () => {
    const registry = new SessionRegistry();
    const opened = registry.open(
      space,
      {},
      7,
      "connection",
      "service",
      "delegated-user",
    );
    const session = registry.peek(space, opened.sessionId)!;
    const entry = {
      branch: "",
      id,
      scope: "space" as const,
      scopeKey: "space" as const,
      seq: 7,
      get doc(): never {
        throw new Error("The diagnostic must not inspect document contents");
      },
    };
    session.entities.set(cacheKeyForEntity("", id), entry);
    session.viewDemandEntities.set(cacheKeyForEntity("", id), entry);
    session.ownerConnectionId = null;
    session.expiresAt = 0;
    session.seenSeq = 7;

    const report = registry.documentInterests({ space, id });
    expect(report.totalMatches).toBe(1);
    expect(report.sessions[0]).toEqual({
      sessionId: opened.sessionId,
      principal: "service",
      actingPrincipal: "delegated-user",
      connectionId: null,
      expiresAt: 0,
      expired: true,
      watchCount: 0,
      directWatchCount: 0,
      cached: true,
      graphCount: 0,
      viewDemandCached: true,
      viewDemandGraphCount: 0,
    });
    expect(JSON.stringify(report)).not.toContain(opened.sessionToken);
    expect(registry.peek(space, opened.sessionId)).toBe(session);
    expect(session.seenSeq).toBe(7);
    expect(session.entities.get(cacheKeyForEntity("", id))).toBe(entry);
  });

  it("resolves explicit instances before scope names and counts field watches", () => {
    const registry = new SessionRegistry();
    const opened = registry.open(space, {}, 0, "connection", "owner");
    const session = registry.peek(space, opened.sessionId)!;
    session.watches = [
      {
        id: "explicit-space",
        kind: "graph",
        query: {
          roots: [{
            id,
            scope: "user",
            entityScopeKey: "space",
            selector: { path: [], schema: false },
          }],
        },
      },
      {
        id: "explicit-user",
        kind: "graph",
        query: {
          roots: [{
            id,
            scope: "space",
            entityScopeKey: "user:owner",
            selector: { path: [], schema: false },
          }],
        },
      },
      {
        id: "field",
        kind: "operation",
        query: { id, path: toValuePath(["field"]) },
      },
      {
        id: "user-field",
        kind: "operation",
        query: { id, path: toValuePath(["field"]), scope: "user" },
      },
      {
        id: "other-branch-field",
        kind: "operation",
        query: { id, path: toValuePath(["field"]), branch: "other" },
      },
    ];
    expect(registry.documentInterests({ space, id }).sessions[0])
      .toMatchObject({ watchCount: 5, directWatchCount: 2 });
    expect(
      registry.documentInterests({ space, id, branch: "other" }).sessions[0]
        .directWatchCount,
    ).toBe(1);
    session.watches = [session.watches[1], session.watches[3]];
    expect(registry.documentInterests({ space, id }).totalMatches).toBe(0);
  });

  it("attributes view-demand graphs independently and isolates their branches", async () => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({ url: toFileUrl(path) });
    try {
      const registry = new SessionRegistry();
      const opened = registry.open(space, {}, 0, "connection", "owner");
      const session = registry.peek(space, opened.sessionId)!;
      const { state } = trackGraph(space, engine, {
        roots: [{ id, selector: { path: [], schema: false } }],
      });
      expect(state.entities.has(toDocKey(space, id, "space", {}))).toBe(true);
      session.viewDemandGraphs.set("main", state);
      session.viewDemandGraphs.set("other", { ...state, branch: "other" });
      const report = registry.documentInterests({ space, id });
      expect(report.totalMatches).toBe(1);
      expect(report.sessions[0]).toMatchObject({
        directWatchCount: 0,
        cached: false,
        graphCount: 0,
        viewDemandCached: false,
        viewDemandGraphCount: 1,
      });
      session.viewDemandGraphs.delete("main");
      expect(registry.documentInterests({ space, id }).totalMatches).toBe(0);
      expect(
        registry.documentInterests({ space, id, branch: "other" }).sessions[0]
          .viewDemandGraphCount,
      ).toBe(1);
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  });
});
