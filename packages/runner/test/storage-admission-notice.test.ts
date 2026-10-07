/**
 * A storage manager refused a space, readmitted when the memory server says
 * a grant admits its principal (`session/admissible`), with nothing asking it
 * to retry. Each case reads the retry the notice started only after a barrier
 * the notice is ordered before: `Client.delivered()` over loopback, or a
 * later round trip on the same shared socket.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  type Client,
  connect,
  loopback,
  type SpaceSession,
} from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { Runtime } from "../src/runtime.ts";

import {
  createStorageAddressResolver,
  RemoteSessionFactory,
} from "../src/storage/v2-remote-session.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";

const owner = await Identity.fromPassphrase("admission-notice owner");
const guest = await Identity.fromPassphrase("admission-notice guest");
const carol = await Identity.fromPassphrase("admission-notice carol");
const space = owner.did();

/** A manager that records each retry it is asked for, and its outcome. */
class RecordingStorageManager extends StorageManager {
  retries: { space: MemorySpace; done: Promise<void> }[] = [];

  constructor(options: Options, factory: SessionFactory) {
    super(options, factory);
  }

  override retrySpaceAccess(target: MemorySpace): Promise<void> {
    const done = super.retrySpaceAccess(target);
    this.retries.push({ space: target, done });
    return done;
  }
}

/** Writes the space's access list as OWNER, plus `grants`. */
const writeAcl = (
  session: SpaceSession,
  localSeq: number,
  grants: Record<string, "READ" | "WRITE">,
) =>
  session.transact({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations: [{
      op: "set",
      id: `of:${space}`,
      value: { value: { [owner.did()]: "OWNER", ...grants } },
    }],
  });

