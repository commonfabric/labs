/**
 * Whether a storage manager's sessions are demand, as a memory server over
 * the network sees them: a manager opened with `demand: false`, as a
 * toolshed's own runtime is, opens sessions the server does not count as a
 * client's, though they carry the principal it excludes for its serving loop;
 * a manager opened without it opens client sessions under that same key.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";

import { isFabricPlainObject } from "@commonfabric/data-model";
import { decodeMemoryBoundary } from "@commonfabric/memory/v2";

import { StorageManager } from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { namesInstancesByDefault } from "../src/builder/instance-name.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const service = await Identity.fromPassphrase("storage-session-demand service");

describe("storage-session-demand", () => {
  let server: StandaloneMemoryServer;
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
    server = StandaloneMemoryServer.start({
      namesInstances: namesInstancesByDefault,
    });
    cleanups.push(() => server.close());
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  /** Opens a session on `space` through a manager signed by `service`. */
  const openSession = async (
    space: `did:${string}:${string}`,
    options: { demand?: boolean },
  ): Promise<void> => {
    const manager = StorageManager.open({
      as: service,
      memoryHost: server.url,
      ...options,
    });
    cleanups.push(() => manager.close());
    const { error } = await manager.open(space).sync("of:probe");
    expect(error).toBeUndefined();
  };

  const clientSessionsOn = (space: string): boolean =>
    server.server.hasLiveSessionsForSpace(space, {
      excludePrincipal: service.did(),
    });

  it("opens sessions the server does not count as a client's when opened with demand off", async () => {
    const space = (await Identity.fromPassphrase("demand off space")).did();

    await openSession(space, { demand: false });

    expect(clientSessionsOn(space)).toBe(false);
  });

  it("opens client sessions under the excluded key when opened without the option", async () => {
    const space = (await Identity.fromPassphrase("demand on space")).did();

    await openSession(space, {});

    expect(clientSessionsOn(space)).toBe(true);
  });

  describe("an emulated manager", () => {
    /**
     * Opens a session on a fresh space through an emulated manager signed by
     * `service`, and returns the `demand` each `session.open` it sent
     * declared.
     */
    const declaredDemand = async (
      options: { demand?: boolean },
    ): Promise<unknown[]> => {
      const shared = newSharedServer();
      cleanups.push(() => shared.close());
      const declared: unknown[] = [];
      const connect = shared.connect.bind(shared);
      shared.connect = (send, syncParts, connectOptions) => {
        const connection = connect(send, syncParts, connectOptions);
        const receive = connection.receive.bind(connection);
        connection.receive = (payload: string) => {
          const message = decodeMemoryBoundary(payload);
          if (
            isFabricPlainObject(message) &&
            message.type === "session.open" &&
            isFabricPlainObject(message.session)
          ) {
            declared.push(message.session.demand);
          }
          return receive(payload);
        };
        return connection;
      };
      const manager = EmulatedStorageManager.connectTo(shared, {
        as: service,
        ...options,
      });
      cleanups.push(() => manager.close());
      const space = (await Identity.fromPassphrase("emulated space")).did();
      const { error } = await manager.open(space).sync("of:probe");
      expect(error).toBeUndefined();
      return declared;
    };

    it("declares its sessions not demand when opened with demand off", async () => {
      expect(await declaredDemand({ demand: false })).toEqual([false]);
    });

    it("declares nothing when opened without the option", async () => {
      expect(await declaredDemand({})).toEqual([undefined]);
    });
  });
});
