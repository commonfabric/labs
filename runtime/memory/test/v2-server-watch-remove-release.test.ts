/**
 * What `Server.watchRemove()` delivers when releasing a watch walks a watch
 * it had covered again: nothing for the documents that walk reaches at the
 * version delivered, the crossings it records that the session was not told
 * of, and, for a session marked for a full re-evaluation, the operation
 * cursors of the watches that remain.
 */

import { expect } from "@std/expect";

import { ChangeSet } from "@codemirror/state";

import {
  type GraphWatchSpec,
  type Operation,
  toValuePath,
  type WatchSpec,
} from "../v2.ts";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
} from "../v2/operation-codec.ts";
import { Server, SessionRegistry } from "../v2/server.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";
import { describe, it } from "@commonfabric/test-support/test";

const SPACE = "did:key:z6Mk-watch-remove-release-space";
const OTHER_SPACE = "did:key:z6Mk-watch-remove-release-other";

const link = (space: string, id: string) => ({
  "/": { "link@1": { space, id, path: [] } },
});

/** A watch on `id` whose `true` schema reaches everything `id` links to. */
const permissive = (id: string): GraphWatchSpec => ({
  id: `${id}:all`,
  kind: "graph",
  query: { roots: [{ id, selector: { path: [], schema: true } }] },
});

/**
 * A watch on `id` reaching the `name` of what its `child` links to, which
 * `permissive(id)` covers.
 */
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
            child: { type: "object", properties: { name: { type: "string" } } },
          },
        },
      },
    }],
  },
});

let serverCount = 0;

/**
 * A server whose sessions refresh only when told to, with a writing session
 * and a reading session on `SPACE`.
 */
const createFixture = () => {
  const sessions = new SessionRegistry();
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://watch-remove-release-${++serverCount}`),
    sessions,
    subscriptionRefreshDelayMs: "manual",
  });
  const writer = sessions.open(SPACE, {}, 0, "writer");
  const reader = sessions.open(SPACE, {}, 0, "reader");
  let localSeq = 0;
  return {
    server,
    sessions,
    reader,
    /** Commits `operations` to `SPACE` through the writing session. */
    async write(...operations: Operation[]): Promise<void> {
      const response = await server.transact({
        type: "transact",
        requestId: `write-${++localSeq}`,
        space: SPACE,
        sessionId: writer.sessionId,
        commit: {
          localSeq,
          reads: { confirmed: [], pending: [] },
          operations,
        },
      });
      expect(response.error).toBeUndefined();
    },
    /** Applies `watches` to the reading session, as `mode` does. */
    async watch(mode: "set" | "add", watches: WatchSpec[]): Promise<void> {
      const request = {
        requestId: `watch-${mode}`,
        space: SPACE,
        sessionId: reader.sessionId,
        watches,
      };
      const response = mode === "set"
        ? await server.watchSet({ type: "session.watch.set", ...request })
        : await server.watchAdd({ type: "session.watch.add", ...request });
      expect(response.error).toBeUndefined();
    },
    remove(watchIds: string[]) {
      return server.watchRemove({
        type: "session.watch.remove",
        requestId: "remove",
        space: SPACE,
        sessionId: reader.sessionId,
        watchIds,
      });
    },
  };
};

describe("Server", () => {
  describe("instance members", () => {
    describe("watchRemove()", () => {
      it("upserts nothing for a document the covered watch reaches at the version delivered", async () => {
        const fixture = createFixture();
        try {
          await fixture.write(
            {
              op: "set",
              id: "of:a",
              value: { value: { child: link(SPACE, "of:x") } },
            },
            { op: "set", id: "of:x", value: { value: { name: "x" } } },
          );
          await fixture.watch("set", [permissive("of:a")]);
          await fixture.watch("add", [narrow("of:a")]);

          const removed = await fixture.remove(["of:a:all"]);
          expect(removed.ok?.sync.upserts).toEqual([]);
          expect(removed.ok?.sync.removes).toEqual([]);
        } finally {
          await fixture.server.close();
        }
      });

      it("reports a crossing the covered watch's walk records under its own selector", async () => {
        const fixture = createFixture();
        try {
          await fixture.write({
            op: "set",
            id: "of:a",
            value: { value: { child: link(OTHER_SPACE, "of:elsewhere") } },
          });
          await fixture.watch("set", [permissive("of:a")]);
          await fixture.watch("add", [narrow("of:a")]);

          const removed = await fixture.remove(["of:a:all"]);
          expect(removed.error).toBeUndefined();
          expect(removed.ok?.sync.crossings).toEqual([{
            space: OTHER_SPACE,
            id: "of:elsewhere",
            path: [],
            schema: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          }]);
        } finally {
          await fixture.server.close();
        }
      });

      it("keeps, for a session marked for a full re-evaluation, the operation cursors of the remaining watches and drops the removed watch's", async () => {
        const fixture = createFixture();
        try {
          for (const id of ["of:op-1", "of:op-2"]) {
            await fixture.write({
              op: "set",
              id,
              value: { value: { body: "a" } },
            });
            await fixture.write({
              op: "apply-op",
              id,
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: `writer:${id}`,
              base: null,
              baselineHash: operationBaselineHash("a"),
              payload: {
                updates: [{
                  clientId: "writer",
                  changes: ChangeSet.of({ from: 1, insert: "b" }, 1).toJSON(),
                }],
              },
            });
          }
          const operationWatch = (id: string): WatchSpec => ({
            id,
            kind: "operation",
            query: { id, path: toValuePath(["body"]) },
          });
          await fixture.watch("set", [
            operationWatch("of:op-1"),
            operationWatch("of:op-2"),
          ]);
          const state = () =>
            fixture.sessions.get(SPACE, fixture.reader.sessionId)!;
          expect([...state().operationCursors.keys()].toSorted()).toEqual([
            "of:op-1",
            "of:op-2",
          ]);
          const kept = state().operationCursors.get("of:op-2");

          fixture.server.markSessionForFullResync(
            SPACE,
            fixture.reader.sessionId,
          );
          const removed = await fixture.remove(["of:op-1"]);
          expect(removed.error).toBeUndefined();
          expect([...state().operationCursors.keys()]).toEqual(["of:op-2"]);
          expect(state().operationCursors.get("of:op-2")).toEqual(kept);
          expect(state().watches.map((watch) => watch.id)).toEqual([
            "of:op-2",
          ]);
        } finally {
          await fixture.server.close();
        }
      });
    });
  });
});
