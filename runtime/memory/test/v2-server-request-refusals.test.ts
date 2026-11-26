/**
 * What the v2 `Server`'s per-session requests answer when the session cannot
 * be served: a session the space does not hold, one whose principal lacks the
 * grant the request needs, one replaced while the request waited for the
 * space's engine, and an engine that cannot be opened. Sessions are opened
 * straight into the server's registry, so each case names the principal its
 * session acts as without a handshake.
 */

import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { aclDocId } from "../acl.ts";
import * as Engine from "../v2/engine.ts";
import { Server, SessionRegistry } from "../v2/server.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";
import type { WatchSpec } from "../v2.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** A session the registry opened, with the token that resumes it. */
type OpenSessionState = ReturnType<SessionRegistry["open"]>;

const SPACE = "did:key:z6Mk-request-refusals-space";
const ALICE = "did:key:z6Mk-request-refusals-alice";
const BOB = "did:key:z6Mk-request-refusals-bob";

type Fixture = {
  server: Server;
  sessions: SessionRegistry;
};

let serverCount = 0;

/** A server whose registry the case opens sessions in, in ACL `mode`. */
const createServer = (
  mode: "off" | "enforce" = "off",
): Fixture => {
  const sessions = new SessionRegistry();
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://request-refusals-${++serverCount}`),
    subscriptionRefreshDelayMs: "manual",
    sessions,
    acl: { mode },
  });
  return { server, sessions };
};

/** Stores `SPACE`'s access list as `{ [ALICE]: "OWNER" }`. */
const grantAliceOwner = async (server: Server): Promise<void> => {
  Engine.applyCommit(await server.engineForSpace(SPACE), {
    sessionId: "acl-seed",
    space: SPACE,
    commitClass: "system",
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: aclDocId(SPACE),
        value: { value: { [ALICE]: "OWNER" } },
      }],
    },
  });
};

/** Opens a session on `SPACE` acting as `principal`. */
const openAs = (
  sessions: SessionRegistry,
  principal?: string,
): OpenSessionState => sessions.open(SPACE, {}, 0, "first", principal);

/**
 * Resumes `opened` under another connection, which replaces the registry's
 * object for it, as a takeover does.
 */
const takeOver = (sessions: SessionRegistry, opened: OpenSessionState) =>
  sessions.open(
    SPACE,
    { sessionId: opened.sessionId, sessionToken: opened.sessionToken },
    0,
    "second",
    opened.state.principal,
  );

/**
 * Has the server's next engine open for `SPACE` run `act` first, and every
 * open after it proceed as usual.
 */
const beforeNextOpen = (server: Server, act: () => void): void => {
  server.accessForTestingOnly.engineOpener = async (space, open) => {
    if (space === SPACE) {
      server.accessForTestingOnly.engineOpener = undefined;
      act();
    }
    return await open(space);
  };
};

/** Has every engine open fail with `error`. */
const failOpens = (server: Server, error: Error): void => {
  server.accessForTestingOnly.engineOpener = () => Promise.reject(error);
};

const graphWatch = (id: string): WatchSpec => ({
  id,
  kind: "graph",
  query: { roots: [{ id, selector: { path: [], schema: false } }] },
});

const UNKNOWN_SESSION = {
  name: "SessionError",
  message: "Unknown session for space",
};

const LACKS_READ = {
  name: "AuthorizationError",
  message: `Principal ${BOB} lacks READ on space ${SPACE}`,
};

