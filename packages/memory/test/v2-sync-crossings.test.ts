import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { GraphWatchSpec, SessionSync } from "../v2.ts";
import {
  type Client,
  connect,
  loopback,
  type SpaceSession,
} from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const space = "did:key:z6Mk-sync-crossings-here";
const farSpace = "did:key:z6Mk-sync-crossings-far";

const leafSchema = {
  type: "object",
  properties: { name: { type: "string" } },
} as const;

/** Watches `id` under a schema that follows its `next` link. */
const followingWatch = (id: string): GraphWatchSpec => ({
  id,
  kind: "graph",
  query: {
    roots: [{
      id,
      selector: {
        path: [],
        schema: { type: "object", properties: { next: leafSchema } },
      },
    }],
  },
});

const link = (toSpace: string, id: string) => ({
  "/": { "link@1": { space: toSpace, id, path: [] } },
});

describe("sync crossings", () => {
  let server: Server;
  let writerClient: Client;
  let readerClient: Client;
  let writer: SpaceSession;
  let reader: SpaceSession;

  beforeEach(async () => {
    server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL(`memory://sync-crossings-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: "manual",
    });
    writerClient = await connect({ transport: loopback(server) });
    readerClient = await connect({ transport: loopback(server) });
    writer = await writerClient.mount(space, {}, testSessionOpenAuthFactory);
    reader = await readerClient.mount(space, {}, testSessionOpenAuthFactory);
    // Two documents whose `next` links into the other space, and one whose
    // `next` stays here.
    await writer.transact({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        {
          op: "set",
          id: "of:crossing-top",
          value: { value: { next: link(farSpace, "of:far-leaf") } },
        },
        {
          op: "set",
          id: "of:crossing-other",
          value: { value: { next: link(farSpace, "of:far-leaf") } },
        },
        {
          op: "set",
          id: "of:local-top",
          value: { value: { next: link(space, "of:near-leaf") } },
        },
        {
          op: "set",
          id: "of:near-leaf",
          value: { value: { name: "near" } },
        },
      ],
    });
    await server.flushSessions();
  });

  afterEach(async () => {
    await readerClient.close();
    await writerClient.close();
    await server.close();
  });

  const farLeaf = {
    space: farSpace,
    id: "of:far-leaf",
    path: [],
    schema: leafSchema,
  };

  it("advertises the capability in its handshake flags", () => {
    expect(readerClient.serverFlags?.syncCrossingsV1).toBe(true);
  });

  it("carries the link a watch's walk followed into another space", async () => {
    const { sync } = await reader.watchAddSync([
      followingWatch("of:crossing-top"),
    ]);
    expect(sync.crossings).toEqual([farLeaf]);
  });

  it("carries no crossing for a link the walk followed within the space", async () => {
    const { sync } = await reader.watchAddSync([
      followingWatch("of:local-top"),
    ]);
    expect(sync.crossings).toBeUndefined();
    expect(sync.upserts.map((upsert) => upsert.id)).toEqual([
      "of:local-top",
      "of:near-leaf",
    ]);
  });

  it("carries the crossing an added watch finds while extending an existing graph", async () => {
    // The first watch gives the session a graph with no crossing; the
    // second extends that graph, and its response carries what the
    // extension's walk found rather than leaving it to a later frame.
    await reader.watchAddSync([followingWatch("of:local-top")]);
    const { sync } = await reader.watchAddSync([
      followingWatch("of:crossing-top"),
    ]);
    expect(sync.upserts.map((upsert) => upsert.id)).toEqual([
      "of:crossing-top",
    ]);
    expect(sync.crossings).toEqual([farLeaf]);
  });

  it("tells a session of each crossing once", async () => {
    await reader.watchAddSync([followingWatch("of:crossing-top")]);
    const { sync } = await reader.watchAddSync([
      followingWatch("of:crossing-other"),
    ]);
    expect(sync.upserts.map((upsert) => upsert.id)).toEqual([
      "of:crossing-other",
    ]);
    expect(sync.crossings).toBeUndefined();
  });

  it("tells every crossing again on a replacement that declares no holdings", async () => {
    await reader.watchAddSync([followingWatch("of:crossing-top")]);
    const { sync: replaced } = await reader.watchSetSync([
      followingWatch("of:crossing-top"),
      followingWatch("of:crossing-other"),
    ]);
    expect(replaced.crossings).toEqual([farLeaf]);
  });

  it("delivers a document a same-space link named once it is written, retiring the miss", async () => {
    // The same walk that reports a crossing records a same-space dead-end as
    // a miss attributed to the referrer; the document's arrival retires it
    // and the pushed frame carries the document.
    await writer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:missing-top",
        value: { value: { next: link(space, "of:missing-leaf") } },
      }],
    });
    await server.flushSessions();
    const first = await reader.watchAddSync([followingWatch("of:missing-top")]);
    expect(first.sync.upserts.map((upsert) => upsert.id)).toEqual([
      "of:missing-top",
    ]);
    const frames = first.view.subscribeSync();
    const pushed = (async (): Promise<SessionSync> => {
      for (;;) {
        const { done, value } = await frames.next();
        if (done) throw new Error("the view closed before the leaf arrived");
        if (value.upserts.some((upsert) => upsert.id === "of:missing-leaf")) {
          return value;
        }
      }
    })();
    await writer.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:missing-leaf",
        value: { value: { name: "born" } },
      }],
    });
    await server.flushSessions();
    const arrived = await pushed;
    expect(arrived.upserts.map((upsert) => upsert.id)).toEqual([
      "of:missing-leaf",
    ]);
    expect(arrived.crossings).toBeUndefined();
  });

  it("carries a crossing a later write creates, as a pushed frame", async () => {
    await writer.transact({
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:later-top",
        value: { value: { next: { name: "inline" } } },
      }],
    });
    await server.flushSessions();
    const first = await reader.watchAddSync([followingWatch("of:later-top")]);
    expect(first.sync.crossings).toBeUndefined();
    const frames = first.view.subscribeSync();
    const pushed = (async (): Promise<SessionSync> => {
      for (;;) {
        const { done, value } = await frames.next();
        if (done) throw new Error("the view closed before a crossing arrived");
        if (value.crossings !== undefined) return value;
      }
    })();
    await writer.transact({
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:later-top",
        value: { value: { next: link(farSpace, "of:far-leaf") } },
      }],
    });
    await server.flushSessions();
    expect((await pushed).crossings).toEqual([farLeaf]);
  });
});
