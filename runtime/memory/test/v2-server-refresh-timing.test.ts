/**
 * The refresh's timing rows close in `finally` blocks: a refresh that throws
 * is skipped and requeued by its caller, and the rows are what say what it
 * cost. The session row closes after the catch-up frame, which can still
 * attach operation-watch fields when no document was upserted.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { getLogger } from "@commonfabric/utils/logger";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import {
  refreshTrackedGraph,
  SchemaClosureError,
  toDirtyKey,
  trackGraph,
} from "../v2/query.ts";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  toValuePath,
  type TransactRequest,
} from "../v2.ts";

const TEST_AUDIENCE = "did:key:z6Mk-memory-v2-refresh-timing-audience";

// `root` references `leaf`, so re-validating the closure reaches `leaf`
// through `root`. The commit boundary refuses to change a content-addressed
// document, so a leaf that no longer hashes to its id is written below it,
// the way the engine-validation tests corrupt rows.
const leafSchema = { type: "string", title: "timing-leaf" } as const;
const leafHash = internSchemaAsTaggedHashString(leafSchema);
const rootSchema = {
  type: "object",
  properties: { x: { $ref: `cid:${leafHash}` } },
} as const;
const rootHash = internSchemaAsTaggedHashString(rootSchema);
const corruptLeaf = { type: "number", title: "timing-corrupt" } as const;

/** A link whose schema position carries `$ref: cid:<hash>`. */
const linkWithSchemaRef = (id: string, hash: string) => ({
  "/": { "link@1": { id, path: [], schema: { $ref: `cid:${hash}` } } },
});

const memoryTiming = getLogger("memory");
const countOf = (row: string): number =>
  memoryTiming.getTimeStats(row)?.count ?? 0;

const createServer = (store: string) =>
  new Server({
    store: new URL(store),
    subscriptionRefreshDelayMs: "manual",
    authorizeSessionOpen() {
      return "did:key:z6Mk-memory-v2-refresh-timing-principal";
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE },
  });

const openSession = async (
  connection: ReturnType<Server["connect"]>,
  messages: ServerMessage[],
  space: string,
): Promise<string> => {
  await connection.receive(encodeMemoryBoundary({
    type: "hello",
    protocol: MEMORY_PROTOCOL,
    flags: getMemoryProtocolFlags(),
  }));
  const hello = messages.shift() as
    | { type: string; sessionOpen?: SessionOpenAuthMetadata }
    | undefined;
  expect(hello?.type).toBe("hello.ok");
  const sessionOpen = hello!.sessionOpen!;
  await connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: "open",
    space,
    session: {},
    invocation: {
      aud: sessionOpen.audience,
      challenge: sessionOpen.challenge.value,
    },
  }));
  const opened = messages.shift() as ResponseMessage<{ sessionId: string }>;
  expect(opened.ok).toBeDefined();
  return opened.ok!.sessionId;
};

const transactMessage = (
  space: string,
  sessionId: string,
  commit: TransactRequest["commit"],
): TransactRequest => ({
  type: "transact",
  requestId: crypto.randomUUID(),
  space,
  sessionId,
  commit,
});

/** The closure fixture: two schema documents and a root whose link names
 * the outer one. */
const closureOperations = (root: string, target: string) => [
  { op: "set" as const, id: `cid:${leafHash}`, value: { value: leafSchema } },
  { op: "set" as const, id: `cid:${rootHash}`, value: { value: rootSchema } },
  { op: "set" as const, id: target, value: { value: { n: 1 } } },
  {
    op: "set" as const,
    id: root,
    value: { value: { x: linkWithSchemaRef(target, rootHash) } },
  },
];

