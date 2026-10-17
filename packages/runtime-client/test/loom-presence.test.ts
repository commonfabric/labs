import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { DID } from "@commonfabric/identity";

import {
  joinLoomPresenceRoom,
  loomPresenceAnchorCause,
} from "@/loom-presence.ts";
import { type CellRef, RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";

const SPACE = "did:key:z6Mk-loom-space" as DID;

const anchorRef: CellRef = {
  space: SPACE,
  id: "of:loom-presence-anchor",
  path: [] as unknown as CellRef["path"],
  scope: "space",
};

type Recorded = {
  type: RequestType;
  space?: string;
  cause?: unknown;
  cell?: CellRef;
};

/** A stand-in connection answering a cell derivation and a join. */
const buildClient = () => {
  const requests: Recorded[] = [];
  const conn = {
    signal: new AbortController().signal,
    on: () => {},
    request: (request: Recorded) => {
      requests.push(request);
      switch (request.type) {
        case RequestType.GetCell:
          return Promise.resolve({ cell: anchorRef });
        case RequestType.PresenceJoin:
          return Promise.resolve({
            participantId: "participant:self",
            room: "room-0123456789abcdefghijklmnop",
            participants: [],
          });
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
  return { client, requests };
};

describe("loom-presence", () => {
  describe("loomPresenceAnchorCause()", () => {
    it("names the space, and nothing else", () => {
      expect(loomPresenceAnchorCause(SPACE)).toEqual({ loomPresence: SPACE });
    });
  });

  describe("joinLoomPresenceRoom()", () => {
    it("joins the room derived from the anchor the space derives from the cause", async () => {
      const { client, requests } = buildClient();
      const handle = await joinLoomPresenceRoom(client, SPACE);
      expect(requests.map(({ type }) => type)).toEqual([
        RequestType.GetCell,
        RequestType.PresenceJoin,
      ]);
      expect(requests[0].space).toBe(SPACE);
      expect(requests[0].cause).toEqual(loomPresenceAnchorCause(SPACE));
      expect(requests[1].cell).toEqual(anchorRef);
      expect(handle.participantId).toBe("participant:self");
      await handle.leave();
    });

    it("shares one membership between two joins of the same space", async () => {
      const { client, requests } = buildClient();
      const first = await joinLoomPresenceRoom(client, SPACE);
      const second = await joinLoomPresenceRoom(client, SPACE);
      expect(second.room).toBe(first.room);
      expect(
        requests.filter(({ type }) => type === RequestType.PresenceJoin),
      ).toHaveLength(1);
      await first.leave();
      await second.leave();
    });
  });
});
