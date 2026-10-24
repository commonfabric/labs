/**
 * A storage manager telling its observers that a connection to a memory
 * server came back after it was lost, from the socket that drops to the
 * observer the manager calls. The socket cases drop a real socket by closing
 * it from the client's side, which is the close event a lost network raises,
 * and wait for the factory's report itself, under a stuck-condition net,
 * rather than for a time.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { withStuckNet } from "@commonfabric/test-support/stuck-net";

import {
  createNativeMemorySocket,
  type MemorySocket,
  type MemorySocketFactory,
} from "../src/storage/memory-socket.ts";
import {
  createStorageAddressResolver,
  RemoteSessionFactory,
} from "../src/storage/v2-remote-session.ts";
import { type SessionFactory, StorageManager } from "../src/storage/v2.ts";

const user = await Identity.fromPassphrase("connection-restored user");
const SPACES = [
  "did:key:z6Mk-connection-restored-one",
  "did:key:z6Mk-connection-restored-two",
] as MemorySpace[];

/** A manager over `factory`, whose constructor is otherwise protected. */
class TestStorageManager extends StorageManager {
  constructor(factory: SessionFactory) {
    super({ as: user, memoryHost: new URL("memory://") }, factory);
  }
}

describe("storage-connection-restored", () => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  describe("StorageManager", () => {
    /** A factory whose restored connections the test reports by hand. */
    const scriptedFactory = () => {
      let report = () => {};
      const factory: SessionFactory = {
        create() {
          throw new Error("no session is opened here");
        },
        subscribeReconnected(observer) {
          report = observer;
          return () => {
            report = () => {};
          };
        },
      };
      return { factory, report: () => report() };
    };

    it("calls its observers once for each connection its factory reports restored", () => {
      const { factory, report } = scriptedFactory();
      const manager = new TestStorageManager(factory);
      cleanups.push(() => manager.close());
      let calls = 0;
      manager.subscribeConnectionRestored(() => calls++);

      report();
      report();

      expect(calls).toBe(2);
    });

    it("calls every observer after one that throws, and none that unsubscribed", () => {
      const { factory, report } = scriptedFactory();
      const manager = new TestStorageManager(factory);
      cleanups.push(() => manager.close());
      const heard: string[] = [];
      const errors = stub(console, "error", () => {});
      cleanups.push(() => Promise.resolve(errors.restore()));
      manager.subscribeConnectionRestored(() => {
        throw new Error("observer failure");
      });
      manager.subscribeConnectionRestored(() => heard.push("kept"));
      const cancel = manager.subscribeConnectionRestored(() =>
        heard.push("dropped")
      );
      cancel();

      report();

      expect(heard).toEqual(["kept"]);
      expect(errors.calls.map((call) => call.args[0])).toEqual([
        "connection-restored subscriber threw:",
      ]);
    });
  });

  describe("RemoteSessionFactory", () => {
    let server: StandaloneMemoryServer;

    beforeEach(() => {
      server = StandaloneMemoryServer.start();
      cleanups.push(() => server.close());
    });

    /**
     * A factory onto the server, every socket it has opened, a session opener
     * whose connection the test's cleanup closes, and a wait for the
     * factory's `count`-th report of a restored connection, which also
     * returns every report it has made by then.
     */
    const factoryOver = (shared: boolean) => {
      const sockets: MemorySocket[] = [];
      const createSocket: MemorySocketFactory = (address) => {
        const connected = createNativeMemorySocket(address);
        sockets.push(connected.socket);
        return connected;
      };
      const factory = new RemoteSessionFactory(
        createStorageAddressResolver(server.url),
        user,
        createSocket,
      );
      factory.setSharedConnections(shared);
      cleanups.push(() => factory.close());
      let reports = 0;
      const waiters: { count: number; resolve: () => void }[] = [];
      factory.subscribeReconnected(() => {
        reports++;
        for (const waiter of waiters) {
          if (reports >= waiter.count) waiter.resolve();
        }
      });
      const reported = async (count: number): Promise<number> => {
        const reached = Promise.withResolvers<void>();
        if (reports >= count) reached.resolve();
        else waiters.push({ count, resolve: reached.resolve });
        await withStuckNet(
          reached.promise,
          `report ${count} of a restored connection`,
        );
        return reports;
      };
      const open = async (space: MemorySpace): Promise<void> => {
        const { client } = await factory.create(space);
        cleanups.push(() => client.close());
      };
      return {
        factory,
        sockets,
        open,
        reported,
        get reports() {
          return reports;
        },
      };
    };

    for (const shared of [false, true]) {
      const connection = shared
        ? "a shared connection"
        : "a connection per space";

      it(`reports a restored connection once its dropped socket comes back, over ${connection}`, async () => {
        const harness = factoryOver(shared);
        await harness.open(SPACES[0]);
        const opened = harness.sockets.length;

        harness.sockets[opened - 1].close();

        expect(await harness.reported(1)).toBe(1);
        expect(harness.sockets.length).toBe(opened + 1);
      });
    }

    it("reports each connection that comes back, over a connection per space", async () => {
      const harness = factoryOver(false);
      await Promise.all(SPACES.map((space) => harness.open(space)));
      expect(harness.sockets).toHaveLength(SPACES.length);

      for (const socket of [...harness.sockets]) socket.close();

      expect(await harness.reported(SPACES.length)).toBe(SPACES.length);
    });

    it("reports nothing for the connections it opens", async () => {
      const harness = factoryOver(false);

      await Promise.all(SPACES.map((space) => harness.open(space)));

      expect(harness.reports).toBe(0);
    });
  });
});
