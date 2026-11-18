import { Identity } from "@commonfabric/identity";
import type { PresencePublication } from "@commonfabric/memory/v2";
import type * as MemoryV2Client from "@commonfabric/memory/v2/client";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { hasPresenceStorageCapability } from "../src/storage/interface.ts";
import { StorageManager as V2StorageManager } from "../src/storage/v2.ts";

const signer = await Identity.fromPassphrase("presence storage capability");
const ROOM = "room-0123456789abcdefghijklmnop";

/** What one stand-in session recorded of the memberships joined through it. */
type SessionRecord = {
  joins: string[];
  published: PresencePublication[];
  leaves: number;
  observer?: (event: MemoryV2Client.PresenceEvent) => void;
};

/**
 * A storage manager whose sessions are stand-ins, each numbered and each
 * recording what presence asked of it, so that a replica replacement's
 * second session is told apart from the first. A join through a session
 * whose number `hold` returns a promise for lands when that promise does,
 * and fails when it rejects.
 */
const buildStorage = (
  hold: (session: number) => Promise<void> | undefined = () => undefined,
) => {
  const sessions: SessionRecord[] = [];
  const storage = new (class extends V2StorageManager {
    constructor() {
      super(
        {
          as: signer,
          memoryHost: new URL("https://default-toolshed.test"),
        },
        {
          create: () => {
            const record: SessionRecord = {
              joins: [],
              published: [],
              leaves: 0,
            };
            sessions.push(record);
            const number = sessions.length;
            const client = {
              serverFlags: { presenceV1: true },
              close: () => Promise.resolve(),
            } as unknown as MemoryV2Client.Client;
            const session = {
              subscribeTermination: () => () => {},
              close: () => Promise.resolve(),
              joinPresenceRoom: (
                room: string,
                observer: (event: MemoryV2Client.PresenceEvent) => void,
              ) => {
                record.joins.push(room);
                record.observer = observer;
                observer({
                  kind: "snapshot",
                  participantId: `participant:${number}`,
                  participants: [],
                });
                const membership: MemoryV2Client.PresenceMembership = {
                  participantId: `participant:${number}`,
                  publish: (publication) => record.published.push(publication),
                  leave: () => {
                    record.leaves++;
                    return Promise.resolve();
                  },
                };
                return (hold(number) ?? Promise.resolve()).then(() =>
                  membership
                );
              },
            } as unknown as MemoryV2Client.SpaceSession;
            return Promise.resolve({ client, session });
          },
        },
      );
    }
  })();
  return { storage, sessions };
};

