import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

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

describe("storage space access loss", () => {
  it("continues authoritative revocation delivery after an observer throws", async () => {
    const identity = await Identity.fromPassphrase("throwing access observer");
    const space = identity.did();
    const server = new Server({
      store: new URL("memory://throwing-access-observer"),
      sessionOpenAuth: { audience: space },
      authorizeSessionOpen: () => space,
      acl: { mode: "enforce" },
    });
    const client = await connect({ transport: loopback(server) });
    const session = await client.mount(
      space,
      {},
      (_space, _options, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: {},
      }),
    );
    const manager = new TestStorageManager({
      as: identity,
      memoryHost: new URL("memory://"),
    }, { create: () => Promise.resolve({ client, session }) });
    const failure = new Error("observer failure");
    const reported = stub(console, "error");
    try {
      expect((await manager.open(space).sync(`of:${space}`)).error)
        .toBeUndefined();
      manager.subscribeSpaceAccessLoss(() => {
        throw failure;
      });
      const observed: { target: MemorySpace; error: Error }[] = [];
      manager.subscribeSpaceAccessLoss((target, error) =>
        observed.push({ target, error })
      );
      expect(() => session.handleRevoked("unauthorized")).not.toThrow();
      expect(observed).toEqual([{ target: space, error: session.closeError }]);
      expect(manager.spaceAccessError(space)).toBe(session.closeError);
      expect(reported.calls.map((call) => call.args)).toEqual([
        ["space-access-loss subscriber threw:", failure],
      ]);
    } finally {
      reported.restore();
      await manager.close();
      await client.close();
      await server.close();
    }
  });

  it("publishes an ACL revocation synchronously and clears it after an authorized reopen", async () => {
    const owner = await Identity.fromPassphrase("access-loss owner");
    const guest = await Identity.fromPassphrase("access-loss guest");
    const space = owner.did();
    const server = new Server({
      store: new URL("memory://storage-space-access-loss"),
      sessionOpenAuth: { audience: "did:key:z6Mk-access-loss-audience" },
      authorizeSessionOpen: (message) =>
        (message.authorization as { principal: string }).principal,
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
    let guestSession: SpaceSession | undefined;
    const factory: SessionFactory = {
      async create(target, signer, options) {
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
          if (signer?.did() === guest.did()) guestSession = session;
          return { client, session };
        } catch (error) {
          await client.close();
          throw error;
        }
      },
    };
    const ownerConnection = await factory.create(space, owner);
    const manager = new TestStorageManager({
      as: guest,
      memoryHost: new URL("memory://"),
    }, factory);
    let seq = 0;
    const setAccess = async (allowed: boolean) => {
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
    const notices: MemorySpace[] = [];
    const changes: { space: MemorySpace; denied: boolean }[] = [];
    manager.subscribeSpaceAccessChange(
      (target: MemorySpace) =>
        changes.push({
          space: target,
          denied: manager.spaceAccessError(target) !== undefined,
        }),
    );
    const loss = Promise.withResolvers<void>();
    const cancel = manager.subscribeSpaceAccessLoss((target) => {
      expect(manager.spaceAccessError(target)?.name).toBe("AuthorizationError");
      notices.push(target);
      loss.resolve();
    });
    try {
      await setAccess(true);
      expect((await manager.open(space).sync(`of:${space}`)).error)
        .toBeUndefined();
      expect(manager.spaceAccessError(space)).toBeUndefined();
      const originalSession = guestSession;
      await setAccess(false);
      await loss.promise;
      expect(notices).toEqual([space]);
      expect(changes).toEqual([{ space, denied: true }]);
      expect(manager.spaceAccessError(guest.did())).toBeUndefined();
      expect(manager.authorizationError(space)?.name).toBe(
        "AuthorizationError",
      );
      await setAccess(true);
      manager.noteSpaceAclChanged(space);
      expect((await manager.open(space).sync(`of:${space}`)).error)
        .toBeUndefined();
      expect(guestSession).not.toBe(originalSession);
      expect(changes).toEqual([{ space, denied: true }, {
        space,
        denied: false,
      }]);
      expect(notices).toEqual([space]);
      expect(manager.spaceAccessError(space)).toBeUndefined();
      expect(manager.authorizationError(space)).toBeUndefined();
      cancel();
      await setAccess(false);
      expect(notices).toEqual([space]);
      await manager.close();
      expect(manager.spaceAccessError(space)).toBeUndefined();
    } finally {
      cancel();
      await manager.close();
      await ownerConnection.client.close();
      await server.close();
    }
  });
});
