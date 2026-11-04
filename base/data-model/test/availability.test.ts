import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { hashOf, toCompactDebugString } from "../src/index.ts";
import { FabricUnavailable as DuplicateUnavailable } from "../src/fabric-primitives/FabricUnavailable.ts?availability-test";
import {
  FabricUnavailable,
  hasError,
  hasSchemaMismatch,
  isObsolete,
  isPending,
  isSyncing,
  isUnavailable,
  UNAVAILABLE_OBSOLETE,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
  unavailableMismatch,
  unavailableObsolete,
} from "../src/availability.ts";

describe("availability", () => {
  it("recognizes and hashes native markers from a pre-obsolete concrete module", async () => {
    // This snapshot is the concrete module at 89e752c51f9a3f69412fcac2d041231001f5a8de.
    // Sharing its dependencies exercises the same native seam as the duplicate import.
    const source = await Deno.readTextFile(
      new URL(
        "./fixtures/pre-obsolete-FabricUnavailable.ts.txt",
        import.meta.url,
      ),
    );
    const moduleUrl = new URL(
      "../src/fabric-primitives/FabricUnavailable.ts",
      import.meta.url,
    );
    const resolvedSource = source.replace(
      /from "([^"]+)"/g,
      (_match, specifier: string) => {
        const resolved = specifier.startsWith(".")
          ? new URL(specifier, moduleUrl).href
          : import.meta.resolve(specifier);
        return `from ${JSON.stringify(resolved)}`;
      },
    );
    const legacyModule = await import(
      `data:text/typescript,${encodeURIComponent(resolvedSource)}`
    );
    expect(typeof legacyModule.FabricUnavailable).toBe("function");
    expect(legacyModule.FabricUnavailable).not.toBe(FabricUnavailable);
    for (
      const canonical of [
        UNAVAILABLE_PENDING,
        UNAVAILABLE_SYNCING,
        unavailableError("Legacy network failure", "network"),
      ]
    ) {
      const legacy: unknown = new legacyModule.FabricUnavailable(
        canonical.reason,
        canonical.errorKind,
        canonical.rawErrorMessage,
      );
      expect(isUnavailable(legacy)).toBe(true);
      if (!isUnavailable(legacy)) {
        throw new Error("The legacy concrete marker was not recognized.");
      }
      expect("isObsolete" in legacy).toBe(false);
      expect(isObsolete(legacy)).toBe(false);
      expect(isPending(legacy)).toBe(isPending(canonical));
      expect(isSyncing(legacy)).toBe(isSyncing(canonical));
      expect(hasError(legacy)).toBe(hasError(canonical));
      expect(hashOf(legacy).toString()).toBe(hashOf(canonical).toString());
    }
  });

  it("recognizes retired outputs without treating them as failures or pending work", () => {
    const value = unavailableObsolete("Use overview.text instead.");
    expect(isObsolete(value)).toBe(true);
    expect(isUnavailable(value)).toBe(true);
    expect(isPending(value)).toBe(false);
    expect(isSyncing(value)).toBe(false);
    expect(hasError(value)).toBe(false);
    expect(value.obsoleteMessage).toBe("Use overview.text instead.");
    const diagnostic = toCompactDebugString(value);
    expect(diagnostic).toContain('reason:"obsolete"');
    expect(diagnostic).toContain(
      'obsoleteMessage:"Use overview.text instead."',
    );
    expect(unavailableObsolete()).toBe(UNAVAILABLE_OBSOLETE);
    expect(isObsolete({ reason: "obsolete" })).toBe(false);
    expect(isObsolete(new DuplicateUnavailable("obsolete"))).toBe(true);
  });

  it("recognizes canonical prefabs and narrowed error kinds", () => {
    expect(isPending(UNAVAILABLE_PENDING)).toBe(true);
    expect(isSyncing(UNAVAILABLE_SYNCING)).toBe(true);
    const failure = unavailableError(new Error("request failed"), "network");
    expect(hasError(failure)).toBe(true);
    expect(failure.errorKind).toBe("network");
    expect(failure.errorMessage).toBe("request failed");
    expect(hasSchemaMismatch(failure)).toBe(false);
    expect(hasSchemaMismatch(unavailableMismatch())).toBe(true);
    expect(hasError(unavailableMismatch())).toBe(true);
    expect(unavailableMismatch()).toBe(unavailableMismatch());
  });

  it("rejects structural lookalikes and does not inspect successful payloads", () => {
    expect(isUnavailable({ reason: "pending" })).toBe(false);
    expect(isUnavailable(undefined)).toBe(false);
    const payload = {
      get nested() {
        throw new Error("opaque payload");
      },
    };
    expect(isPending(payload)).toBe(false);
    expect(hasError(payload)).toBe(false);
  });

  it("recognizes independently evaluated concrete primitive modules", () => {
    expect(DuplicateUnavailable).not.toBe(FabricUnavailable);
    expect(isPending(new DuplicateUnavailable("pending"))).toBe(true);
    expect(isSyncing(new DuplicateUnavailable("syncing"))).toBe(true);
    expect(
      hasSchemaMismatch(
        new DuplicateUnavailable("error", "schemaMismatch"),
      ),
    ).toBe(true);
  });
});
