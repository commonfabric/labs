/**
 * The order a session's frames reach the wire: a frame goes out in the step
 * that records its documents as delivered, so a frame whose `cid:` closure was
 * left out on that record's say-so cannot overtake the frame carrying it
 * (docs/specs/memory-v2/04-protocol.md, section 4.3.6). A client validating
 * arrivals in wire order quarantines a document that overtakes its closure.
 *
 * Each case holds a server method's return, which is the moment between its
 * recording what it delivered and its caller getting control, and puts the
 * competing frame there. That moment is a few microtasks long in production, so
 * only holding it makes the order deterministic. The cases read frames as the
 * connection's transport gets them, and so say nothing of what a client does
 * with them.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
} from "../v2.ts";

const AUDIENCE = "did:key:z6Mk-frame-order-audience";
const SPACE = "did:key:z6Mk-frame-order-space";
const WRITER = "did:key:z6Mk-frame-order-writer";
const READER = "did:key:z6Mk-frame-order-reader";

const leafSchema = { type: "string", title: "frame-order-leaf" } as const;
const leafHash = internSchemaAsTaggedHashString(leafSchema);
const LEAF_ID = `cid:${leafHash}`;

const NAMING_ID = "of:frame-order-naming";
const OTHER_NAMING_ID = "of:frame-order-other-naming";
const PLAIN_ID = "of:frame-order-plain";

type Upsert = { id: string };

type Frame = { kind: "response" | "effect"; ids: string[] };

type Peer = {
  messages: ServerMessage[];
  connection: ReturnType<Server["connect"]>;
  sessionOpen: SessionOpenAuthMetadata;
};

/** A document value naming the leaf schema through a link's schema position. */
const naming = (revision: number) => ({
  value: {
    revision,
    mention: {
      "/": {
        "link@1": {
          id: "of:frame-order-absent",
          path: [],
          schema: { $ref: LEAF_ID },
        },
      },
    },
  },
});

/** A watch on one document that walks nothing it links to. */
const watchOn = (id: string, watchId: string) => ({
  id: watchId,
  kind: "graph" as const,
  query: {
    roots: [{ id, selector: { path: [], schema: false as const } }],
  },
});

/**
 * Wraps `method` so that its first call `selected` picks, once it has done its
 * work, holds its return until `release()` is called. `reached` resolves when
 * it is held.
 */
const holdFirstReturn = <A extends unknown[], R>(
  method: (...args: A) => Promise<R>,
  selected: (...args: A) => boolean = () => true,
) => {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let held = false;
  return {
    wrapped: async (...args: A): Promise<R> => {
      const result = await method(...args);
      if (!held && selected(...args)) {
        held = true;
        reached.resolve();
        await released.promise;
      }
      return result;
    },
    reached: reached.promise,
    release: released.resolve,
  };
};

