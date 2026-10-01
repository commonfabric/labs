import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { ACL } from "@commonfabric/memory/acl";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { noticeSpaceAccess } from "../../src/builder/space-access-notice.ts";
import type { Cell } from "../../src/cell.ts";
import { FakeInbox } from "../../src/for-testing-only.deno.ts";
import { markRendererTrustedEvent } from "../../src/cfc/ui-contract.ts";
import { Runtime } from "../../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { TestStorageManager } from "../memory-v2-test-utils.ts";
import { RecordingSessionFactory } from "../support/recording-session-factory.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const AUDIENCE = "did:key:z6Mk-runner-space-access-notice-audience";
const API_URL = "http://127.0.0.1:8000";

const alice = await Identity.fromPassphrase("space-access-notice alice");
const bob = await Identity.fromPassphrase("space-access-notice bob");
const carol = await Identity.fromPassphrase("space-access-notice carol");

/**
 * A pattern whose `notice` handler tells `event.principal` about `room`, after
 * granting them `READ` first when `event.grant` is set, and records a note;
 * and whose `probe` is a `computed()` calling `noticeSpaceAccess()`, reporting
 * what it threw.
 */
const NOTICE_PATTERN = [
  "import {",
  "  computed, grantSpaceAccess, handler, noticeSpaceAccess, pattern,",
  "  Stream, Writable,",
  "} from 'commonfabric';",
  "import type { DID } from 'commonfabric';",
  "type Notice = { principal: DID; grant?: boolean };",
  "type Room = { title: string };",
  "const notice = handler<",
  "  Notice,",
  "  { notes: Writable<string[]>; room: Writable<Room> }",
  ">((event, { notes, room }) => {",
  "  if (event.grant) grantSpaceAccess(room, event.principal, 'READ');",
  "  noticeSpaceAccess(event.principal, room);",
  "  notes.push(`noticed ${event.principal}`);",
  "});",
  "export default pattern<",
  "  { notes: Writable<string[]>; room: Writable<Room> },",
  "  { notes: string[]; probe: string; notice: Stream<Notice> }",
  ">(({ notes, room }) => ({",
  "  notes,",
  "  probe: computed(() => {",
  "    try {",
  "      noticeSpaceAccess('did:key:z6Mk-probe', room);",
  "      return 'returned';",
  "    } catch (error) {",
  "      return `threw ${(error as Error).message}`;",
  "    }",
  "  }),",
  "  notice: notice({ notes, room }),",
  "}));",
].join("\n");

/** The result cell of a running `NOTICE_PATTERN`. */
type NoticePatternResult = Cell<{
  notes: string[];
  probe: string;
  notice: unknown;
}>;

/** `payload` as an event the renderer marked as a trusted gesture. */
function gesture(payload: Record<string, unknown>): Record<string, unknown> {
  const event = {
    ...payload,
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "MembersSurface",
        eventIntegrity: ["MembersSurface"],
        uiContractDataset: { uiAction: "ChangeAccess" },
      },
    },
  };
  markRendererTrustedEvent(event);
  return event;
}

