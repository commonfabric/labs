import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { connect, loopback } from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { hasPresenceStorageCapability } from "../src/storage/interface.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("runner-space-session-release");
const stranger = await Identity.fromPassphrase(
  "runner-space-session-release-stranger",
);

class TestStorageManager extends StorageManager {
  constructor(options: Options, factory: SessionFactory) {
    super(options, factory);
  }
}

/**
 * A storage manager acting as `signer`, on a memory server of its own that
 * refuses every request in `target`, the space of `stranger`, for want of
 * access.
 */
function refusingManager() {
  const target = stranger.did() as MemorySpace;
  const server = new Server({
    namesInstances: namesInstancesByDefault,
    store: new URL("memory://space-session-release-refusing"),
    sessionOpenAuth: { audience: home },
    authorizeSessionOpen: () => home,
    acl: { mode: "enforce" },
  });
  const refusal = {
    name: "AuthorizationError",
    message: `Not authorized for ${target}`,
    permanentEvidence: true,
    aclRevision: 2,
  };
  const clients: { close(): Promise<void> }[] = [];
  const factory: SessionFactory = {
    async create(space) {
      const client = await connect({
        instanceNames: namesInstancesByDefault(),
        transport: loopback({
          connect: (send, syncParts) =>
            server.connect((message, payload) => {
              if (space === target && message.type === "response") {
                send({
                  type: "response",
                  requestId: message.requestId,
                  error: refusal,
                });
              } else {
                send(message, payload);
              }
            }, syncParts),
        }),
      });
      clients.push(client);
      const session = await client.mount(
        home,
        {},
        (_space, _options, context) => ({
          invocation: {
            aud: context.audience,
            challenge: context.challenge.value,
          },
          authorization: {},
        }),
      );
      return { client, session };
    },
  };
  const manager = new TestStorageManager({
    as: signer,
    memoryHost: new URL("memory://"),
  }, factory);
  return {
    target,
    manager,
    async close() {
      await manager.close();
      for (const client of clients) await client.close();
      await server.close();
    },
  };
}
const home: MemorySpace = signer.did();

/** A presence room, as a room id is spelled. */
const ROOM = "space-session-release-room";

const counterSchema = {
  type: "object",
  properties: { n: { type: "number" } },
} as const satisfies JSONSchema;