describe("session frame order", () => {
  let server: Server;
  let reader: Peer;
  let readerSession: string;
  let readerToken: string;
  let writerSession: string;
  let localSeq = 0;
  let requests = 0;

  const requestId = (): string => `frame-order-${++requests}`;

  const connect = async (): Promise<Peer> => {
    const messages: ServerMessage[] = [];
    const connection = server.connect((message) => messages.push(message));
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    }));
    const hello = messages.shift() as HelloOkMessage;
    assert(hello.sessionOpen !== undefined, "expected session-open metadata");
    return { messages, connection, sessionOpen: hello.sessionOpen };
  };

  /** The request that opens a session, or resumes the one `session` names. */
  const openRequest = (
    peer: Peer,
    principal: string,
    session: { sessionId?: string; sessionToken?: string } = {},
  ) =>
    encodeMemoryBoundary({
      type: "session.open",
      requestId: requestId(),
      space: SPACE,
      session,
      invocation: {
        iss: principal,
        aud: peer.sessionOpen.audience,
        challenge: peer.sessionOpen.challenge.value,
      },
    });

  /** Commits `documents`, each id's whole value, as the writer. */
  const commit = async (documents: Record<string, unknown>): Promise<void> => {
    const response = await server.transact(
      {
        type: "transact",
        requestId: requestId(),
        space: SPACE,
        sessionId: writerSession,
        commit: {
          localSeq: ++localSeq,
          reads: { confirmed: [], pending: [] },
          operations: Object.entries(documents).map(([id, value]) => ({
            op: "set",
            id,
            value,
          })),
        },
      } as Parameters<Server["transact"]>[0],
    );
    assert(response.ok !== undefined, JSON.stringify(response.error));
  };

  const send = (message: Record<string, unknown>): Promise<void> =>
    reader.connection.receive(encodeMemoryBoundary({
      requestId: requestId(),
      space: SPACE,
      sessionId: readerSession,
      ...message,
    }));

  const addWatch = (id: string, watchId: string): Promise<void> =>
    send({ type: "session.watch.add", watches: [watchOn(id, watchId)] });

  /** The frames `messages` holds, in the order the transport got them. */
  const framesOf = (messages: readonly ServerMessage[]): Frame[] =>
    messages.flatMap((message): Frame[] => {
      if (message.type === "session/effect") {
        return [{
          kind: "effect",
          ids: (message.effect.upserts as Upsert[]).map(({ id }) => id),
        }];
      }
      if (message.type !== "response") return [];
      const { ok } = message as ResponseMessage<
        { sync?: { upserts: Upsert[] } }
      >;
      return ok?.sync === undefined
        ? []
        : [{ kind: "response", ids: ok.sync.upserts.map(({ id }) => id) }];
    });

  beforeEach(async () => {
    server = new Server({
      store: new URL(`memory://frame-order-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: "manual",
      authorizeSessionOpen: (message) => {
        const iss = message.invocation?.iss;
        return typeof iss === "string" ? iss : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
    });
    const writer = await connect();
    await writer.connection.receive(openRequest(writer, WRITER));
    const writerOpen = writer.messages.shift() as ResponseMessage<
      { sessionId: string }
    >;
    writerSession = writerOpen.ok!.sessionId;

    reader = await connect();
    await reader.connection.receive(openRequest(reader, READER));
    const readerOpen = reader.messages.shift() as ResponseMessage<
      {
        sessionId: string;
        sessionToken: string;
        sessionOpen: SessionOpenAuthMetadata;
      }
    >;
    readerSession = readerOpen.ok!.sessionId;
    readerToken = readerOpen.ok!.sessionToken;
    reader.sessionOpen = readerOpen.ok!.sessionOpen;

    await commit({
      [LEAF_ID]: { value: leafSchema },
      [NAMING_ID]: naming(1),
      [OTHER_NAMING_ID]: naming(1),
      [PLAIN_ID]: { value: { revision: 1 } },
    });
  });

  afterEach(async () => {
    await server.close();
  });

  /**
   * Holds a watch mutation's return while a commit's frame goes out, and
   * returns the frames that followed, in order.
   */
  const framesAroundHeldMutation = async (
    hold: { reached: Promise<void>; release: () => void },
    mutate: () => Promise<void>,
  ): Promise<Frame[]> => {
    const from = reader.messages.length;
    const mutated = mutate();
    await hold.reached;
    await commit({ [NAMING_ID]: naming(2) });
    await server.flushSessions([SPACE]);
    hold.release();
    await mutated;
    return framesOf(reader.messages.slice(from));
  };

  /**
   * Holds an effect's evaluation's return while a watch is added, and returns
   * the frames that followed, in order.
   */
  const framesAroundHeldEffect = async (
    beforeFlush: () => void = () => {},
  ): Promise<Frame[]> => {
    await addWatch(PLAIN_ID, "w-plain");
    const from = reader.messages.length;
    const hold = holdFirstReturn(
      server.syncSessionForConnection.bind(server),
      (_space, sessionId) => sessionId === readerSession,
    );
    server.syncSessionForConnection = hold.wrapped;
    await commit({ [PLAIN_ID]: naming(2) });
    beforeFlush();
    const flushed = server.flushSessions([SPACE]);
    await hold.reached;
    await addWatch(OTHER_NAMING_ID, "w-other");
    hold.release();
    await flushed;
    return framesOf(reader.messages.slice(from));
  };

  describe("a watch mutation's response", () => {
    it("reaches the wire ahead of an effect built after `watch.add` recorded it", async () => {
      const hold = holdFirstReturn(server.watchAdd.bind(server));
      server.watchAdd = hold.wrapped;

      const frames = await framesAroundHeldMutation(
        hold,
        () => addWatch(NAMING_ID, "w-naming"),
      );

      expect(frames.map(({ kind }) => kind)).toEqual(["response", "effect"]);
      expect(frames[0].ids).toContain(LEAF_ID);
      expect(frames[1].ids).toEqual([NAMING_ID]);
    });

    it("reaches the wire ahead of an effect built after `watch.set` recorded it", async () => {
      const hold = holdFirstReturn(server.watchSet.bind(server));
      server.watchSet = hold.wrapped;

      const frames = await framesAroundHeldMutation(
        hold,
        () =>
          send({
            type: "session.watch.set",
            watches: [watchOn(NAMING_ID, "w-naming")],
          }),
      );

      expect(frames.map(({ kind }) => kind)).toEqual(["response", "effect"]);
      expect(frames[0].ids).toContain(LEAF_ID);
      expect(frames[1].ids).toEqual([NAMING_ID]);
    });

    it("reaches the wire ahead of an effect built after `watch.remove` recorded it", async () => {
      await addWatch(NAMING_ID, "w-naming");
      await addWatch(PLAIN_ID, "w-plain");
      const hold = holdFirstReturn(server.watchRemove.bind(server));
      server.watchRemove = hold.wrapped;

      const frames = await framesAroundHeldMutation(
        hold,
        () => send({ type: "session.watch.remove", watchIds: ["w-plain"] }),
      );

      expect(frames.map(({ kind }) => kind)).toEqual(["response", "effect"]);
      expect(frames[1].ids).toEqual([NAMING_ID]);
    });

    it("reaches the wire ahead of an effect built after a staged `watch.set` recorded it", async () => {
      const hold = holdFirstReturn(server.watchSet.bind(server));
      server.watchSet = hold.wrapped;

      const frames = await framesAroundHeldMutation(
        hold,
        () =>
          send({
            type: "session.watch.set",
            watches: [watchOn(NAMING_ID, "w-naming")],
            part: 0,
            stage: "frame-order-stage",
          }),
      );

      expect(frames.map(({ kind }) => kind)).toEqual(["response", "effect"]);
      expect(frames[0].ids).toContain(LEAF_ID);
      expect(frames[1].ids).toEqual([NAMING_ID]);
    });

    it("reaches the wire ahead of an effect built after a `watch.remove` re-evaluated the set", async () => {
      await addWatch(NAMING_ID, "w-naming");
      await addWatch(PLAIN_ID, "w-plain");
      server.markSessionForFullResync(SPACE, readerSession);
      const hold = holdFirstReturn(server.watchRemove.bind(server));
      server.watchRemove = hold.wrapped;

      const frames = await framesAroundHeldMutation(
        hold,
        () => send({ type: "session.watch.remove", watchIds: ["w-plain"] }),
      );

      expect(frames.map(({ kind }) => kind)).toEqual(["response", "effect"]);
      expect(frames[1].ids).toEqual([NAMING_ID]);
    });

    it("is answered after the call returns when it records nothing", async () => {
      await addWatch(NAMING_ID, "w-naming");
      const from = reader.messages.length;

      await send({
        type: "session.watch.remove",
        watchIds: ["w-never-added"],
      });

      expect(framesOf(reader.messages.slice(from))).toEqual([
        { kind: "response", ids: [] },
      ]);
    });
  });

  describe("an effect", () => {
    it("reaches the wire ahead of a response built after an incremental refresh recorded it", async () => {
      const frames = await framesAroundHeldEffect();

      expect(frames.map(({ kind }) => kind)).toEqual(["effect", "response"]);
      expect(frames[0].ids).toContain(LEAF_ID);
      expect(frames[1].ids).toEqual([OTHER_NAMING_ID]);
    });

    it("reaches the wire ahead of a response built after a full evaluation recorded it", async () => {
      const frames = await framesAroundHeldEffect(() =>
        server.markSessionForFullResync(SPACE, readerSession)
      );

      expect(frames.map(({ kind }) => kind)).toEqual(["effect", "response"]);
      expect(frames[0].ids).toContain(LEAF_ID);
      expect(frames[1].ids).toEqual([OTHER_NAMING_ID]);
    });
  });

  describe("a resume's response", () => {
    it("reaches the wire ahead of an effect built after its catch-up recorded it", async () => {
      await addWatch(NAMING_ID, "w-naming");
      reader.connection.close();
      // What the session has not been told of, for its catch-up to carry.
      await commit({ [NAMING_ID]: naming(2) });

      reader = await connect();
      const hold = holdFirstReturn(server.openSession.bind(server));
      server.openSession = hold.wrapped;
      const from = reader.messages.length;
      const resumed = reader.connection.receive(
        openRequest(reader, READER, {
          sessionId: readerSession,
          sessionToken: readerToken,
        }),
      );
      await hold.reached;
      await commit({ [NAMING_ID]: naming(3) });
      await server.flushSessions([SPACE]);
      hold.release();
      await resumed;

      const frames = framesOf(reader.messages.slice(from));
      expect(frames.map(({ kind }) => kind)).toEqual(["response", "effect"]);
      expect(frames[0].ids).toContain(NAMING_ID);
      expect(frames[1].ids).toEqual([NAMING_ID]);
    });
  });
});
