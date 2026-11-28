/**
 * The restore of a replica's standing watches that word of an access-list
 * change starts once a revocation has ended its session: a restore that
 * throws settles as a failed load rather than rejecting the replica's
 * barrier, and a later retry restores the space.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { connect, loopback } from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import type { URI } from "../src/storage/interface.ts";
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

const owner = await Identity.fromPassphrase("storage-v2 acl restore owner");
const guest = await Identity.fromPassphrase("storage-v2 acl restore guest");
const space = owner.did();
const watched = "of:storage-v2-acl-restore-watched" as URI;

describe("storage/v2 watch restore after an access-list change", () => {
  let server: Server;
  let manager: TestStorageManager;
  let setAccess: (allowed: boolean) => Promise<void>;
  let cleanups: (() => Promise<void>)[];

  beforeEach(async () => {
    cleanups = [];
    server = new Server({
      namesInstances: namesInstancesByDefault,
      store: new URL("memory://storage-v2-acl-restore"),
      sessionOpenAuth: { audience: "did:key:z6Mk-acl-restore-audience" },
      authorizeSessionOpen: (message) =>
        (message.authorization as { principal: string }).principal,
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
    const factory: SessionFactory = {
      async create(target, signer, options) {
        const client = await connect({
          instanceNames: namesInstancesByDefault(),
          transport: loopback(server),
        });
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

  it("settles a restore that throws as a failed load, and restores the space on a later retry", async () => {
    await setAccess(true);
    const provider = manager.open(space);
    expect((await provider.sync(watched)).error).toBeUndefined();
    const loss = Promise.withResolvers<void>();
    const cancel = manager.subscribeSpaceAccessLoss(() => loss.resolve());
    cleanups.push(() => Promise.resolve(cancel()));
    await setAccess(false);
    await loss.promise;
    expect(manager.spaceAccessError(space)?.name).toBe("AuthorizationError");
    await setAccess(true);

    const replica = manager.accessForTestingOnly.openReplica(space);
    expect(replica).toBe(provider.replica);
    const failure = new Error("the restore's pull threw");
    {
      using pull = stub(replica, "pull", () => {
        throw failure;
      });
      manager.noteSpaceAclChanged(space);
      await replica.synced();
      expect(pull.calls.length).toBe(1);
    }

    await manager.retrySpaceAccess(space);
    expect(manager.spaceAccessError(space)).toBeUndefined();
    expect(replica.getDocument(`of:${space}`)).toBeUndefined();
    expect((await provider.sync(`of:${space}`)).error).toBeUndefined();
    expect(replica.getDocument(`of:${space}`)?.value).toEqual({
      [owner.did()]: "OWNER",
      [guest.did()]: "READ",
    });
  });
});
