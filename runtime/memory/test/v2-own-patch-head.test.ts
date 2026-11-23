/**
 * What a session's sync frame carries of a document whose head the session's
 * own accepted `patch` produced: nothing where the session holds the revision
 * its patches were applied over, and the whole post-apply document everywhere
 * else. Fan-out is flushed by hand, so which commits share a dirty batch is
 * stated by each case.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type { FabricPlainObject } from "@commonfabric/api";

import {
  CODEMIRROR_CHANGESET_CODEC,
  encodeMemoryBoundary,
  operationBaselineHash,
  resetServerExecutionConfig,
  type SessionEffectMessage,
  type SessionSync,
  setServerExecutionConfig,
  streamEntriesDocId,
  toValuePath,
  type WatchSetResult,
} from "../v2.ts";
import { toDirtyKey } from "../v2/query.ts";
import { Server } from "../v2/server.ts";
import {
  connectPeer,
  openSession,
  request,
  type WirePeer,
} from "./support/wire-peer.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-own-patch-head";
const DOC = "of:own-patch-head";

/** One session of a test server, with the next `localSeq` it commits under. */
type Writer = { peer: WirePeer; sessionId: string; localSeq: number };

const newServer = () =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://own-patch-head-${crypto.randomUUID()}`),
    subscriptionRefreshDelayMs: "manual",
  });

/**
 * Opens a session on `server` that watches `ids`, each under `schema`: without
 * one unless told otherwise, so the watch follows no link.
 */
const openWriter = async (
  server: Server,
  ids: readonly string[] = [DOC],
  schema: boolean = false,
): Promise<Writer> => {
  const peer = await connectPeer(server);
  const { sessionId } = await openSession(peer, SPACE);
  const watched = await request<WatchSetResult>(peer, {
    type: "session.watch.set",
    space: SPACE,
    sessionId,
    watches: ids.map((id) => ({
      id,
      kind: "graph",
      query: { roots: [{ id, selector: { path: [], schema } }] },
    })),
  });
  expect(watched.error).toBeUndefined();
  return { peer, sessionId, localSeq: 1 };
};

/** Commits `operations` from `writer` and returns the commit's seq. */
const commit = async (
  writer: Writer,
  operations: FabricPlainObject[],
  extra: FabricPlainObject = {},
): Promise<number> => {
  const response = await request<{ seq: number }>(writer.peer, {
    type: "transact",
    space: SPACE,
    sessionId: writer.sessionId,
    commit: {
      localSeq: writer.localSeq++,
      reads: { confirmed: [], pending: [] },
      operations,
      ...extra,
    },
  });
  expect(response.error).toBeUndefined();
  return response.ok!.seq;
};

/** The sync frames `writer` has been sent and no call has taken. */
const takeFrames = (writer: Writer): SessionSync[] =>
  writer.peer.messages.splice(0).flatMap((message) =>
    message.type === "session/effect"
      ? [(message as SessionEffectMessage).effect as unknown as SessionSync]
      : []
  );

/** Flushes the fan-out and returns the one frame it sent `writer`. */
const flushedFrame = async (
  server: Server,
  writer: Writer,
): Promise<SessionSync> => {
  await server.flushSessions([SPACE]);
  const frames = takeFrames(writer);
  expect(frames.length).toBe(1);
  return frames[0]!;
};

/** The `[id, seq]` of each document `frame` carries. */
const carried = (frame: SessionSync): Array<[string, number]> =>
  frame.upserts.map((upsert) => [upsert.id, upsert.seq]);

/** The `[seq, document]` of each document `frame` carries. */
const documents = (frame: SessionSync): Array<[number, unknown]> =>
  frame.upserts.map((upsert) => [upsert.seq, upsert.doc]);

const setItems = (items: FabricPlainObject["items"]): FabricPlainObject => ({
  op: "set",
  id: DOC,
  value: { value: { items } },
});

const patchDoc = (...patches: FabricPlainObject[]): FabricPlainObject => ({
  op: "patch",
  id: DOC,
  patches,
});

const append = (value: string): FabricPlainObject =>
  patchDoc({ op: "append", path: "/value/items", values: [value] });

const ROOT = "of:own-patch-head-root";

/**
 * Leaves `server` with a `writer` that watches `ROOT` and whatever it links
 * to, and has never been sent `DOC`, which another session wrote.
 */
const openWriterNotHoldingDoc = async (server: Server): Promise<Writer> => {
  const other = await openWriter(server);
  await commit(other, [setItems([])]);
  const writer = await openWriter(server, [ROOT], true);
  await commit(writer, [{ op: "set", id: ROOT, value: { value: {} } }]);
  await server.flushSessions([SPACE]);
  expect(takeFrames(writer).flatMap(carried)).toEqual([]);
  return writer;
};

/** A patch of `ROOT` that links it to `DOC`. */
const linkRootToDoc: FabricPlainObject = {
  op: "patch",
  id: ROOT,
  patches: [{
    op: "add",
    path: "/value/child",
    value: { "/": { "link@1": { id: DOC, path: [], space: SPACE } } },
  }],
};