describe("space-access-notice", () => {
  let server: Server;
  let inbox: FakeInbox;
  let cleanups: (() => Promise<void>)[];
  let serverCount = 0;

  beforeEach(() => {
    cleanups = [];
    server = new Server({
      store: new URL(`memory://space-access-notice-${++serverCount}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: AUDIENCE },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
    inbox = new FakeInbox({ apiUrl: API_URL });
    inbox.enable(bob.did());
    inbox.enable(carol.did());
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
    inbox.close();
  });

  /**
   * Returns a client runtime acting as `user`, whose inbox requests go to
   * `inbox`, the factory recording what it commits, and the errors its
   * scheduler reports.
   */
  function clientRuntime(user: Identity): {
    runtime: Runtime;
    factory: RecordingSessionFactory;
    errors: string[];
  } {
    const factory = new RecordingSessionFactory(server);
    const storageManager = TestStorageManager.create(
      { as: user, memoryHost: new URL("memory://") },
      factory,
    );
    const runtime = new Runtime({
      apiUrl: new URL(API_URL),
      storageManager,
      fetch: (input, init) => inbox.fetch(input, init),
    });
    const errors: string[] = [];
    runtime.scheduler.onError((error: Error) => {
      errors.push(error.message);
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await storageManager.close();
    });
    return { runtime, factory, errors };
  }

  /** Returns a serving runtime. */
  function servingRuntime(): Runtime {
    const storageManager = TestStorageManager.create(
      {
        as: alice,
        memoryHost: new URL("memory://"),
        servingHomeSpace: alice.did() as MemorySpace,
      },
      new RecordingSessionFactory(server),
    );
    const runtime = new Runtime({
      apiUrl: new URL(API_URL),
      storageManager,
      servingPosture: true,
      fetch: (input, init) => inbox.fetch(input, init),
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await storageManager.close();
    });
    return runtime;
  }

  /** Creates, through `runtime`, a space whose genesis list is `acl`. */
  async function createSpace(runtime: Runtime, acl: ACL): Promise<MemorySpace> {
    const space = await runtime.storageManager.createSpace!(acl);
    await runtime.getCellFromLink({
      space,
      id: `of:${space}` as URI,
      path: [],
    }).sync();
    await runtime.storageManager.synced();
    return space;
  }

  /**
   * Replaces the access list of `space` with `acl` on the memory server,
   * writing as `writer` through a session of its own.
   */
  async function writeAclAs(
    writer: Identity,
    space: MemorySpace,
    acl: ACL,
  ): Promise<void> {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(server),
    });
    try {
      const session = await client.mount(
        space,
        {},
        (_space, _session, context) => ({
          invocation: {
            aud: context.audience,
            challenge: context.challenge.value,
          },
          authorization: { principal: writer.did() },
        }),
      );
      await session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}` as URI,
          value: { value: acl },
        }],
      });
    } finally {
      await client.close();
    }
  }

  /**
   * Writes, through `runtime`, a room document in `space` whose cause is
   * `name`, and returns it.
   */
  async function createRoom(
    runtime: Runtime,
    space: MemorySpace,
    name = "space-access-notice room",
  ): Promise<Cell<{ title: string }>> {
    const tx = runtime.edit();
    const room = runtime.getCell<{ title: string }>(
      space,
      name,
      undefined,
      tx,
    );
    room.set({ title: "Donut committee" });
    expect((await tx.commit()).error).toBeUndefined();
    return room;
  }

  /**
   * Compiles `NOTICE_PATTERN` and runs it in `space`, through `runtime`, on a
   * room document of its own, which it returns with the pattern's result.
   */
  async function runNoticePattern(
    runtime: Runtime,
    space: MemorySpace,
  ): Promise<{ result: NoticePatternResult; room: Cell<{ title: string }> }> {
    const room = await createRoom(runtime, space);
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: NOTICE_PATTERN }],
    }, { space });
    const argument = runtime.getCell<{ notes: string[]; room: unknown }>(
      space,
      "space-access-notice argument",
      undefined,
    );
    const result = runtime.getCell(
      space,
      "space-access-notice result",
      compiled.resultSchema,
    ) as unknown as NoticePatternResult;
    {
      const tx = runtime.edit();
      argument.withTx(tx).set({ notes: [], room });
      expect((await tx.commit()).error).toBeUndefined();
    }
    {
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancel = result.sink(() => {});
    cleanups.push(() => Promise.resolve(cancel()));
    await runtime.idle();
    return { result, room };
  }

  /** Sends `event` to `result`'s `notice` stream, and waits for it to land. */
  async function send(
    runtime: Runtime,
    result: NoticePatternResult,
    event: Record<string, unknown>,
  ): Promise<void> {
    result.key("notice").send(event);
    await runtime.settled();
  }

  /** The payload a notice about `room` carries. */
  function noticeOf(room: Cell<unknown>): Record<string, unknown> {
    const link = room.getAsNormalizedFullLink();
    return {
      type: "space-access-notice",
      v: 1,
      space: link.space,
      entry: link.id,
    };
  }

  /** Calls `fn` in a handler frame over `tx` whose event key is `eventKey`. */
  function inHandler(
    runtime: Runtime,
    tx: IExtendedStorageTransaction,
    fn: () => void,
    eventKey = "evk:space-access-notice",
  ): void {
    const frame = pushFrame({
      runtime,
      tx,
      inHandler: true,
      frameKind: "handler",
      eventKey,
    });
    try {
      fn();
    } finally {
      popFrame(frame);
    }
  }

  describe("in a compiled pattern", () => {
    it("sends the principal's inbox a notice from the actor naming the space and the room, and nothing else", async () => {
      const { runtime } = clientRuntime(alice);
      const space = await createSpace(runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
      const { result, room } = await runNoticePattern(runtime, space);

      await send(runtime, result, { principal: bob.did() });

      const messages = inbox.messagesFor(bob.did());
      expect(messages.length).toBe(1);
      expect(messages[0].receipt.senderDid).toBe(alice.did());
      expect(messages[0].payload).toStrictEqual(noticeOf(room));
      expect(result.key("notes").get()).toEqual([`noticed ${bob.did()}`]);
    });

    it("sends a notice to a principal the same handler grants access to", async () => {
      const { runtime, errors } = clientRuntime(alice);
      const space = await createSpace(runtime, { [alice.did()]: "OWNER" });
      const { result, room } = await runNoticePattern(runtime, space);

      await send(
        runtime,
        result,
        gesture({ principal: bob.did(), grant: true }),
      );

      expect(errors).toEqual([]);
      expect(inbox.messagesFor(bob.did()).map((message) => message.payload))
        .toEqual([noticeOf(room)]);
    });

    it("sends one message for two deliveries of the same event", async () => {
      // The second delivery's commit is refused, since the event's receipt
      // exists, and a refused commit sends nothing. Two runs of one event that
      // both commit are the case below, under `noticeSpaceAccess()`.

      const { runtime } = clientRuntime(alice);
      const space = await createSpace(runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
      const { result } = await runNoticePattern(runtime, space);
      const stream = result.key("notice").resolveAsCell()
        .getAsNormalizedFullLink();
      const deliver = async () => {
        runtime.scheduler.queueEvent(
          stream,
          { principal: bob.did() },
          true,
          undefined,
          false,
          { eventId: "evt:space-access-notice:redelivered" },
        );
        await runtime.settled();
      };

      await deliver();
      await deliver();

      expect(result.key("notes").get()).toEqual([`noticed ${bob.did()}`]);
      expect(inbox.sends).toBe(1);
      expect(inbox.messagesFor(bob.did()).length).toBe(1);
    });

    it("sends nothing, and commits the handler's writes, for a principal without an entry of their own", async () => {
      for (
        const acl of [
          { [alice.did()]: "OWNER" },
          { [alice.did()]: "OWNER", "*": "WRITE" },
        ] satisfies ACL[]
      ) {
        const { runtime, errors } = clientRuntime(alice);
        const space = await createSpace(runtime, acl);
        const { result } = await runNoticePattern(runtime, space);

        await send(runtime, result, { principal: bob.did() });

        expect(errors).toEqual([]);
        expect(result.key("notes").get()).toEqual([`noticed ${bob.did()}`]);
      }
      expect(inbox.sends).toBe(0);
    });

    it("sends nothing, and commits the handler's writes, for an actor without `OWNER`", async () => {
      const owner = clientRuntime(alice);
      const space = await createSpace(owner.runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
        [carol.did()]: "READ",
      });
      const { runtime, errors } = clientRuntime(bob);
      await runtime.getCellFromLink({
        space,
        id: `of:${space}` as URI,
        path: [],
      }).sync();
      const { result } = await runNoticePattern(runtime, space);

      await send(runtime, result, { principal: carol.did() });

      expect(errors).toEqual([]);
      expect(result.key("notes").get()).toEqual([`noticed ${carol.did()}`]);
      expect(inbox.sends).toBe(0);
    });

    it("sends nothing when the memory server refuses the handler's commit", async () => {
      const { runtime, factory } = clientRuntime(alice);
      const space = await createSpace(runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
      const { result } = await runNoticePattern(runtime, space);
      const notesId = result.key("notes").resolveAsCell()
        .getAsNormalizedFullLink().id;
      factory.beforeNextCommitTo(notesId, () =>
        Promise.reject(
          Object.assign(new Error("refused for the test"), {
            name: "AuthorizationError",
          }),
        ));

      await send(runtime, result, { principal: bob.did() });

      expect(result.key("notes").get()).toEqual([]);
      expect(inbox.sends).toBe(0);
    });

    it("sends nothing when the principal's entry is gone from the memory server's list by the time the handler commits", async () => {
      const { runtime, factory } = clientRuntime(alice);
      const space = await createSpace(runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
      const { result } = await runNoticePattern(runtime, space);
      const notesId = result.key("notes").resolveAsCell()
        .getAsNormalizedFullLink().id;
      factory.beforeNextCommitTo(
        notesId,
        () => writeAclAs(alice, space, { [alice.did()]: "OWNER" }),
      );

      await send(runtime, result, { principal: bob.did() });

      // This runtime's list still held bob's entry when the handler ran; the
      // check just before sending, against the list caught up with the memory
      // server, is what refused.
      expect(result.key("notes").get()).toEqual([`noticed ${bob.did()}`]);
      expect(inbox.sends).toBe(0);
    });

    it("throws in a `computed()`", async () => {
      const { runtime } = clientRuntime(alice);
      const space = await createSpace(runtime, { [alice.did()]: "OWNER" });
      const { result } = await runNoticePattern(runtime, space);

      expect(result.key("probe").get()).toContain(
        "threw `noticeSpaceAccess()` is available only in a handler",
      );
    });
  });

  describe("noticeSpaceAccess()", () => {
    /**
     * Returns a client runtime acting as alice, a space she owns in which bob
     * has `WRITE`, and a room document there.
     */
    async function owned(): Promise<{
      runtime: Runtime;
      space: MemorySpace;
      room: Cell<{ title: string }>;
    }> {
      const { runtime } = clientRuntime(alice);
      const space = await createSpace(runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
      return { runtime, space, room: await createRoom(runtime, space) };
    }

    /**
     * Calls `noticeSpaceAccess(bob, room)` in a handler frame whose event key
     * is `eventKey`, and commits the frame's transaction.
     */
    async function noticeAndCommit(
      runtime: Runtime,
      room: unknown,
      eventKey: string,
    ): Promise<void> {
      const tx = runtime.edit();
      inHandler(
        runtime,
        tx,
        () => noticeSpaceAccess(bob.did(), room),
        eventKey,
      );
      expect((await tx.commit()).error).toBeUndefined();
    }

    it("sends one message for two runs of one event, and one for each of two events", async () => {
      const { runtime, room } = await owned();

      await noticeAndCommit(runtime, room, "evk:space-access-notice:one");
      await noticeAndCommit(runtime, room, "evk:space-access-notice:one");
      expect(inbox.sends).toBe(2);
      expect(inbox.messagesFor(bob.did()).length).toBe(1);

      await noticeAndCommit(runtime, room, "evk:space-access-notice:two");
      expect(inbox.messagesFor(bob.did()).length).toBe(2);
    });

    it("sends one message for two runs of one event whose entries differ, and the inbox refuses the second", async () => {
      const { runtime, space, room } = await owned();
      const other = await createRoom(
        runtime,
        space,
        "space-access-notice other",
      );

      await noticeAndCommit(runtime, room, "evk:space-access-notice:moved");
      await noticeAndCommit(runtime, other, "evk:space-access-notice:moved");

      expect(inbox.sends).toBe(2);
      expect(inbox.refusals).toEqual(["operation-conflict"]);
      expect(inbox.messagesFor(bob.did()).map((message) => message.payload))
        .toEqual([noticeOf(room)]);
    });

    it("sends a notice naming the room for an entry passed as its cell's reactive proxy", async () => {
      const { runtime, room } = await owned();

      await noticeAndCommit(
        runtime,
        room.getAsReactiveProxy(),
        "evk:space-access-notice:proxy",
      );

      expect(inbox.messagesFor(bob.did()).map((message) => message.payload))
        .toEqual([noticeOf(room)]);
    });

    it("sends nothing when the handler's transaction is aborted", async () => {
      const { runtime, room } = await owned();
      const tx = runtime.edit();

      inHandler(runtime, tx, () => noticeSpaceAccess(bob.did(), room));
      tx.abort("aborted for the test");
      await runtime.settled();

      expect(inbox.sends).toBe(0);
    });

    for (
      const [description, principal] of [
        ["`*`", "*"],
        ["a string that is not a DID", "bob"],
        ["a DID that is not a `did:key`", "did:web:example.com"],
      ] as const
    ) {
      it(`throws for ${description} as the principal`, async () => {
        const { runtime, room } = await owned();
        expect(() =>
          inHandler(
            runtime,
            runtime.edit(),
            () => noticeSpaceAccess(principal, room),
          )
        ).toThrow("takes a principal's `did:key` DID");
      });
    }

    it("throws for an entry that is not a cell", async () => {
      const { runtime } = await owned();
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => noticeSpaceAccess(bob.did(), "of:not-a-cell"),
        )
      ).toThrow("takes a cell as its target");
    });

    it("throws for an entry below the root of its document", async () => {
      const { runtime, room } = await owned();
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => noticeSpaceAccess(bob.did(), room.key("title")),
        )
      ).toThrow("a cell at the root of a document");
    });

    it("stages a notice to a principal without an entry, though this runtime holds the list, and sends nothing once the handler commits", async () => {
      const { runtime, room } = await owned();
      const tx = runtime.edit();

      inHandler(runtime, tx, () => noticeSpaceAccess(carol.did(), room));
      expect(tx.hasPendingPostCommitEffects()).toBe(true);
      expect((await tx.commit()).error).toBeUndefined();

      expect(inbox.sends).toBe(0);
    });

    it("throws on a serving runtime", () => {
      const runtime = servingRuntime();
      const room = runtime.getCell(alice.did() as MemorySpace, "room");
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => noticeSpaceAccess(bob.did(), room),
        )
      ).toThrow("not available on a serving runtime");
    });

    it("throws in a `lift()` frame", async () => {
      const { runtime, room } = await owned();
      const frame = pushFrame({
        runtime,
        tx: runtime.edit(),
        frameKind: "lift",
      });
      try {
        expect(() => noticeSpaceAccess(bob.did(), room)).toThrow(
          "available only in a handler",
        );
      } finally {
        popFrame(frame);
      }
    });

    it("throws in a pattern body, even one built inside a handler", async () => {
      const { runtime, room } = await owned();
      const { pattern } = createTrustedBuilder(runtime).commonfabric;
      inHandler(runtime, runtime.edit(), () => {
        expect(() =>
          pattern(() => {
            noticeSpaceAccess(bob.did(), room);
            return {};
          })
        ).toThrow("available only in a handler");
      });
    });
  });
});
