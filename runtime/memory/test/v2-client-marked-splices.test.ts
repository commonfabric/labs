import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import {
  type ClientCommit,
  decodeMemoryBoundary,
  toDocumentPath,
} from "../v2.ts";
import {
  type Client,
  connect,
  connectionError,
  isMarkedSpliceRefusal,
  loopback,
  type SpaceSession,
  type Transport,
  unsentConnectionError,
} from "../v2/client.ts";
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

const SPACE = "did:key:z6Mk-client-marked-splices";
const ID = "of:marked-splices-list";

/**
 * A transport whose host can be taken down and brought back as another
 * server. While it is down every send rejects with a `ConnectionError`, so
 * the client keeps retrying its handshake until `comeBack()`. `transacts`
 * holds each commit handed to a live server, in wire order, and `sent()`
 * resolves once a live server has been handed the commit `localSeq`. While
 * `losesTransactResponses` is set, the client never receives the response to
 * a `transact` frame. While `holdsTransacts` is set, a `transact` send waits
 * in a queue, as one behind an earlier WebSocket write does, until
 * `release()`; `queued()` resolves once the commit `localSeq` waits there.
 * One whose connection changed while it waited rejects, unwritten, with an
 * `unsentConnectionError()`, as the WebSocket transport's does, and
 * `unwritten()` resolves for it.
 */
