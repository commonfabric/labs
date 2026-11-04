import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";

import type { SessionFactory } from "../src/storage/v2.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

describe("storage-close-connection-state", () => {
  for (const closeKind of ["close", "closeNow"] as const) {
    it(`publishes readiness after a rejected ${closeKind} and a fresh session`, async () => {
      const signer = await Identity.fromPassphrase(`rejected-${closeKind}`);
      const server = newSharedServer();
      const clients: MemoryClient.Client[] = [];
      const failure = new Error("Factory close failed");
      let firstClose = true;
      const factory: SessionFactory = {
        async create(space, as) {
          const client = await MemoryClient.connect({
            transport: MemoryClient.loopback(server),
          });
          clients.push(client);
          const session = await client.mount(
            space,
            {},
            testPrincipalSessionOpenAuthFactory(as),
          );
          return { client, session };
        },
        async close() {
          if (firstClose) {
            firstClose = false;
            throw failure;
          }
          await Promise.all(clients.map((client) => client.close()));
        },
      };
      const storage = TestStorageManager.create({
        as: signer,
        memoryHost: new URL("memory://rejected-factory-close"),
      }, factory);
      const states: string[] = [];
      let cancel: (() => void) | undefined;
      try {
        await expect(storage[closeKind]()).rejects.toBe(failure);
        cancel = storage.subscribeConnectionState(signer.did(), (state) => {
          states.push(`${state.status}:${state.epoch}`);
        });
        const synced = await storage.open(signer.did()).sync(
          "of:fresh-session-after-rejected-close" as URI,
        );
        expect(synced.error).toBeUndefined();
        expect(states).toEqual(["idle:0", "ready:1"]);
      } finally {
        cancel?.();
        await storage.close();
        await server.close();
      }
    });
  }
});
