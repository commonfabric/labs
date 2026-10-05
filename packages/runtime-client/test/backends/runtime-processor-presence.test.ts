import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  DEFAULT_BRANCH,
  resolveScopeKey,
  toValuePath,
} from "@commonfabric/memory/v2";
import type {
  PresenceEvent,
  PresenceMembership,
} from "@commonfabric/memory/v2/client";
import { presenceRoomForField } from "@commonfabric/memory/v2/presence";
import { defer } from "@commonfabric/utils/defer";

import type { WorkerClient } from "@/backends/worker-client.ts";
import { NotificationType, type PresenceWireEvent } from "@/protocol/mod.ts";
import { buildProcessor } from "./build-processor.ts";

const identity = { principal: "did:key:z6Mk-presence-worker", sessionId: "s" };

type Cell = { space: string; id: string; path: string[]; scope?: string };

/** A runtime stand-in whose storage joins rooms through `join`. */
const presenceRuntime = (
  join: (
    room: string,
    observer: (event: PresenceEvent) => void,
  ) => Promise<PresenceMembership>,
) => ({
  getCellFromLink: (cell: Cell) => ({
    resolveAsCell: () => ({ getAsNormalizedFullLink: () => cell }),
  }),
  storageManager: {
    open: () => ({ joinPresenceRoom: join, replica: {} }),
    scopeKeyIdentity: () => identity,
  },
});

const postingClient = (id: number) => {
  const posted: unknown[] = [];
  const client: WorkerClient = {
    id,
    post: (message) => {
      posted.push(message);
      return true;
    },
  };
  return { client, posted };
};

const cell: Cell = {
  space: "did:key:z6Mk-presence-space",
  id: "of:presence-field",
  path: ["content"],
  scope: "space",
};