describe("space-session-release", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let readerStorage: EmulatedStorageManager;
  let writer: Runtime;
  let reader: Runtime;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
  });

  afterEach(async () => {
    await writer?.dispose();
    await reader?.dispose();
    await writerStorage?.close();
    await readerStorage?.close();
    await server?.close();
  });

  /** A new space holding the counter `{ n }`, and the counter's id. */
  const spaceWith = async (
    n: number,
  ): Promise<{ space: MemorySpace; id: URI }> => {
    const space = await writer.createSpace();
    const id = await write(space, n);
    return { space, id };
  };

  /** Writes `{ n }` to the counter in `space`, and returns its id. */
  const write = async (space: MemorySpace, n: number): Promise<URI> => {
    const tx = writer.edit();
    const counter = writer.getCell(space, "counter", counterSchema, tx);
    counter.set({ n });
    expect((await tx.commit().settled).error).toBeUndefined();
    await writerStorage.synced();
    await server.flushSessions();
    return counter.getAsNormalizedFullLink().id as URI;
  };

  /** Loads the counter `id` of `space` into the reader with no cell to hold it. */
  const load = async (space: MemorySpace, id: URI) => {
    expect(
      (await readerStorage.open(space).sync(id, { path: [], schema: false }))
        .error,
    ).toBeUndefined();
  };

  /** Runs two release passes, so a document loaded before the first goes. */
  const releaseTwice = async () => {
    await reader.scheduler.idle();
    await readerStorage.releaseUnreadDocuments();
    await readerStorage.releaseUnreadDocuments();
  };

  /** Whether the reader holds `space` open. */
  const isOpen = (space: MemorySpace) =>
    readerStorage.openedSpaces().includes(space);

  it("releases each space nothing uses once its documents are released", async () => {
    const spaces = await Promise.all([
      spaceWith(1),
      spaceWith(2),
      spaceWith(3),
    ]);
    for (const { space, id } of spaces) await load(space, id);
    expect(spaces.map(({ space }) => isOpen(space))).toEqual([
      true,
      true,
      true,
    ]);

    await releaseTwice();

    expect(spaces.map(({ space }) => isOpen(space))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("tells the observers of `subscribeSpacesReleased()` which spaces it released", async () => {
    const { space, id } = await spaceWith(1);
    await load(space, id);
    const released: MemorySpace[] = [];
    const cancel = readerStorage.subscribeSpacesReleased((each) => {
      released.push(each);
    });

    await releaseTwice();
    cancel();

    expect(released).toEqual([space]);
  });

  it("opens a released space again on its next read, with the value the server now holds", async () => {
    const { space, id } = await spaceWith(1);
    await load(space, id);
    await releaseTwice();
    expect(isOpen(space)).toBe(false);
    await write(space, 2);

    const counter = reader.getCellFromLink({
      space,
      id,
      path: [],
      type: "application/json",
    }, counterSchema);
    const value = await counter.pull();

    expect(isOpen(space)).toBe(true);
    expect(value).toEqual({ n: 2 });
  });

  it("sends a write to a released space once it opens again", async () => {
    const { space, id } = await spaceWith(1);
    await load(space, id);
    await releaseTwice();
    expect(isOpen(space)).toBe(false);

    const written = await reader.editWithRetry((tx) => {
      reader.getCell(space, "counter", counterSchema, tx).set({ n: 5 });
    });
    expect(written.error).toBeUndefined();
    await readerStorage.synced();
    await server.flushSessions();
    const seen = writer.getCellFromLink({
      space,
      id,
      path: [],
      type: "application/json",
    }, counterSchema);

    expect(await seen.pull()).toEqual({ n: 5 });
  });

  describe("a space in use", () => {
    it("keeps the signer's home space", async () => {
      const id = await write(home, 1);
      await load(home, id);

      await releaseTwice();

      expect(isOpen(home)).toBe(true);
    });

    it("keeps a space whose document a cell holds", async () => {
      const { space, id } = await spaceWith(1);
      const counter: Cell<unknown> = reader.getCellFromLink({
        space,
        id,
        path: [],
        type: "application/json",
      }, counterSchema);
      await counter.pull();

      await releaseTwice();

      expect(isOpen(space)).toBe(true);
      expect(counter.get()).toEqual({ n: 1 });
    });

    it("keeps a space a sink on its replica names", async () => {
      const { space, id } = await spaceWith(1);
      const cancel = readerStorage.open(space).sink(id, () => {});
      await readerStorage.synced();

      await releaseTwice();

      expect(isOpen(space)).toBe(true);
      cancel();
      await releaseTwice();
      expect(isOpen(space)).toBe(false);
    });

    it("keeps a space a presence membership is open in", async () => {
      const { space, id } = await spaceWith(1);
      await load(space, id);
      const provider = readerStorage.open(space);
      if (!hasPresenceStorageCapability(provider)) {
        throw new Error("the reader's provider joins no presence room");
      }
      const membership = await provider.joinPresenceRoom(ROOM, () => {});

      await releaseTwice();

      expect(isOpen(space)).toBe(true);
      await membership.leave();
      await releaseTwice();
      expect(isOpen(space)).toBe(false);
    });

    it("keeps a space whose session the server refused", async () => {
      const refusing = refusingManager();
      try {
        const result = await refusing.manager.open(refusing.target).sync(
          `of:${refusing.target}` as URI,
        );
        expect(result.error?.name).toBe("AuthorizationError");
        expect(refusing.manager.spaceAccessError(refusing.target))
          .toBeDefined();

        await refusing.manager.releaseUnreadDocuments();
        await refusing.manager.releaseUnreadDocuments();

        expect(refusing.manager.openedSpaces()).toContain(refusing.target);
      } finally {
        await refusing.close();
      }
    });
  });
});