/** A link to the document `of:target:<index>`, as a stored value holds one. */
const linkTo = (index: number): FabricPlainObject => ({
  "/": { "link@1": { id: `of:target:${index}`, path: [] } },
});

describe("Server", () => {
  describe("a session's own `patch` head", () => {
    it("is left out of the writer's frame, whose size is the same for a document of 100 links and one of 1,600", async () => {
      const frameSizes: number[] = [];
      const observerSizes: number[] = [];
      for (const count of [100, 1600]) {
        const server = newServer();
        try {
          const writer = await openWriter(server);
          const observer = await openWriter(server);
          await commit(writer, [
            setItems(
              Array.from({ length: count }, (_, index) => linkTo(index)),
            ),
          ]);
          await server.flushSessions([SPACE]);
          takeFrames(writer);
          takeFrames(observer);

          const seq = await commit(writer, [
            patchDoc({
              op: "replace",
              path: "/value/items/50",
              value: linkTo(count),
            }),
          ]);
          await server.flushSessions([SPACE]);

          const [frame, ...more] = takeFrames(writer);
          expect(more).toEqual([]);
          expect(frame!.upserts).toEqual([]);
          expect(frame!.caughtUpLocalSeq).toBe(2);
          frameSizes.push(encodeMemoryBoundary(frame as never).length);

          const [observed] = takeFrames(observer);
          expect(carried(observed!)).toEqual([[DOC, seq]]);
          observerSizes.push(encodeMemoryBoundary(observed as never).length);
        } finally {
          await server.close();
        }
      }
      expect(frameSizes[1]).toBe(frameSizes[0]);
      // The observer's frame carries the document, so it grows with it.
      expect(observerSizes[1]!).toBeGreaterThan(10 * observerSizes[0]!);
    });

    it("is left out of the writer's frame for each patch of a run the writer committed before one flush", async () => {
      const server = newServer();
      try {
        const writer = await openWriter(server);
        await commit(writer, [setItems([])]);
        await server.flushSessions([SPACE]);
        takeFrames(writer);

        await commit(writer, [append("a")]);
        await commit(writer, [append("b")]);
        const frame = await flushedFrame(server, writer);

        expect(frame.upserts).toEqual([]);
        expect(frame.caughtUpLocalSeq).toBe(3);

        // The session is recorded as holding the head: a foreign patch over
        // it reaches the writer once, and the writer's next patch over that
        // is left out again.
        const other = await openWriter(server);
        takeFrames(other);
        const foreign = await commit(other, [append("c")]);
        expect(carried(await flushedFrame(server, writer))).toEqual([
          [DOC, foreign],
        ]);
        await commit(writer, [append("d")]);
        expect((await flushedFrame(server, writer)).upserts).toEqual([]);
      } finally {
        await server.close();
      }
    });

    it("is left out of the writer's frame where the run follows the writer's own `set` in the same batch", async () => {
      const server = newServer();
      try {
        const writer = await openWriter(server);
        await commit(writer, [setItems(["a"])]);
        await commit(writer, [append("b")]);

        const frame = await flushedFrame(server, writer);

        expect(frame.upserts).toEqual([]);
        expect(frame.caughtUpLocalSeq).toBe(2);
      } finally {
        await server.close();
      }
    });

    it("rides the writer's frame as the merged document when another session's patch landed in the same batch", async () => {
      const server = newServer();
      try {
        const writer = await openWriter(server);
        const other = await openWriter(server);
        await commit(writer, [setItems([])]);
        await server.flushSessions([SPACE]);
        takeFrames(writer);
        takeFrames(other);

        await commit(writer, [append("mine-1")]);
        await commit(other, [append("theirs")]);
        const seq = await commit(writer, [append("mine-2")]);
        const frame = await flushedFrame(server, writer);

        expect(documents(frame)).toEqual([
          [seq, { value: { items: ["mine-1", "theirs", "mine-2"] } }],
        ]);
        expect(frame.caughtUpLocalSeq).toBe(3);
      } finally {
        await server.close();
      }
    });

    it("rides the writer's frame when the writer was never sent the revision its patch was applied over", async () => {
      const server = newServer();
      try {
        const writer = await openWriter(server);
        const other = await openWriter(server);
        await commit(writer, [setItems([])]);
        await server.flushSessions([SPACE]);
        takeFrames(writer);
        takeFrames(other);

        // The other session's patch is fanned out to everyone but the
        // writer, whose connection refuses that one frame.
        const foreign = await commit(other, [append("theirs")]);
        const original = writer.peer.connection.refreshDirty.bind(
          writer.peer.connection,
        );
        let calls = 0;
        const failing = stub(
          writer.peer.connection,
          "refreshDirty",
          (...args) => {
            calls += 1;
            return calls === 1
              ? Promise.reject(new Error("synthetic fan-out failure"))
              : original(...args);
          },
        );
        try {
          await expect(server.flushSessions([SPACE])).rejects.toThrow(
            "synthetic fan-out failure",
          );
          expect(takeFrames(writer)).toEqual([]);

          const seq = await commit(writer, [append("mine")]);
          expect(seq).toBe(foreign + 1);
          const frame = await flushedFrame(server, writer);

          expect(documents(frame)).toEqual([
            [seq, { value: { items: ["theirs", "mine"] } }],
          ]);
        } finally {
          failing.restore();
        }
      } finally {
        await server.close();
      }
    });

    it("rides the writer's frame when the writer's watch first reaches the document in the batch that patches it", async () => {
      const server = newServer();
      try {
        const writer = await openWriterNotHoldingDoc(server);

        const seq = await commit(writer, [append("mine")]);
        await commit(writer, [linkRootToDoc]);
        const frame = await flushedFrame(server, writer);

        expect(documents(frame)).toEqual([
          [seq, { value: { items: ["mine"] } }],
        ]);
      } finally {
        await server.close();
      }
    });

    it("rides the writer's frame when the commit wrote the document more than once", async () => {
      const server = newServer();
      try {
        const writer = await openWriter(server);
        await commit(writer, [setItems([])]);
        await server.flushSessions([SPACE]);
        takeFrames(writer);

        const seq = await commit(writer, [append("a"), append("b")]);

        expect(carried(await flushedFrame(server, writer))).toEqual([
          [DOC, seq],
        ]);
      } finally {
        await server.close();
      }
    });

    it("rides the writer's frame when the commit carries a field edit", async () => {
      const server = newServer();
      try {
        const writer = await openWriter(server);
        await commit(writer, [{
          op: "set",
          id: DOC,
          value: { value: { body: "hello", title: "a" } },
        }]);
        await server.flushSessions([SPACE]);
        takeFrames(writer);

        const edit = {
          op: "apply-op",
          id: DOC,
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "writer:1",
          base: null,
          baselineHash: operationBaselineHash("hello"),
          payload: {
            updates: [{ clientId: "writer", changes: [[0, ">"], 5] }],
          },
        };
        const seq = await commit(writer, [
          patchDoc({ op: "replace", path: "/value/title", value: "b" }),
          edit,
        ]);
        expect(documents(await flushedFrame(server, writer))).toEqual([
          [seq, { value: { body: ">hello", title: "b" } }],
        ]);

        // The same edit sent again integrates to nothing, so the patch is
        // the commit's one write to the document.
        const again = await commit(writer, [
          patchDoc({ op: "replace", path: "/value/title", value: "c" }),
          edit,
        ]);
        expect(documents(await flushedFrame(server, writer))).toEqual([
          [again, { value: { body: ">hello", title: "c" } }],
        ]);
      } finally {
        await server.close();
      }
    });

    it("rides the writer's frame when the engine stamped the appended event before storing it", async () => {
      // A commit may declare an event append only under server execution.
      setServerExecutionConfig(true);
      const server = newServer();
      const stream = { id: DOC, path: ["clicks"] };
      const sidecar = streamEntriesDocId(stream);
      /** The operations and the declaration of one fire of `eventId`. */
      const fire = (
        eventId: string,
      ): [FabricPlainObject[], FabricPlainObject] => [
        [{
          op: "patch",
          id: sidecar,
          patches: [{
            op: "append",
            path: "/value/entries",
            values: [{ eventId, stream, payload: { n: 1 } }],
          }],
        }],
        { eventAppends: [{ id: sidecar, eventId }] },
      ];
      try {
        const writer = await openWriter(server, [sidecar]);
        const first = await commit(writer, ...fire("event-1"));
        await server.flushSessions([SPACE]);
        takeFrames(writer);

        const seq = await commit(writer, ...fire("event-2"));
        const frame = await flushedFrame(server, writer);

        expect(carried(frame)).toEqual([[sidecar, seq]]);
        const entries = (frame.upserts[0]!.doc as {
          value: { entries: Array<{ eventId: string; seq?: number }> };
        }).value.entries;
        expect(entries.map((entry) => [entry.eventId, entry.seq])).toEqual([
          ["event-1", first],
          ["event-2", seq],
        ]);
      } finally {
        resetServerExecutionConfig();
        await server.close();
      }
    });
  });

  describe("markSpaceDirty()", () => {
    it("starts a run of patches at the revision the patch was applied over when the session's earlier origin names another head", async () => {
      const server = newServer();
      try {
        const writer = await openWriterNotHoldingDoc(server);
        // An origin for a `set` by the writer at a seq that is not the
        // document's head: the writer's patch does not continue from it.
        server.markSpaceDirty(SPACE, [toDirtyKey(DOC)], {
          sessionId: writer.sessionId,
          seq: 0,
          ops: new Map([[toDirtyKey(DOC), "set"]]),
        });

        const seq = await commit(writer, [append("mine")]);
        await commit(writer, [linkRootToDoc]);
        const frame = await flushedFrame(server, writer);

        expect(carried(frame)).toEqual([[DOC, seq]]);
      } finally {
        await server.close();
      }
    });
  });
});
