import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { LoopbackStorageManager } from "../../src/executor/loopback-storage.ts";
import { inServingContext } from "../../src/executor/serving-context.ts";
import { newLoopbackServer } from "../../src/storage/v2-emulate.ts";

const service = await Identity.fromPassphrase("loopback storage service");

describe("LoopbackStorageManager", () => {
  describe("static members", () => {
    describe("connect()", () => {
      it("takes each server frame in the serving context, whatever sent the request", async () => {
        // The read is sent from outside the serving context, which is also
        // the context the turn delivering its reply carries.
        const server = newLoopbackServer();
        const seen: boolean[] = [];
        const manager = LoopbackStorageManager.connect(
          server,
          { as: service },
          () => seen.push(inServingContext()),
        );
        try {
          const result = await manager.open(service.did() as MemorySpace)
            .sync("of:loopback-storage-probe", { path: [], schema: false });
          expect(result.error).toBeUndefined();
        } finally {
          await manager.close();
          await server.close();
        }
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((serving) => serving)).toBe(true);
      });
    });
  });
});