describe("RuntimeProcessor presence", () => {
  it("derives one room for one field and another for another scope instance", async () => {
    const rooms: string[] = [];
    const processor = buildProcessor({
      runtime: presenceRuntime((room, observer) => {
        rooms.push(room);
        observer({ kind: "snapshot", participantId: "p", participants: [] });
        return Promise.resolve({
          participantId: "p",
          publish: () => {},
          leave: () => Promise.resolve(),
        });
      }),
    });
    const { client } = postingClient(1);
    const first = await processor.handlePresenceJoin({
      cell,
      subscriptionId: "membership:1",
    } as never, client);
    const second = await processor.handlePresenceJoin({
      cell: { ...cell },
      subscriptionId: "membership:2",
    } as never, client);
    const scoped = await processor.handlePresenceJoin({
      cell: { ...cell, scope: "user" },
      subscriptionId: "membership:3",
    } as never, client);
    const explicit = await processor.handlePresenceJoin({
      cell,
      subscriptionId: "membership:4",
      room: "room-zyxwvutsrqponmlkjihgfedcba",
    } as never, client);
    expect(first.room).toBe(presenceRoomForField({
      space: cell.space,
      branch: DEFAULT_BRANCH,
      id: cell.id,
      scopeKey: resolveScopeKey("space", identity),
      path: toValuePath(cell.path),
    }));
    expect(second.room).toBe(first.room);
    expect(scoped.room).not.toBe(first.room);
    expect(explicit.room).toBe("room-zyxwvutsrqponmlkjihgfedcba");
    expect(rooms).toEqual([first.room, first.room, scoped.room, explicit.room]);
    expect(first).toEqual({
      participantId: "p",
      room: first.room,
      participants: [],
    });
  });

  it("responds to the join with the opening snapshot and posts every later event", async () => {
    let observe: ((event: PresenceEvent) => void) | undefined;
    const processor = buildProcessor({
      runtime: presenceRuntime((_room, observer) => {
        observe = observer;
        observer({
          kind: "snapshot",
          participantId: "p",
          participants: [{
            participantId: "q",
            revision: 1,
            name: "Quinn",
            facets: {},
          }],
        });
        return Promise.resolve({
          participantId: "p",
          publish: () => {},
          leave: () => Promise.resolve(),
        });
      }),
    });
    const { client, posted } = postingClient(1);
    const joined = await processor.handlePresenceJoin({
      cell,
      subscriptionId: "membership:1",
    } as never, client);
    expect(joined.participants.map((record) => record.name)).toEqual([
      "Quinn",
    ]);
    const revoked = new Error("taken over");
    revoked.name = "SessionRevokedError";
    observe!({ kind: "remove", participantId: "q" });
    observe!({ kind: "snapshot", participantId: "p2", participants: [] });
    observe!({ kind: "failure", error: revoked });
    await Promise.resolve();
    const events: PresenceWireEvent[] = [
      { kind: "remove", participantId: "q" },
      { kind: "snapshot", participantId: "p2", participants: [] },
      {
        kind: "failure",
        error: { name: "SessionRevokedError", message: "taken over" },
      },
    ];
    expect(posted).toEqual(events.map((event) => ({
      type: NotificationType.PresenceUpdate,
      subscriptionId: "membership:1",
      event,
    })));
  });

  it("publishes through the membership and refuses another client's", async () => {
    const published: unknown[] = [];
    const processor = buildProcessor({
      runtime: presenceRuntime((_room, observer) => {
        observer({ kind: "snapshot", participantId: "p", participants: [] });
        return Promise.resolve({
          participantId: "p",
          publish: (publication) => published.push(publication),
          leave: () => Promise.resolve(),
        });
      }),
    });
    const owner = postingClient(1).client;
    const other = postingClient(2).client;
    expect(processor.handlePresencePublish({
      subscriptionId: "membership:1",
      name: "Ada",
      facets: {},
    } as never, owner)).toEqual({ value: false });
    await processor.handlePresenceJoin({
      cell,
      subscriptionId: "membership:1",
    } as never, owner);
    expect(processor.handlePresencePublish({
      subscriptionId: "membership:1",
      name: "Ada",
      facets: { caret: { focused: true } },
    } as never, other)).toEqual({ value: false });
    expect(processor.handlePresencePublish({
      subscriptionId: "membership:1",
      name: "Ada",
      facets: { caret: { focused: true } },
    } as never, owner)).toEqual({ value: true });
    expect(published).toEqual([{
      name: "Ada",
      facets: { caret: { focused: true } },
    }]);
    expect(
      await processor.handlePresenceLeave({
        subscriptionId: "membership:1",
      } as never, other),
    ).toEqual({ value: false });
    expect(
      await processor.handlePresenceLeave({
        subscriptionId: "membership:1",
      } as never, owner),
    ).toEqual({ value: true });
    expect(processor.handlePresencePublish({
      subscriptionId: "membership:1",
      name: "Ada",
      facets: {},
    } as never, owner)).toEqual({ value: false });
  });

  it("leaves a disposed client's memberships and no other's", async () => {
    let left = 0;
    const processor = buildProcessor({
      runtime: presenceRuntime((_room, observer) => {
        observer({ kind: "snapshot", participantId: "p", participants: [] });
        return Promise.resolve({
          participantId: "p",
          publish: () => {},
          leave: () => {
            left++;
            return Promise.resolve();
          },
        });
      }),
    });
    const first = postingClient(1).client;
    const second = postingClient(2).client;
    await processor.handlePresenceJoin({
      cell,
      subscriptionId: "membership:1",
    } as never, first);
    await processor.handlePresenceJoin({
      cell,
      subscriptionId: "membership:2",
    } as never, second);
    processor.disposeClient(first);
    await Promise.resolve();
    expect(left).toBe(1);
    expect(processor.handlePresencePublish({
      subscriptionId: "membership:2",
      name: "Bea",
      facets: {},
    } as never, second)).toEqual({ value: true });
    expect(processor.handlePresencePublish({
      subscriptionId: "membership:1",
      name: "Ada",
      facets: {},
    } as never, first)).toEqual({ value: false });
  });

  it("leaves a membership whose client departed while the join was in flight", async () => {
    const joining = defer<PresenceMembership>();
    let left = 0;
    const processor = buildProcessor({
      runtime: presenceRuntime(() => joining.promise),
    });
    const { client } = postingClient(1);
    const join = processor.handlePresenceJoin({
      cell,
      subscriptionId: "membership:1",
    } as never, client);
    processor.disposeClient(client);
    joining.resolve({
      participantId: "p",
      publish: () => {},
      leave: () => {
        left++;
        return Promise.resolve();
      },
    });
    await expect(join).rejects.toThrow("ended while joining");
    expect(left).toBe(1);
  });
});
