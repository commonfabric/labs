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
 * second session is told apart from the first.
 */
const buildStorage = () => {
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
              subscribeAccessLoss: () => () => {},
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
                return Promise.resolve(membership);
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

    // The retired session's failure is not the consumer's to see: the
    // replacement's snapshot is what tells it where it now stands.
    sessions[0].observer?.({
      kind: "failure",
      error: new Error("memory session closed"),
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
});