describe("presence storage capability", () => {
  it("joins through the active session and forwards publications and the leave", async () => {
    const { storage, sessions } = buildStorage();
    const provider = storage.open(signer.did());
    expect(hasPresenceStorageCapability(provider)).toBe(true);
    expect(hasPresenceStorageCapability(null)).toBe(false);
    if (!hasPresenceStorageCapability(provider)) return;

    const events: MemoryV2Client.PresenceEvent[] = [];
    const membership = await provider.joinPresenceRoom(
      ROOM,
      (event) => events.push(event),
    );
    expect(membership.participantId).toBe("participant:1");
    expect(sessions[0].joins).toEqual([ROOM]);
    expect(events).toEqual([{
      kind: "snapshot",
      participantId: "participant:1",
      participants: [],
    }]);
    membership.publish({ name: "Ada", facets: {} });
    expect(sessions[0].published).toEqual([{ name: "Ada", facets: {} }]);
    expect(() => membership.publish({ name: " ", facets: {} })).toThrow(
      "Presence name",
    );
    await membership.leave();
    await membership.leave();
    expect(sessions[0].leaves).toBe(1);

    await storage.closeNow();
    await expect(provider.joinPresenceRoom(ROOM, () => {})).rejects.toThrow(
      "memory provider closed",
    );
  });

  it("rejoins on the replacement session when the route is replaced, republishing the last record", async () => {
    const { storage, sessions } = buildStorage();
    const provider = storage.open(signer.did());
    if (!hasPresenceStorageCapability(provider)) return;
    const events: MemoryV2Client.PresenceEvent[] = [];
    const membership = await provider.joinPresenceRoom(
      ROOM,
      (event) => events.push(event),
    );
    membership.publish({ name: "Ada", facets: { caret: {} } });

    expect(
      storage.registerSpaceHost(signer.did(), "https://hinted-toolshed.test"),
    ).toBe(true);
    await storage.crossSpaceSettled();

    // Nothing from the retired session is the consumer's to see: the
    // replacement's snapshot is what tells it where it now stands.
    sessions[0].observer?.({
      kind: "failure",
      error: new Error("memory session closed"),
    });
    sessions[0].observer?.({
      kind: "upsert",
      participant: {
        participantId: "stale",
        revision: 1,
        name: "Stale",
        facets: {},
      },
    });
    expect(sessions).toHaveLength(2);
    expect(sessions[1].joins).toEqual([ROOM]);
    expect(sessions[1].published).toEqual([{
      name: "Ada",
      facets: { caret: {} },
    }]);
    expect(membership.participantId).toBe("participant:2");
    expect(events.map((event) => event.kind)).toEqual([
      "snapshot",
      "snapshot",
    ]);
    expect(events.at(-1)).toEqual({
      kind: "snapshot",
      participantId: "participant:2",
      participants: [],
    });

    membership.publish({ name: "Ada", facets: {} });
    expect(sessions[1].published).toHaveLength(2);
    expect(sessions[0].published).toHaveLength(1);
    await membership.leave();
    expect(sessions[1].leaves).toBe(1);
    await storage.closeNow();
  });

  it("republishes a room's latest record, whichever membership made it", async () => {
    const { storage, sessions } = buildStorage();
    const provider = storage.open(signer.did());
    if (!hasPresenceStorageCapability(provider)) return;
    const first = await provider.joinPresenceRoom(ROOM, () => {});
    const second = await provider.joinPresenceRoom(ROOM, () => {});
    first.publish({ name: "Ada", facets: { caret: { at: 1 } } });
    second.publish({ name: "Ada", facets: { pointer: { x: 1 } } });
    first.publish({ name: "Ada", facets: { caret: { at: 2 } } });

    expect(
      storage.registerSpaceHost(signer.did(), "https://hinted-toolshed.test"),
    ).toBe(true);
    await storage.crossSpaceSettled();

    expect(sessions[1].published.length).toBeGreaterThan(0);
    for (const publication of sessions[1].published) {
      expect(publication).toEqual({
        name: "Ada",
        facets: { caret: { at: 2 } },
      });
    }
    await first.leave();
    await second.leave();
    await storage.closeNow();
  });

  it("drops a room's record with the join that failed after its last member left", async () => {
    const joining = Promise.withResolvers<MemoryV2Client.PresenceMembership>();
    const published: PresencePublication[][] = [];
    const storage = new (class extends V2StorageManager {
      constructor() {
        super(
          {
            as: signer,
            memoryHost: new URL("https://default-toolshed.test"),
          },
          {
            create: () => {
              const client = {
                serverFlags: { presenceV1: true },
                close: () => Promise.resolve(),
              } as unknown as MemoryV2Client.Client;
              const session = {
                subscribeTermination: () => () => {},
                close: () => Promise.resolve(),
                joinPresenceRoom: (
                  _room: string,
                  observer: (event: MemoryV2Client.PresenceEvent) => void,
                ) => {
                  const record: PresencePublication[] = [];
                  published.push(record);
                  const number = published.length;
                  observer({
                    kind: "snapshot",
                    participantId: `participant:${number}`,
                    participants: [],
                  });
                  // The second join waits, to be refused after the first
                  // member has left; the others settle at once.
                  if (number === 2) return joining.promise;
                  return Promise.resolve({
                    participantId: `participant:${number}`,
                    publish: (publication: PresencePublication) =>
                      record.push(publication),
                    leave: () => Promise.resolve(),
                  });
                },
              } as unknown as MemoryV2Client.SpaceSession;
              return Promise.resolve({ client, session });
            },
          },
        );
      }
    })();
    const provider = storage.open(signer.did());
    if (!hasPresenceStorageCapability(provider)) return;
    const first = await provider.joinPresenceRoom(ROOM, () => {});
    first.publish({ name: "Ada", facets: { caret: {} } });
    const pending = provider.joinPresenceRoom(ROOM, () => {});
    await first.leave();
    joining.reject(new Error("join refused"));
    await expect(pending).rejects.toThrow("join refused");

    // A fresh join finds no record of the room to republish.
    const fresh = await provider.joinPresenceRoom(ROOM, () => {});
    expect(published).toHaveLength(3);
    expect(published[2]).toEqual([]);
    await fresh.leave();
    await storage.closeNow();
  });
  it("sends nothing for a membership that has left, and forwards it nothing", async () => {
    const { storage, sessions } = buildStorage();
    const provider = storage.open(signer.did());
    if (!hasPresenceStorageCapability(provider)) return;
    const events: MemoryV2Client.PresenceEvent[] = [];
    const membership = await provider.joinPresenceRoom(
      ROOM,
      (event) => events.push(event),
    );
    await membership.leave();
    membership.publish({ name: "Ada", facets: {} });
    sessions[0].observer?.({
      kind: "upsert",
      participant: {
        participantId: "late",
        revision: 1,
        name: "Late",
        facets: {},
      },
    });
    expect(sessions[0].published).toEqual([]);
    expect(events.map((event) => event.kind)).toEqual(["snapshot"]);
    await storage.closeNow();
  });

  it("leaves a join that lands after the storage closed, and rejects it", async () => {
    const landing = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const { storage, sessions } = buildStorage(() => {
      reached.resolve();
      return landing.promise;
    });
    const provider = storage.open(signer.did());
    if (!hasPresenceStorageCapability(provider)) return;
    const joining = provider.joinPresenceRoom(ROOM, () => {});
    const refused = expect(joining).rejects.toThrow("memory provider closed");
    await reached.promise;
    expect(sessions[0].joins).toEqual([ROOM]);
    await storage.closeNow();
    landing.resolve();
    await refused;
    expect(sessions[0].leaves).toBe(1);
  });

  for (const outcome of ["lands", "fails"] as const) {
    it(`rejoins on the replacement session when the route is replaced while a join ${outcome} on the replaced one`, async () => {
      const landing = Promise.withResolvers<void>();
      const reached = Promise.withResolvers<void>();
      const { storage, sessions } = buildStorage((session) => {
        if (session !== 1) return undefined;
        reached.resolve();
        return landing.promise;
      });
      const provider = storage.open(signer.did());
      if (!hasPresenceStorageCapability(provider)) return;
      const joining = provider.joinPresenceRoom(ROOM, () => {});
      await reached.promise;
      expect(sessions[0].joins).toEqual([ROOM]);

      expect(
        storage.registerSpaceHost(signer.did(), "https://hinted-toolshed.test"),
      ).toBe(true);
      if (outcome === "lands") landing.resolve();
      else landing.reject(new Error("the replaced session closed"));
      const membership = await joining;
      await storage.crossSpaceSettled();

      expect(membership.participantId).toBe("participant:2");
      expect(sessions[1].joins).toEqual([ROOM]);
      // A membership the replaced session granted is given back.
      expect(sessions[0].leaves).toBe(outcome === "lands" ? 1 : 0);
      await membership.leave();
      await storage.closeNow();
    });
  }
});
