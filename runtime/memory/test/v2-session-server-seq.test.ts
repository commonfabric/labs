import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { connect, loopback, type SpaceSession } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

type Client = Awaited<ReturnType<typeof connect>>;

const space = "did:key:z6Mk-session-server-seq";

/** Commits a new value of `of:doc:1` through `session`. */
const write = (session: SpaceSession, localSeq: number) =>
  session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: "of:doc:1",
      value: { value: { localSeq } },
    }],
  });

const rootQuery = {
  roots: [{ id: "of:doc:1", selector: { path: [], schema: false } }],
};

describe("SpaceSession", () => {
  let server: Server;
  let clients: Client[];

  /** Mounts `space` through a client of its own. */
  const mount = async (): Promise<SpaceSession> => {
    const client = await connect({ transport: loopback(server) });
    clients.push(client);
    return await client.mount(space, {}, testSessionOpenAuthFactory);
  };

  beforeEach(() => {
    server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL(`memory://session-server-seq-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: 0,
    });
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) await client.close();
    await server.close();
  });

  describe("instance members", () => {
    describe("subscribeServerSeq()", () => {
      it("reports the seq of a commit of the session's own", async () => {
        const session = await mount();
        const seen: number[] = [];
        session.subscribeServerSeq((seq) => seen.push(seq));

        const applied = await write(session, 1);

        expect(seen).toEqual([applied.seq]);
        expect(session.serverSeq).toBe(applied.seq);
      });

      it("reports the seq of a commit another session makes to a watched document", async () => {
        const writer = await mount();
        const watcher = await mount();
        await write(writer, 1);
        const view = await watcher.watchSet([{
          id: "root",
          kind: "graph",
          query: rootQuery,
        }]);
        const seen: number[] = [];
        watcher.subscribeServerSeq((seq) => seen.push(seq));
        const pushed = view.subscribe().next();

        const applied = await write(writer, 2);
        await pushed;

        expect(seen).toEqual([applied.seq]);
      });

      it("does not report a seq no newer than the one already known", async () => {
        const session = await mount();
        const applied = await write(session, 1);
        const seen: number[] = [];
        session.subscribeServerSeq((seq) => seen.push(seq));

        // A query is answered at the seq the session already knows.
        const result = await session.queryGraph(rootQuery);
        // A pushed sync behind what the session knows.
        session.handleEffect({
          type: "sync",
          fromSeq: 0,
          toSeq: 0,
          upserts: [],
          removes: [],
        });

        expect(result.serverSeq).toBe(applied.seq);
        expect(seen).toEqual([]);
        expect(session.serverSeq).toBe(applied.seq);
      });

      it("reports to the other observers when one throws, and logs the throw", async () => {
        const session = await mount();
        const failure = new Error("observer failure");
        const reported = stub(console, "error");
        try {
          session.subscribeServerSeq(() => {
            throw failure;
          });
          const seen: number[] = [];
          session.subscribeServerSeq((seq) => seen.push(seq));

          const applied = await write(session, 1);

          expect(seen).toEqual([applied.seq]);
          expect(reported.calls.map((call) => call.args)).toContainEqual([
            "server-seq subscriber threw:",
            failure,
          ]);
        } finally {
          reported.restore();
        }
      });

      it("returns a function that stops the reports", async () => {
        const session = await mount();
        const seen: number[] = [];
        const stop = session.subscribeServerSeq((seq) => seen.push(seq));
        const first = await write(session, 1);

        stop();
        await write(session, 2);

        expect(seen).toEqual([first.seq]);
      });

      it("reports nothing for an answer that arrives after the session began closing", async () => {
        const writer = await mount();
        const queried = Promise.withResolvers<void>();
        const inner = loopback(server);
        const client = await connect({
          transport: {
            ...inner,
            send(payload) {
              const sent = inner.send(payload);
              if (payload.includes('"graph.query"')) queried.resolve();
              return sent;
            },
          },
        });
        clients.push(client);
        const session = await client.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        const applied = await write(writer, 1);
        const seen: number[] = [];
        session.subscribeServerSeq((seq) => seen.push(seq));

        // The query is sent before the close begins, and answered at the
        // writer's commit, which the session had not heard of.
        const answered = session.queryGraph(rootQuery);
        await queried.promise;
        const closing = session.close();
        const result = await answered;
        await closing;

        expect(result.serverSeq).toBe(applied.seq);
        expect(session.serverSeq).toBe(applied.seq);
        expect(seen).toEqual([]);
      });

      it("reports nothing once the session is closed", async () => {
        const session = await mount();
        const seen: number[] = [];
        session.subscribeServerSeq((seq) => seen.push(seq));

        await session.close();
        session.handleEffect({
          type: "sync",
          fromSeq: 0,
          toSeq: 5,
          upserts: [],
          removes: [],
        });

        expect(seen).toEqual([]);
      });

      it("reports nothing once the session is revoked", async () => {
        const session = await mount();
        const seen: number[] = [];
        session.subscribeServerSeq((seq) => seen.push(seq));

        session.handleRevoked("unauthorized");
        session.handleEffect({
          type: "sync",
          fromSeq: 0,
          toSeq: 5,
          upserts: [],
          removes: [],
        });

        expect(session.closeError?.name).toBe("AuthorizationError");
        expect(seen).toEqual([]);
      });
    });
  });
});
