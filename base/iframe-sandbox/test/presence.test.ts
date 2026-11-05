/**
 * Drives a `presence` resource from the guest's `RemotePresence` across a
 * real port, against a host room the test stands in for.
 */

import type { FabricPlainObject, FabricValue } from "@commonfabric/data-model";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type BridgeResource,
  createFabricBridge,
  FabricBridgeHost,
} from "../src/bridge.ts";
import {
  connectFabric,
  type FabricClient,
  type PresenceRoomEvent,
} from "../src/guest.ts";
import {
  BRIDGE_PRESENCE_DISCONNECTED,
  BRIDGE_PRESENCE_UNSUPPORTED,
  GUEST_PORT_HANDOFF,
} from "../src/ipc.ts";
import {
  type BridgePresenceRecord,
  type BridgePresenceRoom,
  type BridgePresenceRoomEvent,
  presenceResource,
} from "../src/presence.ts";

/** Hands out values in the order they arrived, waiting for the next one. */
function queue<T>(): { push(value: T): void; next(): Promise<T> } {
  const held: T[] = [];
  let waiting: PromiseWithResolvers<T> | undefined;
  return {
    push(value) {
      if (waiting === undefined) {
        held.push(value);
        return;
      }
      const resolvers = waiting;
      waiting = undefined;
      resolvers.resolve(value);
    },
    next() {
      if (held.length > 0) return Promise.resolve(held.shift()!);
      waiting = Promise.withResolvers<T>();
      return waiting.promise;
    },
  };
}

