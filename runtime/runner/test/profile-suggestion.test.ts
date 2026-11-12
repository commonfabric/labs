import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import {
  offerProfileSuggestion,
  profileSuggestionCell,
} from "../src/profile-suggestion.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("profile-suggestion");

describe("profile-suggestion", () => {
  const opened: {
    runtime: Runtime;
    storageManager: ReturnType<typeof StorageManager.emulate>;
  }[] = [];

  /** A runtime over its own emulated storage, disposed after the case. */
  const open = (servingPosture: boolean): Runtime => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture,
    });
    opened.push({ runtime, storageManager });
    return runtime;
  };

  afterEach(async () => {
    for (const { runtime, storageManager } of opened.splice(0)) {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  describe("profileSuggestionCell()", () => {
    it("returns a cell in the client's own home space", () => {
      const cell = profileSuggestionCell(open(false));
      expect(cell.getAsNormalizedFullLink().space).toBe(signer.did());
    });

    it("throws on a serving runtime given no run to name the user", () => {
      expect(() => profileSuggestionCell(open(true))).toThrow(
        "this run carries none",
      );
    });
  });

  describe("offerProfileSuggestion()", () => {
    it("stores the suggestion where the cell reads it", async () => {
      const runtime = open(false);
      await offerProfileSuggestion(runtime, { name: "Sam Lee" });

      expect(profileSuggestionCell(runtime).get()).toEqual({ name: "Sam Lee" });
    });

    it("throws on a serving runtime", async () => {
      await expect(offerProfileSuggestion(open(true), { name: "Sam Lee" }))
        .rejects.toThrow("only a client runtime offers its user a profile");
    });

    it("throws when the write cannot commit", async () => {
      const runtime = open(false);
      await runtime.dispose();

      await expect(offerProfileSuggestion(runtime, { name: "Sam Lee" }))
        .rejects.toThrow("the runtime is disposing");
    });
  });
});
