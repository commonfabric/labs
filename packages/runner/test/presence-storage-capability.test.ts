import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Client from "@commonfabric/memory/v2/client";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { hasPresenceStorageCapability } from "../src/storage/interface.ts";
import { StorageManager as V2StorageManager } from "../src/storage/v2.ts";

const signer = await Identity.fromPassphrase("presence storage capability");
const ROOM = "room-0123456789abcdefghijklmnop";

describe("presence storage capability", () => {
  it("joins through the active session and returns its membership", async () => {
    const joins: string[] = [];
    const membership: MemoryV2Client.PresenceMembership = {
      participantId: "participant:1",
      publish: () => {},
      leave: () => Promise.resolve(),
    };
    const snapshot: MemoryV2Client.PresenceEvent = {
      kind: "snapshot",
      participantId: "participant:1",
      participants: [],
    };
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
                subscribeAccessLoss: () => () => {},
                joinPresenceRoom: (
                  room: string,
                  observer: (event: MemoryV2Client.PresenceEvent) => void,
                ) => {
                  joins.push(room);
                  observer(snapshot);
                  return Promise.resolve(membership);
                },
              } as unknown as MemoryV2Client.SpaceSession;
              return Promise.resolve({ client, session });
            },
          },
        );
      }
    })();
    const provider = storage.open(signer.did());
    expect(hasPresenceStorageCapability(provider)).toBe(true);
    if (!hasPresenceStorageCapability(provider)) return;

    const events: MemoryV2Client.PresenceEvent[] = [];
    const joined = await provider.joinPresenceRoom(
      ROOM,
      (event) => events.push(event),
    );
    expect(joined).toBe(membership);
    expect(joins).toEqual([ROOM]);
    expect(events).toEqual([snapshot]);

    await storage.closeNow();
    await expect(provider.joinPresenceRoom(ROOM, () => {})).rejects.toThrow(
      "memory provider closed",
    );
  });
});
