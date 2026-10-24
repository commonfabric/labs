import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import { ChangeSet } from "@codemirror/state";

import { aclDocId } from "../acl.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  resetServerExecutionConfig,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenResult,
  setServerExecutionConfig,
  toValuePath,
  type ViewInterest,
  type WatchSetResult,
  type WatchSpec,
} from "../v2.ts";
import { createBranch } from "../v2/engine.ts";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "../v2/execution-lease.ts";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
} from "../v2/operation-codec.ts";
import { Server } from "../v2/server.ts";
import { parseViewQuery } from "../v2/view-interest.ts";

const space = "did:key:z6Mk-view-space";
const principal = "did:key:z6Mk-view-reader";
const query = (id: string) => ({
  roots: [{ id, selector: { path: [], schema: false as const } }],
});
const watch = (id: string): WatchSpec => ({
  id,
  kind: "graph",
  query: query(id),
});
const view = (revision = 0): ViewInterest => ({
  id: "screen",
  revision,
  query: query("of:render"),
  mode: "speculate",
  componentContractVersion: "1",
});

function response<T>(messages: ServerMessage[], requestId: string): T {
  const message = messages.find((candidate) =>
    candidate.type === "response" && candidate.requestId === requestId
  ) as ResponseMessage<T> | undefined;
  if (message?.ok === undefined) {
    throw new Error(`Request failed: ${message?.error?.message}`);
  }
  return message.ok;
}

