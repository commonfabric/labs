/**
 * A request the storage layer makes of a space while the space's memory host
 * is down waits for the host: the session a replica asks through makes again
 * what its connection never sent (`ResendingSession`), so no caller of the
 * replica sees the outage as a failure.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import * as Client from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";

import { hostTransport } from "../../memory/test/support/host-transport.ts";
import type { SessionFactory } from "../src/storage/v2.ts";
import {
  TEST_MEMORY_SERVER_AUTH,
  testSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("storage-host-down");

/**
 * A storage manager whose space sessions each connect to `server` through a
 * transport whose host can go down, and the transports dialed so far.
 */
function managerOn(server: Server) {
  const hosts: ReturnType<typeof hostTransport>[] = [];
  const factory: SessionFactory = {
    async create(space, _signer, sessionOptions) {
      const host = hostTransport(server);
      hosts.push(host);
      const client = await Client.connect({ transport: host.transport });
      const session = await client.mount(
        space,
        sessionOptions,
        testSessionOpenAuthFactory,
      );
      return { client, session };
    },
  };
  const manager = TestStorageManager.create(
    { as: signer, memoryHost: new URL("memory://") },
    factory,
  );
  return { manager, hosts };
}

describe("storage-host-down", () => {
  it("answers a read of the server's head made while the host is down, once the host is back", async () => {
    const server = new Server(TEST_MEMORY_SERVER_AUTH);
    const { manager, hosts } = managerOn(server);
    try {
      const provider = manager.open(signer.did());
      const before = await provider.serverHeadSeq!();
      const host = hosts.at(-1)!;
      const asked = host.sentOfType("graph.query");
      host.hostDown();
      const reading = provider.serverHeadSeq!();
      host.hostUp();

      expect(await reading).toBe(before);
      expect(host.sentOfType("graph.query")).toBe(asked + 1);
    } finally {
      await manager.closeNow();
      await server.close();
    }
  });
});