describe("storage admission notice", () => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  describe("over a connection per session", () => {
    let server: Server;
    let manager: RecordingStorageManager;
    let guestClients: Client[];
    let notify: (space: MemorySpace, principal: string) => void;
    let setAccess: (grants: Record<string, "READ" | "WRITE">) => Promise<void>;
    let serverCount = 0;

    beforeEach(async () => {
      guestClients = [];
      notify = () => {};
      server = new Server({
        store: new URL(`memory://storage-admission-notice-${++serverCount}`),
        sessionOpenAuth: { audience: "did:key:z6Mk-admission-audience" },
        authorizeSessionOpen: (message) =>
          (message.authorization as { principal: string }).principal,
        acl: { mode: "enforce" },
        subscriptionRefreshDelayMs: 0,
      });
      cleanups.push(() => server.close());
      // One client per session, closed when its mount fails, as the
      // remote factory's connection-per-space path does.
      const factory: SessionFactory = {
        async create(target, signer, options) {
          const client = await connect({ transport: loopback(server) });
          client.subscribeAdmissible((admitted, principal) =>
            notify(admitted as MemorySpace, principal)
          );
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
            if (signer?.did() === guest.did()) guestClients.push(client);
            return { client, session };
          } catch (error) {
            await client.close();
            throw error;
          }
        },
        subscribeAdmissible(observer) {
          notify = observer;
          return () => {
            notify = () => {};
          };
        },
      };
      const ownerConnection = await factory.create(space, owner);
      cleanups.push(() => ownerConnection.client.close());
      manager = new RecordingStorageManager({
        as: guest,
        memoryHost: new URL("memory://"),
      }, factory);
      cleanups.push(() => manager.close());
      let seq = 0;
      setAccess = async (grants) => {
        await writeAcl(ownerConnection.session, ++seq, grants);
      };
    });

    it("retries a space whose session was revoked, once a grant restores its principal, and is readmitted", async () => {
      await setAccess({ [guest.did()]: "READ" });
      expect((await manager.open(space).sync(`of:${space}`)).error)
        .toBeUndefined();
      const loss = Promise.withResolvers<void>();
      const cancel = manager.subscribeSpaceAccessLoss(() => loss.resolve());
      cleanups.push(() => Promise.resolve(cancel()));
      await setAccess({});
      await loss.promise;
      expect(manager.spaceAccessError(space)?.name).toBe("AuthorizationError");
      const changes: boolean[] = [];
      manager.subscribeSpaceAccessChange((target: MemorySpace) =>
        changes.push(manager.spaceAccessError(target) !== undefined)
      );

      await setAccess({ [guest.did()]: "WRITE" });
      await guestClients[0].delivered();
      expect(manager.retries.map((retry) => retry.space)).toEqual([space]);
      await manager.retries[0].done;
      expect(manager.spaceAccessError(space)).toBeUndefined();
      expect(changes).toEqual([false]);
      expect(guestClients).toHaveLength(2);
    });

    it("does not retry for a notice naming another principal", async () => {
      notify(space, carol.did());
      expect(manager.retries).toEqual([]);

      // The same notice naming the manager's own principal starts one.
      notify(space, guest.did());
      expect(manager.retries.map((retry) => retry.space)).toEqual([space]);
      await manager.retries[0].done;
    });
  });

  describe("over a shared connection", () => {
    let ownerSession: SpaceSession;
    let factory: RemoteSessionFactory;
    let memoryHost: URL;

    beforeEach(async () => {
      const server = StandaloneMemoryServer.start({
        acl: { mode: "enforce" },
        connectionAuth: true,
      });
      cleanups.push(() => server.close());
      memoryHost = server.url;
      const ownerFactory = new RemoteSessionFactory(
        createStorageAddressResolver(server.url),
        owner,
      );
      cleanups.push(() => ownerFactory.close());
      ownerSession = (await ownerFactory.create(space)).session;
      await writeAcl(ownerSession, 1, {});
      factory = new RemoteSessionFactory(
        createStorageAddressResolver(server.url),
        guest,
      );
      factory.setSharedConnections(true);
    });

    /**
     * Opens a guest manager on the factory, has the space refuse it and then
     * grant it `READ`, and returns the manager once a later round trip on the
     * same socket has arrived, which the notice is ordered before.
     */
    const refuseThenGrant = async (): Promise<RecordingStorageManager> => {
      const manager = new RecordingStorageManager({
        as: guest,
        memoryHost,
      }, factory);
      cleanups.push(() => manager.close());
      const refused = await manager.open(space).sync(`of:${space}`);
      expect(refused.error?.name).toBe("AuthorizationError");

      await writeAcl(ownerSession, 2, { [guest.did()]: "READ" });
      const home = await manager.open(guest.did()).sync(`of:${guest.did()}`);
      expect(home.error).toBeUndefined();
      return manager;
    };

    it("retries an initially denied absent linked target after automatic admission", async () => {
      const manager = new RecordingStorageManager({
        as: guest,
        memoryHost,
      }, factory);
      cleanups.push(() => manager.close());
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { sharedMemoryConnection: true },
      });
      cleanups.push(() => runtime.dispose());
      const states: { status: string; epoch: number }[] = [];
      const cancel = manager.subscribeConnectionState(space, (state) => {
        states.push({ status: state.status, epoch: state.epoch });
      });
      cleanups.push(() => Promise.resolve(cancel()));
      const target = runtime.getCell<unknown>(
        space,
        "initially denied absent linked target",
      );
      const link = target.getAsNormalizedFullLink();

      expect(runtime.ensureLinkedDocLoaded(link, guest.did())).toBe("pending");
      await manager.synced();
      expect(runtime.ensureLinkedDocLoaded(link, guest.did())).toBe("error");
      expect(runtime.linkedDocLoadError(link)?.name).toBe(
        "ReplicaLoadFailureError",
      );
      expect(manager.spaceAccessError(space)?.name).toBe("AuthorizationError");
      expect(states).toEqual([{ status: "idle", epoch: 0 }]);

      await writeAcl(ownerSession, 2, { [guest.did()]: "READ" });
      // This round trip follows the admission notice on the shared socket.
      const home = await manager.open(guest.did()).sync(`of:${guest.did()}`);
      expect(home.error).toBeUndefined();
      expect(manager.retries.map((retry) => retry.space)).toEqual([space]);
      await manager.retries[0].done;

      expect(manager.spaceAccessError(space)).toBeUndefined();
      expect(states).toEqual([
        { status: "idle", epoch: 0 },
        { status: "ready", epoch: 1 },
      ]);
      expect(runtime.linkedDocLoadError(link)).toBeUndefined();
      expect(runtime.ensureLinkedDocLoaded(link, guest.did())).toBe("pending");
      await manager.synced();
      expect(runtime.ensureLinkedDocLoaded(link, guest.did())).toBe("settled");
      expect(runtime.linkedDocLoadError(link)).toBeUndefined();
      const confirmed = await manager.open(space).sync(link.id);
      expect(confirmed.error).toBeUndefined();
      expect(confirmed.ok).toBeDefined();
      expect(target.getRaw()).toBeUndefined();
    });

    it("retries a space it was refused, once a grant admits its principal, and is readmitted", async () => {
      const manager = await refuseThenGrant();
      expect(manager.retries.map((retry) => retry.space)).toEqual([space]);
      await manager.retries[0].done;
      expect(manager.spaceAccessError(space)).toBeUndefined();
      expect((await manager.open(space).sync(`of:${space}`)).error)
        .toBeUndefined();
    });

    it("retries when an observer subscribed before the manager throws", async () => {
      factory.subscribeAdmissible(() => {
        throw new Error("observer failure");
      });
      const manager = await refuseThenGrant();
      expect(manager.retries.map((retry) => retry.space)).toEqual([space]);
      await manager.retries[0].done;
      expect(manager.spaceAccessError(space)).toBeUndefined();
    });
  });
});
