import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { DocumentLoadError } from "../src/document-readiness.ts";
import { loadProfileCandidates } from "../src/profile-order.ts";
import { Runtime } from "../src/runtime.ts";
import { seedProfileOwner } from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-profile-order-failure");

describe("loadProfileCandidates()", () => {
  it("rejects with a failure reading a listed profile that is not a load failure, rather than recording it as that profile's failure", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const space = (await Identity.fromPassphrase("profile unreadable")).did();
      const profile = runtime.getCell<unknown>(space, crypto.randomUUID());
      await runtime.editWithRetry((tx) => {
        profile.withTx(tx).set({ name: "unreadable" });
        seedProfileOwner(tx, profile.getAsNormalizedFullLink(), signer.did());
      });
      const defaultPattern = runtime.getCell<unknown>(
        signer.did(),
        crypto.randomUUID(),
      );
      await runtime.editWithRetry((tx) =>
        defaultPattern.withTx(tx).set({ profiles: [profile] })
      );
      // A read of the profile's `name` fails in every transaction opened
      // from here on.
      const failure = new Error("the profile's name cannot be read");
      const profileId = profile.getAsNormalizedFullLink().id;
      const edit = runtime.edit.bind(runtime);
      runtime.edit = (...args) => {
        const tx = edit(...args);
        const read = tx.readValueOrThrow.bind(tx);
        tx.readValueOrThrow = (address, options) => {
          if (address.id === profileId && address.path[0] === "name") {
            throw failure;
          }
          return read(address, options);
        };
        return tx;
      };

      const error = await loadProfileCandidates(runtime, defaultPattern)
        .catch((error: unknown) => error);

      expect(error).toBe(failure);
      expect(error).not.toBeInstanceOf(DocumentLoadError);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