function hostTransport(server: Server) {
  let host = server;
  let receiver = (_payload: string) => {};
  let disconnected = (_error?: Error) => {};
  const transacts: ClientCommit[] = [];
  const lost = new Set<string>();
  let losesTransactResponses = false;
  let holdsTransacts = false;
  let held = Promise.withResolvers<void>();
  /** Promises keyed by commit `localSeq`, made on first ask. */
  const signals = () => {
    const entries = new Map<number, PromiseWithResolvers<void>>();
    return (localSeq: number) => {
      let entry = entries.get(localSeq);
      if (entry === undefined) {
        entry = Promise.withResolvers<void>();
        entries.set(localSeq, entry);
      }
      return entry;
    };
  };
  const handedOf = signals();
  const queuedOf = signals();
  const unwrittenOf = signals();
  const open = (next: Server): Transport => {
    const connection = loopback(next);
    connection.setReceiver((payload) => {
      const { requestId } = decodeMemoryBoundary(payload) as {
        requestId?: string;
      };
      if (requestId !== undefined && lost.has(requestId)) return;
      receiver(payload);
    });
    return connection;
  };
  let active: Transport | null = open(server);
  const transport: Transport = {
    async send(payload) {
      if (active === null) throw connectionError("connection refused");
      const message = decodeMemoryBoundary(payload) as {
        type: string;
        requestId?: string;
        commit?: ClientCommit;
      };
      if (message.type === "transact" && holdsTransacts) {
        const connection = active;
        const release = held.promise;
        queuedOf(message.commit!.localSeq).resolve();
        await release;
        if (active !== connection) {
          unwrittenOf(message.commit!.localSeq).resolve();
          throw unsentConnectionError("Memory websocket changed before send");
        }
      }
      if (active === null) throw connectionError("connection refused");
      if (message.type === "transact") {
        transacts.push(message.commit!);
        if (losesTransactResponses) lost.add(message.requestId!);
      }
      await active.send(payload);
      if (message.type === "transact") {
        handedOf(message.commit!.localSeq).resolve();
      }
    },
    close: () => active?.close() ?? Promise.resolve(),
    reset() {
      if (active === null) return;
      void active.close();
      active = open(host);
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver(next) {
      disconnected = next;
    },
  };
  return {
    transport,
    transacts,
    sent: (localSeq: number) => handedOf(localSeq).promise,
    queued: (localSeq: number) => queuedOf(localSeq).promise,
    unwritten: (localSeq: number) => unwrittenOf(localSeq).promise,
    set holdsTransacts(next: boolean) {
      holdsTransacts = next;
    },
    release(): void {
      held.resolve();
      held = Promise.withResolvers<void>();
    },
    set losesTransactResponses(next: boolean) {
      losesTransactResponses = next;
    },
    async goDown(): Promise<void> {
      const down = active;
      active = null;
      await down?.close();
      disconnected(new Error("synthetic outage"));
    },
    comeBack(next: Server): void {
      host = next;
      active = open(next);
    },
  };
}

describe("v2-client marked splices across a reconnect", () => {
  // A session refuses, unsent, a commit carrying a marked splice whose first
  // send would go out on a connection that does not advertise
  // `markedSplicesV1`; a commit it has sent once goes again unchanged. Each
  // case opens the space on a server that advertises the mark, then
  // reconnects to one on the same store that does not, standing in for a
  // server that predates marked splices, as after a rollback.
  let path: string;
  let before: Server;
  let after: Server | undefined;
  let host: ReturnType<typeof hostTransport>;
  let client: Client;
  let session: SpaceSession;
  let seeded: number;

  /**
   * A server on the case's store, which advertises the mark as this build's
   * do, unless `markedSplices` is false, when it advertises what one that
   * predates marked splices does.
   */
  const server = (markedSplices: boolean) => {
    const made = new Server({
      ...testSessionOpenServerOptions,
      store: toFileUrl(path),
    });
    if (!markedSplices) {
      const flags = made.memoryProtocolFlags.bind(made);
      made.memoryProtocolFlags = () => ({ ...flags(), markedSplicesV1: false });
    }
    return made;
  };

  /** A head insertion into the list, marked, under a read of the document. */
  const markedInsertion = (localSeq: number): ClientCommit => ({
    localSeq,
    reads: {
      confirmed: [{ id: ID, path: toDocumentPath(["value"]), seq: seeded }],
      pending: [],
    },
    operations: [{
      op: "patch",
      id: ID,
      patches: [{
        op: "splice",
        path: "/value/list",
        index: 0,
        remove: 0,
        add: ["x"],
        pinned: true,
      }],
    }],
  });

  /**
   * Brings the host, down, back as a server on the same store that does not
   * advertise the mark.
   */
  const comeBackWithoutTheMark = async () => {
    await before.close();
    after = server(false);
    host.comeBack(after);
  };

  beforeEach(async () => {
    after = undefined;
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    before = server(true);
    host = hostTransport(before);
    client = await connect({ transport: host.transport });
    session = await client.mount(SPACE, {}, testSessionOpenAuthFactory);
    expect(client.serverFlags?.markedSplicesV1).toBe(true);
    seeded = (await session.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: ID, value: { value: { list: ["a"] } } }],
    })).seq;
  });

  afterEach(async () => {
    await client.close();
    await (after ?? before).close();
    await Deno.remove(path);
  });

  it("refuses, unsent, a marked commit first sent after the server stopped advertising the mark", async () => {
    await host.goDown();
    const issued = session.transact(markedInsertion(2));
    issued.catch(() => {});
    await comeBackWithoutTheMark();
    await client.restoreConnection();

    const refusal = await issued.then(() => undefined, (error) => error);
    expect(isMarkedSpliceRefusal(refusal)).toBe(true);
    expect((refusal as Error).name).toBe("ConflictError");
    expect(client.serverFlags?.markedSplicesV1).toBe(false);
    expect(host.transacts.filter((commit) => commit.localSeq === 2)).toEqual(
      [],
    );
    // The connection stays usable: the same change, index by index, lands.
    await session.transact({
      localSeq: 3,
      reads: {
        confirmed: [{ id: ID, path: toDocumentPath(["value"]), seq: seeded }],
        pending: [],
      },
      operations: [{
        op: "patch",
        id: ID,
        patches: [
          { op: "replace", path: "/value/list/0", value: "x" },
          {
            op: "splice",
            path: "/value/list",
            index: 1,
            remove: 0,
            add: [
              "a",
            ],
          },
        ],
      }],
    });
  });

  it("refuses, unsent, a marked commit whose first send its transport wrote none of before the connection changed", async () => {
    host.holdsTransacts = true;
    const issued = session.transact(markedInsertion(2));
    issued.catch(() => {});
    await host.queued(2);
    await host.goDown();
    host.holdsTransacts = false;
    host.release();
    await host.unwritten(2);
    await comeBackWithoutTheMark();
    await client.restoreConnection();

    const refusal = await issued.then(() => undefined, (error) => error);
    expect(isMarkedSpliceRefusal(refusal)).toBe(true);
    expect(host.transacts.filter((commit) => commit.localSeq === 2)).toEqual(
      [],
    );
  });

  it("keeps a marked commit it sent once unchanged when a later resend is written none of", async () => {
    // Sent once, on a connection that advertises the mark, and unanswered.
    host.losesTransactResponses = true;
    const issued = session.transact(markedInsertion(2));
    await host.sent(2);
    host.losesTransactResponses = false;
    // Its resend on the next connection waits, and that connection drops
    // before any of it is written.
    host.holdsTransacts = true;
    await host.goDown();
    host.comeBack(before);
    client.restoreConnection().catch(() => {});
    await host.queued(2);
    await host.goDown();
    host.holdsTransacts = false;
    host.release();
    await host.unwritten(2);
    await comeBackWithoutTheMark();
    await client.restoreConnection();

    // The first send may have reached the store, so the commit still goes
    // as it was, and the store answers it as the commit it took.
    const applied = await issued;
    const sends = host.transacts.filter((commit) => commit.localSeq === 2);
    expect(sends.length).toBe(2);
    expect(sends[1]).toEqual(sends[0]);
    expect(applied.seq).toBeGreaterThan(seeded);
  });

  it("sends a marked commit it sent once unchanged after a reconnect, and the store answers it as the commit it took", async () => {
    host.losesTransactResponses = true;
    const issued = session.transact(markedInsertion(2));
    await host.sent(2);
    host.losesTransactResponses = false;
    await host.goDown();
    await comeBackWithoutTheMark();
    await client.restoreConnection();

    const applied = await issued;
    expect(client.serverFlags?.markedSplicesV1).toBe(false);
    const sends = host.transacts.filter((commit) => commit.localSeq === 2);
    expect(sends.length).toBe(2);
    expect(sends[1]).toEqual(sends[0]);
    expect(applied.seq).toBeGreaterThan(seeded);
  });
});
