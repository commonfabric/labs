import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("cold-conflict-read-repair");
const space = signer.did();
const id = "of:cold-conflict-read-repair" as URI;
const scopes = ["space", "user"] as const;

describe("cold-conflict-read-repair", () => {
  for (const scope of scopes) {
    for (const watched of [false, true]) {
      it(`repairs an unwatched ${scope} read with ${watched ? "an unrelated watch" : "no watches"}`, async () => {
        const server = newSharedServer();
        const options = { as: signer };
        const seedStorage = EmulatedStorageManager.connectTo(server, options);
        try {
          const seed = seedStorage.edit();
          for (const [index, seedScope] of scopes.entries()) {
            expect(
              seed.write({
                space,
                id,
                type: "application/json",
                scope: seedScope,
                path: [],
              }, { value: { count: index + 11 } }).error,
            ).toBeUndefined();
          }
          expect((await seed.commit()).error).toBeUndefined();
        } finally {
          await seedStorage.close();
        }
        const storage = EmulatedStorageManager.connectTo(server, options);
        try {
          if (watched) {
            expect(
              (await storage.open(space).sync("of:unrelated" as URI)).error,
            )
              .toBeUndefined();
          }
          const address = {
            space,
            id,
            type: "application/json" as const,
            scope,
            path: ["value", "count"],
          };
          const cold = storage.edit();
          expect(cold.read(address).ok?.value).toBeUndefined();
          expect(cold.write(address, 1000).error).toBeUndefined();
          expect((await cold.commit()).error?.name).toBe("ConflictError");

          const retry = storage.edit();
          const current = retry.read(address).ok?.value;
          expect(current).toBe(scopes.indexOf(scope) + 11);
          if (typeof current !== "number") {
            throw new Error("missing repaired count");
          }
          expect(retry.write(address, current + 1).error).toBeUndefined();
          expect((await retry.commit()).error).toBeUndefined();
          const inspect = storage.edit();
          expect(inspect.read(address).ok?.value).toBe(current + 1);
          inspect.abort();
        } finally {
          await storage.close();
          await server.close();
        }
      });
    }
  }
});
