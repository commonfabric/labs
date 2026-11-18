/**
 * The index entry of a pattern built while a program runs. A serving runtime drops
 * the entry when it releases the piece, and results of one structure share an
 * identity, so what one release drops another result may still need.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("keyless index");

describe("pattern-manager-keyless-index", () => {
  let storageManager: ReturnType<typeof EmulatedStorageManager.emulate>;
  let runtime: Runtime;

  const builtPattern = () =>
    ({
      argumentSchema: {},
      resultSchema: {},
      result: { saved: "value" },
      nodes: [],
    }) as unknown as Pattern;

  beforeEach(() => {
    storageManager = EmulatedStorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  describe("forgetKeylessPattern()", () => {
    it("leaves nothing to resolve a keyless identity to", () => {
      const manager = runtime.patternManager;
      const ref = manager.ensureKeylessPatternIdentity(builtPattern());

      manager.forgetKeylessPattern(ref.identity);

      expect(manager.artifactFromIdentitySync(ref.identity, ref.symbol))
        .toBeUndefined();
    });

    it("leaves an identity that is not keyless", () => {
      const manager = runtime.patternManager;
      const pattern = builtPattern();
      manager.associatePatternIdentity(pattern, {
        identity: "module",
        symbol: "default",
      });

      manager.forgetKeylessPattern("module");

      expect(manager.artifactFromIdentitySync("module", "default"))
        .toBe(pattern);
    });

    it("leaves an identity keepKeylessPattern() named", () => {
      const manager = runtime.patternManager;
      const kept = builtPattern();
      const ref = manager.ensureKeylessPatternIdentity(kept);
      manager.keepKeylessPattern(kept);

      manager.forgetKeylessPattern(ref.identity);

      expect(manager.artifactFromIdentitySync(ref.identity, ref.symbol))
        .toBe(kept);
    });
  });

  describe("ensureKeylessPatternIdentity()", () => {
    it("indexes a pattern again after a result of its structure is forgotten", () => {
      const manager = runtime.patternManager;
      const surviving = builtPattern();
      const ref = manager.ensureKeylessPatternIdentity(surviving);
      manager.ensureKeylessPatternIdentity(builtPattern());
      manager.forgetKeylessPattern(ref.identity);

      expect(manager.ensureKeylessPatternIdentity(surviving)).toEqual(ref);

      expect(manager.artifactFromIdentitySync(ref.identity, ref.symbol))
        .toBe(surviving);
    });
  });

  describe("keepKeylessPattern()", () => {
    it("indexes a pattern whose identity was forgotten", () => {
      const manager = runtime.patternManager;
      const kept = builtPattern();
      const ref = manager.ensureKeylessPatternIdentity(kept);
      manager.forgetKeylessPattern(ref.identity);

      manager.keepKeylessPattern(kept);

      expect(manager.artifactFromIdentitySync(ref.identity, ref.symbol))
        .toBe(kept);
    });
  });
});
