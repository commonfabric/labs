import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("emulated storage ownership");

// Server lifecycle ownership: a `connectTo` manager borrows an externally
// owned shared server, while an `emulate()` manager owns the one it builds.
// The close paths must honor that split — a borrowed server outliving its
// managers is what lets several managers model several sessions on one
// server, and an owned server leaking past its manager is a resource leak.

const countCloses = (server: MemoryV2Server.Server): () => number => {
  let closes = 0;
  const original = server.close.bind(server);
  server.close = () => {
    closes++;
    return original();
  };
  return () => closes;
};

describe("emulated storage server ownership", () => {
  it("leaves a shared server open when a connectTo manager closes", async () => {
    const server = newSharedServer();
    const closes = countCloses(server);
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    // Force the lazy server memo so close() has an instance to consider.
    (manager as unknown as { server(): MemoryV2Server.Server }).server();

    await manager.close();
    expect(closes()).toBe(0);

    await server.close();
    expect(closes()).toBe(1);
  });

  it("closes an owned server when an emulate() manager closes", async () => {
    const manager = EmulatedStorageManager.emulate({ as: signer });
    const server = (manager as unknown as { server(): MemoryV2Server.Server })
      .server();
    const closes = countCloses(server);

    await manager.close();
    expect(closes()).toBe(1);
  });
});
