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

import { StorageManager } from "../src/storage/v2.ts";
import { namesInstancesByDefault } from "../src/builder/instance-name.ts";

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
});
