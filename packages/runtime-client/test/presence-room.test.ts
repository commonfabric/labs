import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { PresenceEvent } from "@commonfabric/memory/v2/client";
import type { PresenceRecord } from "@commonfabric/memory/v2";

import type { CellHandle } from "@/cell-handle.ts";
import { type CellRef, NotificationType, RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";

const ROOM = "room-0123456789abcdefghijklmnop";

const cellRef: CellRef = {
  space: "did:key:z6Mk-presence-client" as CellRef["space"],
  id: "of:presence-client",
  path: ["content"] as unknown as CellRef["path"],
  scope: "space",
};

const peer: PresenceRecord = {
  participantId: "participant:peer",
  principal: "did:key:z6Mk-peer",
  revision: 1,
  name: "Peer",
  facets: { caret: { focused: true } },
};

type Recorded = {
  type: RequestType;
  subscriptionId?: string;
  name?: string;
  facets?: Record<string, unknown>;
  room?: string;
};

/**
 * A stand-in connection answering the presence requests and nothing else.
 * With `holdJoins`, each join's reply waits until `answerJoin()` releases it,
 * so a test chooses the order replies arrive in.
 */
const buildClient = (
  options: { joinFails?: boolean; holdJoins?: boolean } = {},
) => {
  const handlers = new Map<string, (data: unknown) => void>();
  const requests: Recorded[] = [];
  const heldJoins: (() => void)[] = [];
  let joins = 0;
  const conn = {
    signal: new AbortController().signal,
    on: (event: string, handler: (data: unknown) => void) => {
      handlers.set(event, handler);
    },
    request: (request: Recorded) => {
      requests.push(request);
      switch (request.type) {
        case RequestType.PresenceJoin: {
          joins++;
          if (options.joinFails && joins === 1) {
            return Promise.reject(new Error("presence unavailable"));
          }
          const reply = {
            participantId: `participant:self:${joins}`,
            room: request.room ?? ROOM,
            participants: [peer],
          };
          if (!options.holdJoins) return Promise.resolve(reply);
          const { promise, resolve } = Promise.withResolvers<typeof reply>();
          heldJoins.push(() => resolve(reply));
          return promise;
        }
        case RequestType.PresencePublish:
        case RequestType.PresenceLeave:
          return Promise.resolve({ value: true });
        default:
          throw new Error(`unexpected request: ${request.type}`);
      }
    },
  } as unknown as never;
  const client = new (RuntimeClient as unknown as {
    new (conn: never, options: unknown): RuntimeClient;
  })(conn, {});
  const cell = { ref: () => cellRef } as CellHandle<unknown>;
  const notify = (event: unknown) => {
    handlers.get("presenceupdate")!({
      type: NotificationType.PresenceUpdate,
      subscriptionId: requests[0].subscriptionId,
      event,
    });
  };

  /** Releases the reply to the `index`th join the worker was asked for. */
  const answerJoin = (index: number) => heldJoins[index]();
  return { client, cell, requests, notify, answerJoin };
};

/** A cell the stand-in worker resolves to the same field as `cellRef`. */
const aliasCell = {
  ref: () => ({ ...cellRef, id: "of:presence-alias" }),
} as unknown as CellHandle<unknown>;

/** Lets a publication scheduled on the microtask queue go out. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

const publishes = (requests: Recorded[]) =>
  requests.filter((request) => request.type === RequestType.PresencePublish);

describe("RuntimeClient presence rooms", () => {
  describe("joinPresenceRoom()", () => {
    it("joins once for two handles on one room and shares the participants", async () => {
      const { client, cell, requests } = buildClient();
      const first = await client.joinPresenceRoom(cell);
      const second = await client.joinPresenceRoom(cell);
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.PresenceJoin,
      ]);
      expect(second.participantId).toBe(first.participantId);
      expect(first.room).toBe(ROOM);
      expect(second.participants).toEqual([peer]);
    });

    it("passes an explicit room through and keeps it apart from the derived one", async () => {
      const { client, cell, requests } = buildClient();
      await client.joinPresenceRoom(cell);
      const explicit = await client.joinPresenceRoom(cell, {
        room: "room-zyxwvutsrqponmlkjihgfedcba",
      });
      expect(requests.map(({ room }) => room)).toEqual([
        undefined,
        "room-zyxwvutsrqponmlkjihgfedcba",
      ]);
      expect(explicit.room).toBe("room-zyxwvutsrqponmlkjihgfedcba");
    });

    it("rejects when the worker refuses, leaves what it may have joined, and joins afresh next time", async () => {
      const { client, cell, requests } = buildClient({ joinFails: true });
      await expect(client.joinPresenceRoom(cell)).rejects.toThrow(
        "presence unavailable",
      );
      const handle = await client.joinPresenceRoom(cell);
      expect(handle.participantId).toBe("participant:self:2");
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.PresenceJoin,
        RequestType.PresenceLeave,
        RequestType.PresenceJoin,
      ]);
      expect(requests[1].subscriptionId).toBe(requests[0].subscriptionId);
    });

    it("shares one room between two cells the worker resolves to the same field", async () => {
      const { client, requests } = buildClient();
      const alias = {
        ref: () => ({ ...cellRef, id: "of:presence-alias" }),
      } as unknown as CellHandle<unknown>;
      const first = await client.joinPresenceRoom(
        { ref: () => cellRef } as CellHandle<unknown>,
      );
      const second = await client.joinPresenceRoom(alias);
      // The alias asked the worker, was told the room it already held, and
      // gave its redundant membership up.
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.PresenceJoin,
        RequestType.PresenceJoin,
        RequestType.PresenceLeave,
      ]);
      expect(requests[2].subscriptionId).toBe(requests[1].subscriptionId);
      expect(second.participantId).toBe(first.participantId);
      first.setName("Ada");
      first.setFacet("caret", {});
      second.setFacet("pointer", {});
      await settle();
      expect(publishes(requests)).toEqual([{
        type: RequestType.PresencePublish,
        subscriptionId: requests[0].subscriptionId,
        name: "Ada",
        facets: { caret: {}, pointer: {} },
      }]);
      await first.leave();
      expect(requests.at(-1)?.type).toBe(RequestType.PresencePublish);
      await second.leave();
      expect(requests.at(-1)).toEqual({
        type: RequestType.PresenceLeave,
        subscriptionId: requests[0].subscriptionId,
      });
    });

    it("joins afresh after a failure ended the room", async () => {
      const { client, cell, requests, notify } = buildClient();
      const ended = await client.joinPresenceRoom(cell);
      notify({
        kind: "failure",
        error: { name: "SessionRevokedError", message: "taken over" },
      });
      const fresh = await client.joinPresenceRoom(cell);
      expect(fresh).not.toBe(ended);
      expect(fresh.participantId).toBe("participant:self:2");
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.PresenceJoin,
        RequestType.PresenceJoin,
      ]);
      fresh.setName("Ada");
      fresh.setFacet("caret", {});
      await settle();
      expect(publishes(requests).at(-1)?.subscriptionId).toBe(
        requests[1].subscriptionId,
      );
    });

    it("shares one join in flight between two joins through the same cell", async () => {
      const { client, cell, requests, answerJoin } = buildClient({
        holdJoins: true,
      });
      const joining = [
        client.joinPresenceRoom(cell),
        client.joinPresenceRoom(cell),
      ];
      answerJoin(0);
      const [first, second] = await Promise.all(joining);
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.PresenceJoin,
      ]);
      expect(second.participantId).toBe(first.participantId);
    });

    it("hands a join of a room already held its handle when the room's other handle leaves in the same tick", async () => {
      const { client, cell, requests } = buildClient();
      const first = await client.joinPresenceRoom(cell);
      const joining = client.joinPresenceRoom(cell);
      const leaving = first.leave();
      const second = await joining;
      await leaving;
      expect(second.participantId).toBe(first.participantId);
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.PresenceJoin,
      ]);
    });

    it("hands a join its handle when another caller joins and leaves the room before the first join resumes", async () => {
      // The second caller acts after each number of microtasks in turn, so
      // every point between the reply and the first caller resuming is hit.
      for (let ticks = 0; ticks < 8; ticks++) {
        const { client, cell, requests, answerJoin } = buildClient({
          holdJoins: true,
        });
        const joining = client.joinPresenceRoom(cell);
        answerJoin(0);
        for (let i = 0; i < ticks; i++) await Promise.resolve();
        const passing = await client.joinPresenceRoom(cell);
        await passing.leave();
        const first = await joining;
        expect(first.participantId).toBe("participant:self:1");
        expect(requests.map(({ type }) => type)).toEqual([
          RequestType.PresenceJoin,
        ]);
      }
    });

    it("shares an alias's join in flight with a later join through the alias while it waits on a named join", async () => {
      const { client, cell, requests, answerJoin } = buildClient({
        holdJoins: true,
      });
      const named = client.joinPresenceRoom(cell, { room: ROOM });
      const derived = client.joinPresenceRoom(aliasCell);
      answerJoin(1);
      await settle();
      const again = client.joinPresenceRoom(aliasCell);
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.PresenceJoin,
        RequestType.PresenceJoin,
        RequestType.PresenceLeave,
      ]);
      answerJoin(0);
      const handles = await Promise.all([named, derived, again]);
      expect(handles.map(({ participantId }) => participantId)).toEqual([
        "participant:self:1",
        "participant:self:1",
        "participant:self:1",
      ]);
    });

    it("shares a room a named join is still joining with a cell the worker resolves to it", async () => {
      const { client, cell, requests, answerJoin } = buildClient({
        holdJoins: true,
      });
      const named = client.joinPresenceRoom(cell, { room: ROOM });
      const derived = client.joinPresenceRoom(aliasCell);
      answerJoin(1);
      await settle();
      // The derived join was told the room the named one is joining, and
      // gave its own membership up without waiting for that join.
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.PresenceJoin,
        RequestType.PresenceJoin,
        RequestType.PresenceLeave,
      ]);
      expect(requests[2].subscriptionId).toBe(requests[1].subscriptionId);
      answerJoin(0);
      const [first, second] = await Promise.all([named, derived]);
      expect(first.participantId).toBe("participant:self:1");
      expect(second.participantId).toBe(first.participantId);
    });

    it("holds the room through an alias's own membership when the room its reply names was left meanwhile", async () => {
      const { client, cell, requests, answerJoin } = buildClient({
        holdJoins: true,
      });
      const joining = client.joinPresenceRoom(cell);
      answerJoin(0);
      const first = await joining;
      const aliased = client.joinPresenceRoom(aliasCell);
      await first.leave();
      answerJoin(1);
      const second = await aliased;
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.PresenceJoin,
        RequestType.PresenceJoin,
        RequestType.PresenceLeave,
      ]);
      expect(requests[2].subscriptionId).toBe(requests[0].subscriptionId);
      expect(second.participantId).toBe("participant:self:2");
      second.setName("Ada");
      second.setFacet("caret", {});
      await settle();
      expect(publishes(requests).at(-1)?.subscriptionId).toBe(
        requests[1].subscriptionId,
      );
    });

    it("joins afresh through an alias cell after the shared room's last handle left", async () => {
      const { client, cell, requests } = buildClient();
      const first = await client.joinPresenceRoom(cell);
      const second = await client.joinPresenceRoom(aliasCell);
      await first.leave();
      await second.leave();
      const fresh = await client.joinPresenceRoom(aliasCell);
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.PresenceJoin,
        RequestType.PresenceJoin,
        RequestType.PresenceLeave,
        RequestType.PresenceLeave,
        RequestType.PresenceJoin,
      ]);
      expect(requests[3].subscriptionId).toBe(requests[0].subscriptionId);
      expect(fresh.participantId).toBe("participant:self:3");
    });

    it("rejects a join whose membership failed ahead of the reply, leaves it, and joins afresh next time", async () => {
      const { client, cell, requests, notify, answerJoin } = buildClient({
        holdJoins: true,
      });
      const joining = client.joinPresenceRoom(cell);
      notify({
        kind: "failure",
        error: { name: "SessionRevokedError", message: "taken over" },
      });
      answerJoin(0);
      await expect(joining).rejects.toThrow(
        "presence room ended while it was being joined",
      );
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.PresenceJoin,
        RequestType.PresenceLeave,
      ]);
      expect(requests[1].subscriptionId).toBe(requests[0].subscriptionId);
      const rejoining = client.joinPresenceRoom(cell);
      answerJoin(1);
      expect((await rejoining).participantId).toBe("participant:self:2");
    });
  });

  describe("publishing", () => {
    it("sends the merged record once per frame, and nothing without a name", async () => {
      const { client, cell, requests } = buildClient();
      const editor = await client.joinPresenceRoom(cell);
      const overlay = await client.joinPresenceRoom(cell);
      editor.setFacet("caret", { focused: true });
      await settle();
      expect(publishes(requests)).toEqual([]);

      editor.setName("Ada");
      overlay.setFacet("pointer", { x: 1, y: 2 });
      editor.setFacet("caret", { focused: false });
      await settle();
      expect(publishes(requests)).toEqual([{
        type: RequestType.PresencePublish,
        subscriptionId: requests[0].subscriptionId,
        name: "Ada",
        facets: { caret: { focused: false }, pointer: { x: 1, y: 2 } },
      }]);

      overlay.clearFacet("pointer");
      await settle();
      expect(publishes(requests).at(-1)?.facets).toEqual({
        caret: { focused: false },
      });
    });

    it("drops a leaving handle's facets and leaves the room after the last handle", async () => {
      const { client, cell, requests } = buildClient();
      const editor = await client.joinPresenceRoom(cell);
      const overlay = await client.joinPresenceRoom(cell);
      editor.setName("Ada");
      editor.setFacet("caret", {});
      overlay.setFacet("pointer", {});
      await settle();
      await overlay.leave();
      await overlay.leave();
      await settle();
      expect(publishes(requests).map(({ facets }) => facets)).toEqual([
        { caret: {}, pointer: {} },
        { caret: {} },
      ]);
      expect(requests.some(({ type }) => type === RequestType.PresenceLeave))
        .toBe(false);
      await editor.leave();
      expect(requests.at(-1)).toEqual({
        type: RequestType.PresenceLeave,
        subscriptionId: requests[0].subscriptionId,
      });
    });
  });

  describe("focus", () => {
    it("lets the focused handle's facet stand over an unfocused sibling's of the same name", async () => {
      const { client, cell, requests } = buildClient();
      const editorA = await client.joinPresenceRoom(cell);
      const editorB = await client.joinPresenceRoom(cell);
      editorA.setName("Ada");
      editorA.setFocused(true);
      editorA.setFacet("caret", { focused: true, at: "a" });
      editorB.setFacet("caret", { focused: false, at: "b" });
      await settle();
      expect(publishes(requests).at(-1)?.facets).toEqual({
        caret: { focused: true, at: "a" },
      });

      // Focus moves: the other editor's caret is the record's now, even
      // though it was set earlier.
      editorA.setFocused(false);
      editorA.setFacet("caret", { focused: false, at: "a" });
      editorB.setFocused(true);
      await settle();
      expect(publishes(requests).at(-1)?.facets).toEqual({
        caret: { focused: false, at: "b" },
      });

      // Alike in focus, the later write wins.
      editorB.setFocused(false);
      editorA.setFacet("caret", { focused: false, at: "a2" });
      await settle();
      expect(publishes(requests).at(-1)?.facets).toEqual({
        caret: { focused: false, at: "a2" },
      });
    });
  });

  describe("events", () => {
    it("applies newer records, ignores older ones, and delivers each applied event", async () => {
      const { client, cell, notify } = buildClient();
      const handle = await client.joinPresenceRoom(cell);
      const events: PresenceEvent[] = [];
      handle.subscribe((event) => events.push(event));
      const newer = { ...peer, revision: 2, name: "Peer, moved" };
      notify({ kind: "upsert", participant: newer });
      notify({ kind: "upsert", participant: peer });
      expect(handle.participants).toEqual([newer]);
      notify({ kind: "remove", participantId: "participant:unknown" });
      notify({ kind: "remove", participantId: peer.participantId });
      expect(handle.participants).toEqual([]);
      notify({
        kind: "snapshot",
        participantId: "participant:self:again",
        participants: [peer],
      });
      expect(handle.participantId).toBe("participant:self:again");
      expect(events.map((event) => event.kind)).toEqual([
        "upsert",
        "remove",
        "snapshot",
      ]);
    });

    it("applies an update that arrives ahead of the join's reply over the reply's participants", async () => {
      const { client, cell, notify, answerJoin } = buildClient({
        holdJoins: true,
      });
      const joining = client.joinPresenceRoom(cell);
      const newer = { ...peer, revision: 2, name: "Peer, moved" };
      notify({ kind: "upsert", participant: newer });
      answerJoin(0);
      expect((await joining).participants).toEqual([newer]);
    });

    it("ends the room on a failure and still tells the worker on leave", async () => {
      const { client, cell, requests, notify } = buildClient();
      const handle = await client.joinPresenceRoom(cell);
      const events: PresenceEvent[] = [];
      handle.subscribe((event) => events.push(event));
      notify({
        kind: "failure",
        error: { name: "SessionRevokedError", message: "taken over" },
      });
      expect(events).toHaveLength(1);
      const failure = events[0];
      expect(failure.kind).toBe("failure");
      if (failure.kind === "failure") {
        expect(failure.error.name).toBe("SessionRevokedError");
      }
      handle.setName("Ada");
      handle.setFacet("caret", {});
      await settle();
      expect(publishes(requests)).toEqual([]);
      await handle.leave();
      expect(requests.at(-1)?.type).toBe(RequestType.PresenceLeave);
    });
  });
});
