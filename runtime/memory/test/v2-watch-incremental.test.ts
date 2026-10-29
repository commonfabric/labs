import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { ChangeSet } from "@codemirror/state";

import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";

import {
  decodeMemoryBoundary,
  type GraphWatchSpec,
  toDirtyKey,
  toValuePath,
  type WatchSpec,
} from "../v2.ts";
import { connect, loopback, type Transport } from "../v2/client.ts";
import { createBranch } from "../v2/engine.ts";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
} from "../v2/operation-codec.ts";
import { EngineObjectManager } from "../v2/query.ts";
import { Server, SessionRegistry } from "../v2/server.ts";
import { cacheKeyForEntity } from "../v2/server-sync.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const watch = (id: string): WatchSpec => ({
  id,
  kind: "graph",
  query: { roots: [{ id, selector: { path: [], schema: false } }] },
});

const linkedWatch = (id: string): GraphWatchSpec => ({
  id,
  kind: "graph",
  query: {
    roots: [{
      id,
      selector: {
        path: [],
        schema: {
          type: "object",
          properties: {
            child: { type: "object", properties: { name: { type: "string" } } },
            second: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
        },
      },
    }],
  },
});

const link = (space: string, id: string) => ({
  "/": { "link@1": { space, id, path: [] } },
});

/** Creates an established real session and one additional stored root. */
async function openFixture(size: number) {
  const registry = new SessionRegistry();
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://incremental-watch-${crypto.randomUUID()}`),
    sessions: registry,
    subscriptionRefreshDelayMs: "manual",
  });
  const writerClient = await connect({ transport: loopback(server) });
  const readerClient = await connect({ transport: loopback(server) });
  const space = "did:key:z6Mk-incremental-watch";
  const writer = await writerClient.mount(
    space,
    {},
    testSessionOpenAuthFactory,
  );
  const reader = await readerClient.mount(
    space,
    {},
    testSessionOpenAuthFactory,
  );
  const ids = Array.from({ length: size + 1 }, (_, i) => `of:incremental-${i}`);
  await writer.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: ids.map((id) => ({
      op: "set" as const,
      id,
      value: { value: { n: 0 } },
    })),
  });
  await server.flushSessions();
  await reader.watchSetSync(ids.slice(0, size).map(watch));
  await reader.ack(1);
  const state = registry.get(space, reader.sessionId)!;
  expect(state.entities.size).toBe(size);
  return {
    server,
    writer,
    reader,
    readerClient,
    state,
    ids,
    space,
    async close() {
      await readerClient.close();
      await writerClient.close();
      await server.close();
    },
  };
}

/** Copies the observable delivery and graph state without retaining mutable sets. */
function snapshot(state: Awaited<ReturnType<typeof openFixture>>["state"]) {
  return {
    entities: [...state.entities],
    watches: [...state.watches],
    watchIndex: [...state.watchIndex],
    operationTrackedIds: [...state.operationTrackedIds],
    operationWatches: [...state.operationWatches],
    trackedIds: [...state.trackedIds],
    cursors: [...state.operationCursors],
    seenSeq: state.seenSeq,
    lastSyncedSeq: state.lastSyncedSeq,
    caughtUpLocalSeq: state.caughtUpLocalSeq,
    pendingCaughtUpLocalSeq: state.pendingCaughtUpLocalSeq,
    graphs: [...state.graphs].map(([branch, graph]) => ({
      branch,
      entities: [...graph.entities],
      tracker: [...graph.tracker].map(([key, values]) => [key, [...values]]),
      missed: [...graph.missed].map(([key, values]) => [key, [...values]]),
      missedBy: [...graph.missedBy].map(([key, values]) => [key, [...values]]),
      missesOf: [...graph.missesOf].map(([key, values]) => [key, [...values]]),
      memo: [...graph.memo],
      schemaRefs: [...graph.schemaRefs],
      loaded: graph.manager.loadedAddresses(),
    })),
  };
}

