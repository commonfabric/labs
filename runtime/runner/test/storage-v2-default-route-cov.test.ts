import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import { describe, it } from "@commonfabric/test-support/test";
import {
  mountOver,
  newSharedServer,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

describe("StorageManager", () => {
  describe("registerSpaceHost()", () => {
    /**
     * Opens a space on a manager whose memory host is `memoryHost`, reads a
     * document through it, registers `https://default-toolshed.test` for the
     * space, and returns whether the hint was accepted, whether the provider
     * kept its replica, and how many sessions the space opened.
     */
    const hintAfterRead = async (memoryHost: URL) => {
      const signer = await Identity.fromPassphrase("default-route-cov");
      const space = (await Identity.fromPassphrase("default-route-cov-space"))
        .did() as MemorySpace;
      const server = newSharedServer({
        store: new URL(`memory://default-route-cov-${memoryHost.protocol}`),
      });
      let sessions = 0;
      const manager = TestStorageManager.create({ as: signer, memoryHost }, {
        create(createdSpace, createdSigner, mountOptions) {
          sessions++;
          return mountOver(
            MemoryV2Client.loopback(server),
            createdSpace,
            createdSigner,
            mountOptions,
          );
        },
      });
      try {
        const provider = manager.open(space);
        const replica = provider.replica;
        expect(
          (await provider.sync("of:default-route-cov" as URI, {
            path: [],
            schema: true,
          })).error,
        ).toBeUndefined();
        const accepted = manager.registerSpaceHost(
          space,
          "https://default-toolshed.test",
        );
        await manager.crossSpaceSettled();
        return {
          accepted,
          keptReplica: provider.replica === replica,
          sessions,
        };
      } finally {
        await manager.close();
        await server.close();
      }
    };

    it("replaces the provisional replica for any hint where the memory host names no network route", async () => {
      expect(await hintAfterRead(new URL("memory://placeholder"))).toEqual({
        accepted: true,
        keptReplica: false,
        sessions: 2,
      });
    });

    it("keeps the replica for a hint naming the memory host's own route", async () => {
      expect(await hintAfterRead(new URL("https://default-toolshed.test")))
        .toEqual({ accepted: true, keptReplica: true, sessions: 1 });
    });
  });
});
