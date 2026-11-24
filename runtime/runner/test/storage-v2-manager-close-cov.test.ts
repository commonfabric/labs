import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Options, SessionFactory } from "../src/storage/v2.ts";
import {
  mountOver,
  newSharedServer,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("storage-v2-manager-close");
const space: MemorySpace = (await Identity.fromPassphrase(
  "storage-v2-manager-close space",
)).did();
const doc = "of:storage-v2-manager-close-doc" as URI;
const selector = { path: [], schema: true } as const;

/**
 * A loopback session factory that counts and keeps the sessions it opens,
 * and refuses as many opens as `refusals` says, as a memory server refusing
 * the principal would.
 */
class CountingSessionFactory implements SessionFactory {
  /** How many opens were asked for, refused ones included. */
  creates = 0;

  /** How many more opens are refused. */
  refusals = 0;

  /** Each session opened, in order. */
  readonly sessions: MemoryV2Client.SpaceSession[] = [];

  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  /** @inheritDoc */
  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryV2Client.MountOptions = {},
  ) {
    this.creates++;
    if (this.refusals > 0) {
      this.refusals--;
      throw Object.assign(new Error("the space refuses this principal"), {
        name: "AuthorizationError",
      });
    }
    const opened = await mountOver(
      MemoryV2Client.loopback(this.#server),
      space,
      signer,
      mountOptions,
    );
    this.sessions.push(opened.session);
    return opened;
  }
}

describe("StorageManager", () => {
  let server: MemoryV2Server.Server;
  let factory: CountingSessionFactory;
  let managers: TestStorageManager[];

  /** A manager over `factory`, closed after the case. */
  const managerWith = (options: Partial<Options> = {}) => {
    const manager = TestStorageManager.create({
      as: signer,
      memoryHost: new URL("https://default-toolshed.test"),
      ...options,
    }, factory);
    managers.push(manager);
    return manager;
  };

  beforeEach(() => {
    server = newSharedServer({
      store: new URL(
        `memory://storage-v2-manager-close-${crypto.randomUUID()}`,
      ),
    });
    factory = new CountingSessionFactory(server);
    managers = [];
  });

  afterEach(async () => {
    for (const manager of managers) await manager.close();
    await server.close();
  });

  describe("instance members", () => {
    describe("subscribeHoldsCollected()", () => {
      it("tells every observer of a collected hold, and logs the error of one that throws", async () => {
        const collections = new Map<object, () => void>();
        const manager = managerWith({
          createHoldRegistry: <T>(cleanup: (held: T) => void) => ({
            register: (token: object, held: T) => {
              collections.set(token, () => cleanup(held));
            },
          }),
        });
        manager.open(space);
        const token = manager.holdDocument({ space, id: doc });
        await manager.releaseUnreadDocuments({ followUpOnCollection: true });
        const failure = new Error("observer down");
        const told: string[] = [];
        manager.subscribeHoldsCollected(() => told.push("first"));
        manager.subscribeHoldsCollected(() => {
          throw failure;
        });
        manager.subscribeHoldsCollected(() => told.push("third"));
        using errors = stub(console, "error");

        collections.get(token)!();
        expect(told).toEqual(["first", "third"]);
        expect(errors.calls.map((call) => call.args)).toEqual([
          ["holds-collected subscriber threw:", failure],
        ]);
      });
    });

    describe("registerSpaceHost()", () => {
      it("replaces the provisional replica of an open space, and replays its reads on the hinted host", async () => {
        const manager = managerWith();
        const provider = manager.open(space);
        const provisional = provider.replica;
        expect((await provider.sync(doc, selector)).error).toBeUndefined();
        expect(factory.creates).toBe(1);

        expect(manager.registerSpaceHost(space, "https://hinted.test")).toBe(
          true,
        );
        await manager.crossSpaceSettled();
        expect(provider.replica).not.toBe(provisional);
        expect(factory.creates).toBe(2);
      });

      it("leaves the replica of a space whose manager is closing as it is", async () => {
        const manager = managerWith();
        const provider = manager.open(space);
        const provisional = provider.replica;
        expect((await provider.sync(doc, selector)).error).toBeUndefined();

        const closing = manager.close();
        expect(manager.registerSpaceHost(space, "https://hinted.test")).toBe(
          true,
        );
        await closing;
        expect(provider.replica).toBe(provisional);
        expect(factory.creates).toBe(1);
      });
    });

    describe("retrySpaceAccess()", () => {
      it("opens a session again on a space that refused the principal", async () => {
        factory.refusals = 1;
        const manager = managerWith();
        const provider = manager.open(space);
        expect((await provider.sync(doc, selector)).error?.name).toBe(
          "AuthorizationError",
        );
        expect(manager.spaceAccessError(space)).toBeDefined();

        await manager.retrySpaceAccess(space);
        expect(factory.creates).toBe(2);
        expect(manager.spaceAccessError(space)).toBeUndefined();
      });

      it("resolves without opening a session when the manager closes before the retry decides", async () => {
        factory.refusals = 1;
        const manager = managerWith();
        const provider = manager.open(space);
        expect((await provider.sync(doc, selector)).error?.name).toBe(
          "AuthorizationError",
        );

        const retry = manager.retrySpaceAccess(space);
        const closing = manager.close();
        await expect(retry).resolves.toBeUndefined();
        await closing;
        expect(factory.creates).toBe(1);
      });
    });

    describe("subscribeSpaceSessionError()", () => {
      // A space marked for instance names ends the session of a runtime
      // that does not use them, which requires a client update. The manager
      // reports the update first, and the space's session error after it.

      /**
       * A manager holding a session on `space`, the session errors it
       * reports, and the session.
       */
      const sessionOpen = async () => {
        const manager = managerWith();
        expect((await manager.open(space).sync(doc, selector)).error)
          .toBeUndefined();
        const reported: Error[] = [];
        manager.subscribeSpaceSessionError((_space, error) => {
          reported.push(error);
        });
        return { manager, reported, session: factory.sessions[0] };
      };

      it("reports a session the server ends", async () => {
        const { reported, session } = await sessionOpen();
        session.handleRevoked("instance-names");
        expect(reported.map((error) => error.message)).toEqual([
          `Space ${space} now holds data written with instance names, ` +
          "which this runtime does not use",
        ]);
      });

      it("reports nothing of a session ending as the manager closes", async () => {
        const { manager, reported, session } = await sessionOpen();
        let closing: Promise<void> | undefined;
        manager.subscribeClientUpdateRequired(() => {
          closing = manager.close();
        });
        session.handleRevoked("instance-names");
        expect(closing).toBeDefined();
        await closing;
        expect(reported).toEqual([]);
      });
    });
  });
});