describe("Server", () => {
  describe("instance members", () => {
    describe("ackSession()", () => {
      const ack = (server: Server, sessionId: string, seenSeq = 1) =>
        server.ackSession({
          type: "session.ack",
          requestId: "ack",
          space: SPACE,
          sessionId,
          seenSeq,
        });

      it("returns `SessionError` for a session the space does not hold", async () => {
        const { server } = createServer();
        try {
          expect((await ack(server, "no-such-session")).error).toEqual(
            UNKNOWN_SESSION,
          );
        } finally {
          await server.close();
        }
      });

      it("records what the session has seen for a principal holding `READ`, and returns `AuthorizationError` for one lacking it", async () => {
        const { server, sessions } = createServer("enforce");
        try {
          await grantAliceOwner(server);
          const alice = openAs(sessions, ALICE);
          const bob = openAs(sessions, BOB);

          expect((await ack(server, alice.sessionId, 1)).ok).toEqual({
            serverSeq: 1,
          });
          expect(sessions.get(SPACE, alice.sessionId)?.seenSeq).toBe(1);

          expect((await ack(server, bob.sessionId, 1)).error).toMatchObject(
            LACKS_READ,
          );
          expect(sessions.get(SPACE, bob.sessionId)?.seenSeq).toBe(0);
        } finally {
          await server.close();
        }
      });

      it("returns `SessionError` carrying the failure when the space's engine cannot be opened", async () => {
        const { server, sessions } = createServer();
        try {
          const opened = openAs(sessions, ALICE);
          failOpens(server, new Error("the store is unreachable"));
          expect((await ack(server, opened.sessionId)).error).toEqual({
            name: "SessionError",
            message: "the store is unreachable",
          });
          expect(sessions.get(SPACE, opened.sessionId)?.seenSeq).toBe(0);
        } finally {
          await server.close();
        }
      });
    });

    describe("graphQuery()", () => {
      const query = (server: Server, sessionId: string) =>
        server.graphQuery({
          type: "graph.query",
          requestId: "query",
          space: SPACE,
          sessionId,
          query: {
            roots: [{
              id: aclDocId(SPACE),
              selector: { path: [], schema: false },
            }],
          },
        });

      it("evaluates the query for a principal holding `READ`, and returns `AuthorizationError` for one lacking it", async () => {
        const { server, sessions } = createServer("enforce");
        try {
          await grantAliceOwner(server);
          const alice = await query(server, openAs(sessions, ALICE).sessionId);
          expect(alice.ok?.serverSeq).toBe(1);
          expect(alice.ok?.entities.map((entity) => entity.id)).toEqual([
            aclDocId(SPACE),
          ]);

          const bob = await query(server, openAs(sessions, BOB).sessionId);
          expect(bob.ok).toBeUndefined();
          expect(bob.error).toMatchObject(LACKS_READ);
        } finally {
          await server.close();
        }
      });

      it("returns `QueryError` carrying the failure when the space's engine cannot be opened", async () => {
        const { server, sessions } = createServer();
        try {
          const opened = openAs(sessions, ALICE);
          failOpens(server, new Error("the store is unreachable"));
          expect((await query(server, opened.sessionId)).error).toEqual({
            name: "QueryError",
            message: "the store is unreachable",
          });
        } finally {
          await server.close();
        }
      });
    });

    describe("watchSet()", () => {
      const watchSet = (server: Server, sessionId: string) =>
        server.watchSet({
          type: "session.watch.set",
          requestId: "set",
          space: SPACE,
          sessionId,
          watches: [graphWatch(aclDocId(SPACE))],
        });

      it("returns `SessionError` for a session the space does not hold", async () => {
        const { server } = createServer();
        try {
          expect((await watchSet(server, "no-such-session")).error).toEqual(
            UNKNOWN_SESSION,
          );
        } finally {
          await server.close();
        }
      });

      it("installs the watches of a principal holding `READ`, and returns `AuthorizationError` for one lacking it, installing none", async () => {
        const { server, sessions } = createServer("enforce");
        try {
          await grantAliceOwner(server);
          const alice = openAs(sessions, ALICE);
          expect((await watchSet(server, alice.sessionId)).ok?.serverSeq)
            .toBe(1);
          expect(sessions.get(SPACE, alice.sessionId)?.watches.length).toBe(1);

          const bob = openAs(sessions, BOB);
          expect((await watchSet(server, bob.sessionId)).error).toMatchObject(
            LACKS_READ,
          );
          expect(sessions.get(SPACE, bob.sessionId)?.watches).toEqual([]);
        } finally {
          await server.close();
        }
      });
    });

    describe("watchAdd()", () => {
      it("adds the watches of a principal holding `READ`, and returns `AuthorizationError` for one lacking it, adding none", async () => {
        const { server, sessions } = createServer("enforce");
        try {
          await grantAliceOwner(server);
          const add = (sessionId: string) =>
            server.watchAdd({
              type: "session.watch.add",
              requestId: "add",
              space: SPACE,
              sessionId,
              watches: [graphWatch(aclDocId(SPACE))],
            });
          const alice = openAs(sessions, ALICE);
          expect((await add(alice.sessionId)).ok?.serverSeq).toBe(1);
          expect(sessions.get(SPACE, alice.sessionId)?.watches.length).toBe(1);

          const bob = openAs(sessions, BOB);
          expect((await add(bob.sessionId)).error).toMatchObject(LACKS_READ);
          expect(sessions.get(SPACE, bob.sessionId)?.watches).toEqual([]);
        } finally {
          await server.close();
        }
      });
    });

    describe("watchRemove()", () => {
      const watchId = aclDocId(SPACE);

      const remove = (server: Server, sessionId: string) =>
        server.watchRemove({
          type: "session.watch.remove",
          requestId: "remove",
          space: SPACE,
          sessionId,
          watchIds: [watchId],
        });

      /** Opens a session as `principal` holding one watch on the ACL. */
      const openWatching = async (
        { server, sessions }: Fixture,
        principal: string,
      ): Promise<OpenSessionState> => {
        const opened = openAs(sessions, principal);
        const installed = await server.watchSet({
          type: "session.watch.set",
          requestId: "set",
          space: SPACE,
          sessionId: opened.sessionId,
          watches: [graphWatch(watchId)],
        });
        expect(installed.error).toBeUndefined();
        return opened;
      };

      it("returns `SessionError` for a session the space does not hold", async () => {
        const { server } = createServer();
        try {
          expect((await remove(server, "no-such-session")).error).toEqual(
            UNKNOWN_SESSION,
          );
        } finally {
          await server.close();
        }
      });

      it("removes a watch of a principal holding `READ`, and returns `AuthorizationError` for one whose grant has gone, removing nothing", async () => {
        const fixture = createServer("enforce");
        const { server, sessions } = fixture;
        try {
          await grantAliceOwner(server);
          const alice = await openWatching(fixture, ALICE);
          const removed = await remove(server, alice.sessionId);
          expect(removed.ok?.sync.removes.map((entry) => entry.id)).toEqual([
            watchId,
          ]);
          expect(sessions.get(SPACE, alice.sessionId)?.watches).toEqual([]);

          // A session installs its watches while it holds `READ`; what it
          // asks of the server after its grant goes is refused.
          const bob = openAs(sessions, BOB);
          sessions.get(SPACE, bob.sessionId)!.watches = [graphWatch(watchId)];
          expect((await remove(server, bob.sessionId)).error).toMatchObject(
            LACKS_READ,
          );
          expect(sessions.get(SPACE, bob.sessionId)?.watches).toEqual([
            graphWatch(watchId),
          ]);
        } finally {
          await server.close();
        }
      });

      it("returns `SessionError` and leaves the session's replacement as it stands when the session is replaced while the engine opens", async () => {
        const fixture = createServer();
        const { server, sessions } = fixture;
        try {
          const opened = await openWatching(fixture, ALICE);
          let replacement: OpenSessionState | undefined;
          beforeNextOpen(server, () => {
            replacement = takeOver(sessions, opened);
          });
          expect((await remove(server, opened.sessionId)).error).toEqual(
            UNKNOWN_SESSION,
          );
          expect(replacement).toBeDefined();
          expect(sessions.get(SPACE, opened.sessionId)).toBe(
            replacement!.state,
          );
          expect(replacement!.state.watches.map((watch) => watch.id)).toEqual(
            [watchId],
          );
        } finally {
          await server.close();
        }
      });

      it("returns `QueryError` carrying the failure, keeping the session's watches, when the space's engine cannot be opened", async () => {
        const fixture = createServer();
        const { server, sessions } = fixture;
        try {
          const opened = await openWatching(fixture, ALICE);
          failOpens(server, new Error("the store is unreachable"));
          expect((await remove(server, opened.sessionId)).error).toEqual({
            name: "QueryError",
            message: "the store is unreachable",
          });
          expect(
            sessions.get(SPACE, opened.sessionId)?.watches.map((watch) =>
              watch.id
            ),
          ).toEqual([watchId]);
        } finally {
          server.accessForTestingOnly.engineOpener = undefined;
          await server.close();
        }
      });
    });

    describe("sqliteQuery()", () => {
      it("returns `SessionError` for a session the space does not hold", async () => {
        const { server } = createServer();
        try {
          const response = await server.sqliteQuery({
            type: "sqlite.query",
            requestId: "query",
            space: SPACE,
            sessionId: "no-such-session",
            db: { id: "of:request-refusals-db" },
            sql: "SELECT 1",
          });
          expect(response.error).toEqual(UNKNOWN_SESSION);
        } finally {
          await server.close();
        }
      });
    });

    describe("sqliteRegisterDiskSource()", () => {
      const DB = "of:request-refusals-disk-db";

      const register = (server: Server, sessionId: string, path: string) =>
        server.sqliteRegisterDiskSource({
          type: "sqlite.register-disk-source",
          requestId: "register",
          space: SPACE,
          sessionId,
          id: DB,
          path,
        });

      const lookup = (server: Server, sessionId: string) =>
        server.sqliteQuery({
          type: "sqlite.query",
          requestId: "lookup",
          space: SPACE,
          sessionId,
          db: { id: DB },
          sql: "SELECT value FROM lookup",
        });

      /** Runs `body` with a SQLite file holding `lookup(value)` = `"disk"`. */
      const withDiskFile = async (
        body: (path: string) => Promise<void>,
      ): Promise<void> => {
        const directory = await Deno.makeTempDir({
          prefix: "request-refusals-disk-",
        });
        const path = `${directory}/source.sqlite`;
        const database = new Database(path);
        database.exec("CREATE TABLE lookup (value TEXT)");
        database.exec("INSERT INTO lookup VALUES ('disk')");
        database.close();
        try {
          await body(path);
        } finally {
          await Deno.remove(directory, { recursive: true });
        }
      };

      it("returns `SessionError` for a session the space does not hold", async () => {
        const { server } = createServer();
        try {
          expect(
            (await register(server, "no-such-session", "/dev/null")).error,
          ).toEqual(UNKNOWN_SESSION);
        } finally {
          await server.close();
        }
      });

      it("registers the source for its owner, whose reads then resolve against the file", async () => {
        await withDiskFile(async (path) => {
          const { server, sessions } = createServer("enforce");
          try {
            await grantAliceOwner(server);
            const opened = openAs(sessions, ALICE);
            expect((await register(server, opened.sessionId, path)).ok)
              .toEqual({ registered: true });
            expect((await lookup(server, opened.sessionId)).ok?.rows).toEqual(
              [{ value: "disk" }],
            );
          } finally {
            await server.close();
          }
        });
      });

      it("returns `SessionError` and registers nothing when the session is replaced while the source path resolves", async () => {
        await withDiskFile(async (path) => {
          const { server, sessions } = createServer("enforce");
          try {
            await grantAliceOwner(server);
            const opened = openAs(sessions, ALICE);
            // The request's own check opens the engine first; the takeover
            // lands as the registration opens it after resolving the path.
            let opens = 0;
            let replacement: OpenSessionState | undefined;
            server.accessForTestingOnly.engineOpener = async (space, open) => {
              if (space === SPACE && ++opens === 2) {
                replacement = takeOver(sessions, opened);
              }
              return await open(space);
            };
            expect((await register(server, opened.sessionId, path)).error)
              .toEqual(UNKNOWN_SESSION);
            server.accessForTestingOnly.engineOpener = undefined;
            expect(opens).toBe(2);
            // The read resolves against the space's own database, which
            // holds no row of the file's.
            expect((await lookup(server, replacement!.sessionId)).ok?.rows)
              .toEqual([]);
          } finally {
            server.accessForTestingOnly.engineOpener = undefined;
            await server.close();
          }
        });
      });
    });

    describe("runPatternLifecycle()", () => {
      it("runs the verb as the session's principal, and returns `SessionError` without running it when the session is replaced while the engine opens", async () => {
        const { server, sessions } = createServer();
        try {
          const calls: string[] = [];
          server.setPatternLifecycleHandler((call) => {
            calls.push(call.principal);
            return Promise.resolve({ ok: { ran: call.verb } });
          });
          const opened = openAs(sessions, ALICE);
          const run = () =>
            server.runPatternLifecycle({
              type: "pattern.lifecycle",
              requestId: "lifecycle",
              space: SPACE,
              sessionId: opened.sessionId,
              verb: "follow",
              body: {},
            });
          expect((await run()).ok).toEqual({ ran: "follow" });
          expect(calls).toEqual([ALICE]);

          beforeNextOpen(server, () => takeOver(sessions, opened));
          expect((await run()).error).toEqual({
            name: "SessionError",
            message: "Unknown or replaced session for space",
          });
          expect(calls).toEqual([ALICE]);
        } finally {
          await server.close();
        }
      });
    });

    describe("resolveEventAttention()", () => {
      it("returns `SessionError` when the session is replaced while the engine opens", async () => {
        const { server, sessions } = createServer();
        try {
          const opened = openAs(sessions, ALICE);
          const resolve = () =>
            server.resolveEventAttention({
              type: "event.attention.resolve",
              requestId: "resolve",
              space: SPACE,
              sessionId: opened.sessionId,
              eventId: "event-1",
              seq: 1,
              sidecarId: "of:request-refusals-sidecar",
              action: "dismiss",
            });
          // Unreplaced, the request reaches the notice lookup, which finds
          // no such notice.
          const reached = await resolve();
          expect(reached.error?.name).not.toBe("SessionError");

          beforeNextOpen(server, () => takeOver(sessions, opened));
          expect((await resolve()).error).toEqual({
            name: "SessionError",
            message: "Unknown or replaced session for space",
          });
        } finally {
          await server.close();
        }
      });
    });
  });
});
