import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  connect,
  loopback,
  type SpaceSession,
} from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import type { MemorySpace } from "@commonfabric/memory/interface";

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

const owner = await Identity.fromPassphrase("retry-space-access owner");
const guest = await Identity.fromPassphrase("retry-space-access guest");
const space = owner.did();

describe("storage space access retry", () => {
  let server: Server;
  let manager: TestStorageManager;
  let guestSessions: SpaceSession[];
  let guestMounts: number;
  let failNextGuestMount: Error | undefined;
  let failNextGuestWatch: Error | undefined;
  let setAccess: (allowed: boolean) => Promise<void>;
  let cleanups: (() => Promise<void>)[];
  let serverCount = 0;

  beforeEach(async () => {
    cleanups = [];
    guestSessions = [];
    guestMounts = 0;
    failNextGuestMount = undefined;
    failNextGuestWatch = undefined;
    server = new Server({
      store: new URL(`memory://storage-retry-space-access-${++serverCount}`),
      sessionOpenAuth: { audience: "did:key:z6Mk-retry-access-audience" },
      authorizeSessionOpen: (message) =>
        (message.authorization as { principal: string }).principal,
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
    const factory: SessionFactory = {
      async create(target, signer, options) {
        if (signer?.did() === guest.did()) {
          guestMounts++;
          const failure = failNextGuestMount;
          failNextGuestMount = undefined;
          if (failure !== undefined) throw failure;
        }
        const client = await connect({ transport: loopback(server) });
        try {
          const session = await client.mount(
            target,
            options,
            (_space, _options, context) => ({
              invocation: {
                aud: context.audience,
                challenge: context.challenge.value,
              },
              authorization: { principal: signer!.did() },
            }),
          );
          if (signer?.did() === guest.did()) {
            guestSessions.push(session);
            const watchAddSync = session.watchAddSync.bind(session);
            session.watchAddSync = (watches) => {
              const failure = failNextGuestWatch;
              failNextGuestWatch = undefined;
              return failure === undefined
                ? watchAddSync(watches)
                : Promise.reject(failure);
            };
          }
          return { client, session };
        } catch (error) {
          await client.close();
          throw error;
        }
      },
    };
    const ownerConnection = await factory.create(space, owner);
    cleanups.push(() => ownerConnection.client.close());
    manager = new TestStorageManager({
      as: guest,
      memoryHost: new URL("memory://"),
    }, factory);
    cleanups.push(() => manager.close());
    let seq = 0;
    setAccess = async (allowed) => {
      await ownerConnection.session.transact({
        localSeq: ++seq,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}`,
          value: {
            value: {
              [owner.did()]: "OWNER",
              ...(allowed ? { [guest.did()]: "READ" } : {}),
            },
          },
        }],
      });
    };
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  it("opens the session again after a revocation and a later grant, and notifies the change", async () => {
    await setAccess(true);
    expect((await manager.open(space).sync(`of:${space}`)).error)
      .toBeUndefined();
    const loss = Promise.withResolvers<void>();
    const cancel = manager.subscribeSpaceAccessLoss(() => loss.resolve());
    cleanups.push(() => Promise.resolve(cancel()));
    await setAccess(false);
    await loss.promise;
    expect(manager.spaceAccessError(space)?.name).toBe("AuthorizationError");

    const changes: boolean[] = [];
    manager.subscribeSpaceAccessChange((target: MemorySpace) =>
      changes.push(manager.spaceAccessError(target) !== undefined)
    );
    await setAccess(true);
    await manager.retrySpaceAccess(space);
    expect(guestMounts).toBe(2);
    expect(guestSessions.length).toBe(2);
    expect(guestSessions[1].closeError).toBeUndefined();
    expect(manager.spaceAccessError(space)).toBeUndefined();
    expect(manager.authorizationError(space)).toBeUndefined();
    expect(changes).toEqual([false]);
  });

  it("does not remount a standing session that a takeover later ends", async () => {
    await setAccess(true);
    expect((await manager.open(space).sync(`of:${space}`)).error)
      .toBeUndefined();

    await manager.retrySpaceAccess(space);
    expect(guestMounts).toBe(1);
    // A session taken over by another mount is not the memory server's
    // verdict on this principal, and only such a verdict is remounted.
    guestSessions[0].handleRevoked("taken-over");
    const read = await manager.open(space).sync("of:retry-after-takeover");
    expect(read.error?.message).toContain("taken-over");
    expect(guestMounts).toBe(1);
  });

  it("rejects, leaving the space refused, when the retry's open fails for a reason other than a refusal", async () => {
    await setAccess(false);
    const refused = await manager.open(space).sync(`of:${space}`);
    expect(refused.error?.name).toBe("AuthorizationError");
    const refusal = manager.spaceAccessError(space);

    await setAccess(true);
    failNextGuestMount = new Error("memory transport lost");
    await expect(manager.retrySpaceAccess(space)).rejects.toThrow(
      "memory transport lost",
    );
    expect(manager.spaceAccessError(space)).toBe(refusal);
    await manager.retrySpaceAccess(space);
    expect(manager.spaceAccessError(space)).toBeUndefined();
  });

  it("keeps a refused load whose repeat fails for another reason, and repeats it on the next retry", async () => {
    await setAccess(false);
    const refused = await manager.open(space).sync(`of:${space}`);
    expect(refused.error?.name).toBe("AuthorizationError");
    const replica = manager.open(space).replica;
    expect(replica.getDocument(`of:${space}`)).toBeUndefined();

    await setAccess(true);
    failNextGuestWatch = new Error("memory transport lost");
    await expect(manager.retrySpaceAccess(space)).rejects.toThrow(
      "memory transport lost",
    );
    expect(manager.spaceAccessError(space)).toBeUndefined();
    expect(replica.getDocument(`of:${space}`)).toBeUndefined();
    await manager.retrySpaceAccess(space);
    expect(replica.getDocument(`of:${space}`)?.value).toEqual({
      [owner.did()]: "OWNER",
      [guest.did()]: "READ",
    });
  });
});
