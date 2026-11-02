import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { V2Error } from "@commonfabric/memory/v2";
import { connect, loopback } from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";

import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";

class TestStorageManager extends StorageManager {
  constructor(options: Options, factory: SessionFactory) {
    super(options, factory);
  }
}

/** The refusal the memory server sends for a deleted space. */
function deletedRefusal(space: MemorySpace): V2Error {
  return {
    name: "AuthorizationError",
    message: `Space ${space} is deleted`,
    permanentEvidence: true,
    aclRevision: 3,
    deleted: true,
  };
}

/** A refusal of `space` for want of access, which is not a deletion. */
function plainRefusal(space: MemorySpace): V2Error {
  return {
    name: "AuthorizationError",
    message: `Not authorized for ${space}`,
    permanentEvidence: true,
    aclRevision: 2,
  };
}

/**
 * Returns a storage manager acting as the identity of a fresh space, on a
 * memory server of its own, whose responses a test can replace: while
 * `refuse` holds a refusal, every response to a request is that refusal
 * instead. The server sends no refusal marked `deleted` itself, so this
 * stands in for it.
 */
async function refusingManager(name: string, options: {
  failOpen?: Error;
} = {}) {
  const identity = await Identity.fromPassphrase(`deleted-space ${name}`);
  const space = identity.did() as MemorySpace;
  const server = new Server({
    store: new URL(`memory://deleted-space-${name}`),
    sessionOpenAuth: { audience: space },
    authorizeSessionOpen: () => space,
    acl: { mode: "enforce" },
  });
  const control: { refuse: V2Error | undefined; opens: number } = {
    refuse: undefined,
    opens: 0,
  };
  const clients: { close(): Promise<void> }[] = [];
  const factory: SessionFactory = {
    async create(target) {
      control.opens++;
      if (options.failOpen !== undefined) throw options.failOpen;
      const client = await connect({
        transport: loopback({
          connect: (send, syncParts) =>
            server.connect((message, payload) => {
              if (control.refuse !== undefined && message.type === "response") {
                send({
                  type: "response",
                  requestId: message.requestId,
                  error: control.refuse,
                });
              } else {
                send(message, payload);
              }
            }, syncParts),
        }),
      });
      clients.push(client);
      const session = await client.mount(
        target,
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
    as: identity,
    memoryHost: new URL("memory://"),
  }, factory);
  return {
    space,
    manager,
    control,
    async close() {
      await manager.close();
      for (const client of clients) await client.close();
      await server.close();
    },
  };
}

describe("storage of a deleted space", () => {
  describe("a refused load", () => {
    it("keeps the `deleted` marker on the refusal the space's access error and authorization error report", async () => {
      const { space, manager, control, close } = await refusingManager(
        "load-marker",
      );
      try {
        control.refuse = deletedRefusal(space);
        const result = await manager.open(space).sync(`of:${space}`);
        expect(result.error).toMatchObject({
          name: "AuthorizationError",
          deleted: true,
          aclRevision: 3,
        });
        expect(manager.spaceAccessError(space)).toMatchObject({
          name: "AuthorizationError",
          deleted: true,
        });
        expect(manager.authorizationError(space)).toMatchObject({
          name: "AuthorizationError",
          deleted: true,
        });
      } finally {
        await close();
      }
    });

    it("reports no `deleted` marker on a refusal that carries none", async () => {
      const { space, manager, control, close } = await refusingManager(
        "load-unmarked",
      );
      try {
        control.refuse = plainRefusal(space);
        await manager.open(space).sync(`of:${space}`);
        const error = manager.spaceAccessError(space);
        expect(error?.name).toBe("AuthorizationError");
        expect(Object.hasOwn(error!, "deleted")).toBe(false);
      } finally {
        await close();
      }
    });
  });

  describe("access observers", () => {
    it("hear again of a refused space a retry finds deleted, and not of a deleted space a retry refuses again", async () => {
      const { space, manager, control, close } = await refusingManager(
        "observers",
      );
      const losses: { space: MemorySpace; deleted: unknown }[] = [];
      const changes: MemorySpace[] = [];
      manager.subscribeSpaceAccessLoss((target, error) =>
        losses.push({
          space: target,
          deleted: (error as { deleted?: unknown }).deleted,
        })
      );
      manager.subscribeSpaceAccessChange((target) => changes.push(target));
      try {
        control.refuse = plainRefusal(space);
        await manager.open(space).sync(`of:${space}`);
        expect(losses).toEqual([{ space, deleted: undefined }]);
        expect(changes).toEqual([space]);

        control.refuse = deletedRefusal(space);
        await manager.retrySpaceAccess(space);
        expect(losses).toEqual([
          { space, deleted: undefined },
          { space, deleted: true },
        ]);
        expect(changes).toEqual([space, space]);

        await manager.retrySpaceAccess(space);
        expect(manager.spaceAccessError(space)).toMatchObject({
          deleted: true,
        });
        expect(losses).toHaveLength(2);
        expect(changes).toHaveLength(2);
      } finally {
        await close();
      }
    });
  });

  describe("spaceAnswered()", () => {
    it("returns `false` for a space whose session has not opened, and `true` once the server admits it", async () => {
      const { space, manager, close } = await refusingManager("admitted");
      try {
        expect(manager.spaceAnswered(space)).toBe(false);
        await manager.awaitSpaceAnswer(space);
        expect(manager.spaceAnswered(space)).toBe(true);
        expect(manager.spaceAccessError(space)).toBeUndefined();
      } finally {
        await close();
      }
    });

    it("returns `true` once the server refuses the space", async () => {
      const { space, manager, control, close } = await refusingManager(
        "refused",
      );
      try {
        control.refuse = deletedRefusal(space);
        await manager.awaitSpaceAnswer(space);
        expect(manager.spaceAnswered(space)).toBe(true);
        expect(manager.spaceAccessError(space)).toMatchObject({
          deleted: true,
        });
      } finally {
        await close();
      }
    });

    it("returns `undefined` for a space whose reads a store supplies", async () => {
      const { space, manager, control, close } = await refusingManager(
        "read-through",
      );
      try {
        manager.installStoreReadThrough(space, () => undefined);
        expect(manager.spaceAnswered(space)).toBeUndefined();
        await manager.awaitSpaceAnswer(space);
        expect(control.opens).toBe(0);
      } finally {
        await close();
      }
    });
  });

  describe("subscribeSpaceAnswer()", () => {
    it("reports the server's answer to each open, an admission and a refusal alike", async () => {
      const { space, manager, control, close } = await refusingManager(
        "answer-notice",
      );
      const answered: MemorySpace[] = [];
      manager.subscribeSpaceAnswer((target) => answered.push(target));
      try {
        control.refuse = plainRefusal(space);
        await manager.awaitSpaceAnswer(space);
        expect(answered).toEqual([space]);
        expect(manager.spaceAccessError(space)).toBeDefined();

        // The reopen a retry makes after a refused open is answered and
        // noticed like the first open.
        control.refuse = undefined;
        await manager.retrySpaceAccess(space);
        expect(manager.spaceAccessError(space)).toBeUndefined();
        expect(answered).toEqual([space, space]);
      } finally {
        await close();
      }
    });

    it("reports nothing for an open that ends with no answer", async () => {
      const { space, manager, close } = await refusingManager(
        "answer-notice-none",
        { failOpen: new Error("no connection for this space") },
      );
      const answered: MemorySpace[] = [];
      manager.subscribeSpaceAnswer((target) => answered.push(target));
      try {
        await manager.awaitSpaceAnswer(space).catch(() => {});
        expect(answered).toEqual([]);
      } finally {
        await close();
      }
    });
  });

  describe("awaitSpaceAnswer()", () => {
    it("rejects when the space's open fails with no answer", async () => {
      const failure = new Error("no connection for this space");
      const { space, manager, close } = await refusingManager("open-fails", {
        failOpen: failure,
      });
      try {
        await expect(manager.awaitSpaceAnswer(space)).rejects.toBe(failure);
        expect(manager.spaceAnswered(space)).toBe(false);
      } finally {
        await close();
      }
    });
  });
});
