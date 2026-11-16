import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity, issueDelegation } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { namesInstancesByDefault } from "../../src/builder/instance-name.ts";
import { STORAGE_DIAGNOSTICS_LIMIT } from "../../src/storage/diagnostics.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../../src/storage/v2.ts";
import { captureLogs } from "../support/log-capture.ts";

const AUDIENCE = "did:key:z6Mk-runner-v2-storage-manager-audience";

class TestStorageManager extends StorageManager {
  constructor(options: Omit<Options, "memoryHost">, factory: SessionFactory) {
    super({ ...options, memoryHost: new URL("memory://") }, factory);
  }
}

const alice = await Identity.fromPassphrase("v2-storage-manager alice");

/** An `AuthorizationError` the server did not mark retriable. */
const denial = (): Error =>
  Object.assign(new Error("not on the access list"), {
    name: "AuthorizationError",
  });

describe("StorageManager", () => {
  let server: MemoryV2Server.Server;
  let cleanups: (() => Promise<void>)[];

  /** Mounts `space` on `server` as `signer`, over the loopback transport. */
  const mount = async (
    space: MemorySpace,
    signer?: Signer,
    options: MemoryV2Client.MountOptions = {},
  ) => {
    const client = await MemoryV2Client.connect({
      instanceNames: namesInstancesByDefault(),
      transport: MemoryV2Client.loopback(server),
    });
    const session = await client.mount(
      space,
      options,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    return { client, session };
  };

  /** A manager acting as alice over `factory`, closed after the case. */
  const managerOver = (factory: SessionFactory): TestStorageManager => {
    const manager = new TestStorageManager({ as: alice }, factory);
    cleanups.push(() => manager.close());
    return manager;
  };

  /** A failure that tells the client to update before it opens again. */
  const updateRequired = (): Error =>
    Object.assign(new Error("Update this runtime"), {
      name: "SessionRevokedError",
      clientUpdateRequired: true,
    });

  beforeEach(() => {
    cleanups = [];
    server = new MemoryV2Server.Server({
      namesInstances: namesInstancesByDefault,
      store: new URL(`memory://v2-storage-manager-${crypto.randomUUID()}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: AUDIENCE },
      subscriptionRefreshDelayMs: 0,
    });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  describe("instance members", () => {
    describe("addDelegationChain()", () => {
      it("throws when the manager's sessions present no proof chain", async () => {
        const manager = managerOver({ create: mount });
        const delegation = await issueDelegation(alice, {
          aud: alice.did(),
          sub: alice.did(),
          cmd: "/",
          pol: [],
        });
        await expect(manager.addDelegationChain([delegation.bytes])).rejects
          .toThrow("This storage manager's sessions present no proof chain");
      });

      it("hands a chain over no space to the sessions and restores no space", async () => {
        const added: (readonly Uint8Array[])[] = [];
        let mounts = 0;
        const manager = managerOver({
          create: (space, signer, options) => {
            mounts++;
            return mount(space, signer, options);
          },
          addDelegationChain: (chain) => {
            added.push(chain);
            return Promise.resolve();
          },
        });
        const delegation = await issueDelegation(alice, {
          aud: alice.did(),
          sub: null,
          cmd: "/",
          pol: [],
        });
        expect((await manager.open(alice.did()).sync("of:first")).error)
          .toBeUndefined();
        await manager.addDelegationChain([delegation.bytes]);
        expect(added).toEqual([[delegation.bytes]]);
        expect(mounts).toBe(1);
      });
    });

    describe("redeemInvite()", () => {
      it("refuses with `invite-service-unsupported` when the sessions cannot carry an invitation", async () => {
        const manager = managerOver({ create: mount });
        await expect(
          manager.redeemInvite(alice.did(), {
            inviteId: "invite",
            code: "code",
          }),
        ).rejects.toMatchObject({
          name: "SpaceInviteRefusal",
          code: "invite-service-unsupported",
        });
      });
    });

    describe("setSharedMemoryConnection()", () => {
      it("throws when a session is open and the choice changes", () => {
        const shared: boolean[] = [];
        const manager = managerOver({
          create: mount,
          setSharedConnections: (enabled) => shared.push(enabled),
        });
        manager.setSharedMemoryConnection(true);
        manager.open(alice.did());
        expect(() => manager.setSharedMemoryConnection(false)).toThrow(
          "setSharedMemoryConnection: a session is already open",
        );
        // The choice standing is restated without complaint.
        manager.setSharedMemoryConnection(true);
        expect(shared).toEqual([true, true]);
      });
    });

    describe("runPatternLifecycle()", () => {
      it("throws when the space's replica runs no pattern-lifecycle verbs", async () => {
        const storage = { open: () => ({ replica: {} }) };
        await expect(
          StorageManager.prototype.runPatternLifecycle.call(
            storage,
            alice.did(),
            "instantiate",
            {},
          ),
        ).rejects.toThrow(
          "storage replica does not run pattern-lifecycle verbs",
        );
      });
    });

    describe("administerInvites()", () => {
      it("throws when the space's replica administers no invitations", async () => {
        const storage = { open: () => ({ replica: {} }) };
        await expect(
          StorageManager.prototype.administerInvites.call(
            storage,
            alice.did(),
            { operation: "list", body: {} },
          ),
        ).rejects.toThrow("storage replica does not administer invitations");
      });
    });

    describe("pullOpenSpacesToHead()", () => {
      it("rejects when a space's session fails to open for a reason other than a denial", async () => {
        const manager = managerOver({
          create: () => Promise.reject(new Error("the host is down")),
        });
        manager.open(alice.did());
        await expect(manager.pullOpenSpacesToHead()).rejects.toThrow(
          "the host is down",
        );
      });

      it("resolves when a space refuses the session", async () => {
        const manager = managerOver({ create: () => Promise.reject(denial()) });
        manager.open(alice.did());
        await manager.pullOpenSpacesToHead();
        expect(manager.spaceAccessError(alice.did())?.name).toBe(
          "AuthorizationError",
        );
      });
    });

    describe("subscribeClientUpdateRequired()", () => {
      it("reports a status to every subscriber when one of them throws", async () => {
        using reported = stub(console, "error", () => {});
        const manager = managerOver({
          create: () => Promise.reject(updateRequired()),
        });
        const notices: unknown[] = [];
        manager.subscribeClientUpdateRequired(() => {
          throw new Error("subscriber failed");
        });
        manager.subscribeClientUpdateRequired((status) => notices.push(status));
        expect((await manager.open(alice.did()).sync("of:first")).error)
          .toBeDefined();
        expect(notices).toEqual([{
          message: "Update this runtime",
          unconfirmedWrites: false,
        }]);
        expect(reported.calls.map((call) => call.args[0])).toEqual([
          "client-update-required subscriber threw:",
        ]);

        // A subscriber arriving after the status hears it at once, and its
        // throw is reported the same way.
        manager.subscribeClientUpdateRequired(() => {
          throw new Error("late subscriber failed");
        });
        expect(reported.calls.length).toBe(2);
        expect(reported.calls[1].args[0]).toBe(
          "client-update-required subscriber threw:",
        );
        expect(reported.calls[1].args[1]).toMatchObject({
          message: "late subscriber failed",
        });
      });
    });

    describe("subscribeSpaceAnswer()", () => {
      it("tells every subscriber of the answer when one of them throws", async () => {
        using reported = stub(console, "error", () => {});
        const manager = managerOver({ create: mount });
        const answered: MemorySpace[] = [];
        manager.subscribeSpaceAnswer(() => {
          throw new Error("subscriber failed");
        });
        manager.subscribeSpaceAnswer((space) => answered.push(space));
        expect(manager.spaceAnswered(alice.did())).toBe(false);
        await manager.awaitSpaceAnswer(alice.did());
        expect(answered).toEqual([alice.did()]);
        expect(reported.calls.map((call) => call.args[0])).toEqual([
          "space-answer subscriber threw:",
        ]);
      });
    });

    describe("subscribeSpaceSessionReplaced()", () => {
      it("tells every subscriber of a replaced session when one of them throws", async () => {
        using reported = stub(console, "error", () => {});
        const sessions: MemoryV2Client.SpaceSession[] = [];
        const manager = managerOver({
          create: async (space, signer, options) => {
            const opened = await mount(space, signer, options);
            sessions.push(opened.session);
            return opened;
          },
        });
        const replaced: MemorySpace[] = [];
        manager.subscribeSpaceSessionReplaced(() => {
          throw new Error("subscriber failed");
        });
        manager.subscribeSpaceSessionReplaced((space) => replaced.push(space));
        expect((await manager.open(alice.did()).sync("of:first")).error)
          .toBeUndefined();
        // The client reports that the server no longer knew the session.
        sessions[0].onSessionReplaced!();
        expect(replaced).toEqual([alice.did()]);
        expect(reported.calls.map((call) => call.args[0])).toEqual([
          "space-session-replaced subscriber threw:",
        ]);
      });
    });

    describe("subscribeDocumentsDropped()", () => {
      it("tells every subscriber of the documents a release dropped when one of them throws", async () => {
        using reported = stub(console, "error", () => {});
        const manager = managerOver({ create: mount });
        const dropped: string[] = [];
        manager.subscribeDocumentsDropped(() => {
          throw new Error("subscriber failed");
        });
        manager.subscribeDocumentsDropped((_space, addresses) => {
          for (const address of addresses) dropped.push(address.id);
        });
        expect((await manager.open(alice.did()).sync("of:unread")).error)
          .toBeUndefined();
        // The first pass keeps what was loaded since it began.
        await manager.releaseUnreadDocuments();
        await manager.releaseUnreadDocuments();
        expect(dropped).toEqual(["of:unread"]);
        expect(manager.droppedDocuments()).toBe(1);
        expect(reported.calls.map((call) => call.args[0])).toEqual([
          "documents-dropped subscriber threw:",
        ]);
      });
    });

    describe("syncInstance()", () => {
      it("loads nothing for a document an inline id holds", async () => {
        let mounts = 0;
        const manager = managerOver({
          create: (space, signer, options) => {
            mounts++;
            return mount(space, signer, options);
          },
        });
        await manager.syncInstance(
          { space: alice.did(), id: "data:application/json,{}", scope: "user" },
          { principal: alice.did() },
        );
        expect(manager.getSizes().spaces).toBe(0);
        expect(mounts).toBe(0);
      });

      it("rejects with the error a load throws", async () => {
        const manager = managerOver({ create: mount });
        manager.installStoreReadThrough(alice.did(), () => {
          throw new Error("the store is unreadable");
        });
        await expect(
          manager.syncInstance(
            { space: alice.did(), id: "of:unreadable", scope: "space" },
            { principal: alice.did() },
          ),
        ).rejects.toThrow("the store is unreadable");
        expect(manager.getSizes().pendingLoads).toBe(0);
      });
    });

    describe("spaceOpenObserver", () => {
      it("reports an observer that throws and still opens the space", async () => {
        using reported = stub(console, "warn", () => {});
        const manager = managerOver({ create: mount });
        const opened = Promise.withResolvers<MemorySpace>();
        manager.spaceOpenObserver = (space) => {
          opened.resolve(space);
          throw new Error("observer failed");
        };
        const provider = manager.open(alice.did());
        expect(await opened.promise).toBe(alice.did());
        await Promise.resolve();
        expect(reported.calls.map((call) => call.args[0])).toEqual([
          "spaceOpenObserver threw",
        ]);
        expect((await provider.sync("of:after-observer")).error)
          .toBeUndefined();
      });
    });

    describe("createSpace()", () => {
      it("logs a failed release of the space's key and still returns the space", async () => {
        using logs = captureLogs("storage.v2");
        const released: string[] = [];
        const manager = managerOver({
          create: async (space, signer, options) => {
            const opened = await mount(space, signer, options);
            return {
              session: opened.session,
              client: Object.assign(opened.client, {
                releasePrincipal: (principal: string) => {
                  released.push(principal);
                  return Promise.reject(new Error("release refused"));
                },
              }),
            };
          },
        });
        const space = await manager.createSpace({ [alice.did()]: "OWNER" });
        expect(released).toEqual([space]);
        expect(logs.lines("create-space-release")).toEqual([
          expect.stringContaining(
            `space ${space}: releasing its key failed: Error: release refused`,
          ),
        ]);
      });
    });

    describe("getSizes()", () => {
      it("adds the spaces past the diagnostics limit together", async () => {
        const manager = managerOver({
          create: () => Promise.reject(new Error("no session is opened")),
        });
        const spaces = await Promise.all(
          Array.from(
            { length: STORAGE_DIAGNOSTICS_LIMIT + 2 },
            async (_, index) =>
              (await Identity.fromPassphrase(`v2-storage-manager ${index}`))
                .did(),
          ),
        );
        // Each space holds the one document a read served from its store.
        for (const space of spaces) {
          manager.installStoreReadThrough(space, ({ id, scopeKey }) => ({
            branch: "",
            id,
            scope: "space",
            scopeKey,
            seq: 1,
            doc: { value: { space } },
          }));
          expect(manager.open(space).replica.getDocument("of:sized")?.value)
            .toEqual({ space });
        }
        const sizes = manager.getSizes();
        expect(sizes.spaces).toBe(STORAGE_DIAGNOSTICS_LIMIT + 2);
        expect(sizes.documents).toBe(STORAGE_DIAGNOSTICS_LIMIT + 2);
        expect(sizes.bySpace.length).toBe(STORAGE_DIAGNOSTICS_LIMIT);
        expect(sizes.bySpaceOmitted.spaces).toBe(2);
        expect(sizes.bySpaceOmitted.documents).toBe(2);
        expect(
          sizes.bySpace.reduce((sum, entry) => sum + entry.documents, 0) +
            sizes.bySpaceOmitted.documents,
        ).toBe(sizes.documents);
        expect(sizes.bySpaceOmitted.approxBytes).toBeGreaterThan(0);
        expect(
          sizes.bySpace.reduce((sum, entry) => sum + entry.approxBytes, 0) +
            sizes.bySpaceOmitted.approxBytes,
        ).toBe(sizes.approxBytes);
      });
    });
  });

  describe("opening a fresh home space", () => {
    // Opening the space whose key the manager's signer is writes its genesis
    // access list through a bootstrap session of its own, between the
    // manager's session and its resumption.

    const managerId: ReturnType<typeof crypto.randomUUID> =
      "v2-storage-manager-home-session";

    /**
     * A manager acting as alice, recording the session ids it opens with,
     * whose bootstrap session's commit fails with `failure` when one is
     * given.
     */
    const homeManager = (
      sessionIds: (string | undefined)[],
      failure?: Error,
    ) => {
      const manager = new TestStorageManager({ as: alice, id: managerId }, {
        supportsAclBootstrap: true,
        create: async (space, signer, options) => {
          sessionIds.push(options?.sessionId);
          const opened = await mount(space, signer, options);
          if (failure !== undefined && options?.sessionId !== managerId) {
            opened.session.transact = () => Promise.reject(failure);
          }
          return opened;
        },
      });
      cleanups.push(() => manager.close());
      return manager;
    };

    it("fails when the genesis commit fails other than by a conflict", async () => {
      const sessionIds: (string | undefined)[] = [];
      const manager = homeManager(sessionIds, new Error("genesis refused"));
      const result = await manager.open(alice.did()).sync("of:home");
      expect(result.error?.message).toContain("genesis refused");
      expect(sessionIds.length).toBe(2);
    });

    it("resumes the manager's session when another runtime's genesis won", async () => {
      const sessionIds: (string | undefined)[] = [];
      const manager = homeManager(
        sessionIds,
        Object.assign(new Error("genesis already written"), {
          name: "ConflictError",
        }),
      );
      expect((await manager.open(alice.did()).sync("of:home")).error)
        .toBeUndefined();
      expect(sessionIds).toEqual([managerId, expect.any(String), managerId]);
    });

    it("gives the bootstrap session an id other than the manager's", async () => {
      const sessionIds: (string | undefined)[] = [];
      const randomUUID = crypto.randomUUID.bind(crypto);
      let uuids: ReturnType<typeof randomUUID>[] = [];
      using _uuid = stub(
        crypto,
        "randomUUID",
        () => uuids.shift() ?? randomUUID(),
      );
      const manager = homeManager(sessionIds);
      // The first id drawn for the bootstrap session is the manager's own.
      uuids = [managerId];
      expect((await manager.open(alice.did()).sync("of:home")).error)
        .toBeUndefined();
      expect(uuids).toEqual([]);
      expect(sessionIds.length).toBe(3);
      expect(sessionIds[1]).not.toBe(managerId);
    });
  });

  describe("an admission notice", () => {
    it("logs a retry it starts that fails", async () => {
      using logs = captureLogs("storage.v2");
      let notify: ((space: MemorySpace, principal: string) => void) | undefined;
      const failures = [denial(), new Error("the host is down")];
      const manager = managerOver({
        create: () => Promise.reject(failures.shift()),
        subscribeAdmissible: (observer) => {
          notify = observer;
          return () => {};
        },
      });
      expect((await manager.open(alice.did()).sync("of:refused")).error)
        .toBeDefined();
      expect(manager.spaceAccessError(alice.did())).toBeDefined();

      // A notice naming another principal starts nothing.
      notify!(alice.did(), "did:key:z6Mk-someone-else");
      expect(failures.length).toBe(1);

      notify!(alice.did(), alice.did());
      await manager.retrySpaceAccess(alice.did()).catch(() => {});
      expect(failures.length).toBe(0);
      expect(logs.lines("admission-notice-retry")).toEqual([
        expect.stringContaining(
          `space ${alice.did()}: the retry a \`session/admissible\` started ` +
            "failed: Error: the host is down",
        ),
      ]);
    });
  });
});