describe("Server", () => {
  describe("instance members", () => {
    describe("watchAdd()", () => {
      it("leaves a resumed session unchanged when an earlier addition completes", async () => {
        const sessions = new SessionRegistry();
        const server = new Server({
          ...testSessionOpenServerOptions,
          store: new URL(`memory://watch-resume-${crypto.randomUUID()}`),
          sessions,
          subscriptionRefreshDelayMs: "manual",
        });
        const space = "did:key:z6Mk-watch-resume";
        const opened = sessions.open(space, {}, 0, "old");
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let pending: ReturnType<Server["watchAdd"]> | undefined;
        try {
          const initial = await server.watchSet({
            type: "session.watch.set",
            requestId: "set",
            space,
            sessionId: opened.sessionId,
            watches: [watch("of:a")],
          });
          expect(initial.error).toBeUndefined();
          const original = sessions.get(space, opened.sessionId)!;
          server.accessForTestingOnly.engineOpener = async (
            requested,
            open,
          ) => {
            server.accessForTestingOnly.engineOpener = undefined;
            entered.resolve();
            await release.promise;
            return await open(requested);
          };
          pending = server.watchAdd({
            type: "session.watch.add",
            requestId: "add",
            space,
            sessionId: opened.sessionId,
            watches: [watch("of:b"), {
              id: "operation",
              kind: "operation",
              query: { id: "of:b", path: toValuePath([]) },
            }],
          });
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error(
                "Addition completed without reaching engine access",
              );
            }),
          ]);
          sessions.open(
            space,
            {
              sessionId: opened.sessionId,
              sessionToken: opened.sessionToken,
            },
            0,
            "new",
          );
          await server.syncSessionForConnection(space, opened.sessionId);
          const resumed = sessions.get(space, opened.sessionId)!;
          expect(resumed).not.toBe(original);
          const before = snapshot(resumed);
          release.resolve();
          const result = await pending;
          expect(snapshot(resumed)).toEqual(before);
          expect(result.error).toMatchObject({
            name: "SessionError",
            message: "Unknown session for space",
          });
        } finally {
          release.resolve();
          server.accessForTestingOnly.engineOpener = undefined;
          await pending;
          await server.close();
        }
      });

      it("keeps a shared miss reactive until its last branch owner departs", async () => {
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:a",
              value: { value: { child: link(fixture.space, "of:x") } },
            }],
          });
          const engine = await fixture.server.engineForSpace(fixture.space);
          createBranch(engine, "feature");
          await fixture.server.flushSessions();
          const base = linkedWatch("of:a");
          await fixture.reader.watchSetSync([base]);
          await fixture.reader.watchAddSync([{
            ...base,
            id: "feature",
            query: { ...base.query, branch: "feature" },
          }]);
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: "of:a", value: { value: {} } }],
          });
          await fixture.server.flushSessions();
          expect(fixture.state.graphs.get("")!.missed.size).toBe(0);
          expect(fixture.state.graphs.get("feature")!.missed.size).toBe(1);
          expect(fixture.state.trackedIds.has(toDirtyKey("of:x"))).toBe(true);
          await fixture.reader.watchRemoveSync(["feature"]);
          expect(fixture.state.trackedIds.has(toDirtyKey("of:x"))).toBe(false);
        } finally {
          await fixture.close();
        }
      });

      for (const graphOwnsTarget of [false, true]) {
        it(`reconciles normalized duplicate operation owners with graph ownership ${graphOwnsTarget}`, async () => {
          const fixture = await openFixture(0);
          try {
            const operations: WatchSpec[] = ["of:a", "of:b"].map((id) => ({
              id: "duplicate",
              kind: "operation",
              query: { id, path: toValuePath(["body"]) },
            }));
            await fixture.reader.watchSetSync([
              ...operations,
              ...(graphOwnsTarget ? [{ ...watch("of:a"), id: "graph-a" }] : []),
            ]);
            await fixture.reader.watchAddSync([{
              id: "empty",
              kind: "graph",
              query: { roots: [] },
            }]);
            expect(fixture.state.operationTrackedIds.has(toDirtyKey("of:a")))
              .toBe(false);
            expect(fixture.state.trackedIds.has(toDirtyKey("of:a"))).toBe(
              graphOwnsTarget,
            );
            expect(fixture.state.operationTrackedIds.has(toDirtyKey("of:b")))
              .toBe(true);
            await fixture.reader.watchRemoveSync(["graph-a"]);
            expect(fixture.state.trackedIds.has(toDirtyKey("of:a"))).toBe(
              false,
            );
          } finally {
            await fixture.close();
          }
        });
      }

      it("abandons changed miss ownership and retries against a newly created target", async () => {
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              {
                op: "set",
                id: "of:a",
                value: { value: { child: link(fixture.space, "of:x") } },
              },
              {
                op: "set",
                id: "of:b",
                value: {
                  value: {
                    child: link(fixture.space, "of:x"),
                    second: link(fixture.space, "of:y"),
                  },
                },
              },
            ],
          });
          await fixture.server.flushSessions();
          await fixture.reader.watchAddSync([linkedWatch("of:a")]);
          await fixture.reader.ack(2);
          const before = snapshot(fixture.state);
          const invalid = {
            id: "broken",
            kind: "graph",
            query: { branch: "broken", roots: [{ id: "broken" }] },
          } as unknown as WatchSpec;
          await expect(
            fixture.reader.watchAddSync([linkedWatch("of:b"), invalid]),
          ).rejects.toThrow();
          expect(snapshot(fixture.state)).toEqual(before);
          expect(fixture.state.trackedIds.has(toDirtyKey("of:y"))).toBe(false);
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:y",
              value: { value: { name: "arrived before retry" } },
            }],
          });
          await fixture.server.flushSessions();
          const retried = await fixture.reader.watchAddSync([
            linkedWatch("of:b"),
          ]);
          expect(retried.sync.upserts.map((entry) => entry.id)).toContain(
            "of:y",
          );
          await fixture.writer.transact({
            localSeq: 4,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:x",
              value: { value: { name: "shared arrival" } },
            }],
          });
          await fixture.server.flushSessions();
          expect(
            fixture.state.entities.get(cacheKeyForEntity("", "of:x", "space"))
              ?.doc,
          ).toEqual({ value: { name: "shared arrival" } });
        } finally {
          await fixture.close();
        }
      });

      it("retains an operation owner's interest after the last graph miss retires", async () => {
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:a",
              value: { value: { child: link(fixture.space, "of:x") } },
            }],
          });
          await fixture.server.flushSessions();
          await fixture.reader.watchAddSync([linkedWatch("of:a"), {
            id: "operations",
            kind: "operation",
            query: { id: "of:x", path: toValuePath(["body"]) },
          }]);
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: "of:a", value: { value: {} } }],
          });
          await fixture.server.flushSessions();
          expect(fixture.state.trackedIds.has(toDirtyKey("of:x"))).toBe(true);
          expect(
            [...fixture.state.graphs.values()].every((graph) =>
              graph.missed.size === 0
            ),
          ).toBe(true);
          await fixture.reader.watchRemoveSync(["operations"]);
          expect(fixture.state.trackedIds.has(toDirtyKey("of:x"))).toBe(false);
        } finally {
          await fixture.close();
        }
      });

      for (const removeById of [true, false]) {
        it(
          `removes a watch and the documents only it covered, by ${
            removeById ? "id" : "replacing the set"
          }`,
          async () => {
            const fixture = await openFixture(0);
            try {
              if (!removeById) {
                fixture.readerClient.serverFlags!.watchRemoveV1 = false;
              }
              await fixture.writer.transact({
                localSeq: 2,
                reads: { confirmed: [], pending: [] },
                operations: [
                  {
                    op: "set",
                    id: "of:a",
                    value: { value: { child: link(fixture.space, "of:x") } },
                  },
                  {
                    op: "set",
                    id: "of:b",
                    value: {
                      value: {
                        child: link(fixture.space, "of:x"),
                        second: link(fixture.space, "of:y"),
                      },
                    },
                  },
                  { op: "set", id: "of:x", value: { value: { name: "x" } } },
                  { op: "set", id: "of:y", value: { value: { name: "y" } } },
                ],
              });
              await fixture.server.flushSessions();
              await fixture.reader.watchAddSync([
                linkedWatch("of:a"),
                linkedWatch("of:b"),
              ]);
              await fixture.reader.ack(2);
              const removal = await fixture.reader.watchRemoveSync(["of:b"]);
              const ids = (entries: readonly { id: string }[]) =>
                entries.map((entry) => entry.id).toSorted();
              expect(ids(removal.sync.removes)).toEqual(["of:b", "of:y"]);
              // A removal by id resends nothing the session still holds; a
              // replacement without holdings resends the whole union.
              expect(ids(removal.sync.upserts)).toEqual(
                removeById ? [] : ["of:a", "of:x"],
              );
              expect(fixture.state.watches.map((watch) => watch.id)).toEqual([
                "of:a",
              ]);
              expect([...fixture.state.entities.keys()].toSorted()).toEqual(
                [
                  cacheKeyForEntity("", "of:a"),
                  cacheKeyForEntity("", "of:x"),
                ].toSorted(),
              );
            } finally {
              await fixture.close();
            }
          },
        );
      }

      it("reads removal by id from the server, and leaves it out of the client's own hello", async () => {
        // An older routed host refuses a `hello` carrying a flag it does not
        // know, so the capability travels only in `hello.ok`.
        const fixture = await openFixture(0);
        try {
          const inner = loopback(fixture.server);
          const sent: unknown[] = [];
          const transport: Transport = Object.assign(Object.create(inner), {
            send: (payload: string) => {
              sent.push(decodeMemoryBoundary(payload));
              return inner.send(payload);
            },
          });
          const client = await connect({ transport });
          const hello = sent.find((frame) =>
            (frame as { type?: unknown }).type === "hello"
          ) as { flags: Record<string, unknown> } | undefined;
          expect(hello).toBeDefined();
          expect(hello!.flags).not.toHaveProperty("watchRemoveV1");
          expect(client.serverFlags?.watchRemoveV1).toBe(true);
          await client.close();
        } finally {
          await fixture.close();
        }
      });

      it("ignores a removal naming a watch the session does not hold", async () => {
        const fixture = await openFixture(1);
        try {
          const removal = await fixture.reader.watchRemoveSync(["unknown"]);
          expect(removal.sync.upserts).toEqual([]);
          expect(removal.sync.removes).toEqual([]);
          expect(fixture.state.watches.map((watch) => watch.id)).toEqual([
            fixture.ids[0],
          ]);
        } finally {
          await fixture.close();
        }
      });

      it("publishes a large valid batch without an argument-count limit", async () => {
        const fixture = await openFixture(0);
        try {
          const watches: WatchSpec[] = Array.from(
            { length: 130_000 },
            (_, i) => ({
              id: `empty-${i}`,
              kind: "graph",
              query: { roots: [] },
            }),
          );
          const result = await fixture.reader.watchAddSync(watches);
          expect(result.sync.upserts).toEqual([]);
          expect(fixture.state.watches).toHaveLength(watches.length);
          expect(fixture.state.watchIndex.size).toBe(watches.length);
        } finally {
          await fixture.close();
        }
      });

      it("retains the last duplicate addition when graph and operation watches share an ID", async () => {
        const fixture = await openFixture(2);
        try {
          const added = await fixture.reader.watchAddSync([
            {
              id: "duplicate",
              kind: "operation",
              query: { id: fixture.ids[0], path: toValuePath([]) },
            },
            { ...watch(fixture.ids[1]), id: "duplicate" },
          ]);
          expect(added.sync.operationFields?.[0].watchId).toBe("duplicate");
          await fixture.reader.watchRemoveSync([fixture.ids[0]]);
          expect(fixture.state.watches).toEqual([
            watch(fixture.ids[1]),
            { ...watch(fixture.ids[1]), id: "duplicate" },
          ]);
          expect(fixture.state.operationWatches).toEqual([]);
          expect(fixture.state.trackedIds.has(toDirtyKey(fixture.ids[0])))
            .toBe(false);
          expect(fixture.state.trackedIds.has(toDirtyKey(fixture.ids[1])))
            .toBe(true);
        } finally {
          await fixture.close();
        }
      });

      it("keeps unsupported content types absent without hiding the stored JSON document", async () => {
        const fixture = await openFixture(1);
        try {
          const manager = [...fixture.state.graphs.values()][0].manager;
          const address = { id: fixture.ids[0], type: "text/plain" };
          expect(manager.load(address)).toBeNull();
          expect(manager.load(address)).toBeNull();
          expect(manager.load({ id: fixture.ids[0] })).not.toBeNull();
          expect(
            manager.loadedAddresses().every((entry) =>
              entry.type === "application/json"
            ),
          ).toBe(true);
        } finally {
          await fixture.close();
        }
      });

      it("retains accepted duplicate-id roots when removing an unrelated watch", async () => {
        const fixture = await openFixture(2);
        try {
          const installed = await fixture.reader.watchSetSync([
            { ...watch(fixture.ids[0]), id: "duplicate" },
            { ...watch(fixture.ids[1]), id: "duplicate" },
          ]);
          expect(installed.view.snapshot().entities.map((entry) => entry.id))
            .toEqual(fixture.ids.slice(0, 2));
          const removed = await fixture.reader.watchRemoveSync([
            "not-installed",
          ]);
          expect(removed.sync.removes).toEqual([]);
          expect(removed.view.snapshot().entities.map((entry) => entry.id))
            .toEqual(fixture.ids.slice(0, 2));
        } finally {
          await fixture.close();
        }
      });

      it("leaves established delivery and graph state unchanged when a later branch fails", async () => {
        const fixture = await openFixture(64);
        try {
          const before = snapshot(fixture.state);
          const invalid = {
            id: "broken",
            kind: "graph",
            query: { branch: "branch:broken", roots: [{ id: "of:broken" }] },
          } as unknown as WatchSpec;
          await expect(fixture.reader.watchAddSync([
            watch(fixture.ids[64]),
            invalid,
          ])).rejects.toThrow();
          expect(snapshot(fixture.state)).toEqual(before);
          const added = await fixture.reader.watchAddSync([
            watch(fixture.ids[64]),
          ]);
          expect(added.sync.upserts.map((entry) => entry.id)).toEqual([
            fixture.ids[64],
          ]);
          expect(fixture.state.entities.size).toBe(65);
        } finally {
          await fixture.close();
        }
      });

      it("rolls back graph and cursor changes when a later operation snapshot fails", async () => {
        const fixture = await openFixture(32);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:text",
              value: { value: { body: "a" } },
            }],
          });
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: "of:text",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: "writer:text",
              base: null,
              baselineHash: operationBaselineHash("a"),
              payload: {
                updates: [{
                  clientId: "writer",
                  changes: ChangeSet.of({ from: 1, insert: "b" }, 1).toJSON(),
                }],
              },
            }],
          });
          await fixture.server.flushSessions();
          await fixture.reader.ack(3);
          const operation: WatchSpec = {
            id: "valid-operation",
            kind: "operation",
            query: {
              id: "of:text",
              path: toValuePath(["body"]),
              after: { epoch: 1, version: 0 },
            },
          };
          const invalid: WatchSpec = {
            ...operation,
            id: "future-operation",
            query: { ...operation.query, after: { epoch: 1, version: 99 } },
          };
          const before = snapshot(fixture.state);
          await expect(
            fixture.reader.watchAddSync([
              watch(fixture.ids[32]),
              operation,
              invalid,
            ]),
          ).rejects.toThrow("cursor is in the future");
          expect(snapshot(fixture.state)).toEqual(before);
          const added = await fixture.reader.watchAddSync([
            watch(fixture.ids[32]),
            operation,
          ]);
          expect(added.sync.upserts.map((entry) => entry.id)).toEqual([
            fixture.ids[32],
          ]);
          expect(added.sync.operationFields?.[0].field).toMatchObject({
            cursor: { epoch: 1, version: 1 },
            materialized: "ab",
          });
        } finally {
          await fixture.close();
        }
      });

      it("keeps an in-flight operation snapshot paired with its original cursors", async () => {
        const fixture = await openFixture(0);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let pending: ReturnType<Server["syncSessionForConnection"]> | undefined;
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: ["of:a", "of:b"].map((id) => ({
              op: "set" as const,
              id,
              value: { value: { body: "a" } },
            })),
          });
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: ["of:a", "of:b"].map((id) => ({
              op: "apply-op" as const,
              id,
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: `first:${id}`,
              base: null,
              baselineHash: operationBaselineHash("a"),
              payload: {
                updates: [{
                  clientId: "writer",
                  changes: ChangeSet.of({ from: 1, insert: "b" }, 1).toJSON(),
                }],
              },
            })),
          });
          await fixture.writer.transact({
            localSeq: 4,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: "of:b",
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: "second:b",
              base: { epoch: 1, version: 1 },
              payload: {
                updates: [{
                  clientId: "writer",
                  changes: ChangeSet.of({ from: 2, insert: "c" }, 2).toJSON(),
                }],
              },
            }],
          });
          await fixture.server.flushSessions();
          await fixture.reader.watchSetSync([{
            id: "shared",
            kind: "operation",
            query: { id: "of:a", path: toValuePath(["body"]) },
          }]);
          const originalCursors = fixture.state.operationCursors;
          expect(originalCursors.get("shared")).toEqual({
            epoch: 1,
            version: 1,
          });
          const beforeSeq = fixture.state.lastSyncedSeq;
          await fixture.writer.transact({
            localSeq: 5,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: "of:tick", value: { value: 1 } }],
          });
          fixture.server.accessForTestingOnly.engineOpener = async (
            space,
            open,
          ) => {
            if (
              space === fixture.space && fixture.state.lastSyncedSeq > beforeSeq
            ) {
              fixture.server.accessForTestingOnly.engineOpener = undefined;
              entered.resolve();
              await release.promise;
            }
            return await open(space);
          };
          pending = fixture.server.syncSessionForConnection(
            fixture.space,
            fixture.reader.sessionId,
            new Set([toDirtyKey("of:tick")]),
          );
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error(
                "Refresh completed without reaching operation attachment",
              );
            }),
          ]);
          const replacement = await fixture.reader.watchSetSync([{
            id: "shared",
            kind: "operation",
            query: { id: "of:b", path: toValuePath(["body"]) },
          }]);
          expect(replacement.sync.operationFields?.[0].field).toMatchObject({
            id: "of:b",
            cursor: { epoch: 1, version: 2 },
            materialized: "abc",
          });
          const replacementCursors = fixture.state.operationCursors;
          expect(replacementCursors).not.toBe(originalCursors);
          release.resolve();
          const effect = await pending;
          expect(effect?.effect.operationFields?.[0].field).toMatchObject({
            id: "of:a",
            cursor: { epoch: 1, version: 1 },
            materialized: "ab",
            operations: [],
          });
          expect(fixture.state.operationCursors).toBe(replacementCursors);
          expect(replacementCursors.get("shared")).toEqual({
            epoch: 1,
            version: 2,
          });
        } finally {
          release.resolve();
          fixture.server.accessForTestingOnly.engineOpener = undefined;
          await pending?.catch(() => {});
          await fixture.close();
        }
      });

      for (const size of [32, 256]) {
        it(`refreshes without filtering the ${size} established graph watches for operation fields`, async () => {
          const fixture = await openFixture(size);
          const watches = fixture.state.watches;
          const filter = watches.filter;
          const some = watches.some;
          let visited = 0;
          watches.filter = ((...args: unknown[]) => {
            visited += watches.length;
            return Reflect.apply(filter, watches, args);
          }) as typeof filter;
          watches.some = (...args) => {
            visited += watches.length;
            return Reflect.apply(some, watches, args);
          };
          try {
            await fixture.writer.transact({
              localSeq: 2,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: fixture.ids[0],
                value: { value: { n: 1 } },
              }],
            });
            await fixture.server.flushSessions();
            await fixture.server.syncSessionForConnection(
              fixture.space,
              fixture.reader.sessionId,
              new Set([toDirtyKey("of:unwatched")]),
            );
            expect(visited).toBe(0);
          } finally {
            watches.filter = filter;
            watches.some = some;
            await fixture.close();
          }
        });

        it(`adds one root without enumerating the ${size} established delivered entries`, async () => {
          const fixture = await openFixture(size);
          const map = fixture.state.entities;
          const iterator = map[Symbol.iterator];
          const values = map.values;
          let visited = 0;
          map[Symbol.iterator] = function* () {
            for (const entry of iterator.call(this)) {
              visited++;
              yield entry;
            }
            return undefined;
          };
          map.values = function* () {
            for (const value of values.call(this)) {
              visited++;
              yield value;
            }
            return undefined;
          };
          try {
            const added = await fixture.reader.watchAddSync([
              watch(fixture.ids[size]),
            ]);
            expect(added.sync.upserts.map((entry) => entry.id)).toEqual([
              fixture.ids[size],
            ]);
            expect(visited).toBe(0);
          } finally {
            map[Symbol.iterator] = iterator;
            map.values = values;
            await fixture.close();
          }
        });

        it(`refreshes one root without enumerating the ${size} established delivered entries`, async () => {
          const fixture = await openFixture(size);
          const maps: Map<string, unknown>[] = [
            fixture.state.entities,
            ...[...fixture.state.graphs.values()].map((graph) =>
              graph.entities
            ),
          ];
          const restore: Array<() => void> = [];
          let visited = 0;
          for (const map of maps) {
            const iterator = map[Symbol.iterator];
            const values = map.values;
            map[Symbol.iterator] = function* () {
              for (const entry of iterator.call(this)) {
                visited++;
                yield entry;
              }
              return undefined;
            };
            map.values = function* () {
              for (const value of values.call(this)) {
                visited++;
                yield value;
              }
              return undefined;
            };
            restore.push(() => {
              map[Symbol.iterator] = iterator;
              map.values = values;
            });
          }
          try {
            await fixture.writer.transact({
              localSeq: 2,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "set",
                id: fixture.ids[0],
                value: { value: { n: 1 } },
              }],
            });
            await fixture.server.flushSessions();
            expect(
              fixture.state.entities.get(
                cacheKeyForEntity("", fixture.ids[0], "space"),
              )
                ?.doc,
            ).toEqual({ value: { n: 1 } });
            expect(visited).toBe(0);
          } finally {
            for (const undo of restore) undo();
            await fixture.close();
          }
        });

        it(`adds one root without scanning the ${size} established manager addresses`, async () => {
          const fixture = await openFixture(size);
          const loaded = EngineObjectManager.prototype.loadedAddresses;
          let visited = 0;
          EngineObjectManager.prototype.loadedAddresses = function () {
            const addresses = loaded.call(this);
            visited += addresses.length;
            return addresses;
          };
          try {
            const added = await fixture.reader.watchAddSync([
              watch(fixture.ids[size]),
            ]);
            expect(added.sync.upserts.map((entry) => entry.id)).toEqual([
              fixture.ids[size],
            ]);
            expect(visited).toBeLessThanOrEqual(4);
          } finally {
            EngineObjectManager.prototype.loadedAddresses = loaded;
            await fixture.close();
          }
        });
      }
    });

    describe("watchRemove()", () => {
      // `of:a` links to `of:x` and `of:y`. A `true` schema on `of:a` reaches
      // both, and a schema naming `child` alone reaches `of:x` alone, so the
      // narrower watch added after the permissive one is covered by the
      // permissive one's record rather than walked.

      const permissive = (id: string): GraphWatchSpec => ({
        id: `${id}:all`,
        kind: "graph",
        query: { roots: [{ id, selector: { path: [], schema: true } }] },
      });

      const narrow = (id: string): GraphWatchSpec => ({
        id,
        kind: "graph",
        query: {
          roots: [{
            id,
            selector: {
              path: [],
              schema: {
                type: "object",
                properties: {
                  child: {
                    type: "object",
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
          }],
        },
      });

      const ids = (entries: readonly { id: string }[]) =>
        entries.map((entry) => entry.id).toSorted();

      /** A link to `id` whose schema position carries `$ref: cid:<hash>`. */
      const linkWithSchemaRef = (id: string, hash: string) => ({
        "/": {
          "link@1": { id, path: [], schema: { $ref: `cid:${hash}` } },
        },
      });

      /** A watch on `id` whose selector schema is `$ref: cid:<hash>`. */
      const selectorWatch = (id: string, hash: string): GraphWatchSpec => ({
        id,
        kind: "graph",
        query: {
          roots: [{
            id,
            selector: { path: [], schema: { $ref: `cid:${hash}` } },
          }],
        },
      });

      /** A schema document naming `title`, and one referring to it. */
      const schemaPair = (title: string) => {
        const leaf = { type: "string", title } as const;
        const leafHash = internSchemaAsTaggedHashString(leaf);
        const outer = {
          type: "object",
          properties: { x: { $ref: `cid:${leafHash}` } },
        } as const;
        const outerHash = internSchemaAsTaggedHashString(outer);
        return {
          leafHash,
          outerHash,
          ids: [`cid:${leafHash}`, `cid:${outerHash}`],
          operations: [
            {
              op: "set" as const,
              id: `cid:${leafHash}`,
              value: { value: leaf },
            },
            {
              op: "set" as const,
              id: `cid:${outerHash}`,
              value: { value: outer },
            },
          ],
        };
      };

      /** Opens a session watching `of:a` permissively, then narrowly. */
      async function openCoveredFixture() {
        const fixture = await openFixture(0);
        await fixture.writer.transact({
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [
            {
              op: "set",
              id: "of:a",
              value: {
                value: {
                  child: link(fixture.space, "of:x"),
                  second: link(fixture.space, "of:y"),
                },
              },
            },
            { op: "set", id: "of:x", value: { value: { name: "x" } } },
            { op: "set", id: "of:y", value: { value: { name: "y" } } },
          ],
        });
        await fixture.server.flushSessions();
        await fixture.reader.watchAddSync([permissive("of:a")]);
        await fixture.reader.watchAddSync([narrow("of:a")]);
        await fixture.reader.ack(2);
        return fixture;
      }

      it("leaves the graph as it stands when a covered watch is removed", async () => {
        const fixture = await openCoveredFixture();
        try {
          const graph = fixture.state.graphs.get("")!;
          const before = snapshot(fixture.state);
          const removal = await fixture.reader.watchRemoveSync(["of:a"]);
          expect(removal.sync.upserts).toEqual([]);
          expect(removal.sync.removes).toEqual([]);
          expect(fixture.state.graphs.get("")).toBe(graph);
          const after = snapshot(fixture.state);
          expect(after.graphs).toEqual(before.graphs);
          expect(after.entities).toEqual(before.entities);
          expect(after.trackedIds).toEqual(before.trackedIds);
          expect(fixture.state.watches.map((watch) => watch.id)).toEqual([
            "of:a:all",
          ]);
        } finally {
          await fixture.close();
        }
      });

      it("walks a covered watch when the watch covering it is removed, and removes what only the removed watch reached", async () => {
        const fixture = await openCoveredFixture();
        try {
          const removal = await fixture.reader.watchRemoveSync(["of:a:all"]);
          expect(ids(removal.sync.removes)).toEqual(["of:y"]);
          expect(removal.sync.upserts).toEqual([]);
          expect(ids([...fixture.state.entities.values()])).toEqual([
            "of:a",
            "of:x",
          ]);
          expect(fixture.state.watches.map((watch) => watch.id)).toEqual([
            "of:a",
          ]);
          expect(fixture.state.trackedIds.has(toDirtyKey("of:x"))).toBe(true);
          expect(fixture.state.trackedIds.has(toDirtyKey("of:y"))).toBe(
            false,
          );
        } finally {
          await fixture.close();
        }
      });

      it("keeps a watch covered while any walked watch still covers it", async () => {
        // `of:b` links to `of:a`, so a `true` schema on `of:b` covers the
        // narrow watch on `of:a` as the permissive watch on `of:a` does.
        const fixture = await openCoveredFixture();
        try {
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:b",
              value: { value: { child: link(fixture.space, "of:a") } },
            }],
          });
          await fixture.server.flushSessions();
          await fixture.reader.watchAddSync([permissive("of:b")]);
          const first = await fixture.reader.watchRemoveSync(["of:a:all"]);
          expect(first.sync.removes).toEqual([]);
          expect(ids([...fixture.state.entities.values()])).toEqual([
            "of:a",
            "of:b",
            "of:x",
            "of:y",
          ]);
          const second = await fixture.reader.watchRemoveSync(["of:b:all"]);
          expect(ids(second.sync.removes)).toEqual(["of:b", "of:y"]);
          expect(ids([...fixture.state.entities.values()])).toEqual([
            "of:a",
            "of:x",
          ]);
        } finally {
          await fixture.close();
        }
      });

      it("retracts, at the refresh, a document a link no longer reaches, and keeps one a watch of its own names", async () => {
        // The permissive watch on `of:a` covers a watch on `of:x` while the
        // link stands. Once the link is gone, the watch on `of:x` is what
        // keeps `of:x` delivered, and nothing keeps `of:y`.
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              {
                op: "set",
                id: "of:a",
                value: {
                  value: {
                    child: link(fixture.space, "of:x"),
                    second: link(fixture.space, "of:y"),
                  },
                },
              },
              { op: "set", id: "of:x", value: { value: { name: "x" } } },
              { op: "set", id: "of:y", value: { value: { name: "y" } } },
            ],
          });
          await fixture.server.flushSessions();
          await fixture.reader.watchAddSync([permissive("of:a")]);
          const { view } = await fixture.reader.watchAddSync([watch("of:x")]);
          const frames = view.subscribeSync();
          const pushed = frames.next();
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: "of:a", value: { value: {} } }],
          });
          await fixture.server.flushSessions();
          const { value: frame } = await pushed;
          expect(ids(frame!.removes)).toEqual(["of:y"]);
          expect(ids(frame!.upserts)).toEqual(["of:a"]);
          expect(ids([...fixture.state.entities.values()])).toEqual([
            "of:a",
            "of:x",
          ]);
          const removal = await fixture.reader.watchRemoveSync(["of:x"]);
          expect(ids(removal.sync.removes)).toEqual(["of:x"]);
          expect(ids([...fixture.state.entities.values()])).toEqual(["of:a"]);
        } finally {
          await fixture.close();
        }
      });

      it("delivers a root added again after its removal with what it reaches, at the version stored", async () => {
        // Removing the watch retires `of:a` and `of:x`, and the graph's
        // read cache and traversal memo let go of both: adding the watch
        // again reads `of:a` as it was written in between, and walks
        // `of:x` below it. The watch on `of:b` keeps the graph throughout.
        const fixture = await openFixture(0);
        const rootValue = (n: number) => ({
          value: { child: link(fixture.space, "of:x"), n },
        });
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: "of:a", value: rootValue(1) },
              { op: "set", id: "of:x", value: { value: { name: "x" } } },
              { op: "set", id: "of:b", value: { value: { name: "b" } } },
            ],
          });
          await fixture.server.flushSessions();
          await fixture.reader.watchAddSync([
            permissive("of:a"),
            watch("of:b"),
          ]);
          const removal = await fixture.reader.watchRemoveSync(["of:a:all"]);
          expect(ids(removal.sync.removes)).toEqual(["of:a", "of:x"]);
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: "of:a", value: rootValue(2) }],
          });
          await fixture.server.flushSessions();
          const added = await fixture.reader.watchAddSync([permissive("of:a")]);
          expect(ids(added.sync.upserts)).toEqual(["of:a", "of:x"]);
          expect(
            added.sync.upserts.find((entry) => entry.id === "of:a")?.doc,
          ).toEqual(rootValue(2));
          expect(ids([...fixture.state.entities.values()])).toEqual([
            "of:a",
            "of:b",
            "of:x",
          ]);
        } finally {
          await fixture.close();
        }
      });

      it("retracts, with a removed root, the schema documents only its own refs reach", async () => {
        // `of:a` and `of:b` are walked in one evaluation, each linking
        // under a `$ref` schema of its own. Each keeps the closure its own
        // refs reach and no other, so removing `of:a` retracts its schema
        // document and leaves the one `of:b` refers to delivered.
        const onlyA = { type: "string", title: "only-a" } as const;
        const onlyAHash = internSchemaAsTaggedHashString(onlyA);
        const onlyB = { type: "string", title: "only-b" } as const;
        const onlyBHash = internSchemaAsTaggedHashString(onlyB);
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: `cid:${onlyAHash}`, value: { value: onlyA } },
              { op: "set", id: `cid:${onlyBHash}`, value: { value: onlyB } },
              { op: "set", id: "of:t", value: { value: { n: 1 } } },
              {
                op: "set",
                id: "of:a",
                value: { value: { x: linkWithSchemaRef("of:t", onlyAHash) } },
              },
              {
                op: "set",
                id: "of:b",
                value: { value: { x: linkWithSchemaRef("of:t", onlyBHash) } },
              },
            ],
          });
          await fixture.server.flushSessions();
          await fixture.reader.watchAddSync([watch("of:a"), watch("of:b")]);
          expect(ids([...fixture.state.entities.values()])).toEqual(
            [`cid:${onlyAHash}`, `cid:${onlyBHash}`, "of:a", "of:b"].toSorted(),
          );
          const removal = await fixture.reader.watchRemoveSync(["of:a"]);
          expect(ids(removal.sync.removes)).toEqual(
            [`cid:${onlyAHash}`, "of:a"].toSorted(),
          );
          expect(ids([...fixture.state.entities.values()])).toEqual(
            [`cid:${onlyBHash}`, "of:b"].toSorted(),
          );
        } finally {
          await fixture.close();
        }
      });

      it("walks, for a root added later, a document a refresh retired, at the version that refresh read", async () => {
        // One write unlinks `of:x` from `of:a` and relinks `of:x` to a new
        // `of:y`. The refresh reads the new `of:x` and then retires it,
        // and the graph's cache lets go of it when the refresh's reads are
        // merged in, so a watch on `of:x` added afterwards walks it and
        // reaches `of:y`.
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              {
                op: "set",
                id: "of:a",
                value: { value: { child: link(fixture.space, "of:x") } },
              },
              { op: "set", id: "of:x", value: { value: { name: "x" } } },
              { op: "set", id: "of:b", value: { value: { name: "b" } } },
            ],
          });
          await fixture.server.flushSessions();
          const { view } = await fixture.reader.watchAddSync([
            permissive("of:a"),
            watch("of:b"),
          ]);
          const frames = view.subscribeSync();
          const pushed = frames.next();
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: "of:a", value: { value: {} } },
              {
                op: "set",
                id: "of:x",
                value: { value: { child: link(fixture.space, "of:y") } },
              },
              { op: "set", id: "of:y", value: { value: { name: "y" } } },
            ],
          });
          await fixture.server.flushSessions();
          const { value: frame } = await pushed;
          expect(ids(frame!.removes)).toEqual(["of:x"]);
          const added = await fixture.reader.watchAddSync([permissive("of:x")]);
          expect(ids(added.sync.upserts)).toEqual(["of:x", "of:y"]);
          expect(ids([...fixture.state.entities.values()])).toEqual([
            "of:a",
            "of:b",
            "of:x",
            "of:y",
          ]);
        } finally {
          await fixture.close();
        }
      });

      it("keeps, at the refresh, a schema document the selector needs when the content stops referring to it", async () => {
        // The watch's selector is `outer`, which refers to `leaf`, and the
        // document's link carries the same ref. Replacing the document
        // with a value carrying no ref releases what the content kept and
        // nothing the selector's walk keeps, so both stay delivered.
        const leaf = { type: "string", title: "selector-leaf" } as const;
        const leafHash = internSchemaAsTaggedHashString(leaf);
        const outer = {
          type: "object",
          properties: { x: { $ref: `cid:${leafHash}` } },
        } as const;
        const outerHash = internSchemaAsTaggedHashString(outer);
        const selectorWatch: GraphWatchSpec = {
          id: "of:a",
          kind: "graph",
          query: {
            roots: [{
              id: "of:a",
              selector: { path: [], schema: { $ref: `cid:${outerHash}` } },
            }],
          },
        };
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: `cid:${leafHash}`, value: { value: leaf } },
              { op: "set", id: `cid:${outerHash}`, value: { value: outer } },
              { op: "set", id: "of:t", value: { value: { n: 1 } } },
              {
                op: "set",
                id: "of:a",
                value: { value: { x: linkWithSchemaRef("of:t", outerHash) } },
              },
            ],
          });
          await fixture.server.flushSessions();
          const { view } = await fixture.reader.watchAddSync([selectorWatch]);
          const delivered = () => ids([...fixture.state.entities.values()]);
          expect(delivered()).toEqual(
            [`cid:${leafHash}`, `cid:${outerHash}`, "of:a", "of:t"].toSorted(),
          );
          const frames = view.subscribeSync();
          const pushed = frames.next();
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: "of:a", value: { value: {} } }],
          });
          await fixture.server.flushSessions();
          const { value: frame } = await pushed;
          expect(ids(frame!.removes)).toEqual(["of:t"]);
          expect(ids(frame!.upserts)).toEqual(["of:a"]);
          expect(delivered()).toEqual(
            [`cid:${leafHash}`, `cid:${outerHash}`, "of:a"].toSorted(),
          );
        } finally {
          await fixture.close();
        }
      });

      it("delivers a link target born after the watch reaching it was removed, once that watch is added again", async () => {
        // `of:a` links to `of:x`, which does not exist. Removing the watch
        // retires the miss, and the graph's cache lets go of the absence
        // with it; `of:x` written in between is read when the watch is
        // added again. The watch on `of:b` keeps the graph throughout.
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              {
                op: "set",
                id: "of:a",
                value: { value: { child: link(fixture.space, "of:x") } },
              },
              { op: "set", id: "of:b", value: { value: { name: "b" } } },
            ],
          });
          await fixture.server.flushSessions();
          await fixture.reader.watchAddSync([
            permissive("of:a"),
            watch("of:b"),
          ]);
          const removal = await fixture.reader.watchRemoveSync(["of:a:all"]);
          expect(ids(removal.sync.removes)).toEqual(["of:a"]);
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: "of:x", value: { value: { name: "x" } } },
            ],
          });
          await fixture.server.flushSessions();
          const added = await fixture.reader.watchAddSync([permissive("of:a")]);
          expect(ids(added.sync.upserts)).toEqual(["of:a", "of:x"]);
          expect(ids([...fixture.state.entities.values()])).toEqual([
            "of:a",
            "of:b",
            "of:x",
          ]);
        } finally {
          await fixture.close();
        }
      });

      it("retracts, at the refresh, the schema documents a followed link's schema reached, when the link goes", async () => {
        // A permissive walk of `of:a` follows its link to `of:t` and loads
        // the link schema's closure, `outer` and `leaf`, which the content
        // keeps as well. Replacing `of:a` with a value holding no link
        // retracts all three: a schema document keeps the ones it refers
        // to, never itself.
        const leaf = { type: "string", title: "followed-leaf" } as const;
        const leafHash = internSchemaAsTaggedHashString(leaf);
        const outer = {
          type: "object",
          properties: { x: { $ref: `cid:${leafHash}` } },
        } as const;
        const outerHash = internSchemaAsTaggedHashString(outer);
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: `cid:${leafHash}`, value: { value: leaf } },
              { op: "set", id: `cid:${outerHash}`, value: { value: outer } },
              { op: "set", id: "of:t", value: { value: { x: "t" } } },
              {
                op: "set",
                id: "of:a",
                value: { value: { x: linkWithSchemaRef("of:t", outerHash) } },
              },
            ],
          });
          await fixture.server.flushSessions();
          const { view } = await fixture.reader.watchAddSync([
            permissive("of:a"),
          ]);
          const delivered = () => ids([...fixture.state.entities.values()]);
          expect(delivered()).toEqual(
            [`cid:${leafHash}`, `cid:${outerHash}`, "of:a", "of:t"].toSorted(),
          );
          const frames = view.subscribeSync();
          const pushed = frames.next();
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: "of:a", value: { value: {} } }],
          });
          await fixture.server.flushSessions();
          const { value: frame } = await pushed;
          expect(ids(frame!.removes)).toEqual(
            [`cid:${leafHash}`, `cid:${outerHash}`, "of:t"].toSorted(),
          );
          expect(ids(frame!.upserts)).toEqual(["of:a"]);
          expect(delivered()).toEqual(["of:a"]);
        } finally {
          await fixture.close();
        }
      });

      it("delivers a schema document again to a watch needing it after a refresh retracted it", async () => {
        // The watch on `of:a` is added while the write of `of:a` and its
        // schema document is still to be refreshed, so the refresh that
        // follows the write dropping the ref reads the schema document
        // again as well as retiring it. What it retired leaves the graph,
        // and a watch on `of:b`, which refers to the schema document, is
        // delivered the document with it.
        const only = { type: "string", title: "redelivered" } as const;
        const onlyHash = internSchemaAsTaggedHashString(only);
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: `cid:${onlyHash}`, value: { value: only } },
              { op: "set", id: "of:t", value: { value: { n: 1 } } },
              {
                op: "set",
                id: "of:a",
                value: { value: { x: linkWithSchemaRef("of:t", onlyHash) } },
              },
            ],
          });
          const { view } = await fixture.reader.watchAddSync([watch("of:a")]);
          const delivered = () => ids([...fixture.state.entities.values()]);
          expect(delivered()).toEqual([`cid:${onlyHash}`, "of:a"].toSorted());
          const frames = view.subscribeSync();
          const pushed = frames.next();
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: "of:a", value: { value: {} } }],
          });
          await fixture.server.flushSessions();
          const { value: frame } = await pushed;
          expect(ids(frame!.removes)).toEqual([`cid:${onlyHash}`]);
          expect(delivered()).toEqual(["of:a"]);
          await fixture.writer.transact({
            localSeq: 4,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:b",
              value: { value: { x: linkWithSchemaRef("of:t", onlyHash) } },
            }],
          });
          await fixture.server.flushSessions();
          const added = await fixture.reader.watchAddSync([watch("of:b")]);
          expect(ids(added.sync.upserts)).toEqual(
            [`cid:${onlyHash}`, "of:b"].toSorted(),
          );
          expect(delivered()).toEqual(
            [`cid:${onlyHash}`, "of:a", "of:b"].toSorted(),
          );
        } finally {
          await fixture.close();
        }
      });

      it("retracts, at the refresh, the whole closure of a schema ref a document no longer carries", async () => {
        // `of:a` links under `outer`, which refers to `leaf`. Replacing
        // `of:a` with a value carrying no ref releases the closure the old
        // version kept whole, `leaf` with `outer`.
        const leaf = { type: "string", title: "closure-leaf" } as const;
        const leafHash = internSchemaAsTaggedHashString(leaf);
        const outer = {
          type: "object",
          properties: { x: { $ref: `cid:${leafHash}` } },
        } as const;
        const outerHash = internSchemaAsTaggedHashString(outer);
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: `cid:${leafHash}`, value: { value: leaf } },
              { op: "set", id: `cid:${outerHash}`, value: { value: outer } },
              { op: "set", id: "of:t", value: { value: { n: 1 } } },
              {
                op: "set",
                id: "of:a",
                value: { value: { x: linkWithSchemaRef("of:t", outerHash) } },
              },
            ],
          });
          await fixture.server.flushSessions();
          const { view } = await fixture.reader.watchAddSync([watch("of:a")]);
          expect(ids([...fixture.state.entities.values()])).toEqual(
            [`cid:${leafHash}`, `cid:${outerHash}`, "of:a"].toSorted(),
          );
          const frames = view.subscribeSync();
          const pushed = frames.next();
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: "of:a", value: { value: {} } }],
          });
          await fixture.server.flushSessions();
          const { value: frame } = await pushed;
          expect(ids(frame!.removes)).toEqual(
            [`cid:${leafHash}`, `cid:${outerHash}`].toSorted(),
          );
          expect(ids(frame!.upserts)).toEqual(["of:a"]);
          expect(ids([...fixture.state.entities.values()])).toEqual(["of:a"]);
        } finally {
          await fixture.close();
        }
      });

      it("keeps a schema document delivered while any delivered document refers to it", async () => {
        // Two roots link under one `$ref` schema. The schema documents are
        // walked in once, for the first root, and every later document
        // referring to them is attributed to them too, so they leave only
        // with the last of those documents.
        const leafSchema = { type: "string", title: "shared-leaf" } as const;
        const leafHash = internSchemaAsTaggedHashString(leafSchema);
        const refSchema = {
          type: "object",
          properties: { x: { $ref: `cid:${leafHash}` } },
        } as const;
        const refHash = internSchemaAsTaggedHashString(refSchema);
        const refLink = (id: string) => linkWithSchemaRef(id, refHash);
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              {
                op: "set",
                id: `cid:${leafHash}`,
                value: { value: leafSchema },
              },
              { op: "set", id: `cid:${refHash}`, value: { value: refSchema } },
              { op: "set", id: "of:t", value: { value: { n: 1 } } },
              {
                op: "set",
                id: "of:p",
                value: { value: { x: refLink("of:t") } },
              },
              {
                op: "set",
                id: "of:q",
                value: { value: { x: refLink("of:t") } },
              },
            ],
          });
          await fixture.server.flushSessions();
          await fixture.reader.watchAddSync([watch("of:p")]);
          await fixture.reader.watchAddSync([watch("of:q")]);
          const schemaIds = [`cid:${leafHash}`, `cid:${refHash}`].toSorted();
          const delivered = () =>
            [...fixture.state.entities.values()].map((entry) => entry.id)
              .filter((id) => id.startsWith("cid:")).toSorted();
          expect(delivered()).toEqual(schemaIds);
          const first = await fixture.reader.watchRemoveSync(["of:p"]);
          expect(first.sync.removes.map((entry) => entry.id)).toEqual([
            "of:p",
          ]);
          expect(delivered()).toEqual(schemaIds);
          const second = await fixture.reader.watchRemoveSync(["of:q"]);
          expect(
            second.sync.removes.map((entry) => entry.id).toSorted(),
          ).toEqual(["of:q", ...schemaIds].toSorted());
          expect(delivered()).toEqual([]);
        } finally {
          await fixture.close();
        }
      });

      it("pushes no update for a document a removal retracted, and still pushes for one a remaining watch keeps", async () => {
        // Frames arrive in order, so the first frame after the removal is
        // the one the write to the kept document earns, and a frame for the
        // write to the retracted document would have come before it.
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              {
                op: "set",
                id: "of:a",
                value: { value: { child: link(fixture.space, "of:x") } },
              },
              { op: "set", id: "of:x", value: { value: { name: "x" } } },
              { op: "set", id: "of:b", value: { value: { name: "b" } } },
            ],
          });
          await fixture.server.flushSessions();
          const { view } = await fixture.reader.watchAddSync([
            permissive("of:a"),
            watch("of:b"),
          ]);
          const removal = await fixture.reader.watchRemoveSync(["of:a:all"]);
          expect(ids(removal.sync.removes)).toEqual(["of:a", "of:x"]);
          const frames = view.subscribeSync();
          const pushed = frames.next();
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: "of:x", value: { value: { name: "x2" } } },
            ],
          });
          await fixture.server.flushSessions();
          await fixture.writer.transact({
            localSeq: 4,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: "of:b", value: { value: { name: "b2" } } },
            ],
          });
          await fixture.server.flushSessions();
          const { value: frame } = await pushed;
          expect(ids(frame!.upserts)).toEqual(["of:b"]);
          expect(frame!.removes).toEqual([]);
          expect(ids([...fixture.state.entities.values()])).toEqual(["of:b"]);
        } finally {
          await fixture.close();
        }
      });

      it("keeps the schema documents two watches' selectors share when one watch is removed", async () => {
        // Both selectors name `outer`, which refers to `leaf`, and the two
        // watches are evaluated in one walk, which loads the closure once.
        // Each watch is attributed the closure all the same, so removing
        // one leaves the schema documents to the other.
        const { outerHash, ids: schemaIds } = schemaPair("shared-selector");
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              ...schemaPair("shared-selector").operations,
              { op: "set", id: "of:a", value: { value: { x: "a" } } },
              { op: "set", id: "of:b", value: { value: { x: "b" } } },
            ],
          });
          await fixture.server.flushSessions();
          await fixture.reader.watchAddSync([
            selectorWatch("of:a", outerHash),
            selectorWatch("of:b", outerHash),
          ]);
          const delivered = () => ids([...fixture.state.entities.values()]);
          expect(delivered()).toEqual(
            [...schemaIds, "of:a", "of:b"].toSorted(),
          );
          const removal = await fixture.reader.watchRemoveSync(["of:a"]);
          expect(ids(removal.sync.removes)).toEqual(["of:a"]);
          expect(delivered()).toEqual([...schemaIds, "of:b"].toSorted());
        } finally {
          await fixture.close();
        }
      });

      it("delivers, and does not retract, a schema document a refresh retires and reaches again in one pass", async () => {
        // `of:a` links to `of:x`, whose `schema` member names the schema
        // document, which only the content closure attributes; the write
        // relinks `of:a` to `of:y`, whose `schema` member names it too. The
        // refresh retires `of:x` and with it the schema document, then
        // delivers `of:y` and reaches the schema document again. The
        // frame retracts `of:x` alone.
        const { leafHash, ids: schemaIds, operations } = schemaPair(
          "readmitted",
        );
        const labeled = (n: number) => ({
          value: { n },
          schema: { $ref: `cid:${leafHash}` },
        });
        const fixture = await openFixture(0);
        try {
          await fixture.writer.transact({
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              ...operations,
              { op: "set", id: "of:x", value: labeled(1) },
              { op: "set", id: "of:y", value: labeled(2) },
              {
                op: "set",
                id: "of:a",
                value: { value: { child: link(fixture.space, "of:x") } },
              },
            ],
          });
          await fixture.server.flushSessions();
          const { view } = await fixture.reader.watchAddSync([
            permissive("of:a"),
          ]);
          const delivered = () => ids([...fixture.state.entities.values()]);
          expect(delivered()).toEqual(
            [schemaIds[0], "of:a", "of:x"].toSorted(),
          );
          const frames = view.subscribeSync();
          const pushed = frames.next();
          await fixture.writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:a",
              value: { value: { child: link(fixture.space, "of:y") } },
            }],
          });
          await fixture.server.flushSessions();
          const { value: frame } = await pushed;
          expect(ids(frame!.removes)).toEqual(["of:x"]);
          expect(ids(frame!.upserts)).toContain("of:y");
          expect(delivered()).toEqual(
            [schemaIds[0], "of:a", "of:y"].toSorted(),
          );
        } finally {
          await fixture.close();
        }
      });

      it("keeps the graph of a branch the removal does not touch", async () => {
        const fixture = await openCoveredFixture();
        try {
          const engine = await fixture.server.engineForSpace(fixture.space);
          createBranch(engine, "feature");
          await fixture.server.flushSessions();
          const base = linkedWatch("of:a");
          await fixture.reader.watchAddSync([{
            ...base,
            id: "feature",
            query: { ...base.query, branch: "feature" },
          }]);
          const feature = fixture.state.graphs.get("feature")!;
          const removal = await fixture.reader.watchRemoveSync([
            "of:a:all",
            "of:a",
          ]);
          expect(fixture.state.graphs.get("feature")).toBe(feature);
          expect(fixture.state.graphs.has("")).toBe(false);
          expect(
            removal.sync.removes.map((entry) => [entry.branch, entry.id])
              .toSorted(),
          ).toEqual([["", "of:a"], ["", "of:x"], ["", "of:y"]]);
          expect(fixture.state.watches.map((watch) => watch.id)).toEqual([
            "feature",
          ]);
        } finally {
          await fixture.close();
        }
      });
    });
  });
});