describe("v2-server-refresh-timing", () => {
  describe("refreshTrackedGraph()", () => {
    it("records the closure phase and the total when the closure fails to verify", async () => {
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      let engine = await open({ url: toFileUrl(path) });
      const space = "did:key:z6Mk-memory-v2-refresh-timing-query";
      const root = "of:timing-query-root";
      try {
        applyCommit(engine, {
          sessionId: "session:writer",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: closureOperations(root, "of:timing-query-target"),
          },
        });
        const tracked = trackGraph(space, engine, {
          roots: [{ id: root, selector: { path: [], schema: false } }],
        });
        expect(tracked.state.entities.has(`${space}/space/cid:${leafHash}`))
          .toBe(true);

        // The stored leaf no longer hashes to its id. A reopened engine has
        // verified nothing yet, so the refresh re-verifies the closure and
        // throws — the restart case, where a corrupted store is first met.
        engine.database.prepare(
          `UPDATE revision SET data = :data WHERE id = :id`,
        ).run({
          data: encodeMemoryBoundary({ value: corruptLeaf }),
          id: `cid:${leafHash}`,
        });
        close(engine);
        engine = await open({ url: toFileUrl(path) });
        const before = {
          rewalk: countOf("memory/refresh/walk/rewalk"),
          closure: countOf("memory/refresh/walk/closure"),
          total: countOf("memory/refresh/walk/total"),
        };
        expect(() =>
          refreshTrackedGraph(
            space,
            engine,
            tracked.state,
            new Set([toDirtyKey(`cid:${leafHash}`)]),
          )
        ).toThrow(SchemaClosureError);
        expect(countOf("memory/refresh/walk/rewalk")).toBe(before.rewalk + 1);
        expect(countOf("memory/refresh/walk/closure")).toBe(
          before.closure + 1,
        );
        expect(countOf("memory/refresh/walk/total")).toBe(before.total + 1);
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    });
  });

  describe("Server", () => {
    describe("instance members", () => {
      describe("flushSessions()", () => {
        const realError = console.error;
        let errors: string[];

        beforeEach(() => {
          errors = [];
          console.error = (...args: unknown[]) => {
            errors.push(args.map(String).join(" "));
          };
        });

        afterEach(() => {
          console.error = realError;
        });

        it("records the session and walk rows of a refresh that throws", async () => {
          const space = "did:key:z6Mk-memory-v2-refresh-timing-throw";
          const root = "of:timing-throw-root";
          const server = createServer("memory://refresh-timing-throw");
          // The space's engine, kept so the test can reach its store below
          // the commit boundary.
          let engine: Engine | undefined;
          server.accessForTestingOnly.engineOpener = async (
            requested,
            openEngine,
          ) => {
            engine = await openEngine(requested);
            return engine;
          };
          const messages: ServerMessage[] = [];
          const connection = server.connect((message) =>
            messages.push(message)
          );
          try {
            const sessionId = await openSession(connection, messages, space);
            const seeded = await server.transact(
              transactMessage(space, sessionId, {
                localSeq: 1,
                reads: { confirmed: [], pending: [] },
                operations: closureOperations(root, "of:timing-throw-target"),
              }),
            );
            expect(seeded.error).toBeUndefined();
            await connection.receive(encodeMemoryBoundary({
              type: "session.watch.add",
              requestId: "watch-throw",
              space,
              sessionId,
              watches: [{
                id: "watch-throw-id",
                kind: "graph",
                query: {
                  roots: [{ id: root, selector: { path: [], schema: true } }],
                },
              }],
            }));

            const before = {
              touched: countOf("memory/refresh/session/touched"),
              walk: countOf("memory/refresh/phase/walk"),
              rewalk: countOf("memory/refresh/walk/rewalk"),
              total: countOf("memory/refresh/walk/total"),
              frame: countOf("memory/refresh/phase/frame"),
            };
            // A legitimate change dirties the root; its new revision row is
            // then corrupted in place (a valid encoding whose root is not a
            // plain object), so the refresh's re-walk throws on decode. The
            // refresh is manual, so the corruption lands before it runs.
            const written = await server.writeDocument(space, root, {
              x: linkWithSchemaRef("of:timing-throw-target", rootHash),
              n: 2,
            });
            engine!.database.prepare(
              `UPDATE revision SET data = :data WHERE id = :id AND seq = :seq`,
            ).run({
              data: encodeMemoryBoundary([1]),
              id: root,
              seq: written.seq,
            });
            await server.flushSessions();

            // The failed refresh is logged and its frame skipped …
            expect(
              errors.some((line) =>
                line.includes("watch refresh evaluation failed")
              ),
            ).toBe(true);
            // … and still shows in the rows that attribute the pass: the
            // session, the walk phase, the graph phase the throw landed in
            // (the re-walk decodes the corrupted row) and the graph total.
            expect(countOf("memory/refresh/session/touched")).toBe(
              before.touched + 1,
            );
            expect(countOf("memory/refresh/phase/walk")).toBe(before.walk + 1);
            expect(countOf("memory/refresh/walk/rewalk")).toBe(
              before.rewalk + 1,
            );
            expect(countOf("memory/refresh/walk/total")).toBe(before.total + 1);
            expect(countOf("memory/refresh/phase/frame")).toBe(before.frame);
          } finally {
            connection.close();
          }
        });

        it("closes the session row after an operation-watch catch-up that upserts nothing", async () => {
          const space = "did:key:z6Mk-memory-v2-refresh-timing-operation";
          const doc = "of:timing-operation-doc";
          const server = createServer("memory://refresh-timing-operation");
          const messages: ServerMessage[] = [];
          const connection = server.connect((message) =>
            messages.push(message)
          );
          try {
            const sessionId = await openSession(connection, messages, space);
            const seeded = await server.transact(
              transactMessage(space, sessionId, {
                localSeq: 1,
                reads: { confirmed: [], pending: [] },
                operations: [{
                  op: "set",
                  id: doc,
                  value: { value: { n: 1 } },
                }],
              }),
            );
            expect(seeded.error).toBeUndefined();
            await connection.receive(encodeMemoryBoundary({
              type: "session.watch.add",
              requestId: "watch-operation",
              space,
              sessionId,
              watches: [{
                id: "watch-operation-graph",
                kind: "graph",
                query: {
                  roots: [{ id: doc, selector: { path: [], schema: true } }],
                },
              }, {
                id: "watch-operation-field",
                kind: "operation",
                query: { id: doc, path: toValuePath([]) },
              }],
            }));

            const before = {
              touched: countOf("memory/refresh/session/touched"),
              tracked: countOf("memory/refresh/phase/tracked"),
              frame: countOf("memory/refresh/phase/frame"),
            };
            // The session's own `set` is elided from its frame (the writer
            // holds the bytes), so the refresh upserts nothing and takes the
            // catch-up path that still attaches operation-watch fields.
            const own = await server.transact(
              transactMessage(space, sessionId, {
                localSeq: 2,
                reads: { confirmed: [], pending: [] },
                operations: [{
                  op: "set",
                  id: doc,
                  value: { value: { n: 2 } },
                }],
              }),
            );
            expect(own.error).toBeUndefined();
            const attachmentStarted = Promise.withResolvers<void>();
            const releaseAttachment = Promise.withResolvers<void>();
            server.accessForTestingOnly.engineOpener = async (
              requested,
              openEngine,
            ) => {
              // After the tracked set is committed, this path opens the
              // engine to attach operation-watch fields to the catch-up.
              if (
                countOf("memory/refresh/phase/tracked") === before.tracked + 1
              ) {
                attachmentStarted.resolve();
                await releaseAttachment.promise;
              }
              return await openEngine(requested);
            };
            const messageCount = messages.length;
            const flushing = server.flushSessions();
            try {
              await Promise.race([
                attachmentStarted.promise,
                flushing.then(() => {
                  throw new Error(
                    "`flushSessions()` completed without pausing operation-field attachment",
                  );
                }),
              ]);
              expect(countOf("memory/refresh/session/touched")).toBe(
                before.touched,
              );
            } finally {
              releaseAttachment.resolve();
              server.accessForTestingOnly.engineOpener = undefined;
              await flushing;
            }

            expect(errors).toEqual([]);
            expect(countOf("memory/refresh/session/touched")).toBe(
              before.touched + 1,
            );
            expect(countOf("memory/refresh/phase/tracked")).toBe(
              before.tracked + 1,
            );
            expect(countOf("memory/refresh/phase/frame")).toBe(before.frame);
            const effects = messages.slice(messageCount).filter((message) =>
              message.type === "session/effect"
            );
            expect(effects).toHaveLength(1);
            expect(effects[0].effect.upserts).toEqual([]);
            expect(
              effects[0].effect.operationFields?.map(({ watchId }) => watchId),
            )
              .toEqual(["watch-operation-field"]);
          } finally {
            connection.close();
          }
        });
      });
    });
  });
});
