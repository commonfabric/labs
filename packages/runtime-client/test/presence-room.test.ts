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

/** A stand-in connection answering the presence requests and nothing else. */
const buildClient = (options: { joinFails?: boolean } = {}) => {
  const handlers = new Map<string, (data: unknown) => void>();
  const requests: Recorded[] = [];
  let joins = 0;
  const conn = {
    signal: new AbortController().signal,
    on: (event: string, handler: (data: unknown) => void) => {
      handlers.set(event, handler);
    },
    request: (request: Recorded) => {
      requests.push(request);
      switch (request.type) {
        case RequestType.PresenceJoin:
          joins++;
          if (options.joinFails && joins === 1) {
            return Promise.reject(new Error("presence unavailable"));
          }
          return Promise.resolve({
            participantId: `participant:self:${joins}`,
            room: request.room ?? ROOM,
            participants: [peer],
          });
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
  return { client, cell, requests, notify };
};

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

    it("rejects when the worker refuses and joins afresh next time", async () => {
      const { client, cell, requests } = buildClient({ joinFails: true });
      await expect(client.joinPresenceRoom(cell)).rejects.toThrow(
        "presence unavailable",
      );
      const handle = await client.joinPresenceRoom(cell);
      expect(handle.participantId).toBe("participant:self:2");
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.PresenceJoin,
        RequestType.PresenceJoin,
      ]);
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
