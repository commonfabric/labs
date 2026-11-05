import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { ChangeSet } from "@codemirror/state";

import {
  type GraphWatchSpec,
  toDirtyKey,
  toValuePath,
  type WatchSpec,
} from "../v2.ts";
import { connect, loopback } from "../v2/client.ts";
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
      schemaRefCounts: [...graph.schemaRefCounts],
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
  });
});