/** A host room that records what is published to it. */
function fakeRoom(participants: BridgePresenceRecord[] = []): {
  room: BridgePresenceRoom;
  calls: unknown[][];
  listening(): number;
  emit(event: BridgePresenceRoomEvent): void;
} {
  const listeners = new Set<(event: BridgePresenceRoomEvent) => void>();
  const calls: unknown[][] = [];
  return {
    room: {
      participantId: "self",
      participants,
      setName: (name) => void calls.push(["setName", name]),
      setFacet: (facet, value) => void calls.push(["setFacet", facet, value]),
      clearFacet: (facet) => void calls.push(["clearFacet", facet]),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      leave: () => {
        calls.push(["leave"]);
        return Promise.resolve();
      },
    },
    calls,
    listening: () => listeners.size,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

/**
 * Connects a guest to a bridge holding `resources` beside a `fence` service,
 * and runs `body` with it. A call of `fence` returns once the guest has
 * handled everything the host sent ahead of the call's response.
 */
async function withGuest(
  resources: Record<string, BridgeResource>,
  body: (client: FabricClient, fence: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const channel = new MessageChannel();
  const host = new FabricBridgeHost(
    createFabricBridge({
      ...resources,
      fence: { kind: "service", methods: { pass: () => undefined } },
    }),
    channel.port1,
  );
  const client = connectFabric();
  globalThis.dispatchEvent(
    new MessageEvent("message", {
      data: GUEST_PORT_HANDOFF,
      ports: [channel.port2],
    }),
  );
  try {
    await body(client, async () => {
      await client.call("fence", "pass");
    });
  } finally {
    client.disconnect();
    host.disconnect();
  }
}

const ada: BridgePresenceRecord = {
  participantId: "ada",
  name: "Ada",
  facets: { pointer: { x: 1, y: 2 } },
};

describe("presence", () => {
  describe("presenceResource()", () => {
    it("describes the room as a `presence` resource with a sink and its publishing methods", async () => {
      const cursors = presenceResource({
        join: () => Promise.resolve(fakeRoom().room),
        failure: () => ({ code: "unused", message: "unused" }),
      }, { description: "Who is on the canvas" });

      await withGuest({ cursors }, async (client) => {
        const manifest = await client.describe();
        expect(manifest.resources.find((entry) => entry.name === "cursors"))
          .toEqual({
            name: "cursors",
            kind: "presence",
            operations: ["sink"],
            methods: ["clearFacet", "setFacet", "setName"],
            description: "Who is on the canvas",
          });
      });
    });

    it("joins when a guest listener is added, and tells it the room as it stands", async () => {
      const { room } = fakeRoom([ada]);
      let joins = 0;
      const cursors = presenceResource({
        join: () => {
          joins++;
          return Promise.resolve(room);
        },
        failure: () => ({ code: "unused", message: "unused" }),
      });

      await withGuest({ cursors }, async (client, fence) => {
        await fence();
        expect(joins).toBe(0);

        const events = queue<PresenceRoomEvent>();
        const presence = client.presence("cursors");
        presence.join((event) => events.push(event));

        expect(await events.next()).toEqual({
          kind: "snapshot",
          participantId: "self",
          participants: [ada],
        });
        expect(joins).toBe(1);
        expect(presence.participantId).toBe("self");
        expect(presence.participants).toEqual([ada]);
      });
    });

    it("tells a guest a participant's id, name, and facets, and nothing else the room holds", async () => {
      const { room, emit } = fakeRoom();
      const cursors = presenceResource({
        join: () => Promise.resolve(room),
        failure: () => ({ code: "unused", message: "unused" }),
      });

      await withGuest({ cursors }, async (client) => {
        const events = queue<PresenceRoomEvent>();
        client.presence("cursors").join((event) => events.push(event));
        await events.next();

        const record = { ...ada, principal: "did:key:ada", revision: 7 };
        emit({ kind: "upsert", participant: record });

        expect(await events.next()).toEqual({
          kind: "upsert",
          participant: ada,
        });
      });
    });

    it("applies each of the room's events to the guest's `.participants`", async () => {
      const { room, emit } = fakeRoom([ada]);
      const cursors = presenceResource({
        join: () => Promise.resolve(room),
        failure: () => ({ code: "unused", message: "unused" }),
      });

      await withGuest({ cursors }, async (client) => {
        const events = queue<PresenceRoomEvent>();
        const presence = client.presence("cursors");
        presence.join((event) => events.push(event));
        await events.next();

        const moved = { ...ada, facets: { pointer: { x: 5, y: 6 } } };
        const grace = { participantId: "grace", name: "Grace", facets: {} };
        emit({ kind: "upsert", participant: moved });
        emit({ kind: "upsert", participant: grace });
        await events.next();
        await events.next();
        expect(presence.participants).toEqual([moved, grace]);

        emit({ kind: "remove", participantId: "ada" });
        expect(await events.next()).toEqual({
          kind: "remove",
          participantId: "ada",
        });
        expect(presence.participants).toEqual([grace]);

        emit({ kind: "snapshot", participantId: "again", participants: [] });
        await events.next();
        expect(presence.participantId).toBe("again");
        expect(presence.participants).toEqual([]);
      });
    });

    it("passes the guest's name and facets to the joined room", async () => {
      const { room, calls } = fakeRoom();
      const cursors = presenceResource({
        join: () => Promise.resolve(room),
        failure: () => ({ code: "unused", message: "unused" }),
      });

      await withGuest({ cursors }, async (client) => {
        const events = queue<PresenceRoomEvent>();
        const presence = client.presence("cursors");
        presence.join((event) => events.push(event));
        await events.next();

        await presence.setName("Grace");
        await presence.setFacet("pointer", { x: 3, y: 4 });
        await presence.clearFacet("pointer");

        expect(calls).toEqual([
          ["setName", "Grace"],
          ["setFacet", "pointer", { x: 3, y: 4 }],
          ["clearFacet", "pointer"],
        ]);
      });
    });

    it("holds what the guest publishes ahead of the join, and passes the room what stands once it settles", async () => {
      const { room, calls } = fakeRoom();
      const joining = Promise.withResolvers<BridgePresenceRoom>();
      const cursors = presenceResource({
        join: () => joining.promise,
        failure: () => ({ code: "unused", message: "unused" }),
      });

      await withGuest({ cursors }, async (client) => {
        const events = queue<PresenceRoomEvent>();
        const presence = client.presence("cursors");
        presence.join((event) => events.push(event));

        await presence.setName("Grace");
        await presence.setFacet("pointer", { x: 3, y: 4 });
        await presence.setFacet("drag", { id: "a" });
        await presence.setFacet("pointer", { x: 9, y: 9 });
        await presence.clearFacet("drag");
        expect(calls).toEqual([]);

        joining.resolve(room);
        await events.next();
        expect(calls).toEqual([
          ["setName", "Grace"],
          ["setFacet", "pointer", { x: 9, y: 9 }],
        ]);
      });
    });

    it("rejects a publication while no guest listener has joined", async () => {
      let joins = 0;
      const cursors = presenceResource({
        join: () => {
          joins++;
          return Promise.resolve(fakeRoom().room);
        },
        failure: () => ({ code: "unused", message: "unused" }),
      });

      await withGuest({ cursors }, async (client) => {
        await expect(client.presence("cursors").setName("Grace")).rejects
          .toMatchObject({
            code: "operation-failed",
            message:
              "The presence room is not joined: open its sink before publishing.",
          });
        expect(joins).toBe(0);
      });
    });

    it("rejects a name, a facet name, or a facet value of the wrong shape, and publishes none of them", async () => {
      const { room, calls } = fakeRoom();
      const cursors = presenceResource({
        join: () => Promise.resolve(room),
        failure: () => ({ code: "unused", message: "unused" }),
      });

      await withGuest({ cursors }, async (client) => {
        const events = queue<PresenceRoomEvent>();
        client.presence("cursors").join((event) => events.push(event));
        await events.next();

        const call = (method: string, value: FabricValue) =>
          client.call("cursors", method, value);
        await expect(call("setName", 7)).rejects.toMatchObject({
          message: "A presence name is a string.",
        });
        await expect(call("clearFacet", 7)).rejects.toMatchObject({
          message: "A presence facet is named by a string.",
        });
        await expect(call("setFacet", "pointer")).rejects.toMatchObject({
          message:
            "`setFacet` takes an object with `facet` and `value` fields.",
        });
        await expect(call("setFacet", { facet: 7, value: {} })).rejects
          .toMatchObject({ message: "A presence facet is named by a string." });
        await expect(call("setFacet", { facet: "pointer", value: [1, 2] }))
          .rejects.toMatchObject({
            message: "A presence facet's value is a plain object.",
          });
        expect(calls).toEqual([]);
      });
    });

    it("leaves the room when the guest's last listener leaves, and joins again for the next", async () => {
      const first = fakeRoom();
      const second = fakeRoom();
      const rooms = [first.room, second.room];
      const cursors = presenceResource({
        join: () => Promise.resolve(rooms.shift()!),
        failure: () => ({ code: "unused", message: "unused" }),
      });

      await withGuest({ cursors }, async (client, fence) => {
        const events = queue<PresenceRoomEvent>();
        const presence = client.presence("cursors");
        const leaveOne = presence.join((event) => events.push(event));
        const leaveTwo = presence.join(() => {});
        await events.next();

        leaveOne();
        await fence();
        expect(first.calls).toEqual([]);

        leaveTwo();
        await fence();
        expect(first.calls).toEqual([["leave"]]);
        expect(first.listening()).toBe(0);
        expect(presence.participantId).toBeUndefined();

        presence.join((event) => events.push(event));
        expect(await events.next()).toMatchObject({ kind: "snapshot" });
        expect(rooms).toEqual([]);
        expect(second.listening()).toBe(1);
      });
    });

    it("leaves a room whose join settles after the guest left, and tells the guest nothing of it", async () => {
      const { room, calls, listening } = fakeRoom();
      const joining = Promise.withResolvers<BridgePresenceRoom>();
      const cursors = presenceResource({
        join: () => joining.promise,
        failure: () => ({ code: "unused", message: "unused" }),
      });

      await withGuest({ cursors }, async (client, fence) => {
        const heard: PresenceRoomEvent[] = [];
        const leave = client.presence("cursors").join((event) =>
          heard.push(event)
        );
        leave();
        await fence();

        joining.resolve(room);
        // The host acts on the join in a microtask of its own, which a
        // second round trip is behind.
        await fence();
        await fence();
        expect(calls).toEqual([["leave"]]);
        expect(listening()).toBe(0);
        expect(heard).toEqual([]);
      });
    });

    it("tells a listener added to a joined room a snapshot of it at once", async () => {
      const { room } = fakeRoom([ada]);
      const cursors = presenceResource({
        join: () => Promise.resolve(room),
        failure: () => ({ code: "unused", message: "unused" }),
      });

      await withGuest({ cursors }, async (client) => {
        const events = queue<PresenceRoomEvent>();
        const presence = client.presence("cursors");
        presence.join((event) => events.push(event));
        await events.next();

        const heard: PresenceRoomEvent[] = [];
        presence.join((event) => heard.push(event));
        expect(heard).toEqual([{
          kind: "snapshot",
          participantId: "self",
          participants: [ada],
        }]);
      });
    });

    it("keeps no listener that throws as it hears a joined room's snapshot, and leaves the room when the others leave", async () => {
      const { room, calls } = fakeRoom([ada]);
      const cursors = presenceResource({
        join: () => Promise.resolve(room),
        failure: () => ({ code: "unused", message: "unused" }),
      });

      await withGuest({ cursors }, async (client, fence) => {
        const events = queue<PresenceRoomEvent>();
        const presence = client.presence("cursors");
        const leave = presence.join((event) => events.push(event));
        await events.next();

        let heard = 0;
        expect(() =>
          presence.join(() => {
            heard++;
            throw new Error("listener failed");
          })
        ).toThrow("listener failed");

        leave();
        await fence();
        expect(calls).toEqual([["leave"]]);
        expect(heard).toBe(1);
      });
    });

    it("ends the room for every listener with what the grant says of a rejected join", async () => {
      const causes: unknown[] = [];
      const cause = new Error("memory server does not support presence");
      const cursors = presenceResource({
        join: () => Promise.reject(cause),
        failure: (seen) => {
          causes.push(seen);
          return { code: BRIDGE_PRESENCE_UNSUPPORTED, message: "No relay." };
        },
      });

      await withGuest({ cursors }, async (client) => {
        const one = queue<PresenceRoomEvent>();
        const two = queue<PresenceRoomEvent>();
        const presence = client.presence("cursors");
        presence.join((event) => one.push(event));
        presence.join((event) => two.push(event));

        for (const events of [one, two]) {
          const event = await events.next();
          expect(event).toMatchObject({
            kind: "failure",
            error: { code: BRIDGE_PRESENCE_UNSUPPORTED, message: "No relay." },
          });
        }
        expect(causes).toEqual([cause]);
      });
    });

    it("ends the room with `resource-not-found` for a name the host grants no resource under", async () => {
      await withGuest({}, async (client) => {
        const events = queue<PresenceRoomEvent>();
        client.presence("cursors").join((event) => events.push(event));

        expect(await events.next()).toMatchObject({
          kind: "failure",
          error: { code: "resource-not-found", resource: "cursors" },
        });
      });
    });

    it("ends the room on its failure, rejects a publication to it, and joins a fresh room after", async () => {
      const first = fakeRoom([ada]);
      const second = fakeRoom();
      const rooms = [first.room, second.room];
      const cursors = presenceResource({
        join: () => Promise.resolve(rooms.shift()!),
        failure: () => ({
          code: BRIDGE_PRESENCE_DISCONNECTED,
          message: "Lost the room.",
        }),
      });

      await withGuest({ cursors }, async (client, fence) => {
        const events = queue<PresenceRoomEvent>();
        const presence = client.presence("cursors");
        const leave = presence.join((event) => events.push(event));
        await events.next();

        first.emit({ kind: "failure", error: new Error("session closed") });
        // The publication is sent before the guest has heard of the failure,
        // so the host is what refuses it.
        const late = client.call("cursors", "setName", "Grace");
        await expect(late).rejects.toMatchObject({
          code: BRIDGE_PRESENCE_DISCONNECTED,
        });
        expect(await events.next()).toMatchObject({
          kind: "failure",
          error: { code: BRIDGE_PRESENCE_DISCONNECTED },
        });
        expect(presence.participants).toEqual([]);
        expect(presence.participantId).toBeUndefined();
        expect(first.calls).toEqual([["leave"]]);

        // The listener the failure ended holds nothing to leave.
        leave();
        presence.join((event) => events.push(event));
        expect(await events.next()).toEqual({
          kind: "snapshot",
          participantId: "self",
          participants: [],
        });
        await fence();
        expect(second.calls).toEqual([]);
      });
    });

    it("leaves the room when the guest disconnects", async () => {
      const { room, calls } = fakeRoom();
      const cursors = presenceResource({
        join: () => Promise.resolve(room),
        failure: () => ({ code: "unused", message: "unused" }),
      });
      const left = Promise.withResolvers<void>();
      const leave = room.leave;
      room.leave = () => {
        left.resolve();
        return leave();
      };

      await withGuest({ cursors }, async (client) => {
        const events = queue<PresenceRoomEvent>();
        client.presence("cursors").join((event) => events.push(event));
        await events.next();

        client.disconnect();
        await left.promise;
        expect(calls).toEqual([["leave"]]);
      });
    });
  });

  describe("RemotePresence", () => {
    it("tells a listener nothing of a sink it let go of whose request fails after it joined again", async () => {
      let sinks = 0;
      const cursors: BridgeResource = {
        kind: "presence",
        sink: (listener) => {
          if (sinks++ === 0) throw new Error("first sink refused");
          listener({
            kind: "snapshot",
            participantId: "self",
            participants: [],
          });
          return () => {};
        },
      };

      await withGuest({ cursors }, async (client) => {
        const events = queue<PresenceRoomEvent>();
        const presence = client.presence("cursors");
        presence.join(() => {})();
        presence.join((event) => events.push(event));

        expect(await events.next()).toEqual({
          kind: "snapshot",
          participantId: "self",
          participants: [],
        });
        expect(presence.participantId).toBe("self");
      });
    });

    it("hands out frozen participants, facets and their contents included", async () => {
      const { room } = fakeRoom([{
        participantId: "ada",
        name: "Ada",
        facets: { drag: { id: "shape", position: { x: 1, y: 2 } } },
      }]);
      const cursors = presenceResource({
        join: () => Promise.resolve(room),
        failure: () => ({ code: "unused", message: "unused" }),
      });

      await withGuest({ cursors }, async (client) => {
        const events = queue<PresenceRoomEvent>();
        const presence = client.presence("cursors");
        presence.join((event) => events.push(event));
        await events.next();

        const [participant] = presence.participants;
        expect(Object.isFrozen(participant)).toBe(true);
        expect(Object.isFrozen(participant.facets)).toBe(true);
        expect(Object.isFrozen(participant.facets.drag)).toBe(true);
        expect(Object.isFrozen(participant.facets.drag.position)).toBe(true);
      });
    });

    it("ignores a delivery that is not a room event, and a participant whose facet is not a plain object", async () => {
      let deliver: (value: FabricValue | undefined) => void = () => {};
      const cursors: BridgeResource = {
        kind: "presence",
        sink: (listener) => {
          deliver = listener;
          return () => {};
        },
      };

      await withGuest({ cursors }, async (client, fence) => {
        const heard: PresenceRoomEvent[] = [];
        const presence = client.presence("cursors");
        presence.join((event) => heard.push(event));
        await fence();

        const snapshot: FabricPlainObject = {
          kind: "snapshot",
          participantId: "self",
          participants: [],
        };
        deliver(snapshot);
        deliver("upsert");
        deliver({ kind: "resync" });
        deliver({ kind: "remove" });
        deliver({
          kind: "upsert",
          participant: { ...ada, facets: { pointer: "here" } },
        });
        await fence();

        expect(heard).toEqual([snapshot]);
        expect(presence.participants).toEqual([]);
      });
    });
  });
});
