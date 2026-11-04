/**
 * An in-process memory server holding a small Topics board stored the way
 * the deployed board stores one: a board piece linking its input document,
 * a `names` map whose entries link either a piece or a document that only
 * links onward to one, and Topic input documents whose comments are partly
 * documents of their own and partly inline records.
 */

import {
  type Client,
  connect,
  loopback,
  type MountOptions,
  type SessionOpenAuthFactory,
  type SpaceSession,
} from "@commonfabric/memory/v2/client";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import type { EntityDocument } from "@commonfabric/memory/v2";
import { Server } from "@commonfabric/memory/v2/server";
import type { SessionFactory } from "@commonfabric/runner/storage/v2";

import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "../../../../runtime/memory/test/v2-auth-test-helpers.ts";
import { type OpenedDocSource, sessionDocSource } from "./sync.ts";

export const SPACE = "did:key:z6Mk-topics-tool-board";
export const BOARD = "of:fid1:topics-board";

/** A link as the server stores one. */
export function link(id: string | undefined, path: string[] = []) {
  return { "/": { "link@1": { ...(id === undefined ? {} : { id }), path } } };
}

/** Topic 1's input document, which a test rewrites to add a comment. */
export const INPUT_1 = {
  title: "Flaky fryer test",
  body: "The fryer test fails\nwhen the oil is cold.",
  createdAt: 1000,
  createdBy: { kind: "agent", name: "Sol" },
  comments: [link("of:fid1:comment-1")],
  links: [{
    kind: "pr",
    url: "https://example.com/pull/1",
    label: "Fix",
    addedAt: 3000,
  }],
};

/** The standard board's documents. */
export const BOARD_DOCS: Record<string, EntityDocument> = {
  [BOARD]: {
    value: { title: "Topics" },
    argument: link("of:fid1:board-input"),
  },
  "of:fid1:board-input": {
    value: {
      names: {
        "1": link("of:fid1:topic-alias-1"),
        "2": link("of:fid1:topic-piece-2"),
      },
    },
  },
  "of:fid1:topic-alias-1": { value: link("of:fid1:topic-piece-1") },
  "of:fid1:topic-piece-1": {
    value: { $NAME: "Fryer" },
    argument: link("of:fid1:input-1"),
  },
  "of:fid1:topic-piece-2": { value: {}, argument: link("of:fid1:input-2") },
  "of:fid1:input-1": { value: INPUT_1 },
  "of:fid1:comment-1": {
    value: {
      author: { kind: "person", name: "Ada" },
      body: "Reproduced with cold oil.",
      sentAt: 2000,
    },
  },
  "of:fid1:input-2": {
    value: {
      title: link(undefined, ["draftTitle"]),
      draftTitle: "Donut glaze",
      body: "Glaze ratios.",
      createdAt: 1500,
      createdByName: "Legacy Lu",
      comments: [],
      links: [],
    },
  },
};

/** A memory server, a writer on it, and sources reading from it. */
export interface BoardServer {
  /** Sets each document in one commit. */
  write(docs: Record<string, EntityDocument>): Promise<void>;

  /** Deletes the document `id`. */
  delete(id: string): Promise<void>;

  /** A session of its own on `space`, the board's by default. */
  mount(space?: string): Promise<{ client: Client; session: SpaceSession }>;

  /** The server itself, for a runtime to run a pattern on. */
  server: Server;

  /**
   * A source over a session of its own on `space`, the board's by default,
   * as the client opens one.
   */
  open(space?: string): Promise<OpenedDocSource>;

  /** Sessions as `openDocSource` opens them, on this server. */
  Sessions: new (address: (space: MemorySpace) => URL) => SessionFactory;

  /** The storage endpoint each of those was given for the board's space. */
  addresses: string[];

  close(): Promise<void>;
}

/** Starts a server holding the standard board. */
export async function boardServer(): Promise<BoardServer> {
  const server = new Server({
    store: new URL(`memory://topics-tool-${crypto.randomUUID()}`),
    ...testSessionOpenServerOptions,
    subscriptionRefreshDelayMs: 0,
  });
  const clients: Client[] = [];
  const mount = async (options: MountOptions = {}, space = SPACE) => {
    const client = await connect({ transport: loopback(server) });
    clients.push(client);
    const auth: SessionOpenAuthFactory = testSessionOpenAuthFactory;
    return { client, session: await client.mount(space, options, auth) };
  };
  const writer = (await mount()).session;
  const addresses: string[] = [];
  let localSeq = 0;
  const write = async (docs: Record<string, EntityDocument>) => {
    await writer.transact({
      localSeq: ++localSeq,
      reads: { confirmed: [], pending: [] },
      operations: Object.entries(docs).map(([id, value]) => ({
        op: "set" as const,
        id,
        value,
      })),
    });
  };
  const remove = async (id: string) => {
    await writer.transact({
      localSeq: ++localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "delete", id }],
    });
  };
  await write(BOARD_DOCS);
  return {
    mount: (space = SPACE) => mount({}, space),
    server,
    write,
    delete: remove,
    async open(space = SPACE) {
      const { client, session } = await mount({}, space);
      return {
        ...sessionDocSource(session, space),
        close: () => client.close(),
      };
    },
    addresses,
    Sessions: class implements SessionFactory {
      readonly supportsAclBootstrap = true;

      constructor(address: (space: MemorySpace) => URL) {
        addresses.push(address(SPACE).href);
      }

      create(space: MemorySpace, _signer?: Signer, options?: MountOptions) {
        return mount(options, space);
      }
    },
    async close() {
      for (const client of clients) await client.close();
      await server.close();
    },
  };
}