describe("view interests", () => {
  let server: Server;
  let connection: ReturnType<Server["connect"]>;
  let messages: ServerMessage[];
  let sessionId: string;
  let requests: number;

  async function set(watches: WatchSpec[], views?: ViewInterest[]) {
    const requestId = `watch-${requests++}`;
    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId,
      space,
      sessionId,
      watches,
      ...(views === undefined ? {} : { views }),
    }));
    return response<WatchSetResult>(messages, requestId).sync;
  }

  async function resume() {
    const initial = response<SessionOpenResult>(messages, "open");
    connection.close();
    connection = server.connect((message) => messages.push(message));
    const offset = messages.length;
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    }));
    const hello = messages[offset] as HelloOkMessage;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "resume-evaluation",
      space,
      session: {
        sessionId: initial.sessionId,
        sessionToken: initial.sessionToken,
      },
      invocation: {
        iss: principal,
        aud: hello.sessionOpen!.audience,
        challenge: hello.sessionOpen!.challenge.value,
      },
    }));
    expect(response<SessionOpenResult>(messages, "resume-evaluation").resumed)
      .toBe(true);
  }

  beforeEach(async () => {
    requests = 0;
    messages = [];
    server = new Server({
      store: new URL("memory://view-interests"),
      subscriptionRefreshDelayMs: "manual",
      authorizeSessionOpen: (message) =>
        typeof message.invocation?.iss === "string"
          ? message.invocation.iss
          : undefined,
      sessionOpenAuth: { audience: "did:key:z6Mk-view-audience" },
    });
    connection = server.connect((message) => messages.push(message));
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    }));
    const hello = messages[0] as HelloOkMessage;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "open",
      space,
      session: {},
      invocation: {
        iss: principal,
        aud: hello.sessionOpen!.audience,
        challenge: hello.sessionOpen!.challenge.value,
      },
    }));
    sessionId = response<SessionOpenResult>(messages, "open").sessionId;
    const result = await server.transact({
      type: "transact",
      requestId: "seed",
      space,
      sessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: ["of:ordinary", "of:render", "of:support"].map((id) => ({
          op: "set",
          id,
          value: { value: { label: id } },
        })),
      },
    });
    expect(result.error).toBeUndefined();
    setServerExecutionConfig(true);
  });

  afterEach(async () => {
    await server.close();
    resetServerExecutionConfig();
  });

  it("excludes the serving principal from visible client demand", async () => {
    await set([], [view()]);
    expect(server.viewInterestsForSpace(space, { excludePrincipal: principal }))
      .toEqual([]);
    expect(server.viewInterestsForSpace(space, { excludePrincipal: "another" }))
      .toHaveLength(1);
  });

  it("refuses view interests when server execution is disabled", async () => {
    setServerExecutionConfig(false);
    const result = await server.watchSet({
      type: "session.watch.set",
      requestId: "disabled",
      space,
      sessionId,
      watches: [],
      views: [view()],
    });
    expect(result.error?.name).toBe("ProtocolError");
    expect(server.viewInterestsForSpace(space)).toEqual([]);
  });

  it("requires a newer revision to change an existing view", async () => {
    await set([], [view(1)]);
    for (const revision of [1, 0]) {
      const result = await server.watchSet({
        type: "session.watch.set",
        requestId: "stale-view",
        space,
        sessionId,
        watches: [],
        views: [{ ...view(revision), query: query("of:support") }],
      });
      expect(result.error?.name).toBe("ProtocolError");
      expect(server.viewInterestsForSpace(space)[0].view).toEqual(view(1));
    }
    const sync = await set([], [{ ...view(2), query: query("of:support") }]);
    expect(sync.removes.map((entry) => entry.id)).toEqual(["of:render"]);
    expect(sync.upserts.map((entry) => entry.id)).toEqual(["of:support"]);
  });

  it("refuses replacement through watch addition while a view is mounted", async () => {
    await set([watch("of:ordinary")], [view()]);
    const result = await server.watchAdd({
      type: "session.watch.add",
      requestId: "replace-watch",
      space,
      sessionId,
      watches: [{
        id: "of:ordinary",
        kind: "graph",
        query: query("of:support"),
      }],
    });
    expect(result.error?.name).toBe("ProtocolError");
    expect(
      server.demandedInstancesForSpace(space).map((entry) => entry.id)
        .toSorted(),
    )
      .toEqual(["of:ordinary", "of:render"]);
    const sync = await set([watch("of:ordinary")]);
    expect(sync.upserts.map((entry) => entry.id).toSorted())
      .toEqual(["of:ordinary", "of:render"]);
  });

  it("refuses invalid planner generations without replacing valid delivery", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    expect(
      await server.setViewSelection(space, handle, {
        generation: 1,
        delivery: [query("of:support")],
      }),
    ).toBe(true);
    for (const generation of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(server.setViewSelection(space, handle, {
        generation,
        delivery: [],
      })).rejects.toThrow("Invalid view selection");
    }
    const sync = await set([]);
    expect(sync.viewPlans?.[0].generation).toBe(1);
    expect(sync.upserts.map((entry) => entry.id)).toContain("of:support");
  });

  it("rechecks read authority before accepting a planner selection", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    await server.writeDocument(space, aclDocId(space), { [space]: "OWNER" });
    server.options.acl = { mode: "enforce" };
    expect(
      await server.setViewSelection(space, handle, {
        generation: 1,
        delivery: [query("of:support")],
      }),
    ).toBe(false);
    expect(server.viewInterestsForSpace(space)[0].selectionGeneration)
      .toBeUndefined();
  });

  it("preserves delivery when a serving session selects an unnamed foreign scoped root", async () => {
    const homeSpace = "did:key:z6Mk-view-home";
    const homeEngine = await server.engineForSpace(homeSpace);
    expect(acquireExecutionLease(homeEngine, {
      space: homeSpace,
      holder: executionLeaseHolder(principal),
    })).toBe(true);
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    expect(
      await server.setViewSelection(space, handle, {
        generation: 1,
        delivery: [query("of:support")],
      }),
    ).toBe(true);

    expect(
      await server.setViewSelection(space, handle, {
        generation: 2,
        delivery: [{
          roots: [{
            id: "of:ordinary",
            scope: "user",
            selector: { path: [], schema: false },
          }],
        }],
      }),
    ).toBe(false);

    const sync = await set([]);
    expect(sync.viewPlans?.[0].generation).toBe(1);
    expect(sync.upserts.map((entry) => entry.id).toSorted()).toEqual([
      "of:render",
      "of:support",
    ]);
  });

  it("does not publish a selection evaluated across session replacement", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    const evaluate = server.evaluateWatchSet.bind(server);
    const sync = server.syncSessionForConnection.bind(server);
    const replacing = Promise.withResolvers<void>();
    let resuming: Promise<void> | undefined;
    using _sync = stub(server, "syncSessionForConnection", (...args) => {
      replacing.resolve();
      return sync(...args);
    });
    using _evaluation = stub(server, "evaluateWatchSet", async (...args) => {
      const result = await evaluate(...args);
      if (resuming === undefined) {
        resuming = resume();
        await replacing.promise;
      }
      return result;
    });
    expect(
      await server.setViewSelection(space, handle, {
        generation: 1,
        delivery: [query("of:support")],
      }),
    ).toBe(false);
    await resuming;
    expect(server.viewInterestsForSpace(space)[0].selectionGeneration)
      .toBeUndefined();
  });

  it("does not publish a watch replacement evaluated across session replacement", async () => {
    await set([], [view()]);
    const evaluate = server.evaluateWatchSet.bind(server);
    const sync = server.syncSessionForConnection.bind(server);
    const replacing = Promise.withResolvers<void>();
    let resuming: Promise<void> | undefined;
    using _sync = stub(server, "syncSessionForConnection", (...args) => {
      replacing.resolve();
      return sync(...args);
    });
    using _evaluation = stub(server, "evaluateWatchSet", async (...args) => {
      const result = await evaluate(...args);
      if (resuming === undefined) {
        resuming = resume();
        await replacing.promise;
      }
      return result;
    });
    const result = await server.watchSet({
      type: "session.watch.set",
      requestId: "replaced-session",
      space,
      sessionId,
      watches: [],
      views: [{ ...view(1), query: query("of:support") }],
    });
    expect(result.error?.name).toBe("SessionError");
    await resuming;
    expect(server.viewInterestsForSpace(space)[0].view).toEqual(view());
  });

  it("evaluates render demand once when adding supporting delivery", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    await server.setViewSelection(space, handle, {
      generation: 1,
      delivery: [query("of:support")],
    });
    const evaluations = spy(server, "evaluateWatchSet");
    try {
      await set([]);
      const renderEvaluations = evaluations.calls.filter((call) =>
        call.args[1].some((watch) =>
          watch.kind === "graph" &&
          watch.query.roots.some((root) => root.id === "of:render")
        )
      );
      expect(renderEvaluations).toHaveLength(1);
    } finally {
      evaluations.restore();
    }
  });

  it("refreshes changed render and support documents without rebuilding the watch union", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    await server.setViewSelection(space, handle, {
      generation: 1,
      delivery: [query("of:support")],
    });
    await server.flushSessions();
    messages.length = 0;
    const evaluations = spy(server, "evaluateWatchSet");
    try {
      for (const id of ["of:render", "of:support"]) {
        await server.writeDocument(space, id, { label: "updated" });
      }
      await server.flushSessions();
      const ids = messages.flatMap((message) =>
        message.type === "session/effect"
          ? message.effect.upserts.map((entry) => entry.id)
          : []
      );
      expect(ids.toSorted()).toEqual(["of:render", "of:support"]);
      expect(evaluations.calls).toHaveLength(0);
      expect(server.demandedInstancesForSpace(space).map((entry) => entry.id))
        .not.toContain("of:support");
    } finally {
      evaluations.restore();
    }
  });

  it("ignores unrelated commits without rebuilding queries or resending a manifest", async () => {
    await set([], [view()]);
    await server.flushSessions();
    messages.length = 0;
    const evaluations = spy(server, "evaluateWatchSet");
    try {
      await server.writeDocument(space, "of:ordinary", { label: "updated" });
      await server.flushSessions();
      expect(evaluations.calls).toHaveLength(0);
      expect(messages.filter((message) => message.type === "session/effect"))
        .toHaveLength(0);
    } finally {
      evaluations.restore();
    }
  });

  it("updates visible link demand incrementally and retires unreachable misses", async () => {
    const changed = spy();
    server.setServerExecutionObserver({ demandChanged: changed });
    const linked = (id: string) => ({
      primary: { "/": { "link@1": { id, path: [], space } } },
    });
    await server.writeDocument(space, "of:render", linked("of:unborn"));
    await set([], [{
      ...view(),
      query: {
        roots: [{
          id: "of:render",
          selector: {
            path: [],
            schema: {
              type: "object",
              properties: {
                primary: {
                  type: "object",
                  properties: { label: { type: "string" } },
                },
              },
            },
          },
        }],
      },
    }]);
    await server.flushSessions();
    const demanded = () =>
      server.demandedInstancesForSpace(space).map((row) => row.id);
    expect(demanded()).toContain("of:unborn");
    const notifications = changed.calls.length;
    const evaluations = spy(server, "evaluateWatchSet");
    try {
      await server.writeDocument(space, "of:render", linked("of:arriving"));
      await server.flushSessions();
      expect(demanded()).not.toContain("of:unborn");
      expect(demanded()).toContain("of:arriving");
      expect(changed.calls.slice(notifications).map((call) => call.args))
        .toEqual([[space, "push-growth", principal]]);
      messages.length = 0;
      await server.writeDocument(space, "of:unborn", { label: "orphan" });
      await server.flushSessions();
      expect(messages.filter((message) => message.type === "session/effect"))
        .toHaveLength(0);
      await server.writeDocument(space, "of:arriving", { label: "visible" });
      await server.flushSessions();
      expect(
        messages.flatMap((message) =>
          message.type === "session/effect"
            ? message.effect.upserts.map((entry) => entry.id)
            : []
        ),
      ).toContain("of:arriving");
      await server.writeDocument(space, "of:render", linked("of:next-missing"));
      await server.flushSessions();
      expect(demanded()).toContain("of:next-missing");
      expect(evaluations.calls).toHaveLength(0);
    } finally {
      evaluations.restore();
    }
  });

  it("retains detached views and marks them attached when the session resumes", async () => {
    await set([], [view()]);
    const initial = response<SessionOpenResult>(messages, "open");
    const [interest] = server.viewInterestsForSpace(space);
    expect(interest).toMatchObject({ attached: true });
    connection.close();
    expect(server.viewInterestsForSpace(space)).toEqual([
      { ...interest, attached: false },
    ]);
    connection = server.connect((message) => messages.push(message));
    const offset = messages.length;
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    }));
    const hello = messages[offset] as HelloOkMessage;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "resume",
      space,
      session: {
        sessionId: initial.sessionId,
        sessionToken: initial.sessionToken,
      },
      invocation: {
        iss: principal,
        aud: hello.sessionOpen!.audience,
        challenge: hello.sessionOpen!.challenge.value,
      },
    }));
    expect(response<SessionOpenResult>(messages, "resume").resumed).toBe(true);
    expect(server.viewInterestsForSpace(space)).toEqual([interest]);
  });

  it("keeps ordinary watch ownership independent of visible roots", async () => {
    const first = await set([watch("of:ordinary")], [view()]);
    expect(first.upserts.map((entry) => entry.id).toSorted()).toEqual([
      "of:ordinary",
      "of:render",
    ]);
    const ordinaryRemoved = await set([]);
    expect(ordinaryRemoved.upserts.map((entry) => entry.id)).toEqual([
      "of:render",
    ]);
    expect(server.viewInterestsForSpace(space)).toHaveLength(1);
    const viewRemoved = await set([watch("of:ordinary")], []);
    expect(viewRemoved.removes.map((entry) => entry.id)).toEqual(["of:render"]);
    expect(viewRemoved.upserts.map((entry) => entry.id)).toEqual([
      "of:ordinary",
    ]);
    expect(server.viewInterestsForSpace(space)).toHaveLength(0);
  });

  it("delivers selected support without adding execution demand", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    expect(
      await server.setViewSelection(space, handle, {
        generation: 1,
        delivery: [query("of:support")],
      }),
    ).toBe(true);
    const selected = await set([]);
    expect(selected.upserts.map((entry) => entry.id).toSorted()).toEqual([
      "of:render",
      "of:support",
    ]);
    expect(server.demandedInstancesForSpace(space).map((row) => row.id))
      .toEqual(["of:render"]);
    expect(
      await server.setViewSelection(space, handle, {
        generation: 2,
        delivery: [],
      }),
    ).toBe(true);
    const shrunk = await set([]);
    expect(shrunk.removes.map((entry) => entry.id)).toEqual(["of:support"]);
  });

  it("adds an ordinary watch without resending unchanged view documents", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    expect(
      await server.setViewSelection(space, handle, {
        generation: 1,
        delivery: [query("of:support")],
      }),
    ).toBe(true);
    await set([]);
    await server.flushSessions();
    const evaluations = spy(server, "evaluateWatchSet");
    try {
      const added = await server.watchAdd({
        type: "session.watch.add",
        requestId: "add-ordinary",
        space,
        sessionId,
        watches: [watch("of:ordinary")],
      });
      expect(added.error).toBeUndefined();
      expect(added.ok?.sync.upserts.map((entry) => entry.id)).toEqual([
        "of:ordinary",
      ]);
      expect(added.ok?.sync.viewPlans?.[0].generation).toBe(1);
      const unchanged = await server.watchAdd({
        type: "session.watch.add",
        requestId: "add-existing",
        space,
        sessionId,
        watches: [watch("of:ordinary")],
      });
      expect(unchanged.error).toBeUndefined();
      expect(unchanged.ok?.sync.upserts).toEqual([]);
      expect(
        server.demandedInstancesForSpace(space).map((row) => row.id).toSorted(),
      )
        .toEqual(["of:ordinary", "of:render"]);
      expect(evaluations.calls).toHaveLength(0);
    } finally {
      evaluations.restore();
    }
  });

  it("adds a watch on another branch while retaining the active view", async () => {
    const engine = await server.engineForSpace(space);
    createBranch(engine, "feature");
    await server.writeDocument(space, "of:ordinary", {
      value: { label: "updated on main" },
    });
    await set([], [view()]);
    const [session] = server.accessForTestingOnly.sessionsForSpace(space);
    const viewGraphs = new Map(session.graphs);
    expect(viewGraphs.size).toBeGreaterThan(0);

    const added = await server.watchAdd({
      type: "session.watch.add",
      requestId: "add-feature",
      space,
      sessionId,
      watches: [{
        id: "feature-owner",
        kind: "graph",
        query: { ...query("of:ordinary"), branch: "feature" },
      }],
    });
    expect(added.error).toBeUndefined();
    expect(added.ok?.sync.upserts).toHaveLength(1);
    expect(added.ok?.sync.upserts[0]).toMatchObject({
      id: "of:ordinary",
      branch: "feature",
      doc: { value: { label: "of:ordinary" } },
    });
    for (const [key, graph] of viewGraphs) {
      expect(session.graphs.get(key)).toBe(graph);
    }
    expect(session.graphs.size).toBe(viewGraphs.size + 1);
    expect(server.viewInterestsForSpace(space)[0].view).toEqual(view());

    const removed = await set([]);
    expect(removed.removes).toEqual([{
      id: "of:ordinary",
      branch: "feature",
      scope: "space",
    }]);
    expect(removed.upserts.map((entry) => entry.id)).toEqual(["of:render"]);
    expect(session.graphs.size).toBe(viewGraphs.size);
  });

  it("does not install staged view watch additions when a later query fails", async () => {
    await set([], [view()]);
    const failed = await server.watchAdd({
      type: "session.watch.add",
      requestId: "bad-add",
      space,
      sessionId,
      watches: [watch("of:ordinary"), {
        id: "invalid-schema",
        kind: "graph",
        query: {
          branch: "other",
          roots: [{
            id: "of:broken",
            selector: {
              path: [],
              schema: {
                $ref:
                  "cid:bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
              },
            },
          }],
        },
      }],
    });
    expect(failed.error).toBeDefined();
    expect(server.demandedInstancesForSpace(space).map((row) => row.id)).not
      .toContain("of:ordinary");
    const added = await server.watchAdd({
      type: "session.watch.add",
      requestId: "good-add",
      space,
      sessionId,
      watches: [watch("of:ordinary")],
    });
    expect(added.error).toBeUndefined();
    expect(added.ok?.sync.upserts.map((entry) => entry.id)).toEqual([
      "of:ordinary",
    ]);
  });

  it("rejects results from replaced and removed views even when an id is reused", async () => {
    await set([], [view()]);
    const [first] = server.viewInterestsForSpace(space);
    await set([], [view(1)]);
    expect(
      await server.setViewSelection(space, first.handle, {
        generation: 1,
        delivery: [query("of:support")],
      }),
    ).toBe(false);
    const [second] = server.viewInterestsForSpace(space);
    await set([], []);
    await set([], [view(1)]);
    expect(
      await server.setViewSelection(space, second.handle, {
        generation: 2,
        delivery: [query("of:support")],
      }),
    ).toBe(false);
  });

  it("rejects an older selection and accepts an identical replay", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    const selection = { generation: 2, delivery: [query("of:support")] };
    expect(await server.setViewSelection(space, handle, selection)).toBe(true);
    expect(await server.setViewSelection(space, handle, selection)).toBe(true);
    expect(
      await server.setViewSelection(space, handle, {
        ...selection,
        generation: 1,
      }),
    ).toBe(false);
    expect(
      await server.setViewSelection(space, handle, {
        generation: 2,
        delivery: [],
      }),
    ).toBe(false);
  });

  it("emits plan changes when the delivered documents stay identical", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    await server.setViewSelection(space, handle, {
      generation: 1,
      delivery: [query("of:support")],
      eligibleActions: ["first"],
    });
    await server.flushSessions();
    messages.length = 0;
    await server.setViewSelection(space, handle, {
      generation: 2,
      delivery: [query("of:support")],
      eligibleActions: ["second"],
    });
    await server.flushSessions();
    const effects = messages.filter((message) =>
      message.type === "session/effect"
    );
    expect(effects).toHaveLength(1);
    const effect = effects[0];
    if (effect.type !== "session/effect") {
      throw new Error("Expected session effect");
    }
    expect(effect.effect.upserts).toEqual([]);
    expect(effect.effect.viewPlans?.[0].generation).toBe(2);
    expect(effect.effect.viewPlans?.[0].eligibleActions).toEqual(["second"]);
  });

  it("isolates a stored selection from its caller's later mutations", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    const selection = {
      generation: 1,
      delivery: [query("of:support")],
      eligibleActions: ["allowed"],
    };
    await server.setViewSelection(space, handle, selection);
    selection.eligibleActions.push("unpublished");
    selection.delivery.length = 0;
    const sync = await set([]);
    expect(sync.viewPlans?.[0].eligibleActions).toEqual(["allowed"]);
    expect(sync.upserts.map((upsert) => upsert.id)).toContain("of:support");
  });

  it("leaves the current delivery intact when a selection schema is invalid", async () => {
    await set([watch("of:ordinary")], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    await expect(server.setViewSelection(space, handle, {
      generation: 1,
      delivery: [{
        roots: [{
          id: "of:support",
          selector: {
            path: [],
            schema: {
              $ref:
                "cid:bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
            },
          },
        }],
      }],
    })).rejects.toThrow();
    const sync = await set([watch("of:ordinary")]);
    expect(sync.upserts.map((upsert) => upsert.id).toSorted()).toEqual([
      "of:ordinary",
      "of:render",
    ]);
  });

  it("refuses explicit foreign instance roots at the wire boundary", async () => {
    await connection.receive(encodeMemoryBoundary({
      type: "session.watch.set",
      requestId: "invalid",
      space,
      sessionId,
      watches: [],
      views: [{
        ...view(),
        query: {
          roots: [{
            id: "of:render",
            entityScopeKey: "user:foreign",
            selector: { path: [] },
          }],
        },
      }],
    }));
    const message = messages.find((entry) =>
      entry.type === "response" && entry.requestId === "invalid"
    ) as ResponseMessage<unknown>;
    expect(message.error).toBeDefined();
    expect(server.viewInterestsForSpace(space)).toHaveLength(0);
  });
  it("rearms a plan-only failed delivery", async () => {
    await set([], [view()]);
    const [{ handle }] = server.viewInterestsForSpace(space);
    await server.setViewSelection(space, handle, {
      generation: 1,
      delivery: [query("of:support")],
      eligibleActions: ["first"],
    });
    await server.flushSessions();
    await server.setViewSelection(space, handle, {
      generation: 2,
      delivery: [query("of:support")],
      eligibleActions: ["second"],
    });
    const frame = await server.syncSessionForConnection(
      space,
      sessionId,
      new Set(),
    );
    expect(frame?.effect.upserts).toEqual([]);
    expect(frame?.effect.viewPlans?.[0].generation).toBe(2);
    server.rollbackUndeliveredSync(space, sessionId, frame!);
    const retry = await server.syncSessionForConnection(
      space,
      sessionId,
      new Set(),
    );
    expect(retry?.effect.viewPlans?.[0].generation).toBe(2);
  });

  it("retains operation cursors when adding an ordinary watch to a view", async () => {
    expect(
      (await server.transact({
        type: "transact",
        requestId: "seed-text",
        space,
        sessionId,
        commit: {
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:text",
            value: { value: { body: "a" } },
          }],
        },
      })).error,
    ).toBeUndefined();
    expect(
      (await server.transact({
        type: "transact",
        requestId: "edit-text",
        space,
        sessionId,
        commit: {
          localSeq: 3,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "apply-op",
            id: "of:text",
            path: toValuePath(["body"]),
            codec: CODEMIRROR_CHANGESET_CODEC,
            submissionId: "review:1",
            base: null,
            baselineHash: operationBaselineHash("a"),
            payload: {
              updates: [{
                clientId: "writer",
                changes: ChangeSet.of({ from: 1, insert: "b" }, 1).toJSON(),
              }],
            },
          }],
        },
      })).error,
    ).toBeUndefined();
    const original = await set([{
      id: "body-operations",
      kind: "operation",
      query: {
        id: "of:text",
        path: toValuePath(["body"]),
        after: { epoch: 1, version: 0 },
      },
    }], [view()]);
    expect(original.operationFields?.[0].field.operations).toHaveLength(1);
    const added = await server.watchAdd({
      type: "session.watch.add",
      requestId: "add",
      space,
      sessionId,
      watches: [watch("of:ordinary")],
    });
    expect(added.error).toBeUndefined();
    expect(added.ok?.sync.operationFields?.[0].field.operations).toHaveLength(
      0,
    );
  });

  it("refuses string schemas at the view query boundary", () => {
    expect(
      parseViewQuery({
        roots: [{ id: "of:render", selector: { path: [], schema: "invalid" } }],
      }),
    ).toBeNull();
    for (const schema of [true, false, { type: "string" }]) {
      expect(
        parseViewQuery({
          roots: [{ id: "of:render", selector: { path: [], schema } }],
        }),
      ).not.toBeNull();
    }
  });

  it("reuses an ordinary query under another watch ID while retaining visible demand", async () => {
    await set([watch("of:ordinary")], [view()]);
    const [session] = server.accessForTestingOnly.sessionsForSpace(space);
    const graphs = new Map(session.graphs);
    expect(graphs.size).toBeGreaterThan(0);
    using evaluations = spy(server, "evaluateWatchSet");
    const added = await server.watchAdd({
      type: "session.watch.add",
      requestId: "alias-watch",
      space,
      sessionId,
      watches: [{ ...watch("of:ordinary"), id: "another-owner" }],
    });
    expect(added.error).toBeUndefined();
    expect(added.ok?.sync.upserts).toEqual([]);
    expect(evaluations.calls).toHaveLength(0);
    expect(session.graphs.size).toBe(graphs.size);
    // The added root is covered by the record its query already made, so
    // the graph tracks and delivers what it did; only the root's
    // attribution to that record is new.
    for (const [branch, graph] of graphs) {
      const reused = session.graphs.get(branch)!;
      expect([...reused.entities]).toEqual([...graph.entities]);
      expect([...reused.tracker]).toEqual([...graph.tracker]);
      expect(reused.coveredBy.size).toBe(1);
    }
    expect(server.viewInterestsForSpace(space)).toHaveLength(1);
    expect(
      server.demandedInstancesForSpace(space).map((row) => row.id).toSorted(),
    ).toEqual(["of:ordinary", "of:render"]);
  });
});
