import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

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
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-client-marked-splices";
const ID = "of:marked-splices-list";

/**
 * A transport whose host can be taken down and brought back as another
 * server. While it is down every send rejects with a `ConnectionError`, so
 * the client keeps retrying its handshake until `comeBack()`. `transacts`
 * holds each commit handed to a live server, in wire order, and `sent()`
 * resolves once a live server has been handed the commit `localSeq`. While
 * `losesTransactResponses` is set, the client never receives the response to
 * a `transact` frame.
 */
function hostTransport(server: Server) {
  let host = server;
  let receiver = (_payload: string) => {};
  let disconnected = (_error?: Error) => {};
  const transacts: ClientCommit[] = [];
  const lost = new Set<string>();
  let losesTransactResponses = false;
  const handed = new Map<number, PromiseWithResolvers<void>>();
  const handedOf = (localSeq: number) => {
    let entry = handed.get(localSeq);
    if (entry === undefined) {
      entry = Promise.withResolvers<void>();
      handed.set(localSeq, entry);
    }
    return entry;
  };
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
  // reconnects to one on the same store that does not.
  let path: string;
  let before: Server;
  let after: Server | undefined;
  let host: ReturnType<typeof hostTransport>;
  let client: Client;
  let session: SpaceSession;
  let seeded: number;

  const server = (markedSplices: boolean) =>
    new Server({
      ...testSessionOpenServerOptions,
      store: toFileUrl(path),
      markedSplices,
    });

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
