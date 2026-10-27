import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { decodeMemoryBoundary, toValuePath } from "@commonfabric/memory/v2";
import {
  connect,
  loopback,
  type SpaceSession,
} from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import type { MemorySpace } from "@commonfabric/memory/interface";

import { hasOperationStorageCapability } from "../src/storage/interface.ts";
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

  it("warns about an unconfirmed space-creation write when its session is refused", async () => {
    const issued = Promise.withResolvers<void>();
    let creatingSession: SpaceSession | undefined;
    const storage = new TestStorageManager({
      as: owner,
      memoryHost: new URL("memory://"),
    }, {
      async create(target, _signer, options) {
        const transport = loopback(server);
        const client = await connect({
          transport: {
            ...transport,
            send(payload) {
              if (
                (decodeMemoryBoundary(payload) as { type: string }).type ===
                  "transact"
              ) {
                issued.resolve();
                return Promise.resolve();
              }
              return transport.send(payload);
            },
          },
        });
        const session = await client.mount(
          target,
          options,
          (_space, _options, context) => ({
            invocation: {
              aud: context.audience,
              challenge: context.challenge.value,
            },
            authorization: { principal: target },
          }),
        );
        creatingSession = session;
        return { client, session };
      },
    });
    cleanups.push(() => storage.close());
    const creating = storage.createSpace({ [owner.did()]: "OWNER" });
    const refused = expect(creating).rejects.toThrow("Update this runtime");
    await issued.promise;
    expect(storage.hasPendingCommits()).toBe(true);
    creatingSession!.handleConnectionFailure(
      Object.assign(new Error("Update this runtime"), {
        name: "SessionRevokedError",
        clientUpdateRequired: true,
      }),
    );
    await refused;
    await storage.pendingCommitsSettled();
    expect(storage.hasPendingCommits()).toBe(false);
    expect(storage.clientUpdateRequired()?.unconfirmedWrites).toBe(true);
  });

  for (const operation of ["apply", "release"] as const) {
    it(`retains the warning for an unconfirmed operation ${operation}`, async () => {
      await setAccess(true);
      const provider = manager.open(space);
      expect((await provider.sync("of:operation-ready")).error).toBeUndefined();
      if (!hasOperationStorageCapability(provider)) {
        throw new Error("Expected operation support");
      }
      const issued = Promise.withResolvers<void>();
      const commit = Promise.withResolvers<
        Awaited<ReturnType<SpaceSession["transact"]>>
      >();
      const transact = stub(guestSessions[0], "transact", () => {
        issued.resolve();
        return commit.promise;
      });
      try {
        const address = {
          id: "of:editor",
          path: toValuePath([]),
          codec: "test@1",
        };
        const writing = operation === "apply"
          ? provider.applyOperation({
            ...address,
            op: "apply-op",
            submissionId: "edit:1",
            base: null,
            baselineHash: "baseline",
            payload: {},
          })
          : provider.releaseOperationField({
            ...address,
            op: "release-op-field",
            cursor: { epoch: 1, version: 1 },
          });
        const refused = expect(writing).rejects.toThrow("Update this runtime");
        await issued.promise;
        expect(manager.hasPendingCommits()).toBe(true);
        const error = Object.assign(new Error("Update this runtime"), {
          name: "SessionRevokedError",
          clientUpdateRequired: true,
        });
        guestSessions[0].handleConnectionFailure(error);
        commit.reject(error);
        await refused;
        await manager.pendingCommitsSettled();
        expect(manager.hasPendingCommits()).toBe(false);
        expect(manager.clientUpdateRequired()?.unconfirmedWrites).toBe(true);
      } finally {
        transact.restore();
      }
    });
  }

  it("records a refusal during space creation and blocks every later admission path", async () => {
    const failure = Object.assign(new Error("Update this runtime"), {
      name: "SessionRevokedError",
      clientUpdateRequired: true,
    });
    let mounts = 0;
    const storage = new TestStorageManager({
      as: guest,
      memoryHost: new URL("memory://"),
    }, {
      create: () => {
        mounts++;
        return Promise.reject(failure);
      },
    });
    cleanups.push(() => storage.close());
    await expect(storage.createSpace({ [guest.did()]: "OWNER" })).rejects.toBe(
      failure,
    );
    expect(storage.clientUpdateRequired()?.message).toBe(failure.message);
    await expect(storage.createSpace({ [guest.did()]: "OWNER" })).rejects.toBe(
      failure,
    );
    expect((await storage.open(space).sync("of:blocked")).error).toBeDefined();
    await expect(storage.spaceKind(space)).rejects.toBe(failure);
    expect(mounts).toBe(1);
  });

  it("does not serve a covered selector after an update-required authorization refusal", async () => {
    await setAccess(true);
    const provider = manager.open(space);
    expect((await provider.sync("of:covered")).error).toBeUndefined();
    guestSessions[0].handleConnectionFailure(
      Object.assign(new Error("Update this runtime"), {
        name: "AuthorizationError",
        clientUpdateRequired: true,
      }),
    );
    expect((await provider.sync("of:covered")).error?.message).toBe(
      "Update this runtime",
    );
    expect(manager.spaceAccessError(space)).toBeUndefined();
    expect(guestMounts).toBe(1);
  });

  it("keeps a denied Retry of a terminated session latched across ordinary reads", async () => {
    await setAccess(true);
    const provider = manager.open(space);
    expect((await provider.sync("of:covered")).error).toBeUndefined();
    const loss = Promise.withResolvers<void>();
    manager.subscribeSpaceAccessLoss(() => loss.resolve());
    await setAccess(false);
    await loss.promise;
    await manager.retrySpaceAccess(space);
    expect(guestMounts).toBe(2);
    expect((await provider.sync("of:after-retry")).error?.name).toBe(
      "AuthorizationError",
    );
    expect((await provider.sync("of:another")).error?.name).toBe(
      "AuthorizationError",
    );
    expect(guestMounts).toBe(2);
  });

  it("retains an initial denial and a denied Retry until another access event", async () => {
    await setAccess(false);
    const provider = manager.open(space);
    const read = async (id: string) => {
      expect((await provider.sync(`of:${id}`)).error?.name).toBe(
        "AuthorizationError",
      );
    };
    await Promise.all([read("first"), read("second")]);
    await read("third");
    expect(guestMounts).toBe(1);
    expect(manager.authorizationError(space)?.name).toBe("AuthorizationError");
    await manager.retrySpaceAccess(space);
    expect(guestMounts).toBe(2);
    await read("after-retry");
    await read("another-read");
    expect(guestMounts).toBe(2);
    await setAccess(true);
    await manager.retrySpaceAccess(space);
    expect(guestMounts).toBe(3);
    expect((await provider.sync("of:healed")).error).toBeUndefined();
    expect(manager.spaceSessionError(space)).toBeUndefined();
  });

  it("reopens on a later read after an unmarked admission revocation", async () => {
    await setAccess(true);
    const failure = Object.assign(
      new Error("resume token is no longer valid"),
      {
        name: "SessionRevokedError",
      },
    );
    failNextGuestMount = failure;
    const provider = manager.open(space);
    expect((await provider.sync("of:refused-open")).error?.message).toBe(
      failure.message,
    );
    expect(guestMounts).toBe(1);
    expect(manager.spaceAccessError(space)).toBeUndefined();
    expect(manager.clientUpdateRequired()).toBeUndefined();

    expect((await provider.sync("of:after-refused-open")).error)
      .toBeUndefined();
    expect(guestMounts).toBe(2);
    expect(manager.spaceSessionError(space)).toBeUndefined();
    await manager.retrySpaceAccess(space);
    expect(guestMounts).toBe(2);
  });

  for (const name of ["SessionRevokedError", "AuthorizationError"]) {
    it(`retains an update-required ${name} across reads, Retry, ACL notices, and new spaces`, async () => {
      const failure = Object.assign(new Error("Update this runtime"), {
        name,
        clientUpdateRequired: true,
      });
      failNextGuestMount = failure;
      const notices: unknown[] = [];
      manager.subscribeClientUpdateRequired((status) => notices.push(status));
      const provider = manager.open(space);
      expect((await provider.sync("of:first")).error).toBeDefined();
      expect(manager.spaceAccessError(space)).toBeUndefined();
      expect(manager.clientUpdateRequired()).toEqual({
        message: failure.message,
        unconfirmedWrites: false,
      });
      manager.noteSpaceAclChanged(space);
      await manager.retrySpaceAccess(space).catch((error) =>
        expect(error).toBe(failure)
      );
      expect((await provider.sync("of:second")).error).toBeDefined();
      expect((await manager.open(guest.did()).sync("of:another-space")).error)
        .toBeDefined();
      expect(guestMounts).toBe(1);
      expect(notices).toHaveLength(1);
      const late: unknown[] = [];
      manager.subscribeClientUpdateRequired((status) => late.push(status));
      expect(late).toEqual(notices);
    });
  }

  it("retains write uncertainty after an established session's refusal settles pending writes", async () => {
    await setAccess(true);
    expect((await manager.open(space).sync("of:first")).error).toBeUndefined();
    const write = Promise.withResolvers<void>();
    manager.trackPendingCommit(write.promise);
    const failure = Object.assign(new Error("Update this runtime"), {
      name: "SessionRevokedError",
      clientUpdateRequired: true,
    });
    guestSessions[0].handleConnectionFailure(failure);
    write.reject(failure);
    await manager.pendingCommitsSettled();
    expect(manager.hasPendingCommits()).toBe(false);
    expect(manager.clientUpdateRequired()).toEqual({
      message: failure.message,
      unconfirmedWrites: true,
    });
    await manager.retrySpaceAccess(space);
    expect((await manager.open(space).sync("of:next")).error).toBeDefined();
    expect(guestMounts).toBe(1);
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

  it("repeats a load refused after a revocation ended the session", async () => {
    await setAccess(true);
    const provider = manager.open(space);
    expect((await provider.sync("of:retry-first-read")).error)
      .toBeUndefined();
    const loss = Promise.withResolvers<void>();
    const cancel = manager.subscribeSpaceAccessLoss(() => loss.resolve());
    cleanups.push(() => Promise.resolve(cancel()));
    await setAccess(false);
    await loss.promise;
    expect(guestSessions[0].closeError?.name).toBe("AuthorizationError");

    const refused = await provider.sync(`of:${space}`);
    expect(refused.error?.name).toBe("AuthorizationError");
    expect(provider.replica.getDocument(`of:${space}`)).toBeUndefined();

    await setAccess(true);
    await manager.retrySpaceAccess(space);
    expect(guestMounts).toBe(2);
    expect(provider.replica.getDocument(`of:${space}`)?.value).toEqual({
      [owner.did()]: "OWNER",
      [guest.did()]: "READ",
    });
  });
});
