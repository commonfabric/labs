import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { cfcObservationFitsCeiling } from "../src/cfc/observation.ts";

const signer = await Identity.fromPassphrase("runner-cfc-ceiling-empty");

describe("cfcObservationFitsCeiling empty ceiling", () => {
  // Regression guard for empty-ceiling semantics (audit minor / W0.7).
  //
  // A declared but empty maxConfidentiality means "public only" — no
  // confidential atom is permitted. It was conflated with undefined ("no
  // ceiling"), so an empty ceiling let confidential data through. undefined
  // stays no-ceiling; public data (no confidentiality atoms) still fits any
  // ceiling, including the empty one.

  it("treats undefined ceiling as no ceiling", () => {
    expect(cfcObservationFitsCeiling(["secret"], undefined)).toBe(true);
  });

  it("denies confidential data under an empty (public-only) ceiling", () => {
    expect(cfcObservationFitsCeiling(["secret"], [])).toBe(false);
  });

  it("permits public data under an empty ceiling", () => {
    expect(cfcObservationFitsCeiling([], [])).toBe(true);
  });

  it("permits atoms within a populated ceiling", () => {
    expect(cfcObservationFitsCeiling(["a"], ["a", "b"])).toBe(true);
    expect(cfcObservationFitsCeiling(["c"], ["a", "b"])).toBe(false);
  });
});

describe("prepare maxConfidentiality empty ceiling", () => {
  it("rejects a write to an empty-ceiling path that consumes confidential input", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // The single assertion below is that the write is rejected with
      // "maxConfidentiality failed", and only an enforcing rung aborts it.
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      // Seed and persist a confidential source.
      const seed = runtime.edit();
      const srcSchema = {
        type: "string",
        ifc: { confidentiality: ["secret"] },
      } as const satisfies JSONSchema;
      const src = runtime.getCell(signer.did(), "ceiling-src", srcSchema, seed);
      src.set("classified");
      seed.prepareCfc();
      expect((await seed.commit().settled).ok).toBeDefined();

      // In an enforcing tx, consume the confidential read and write to a path
      // declaring an empty (public-only) maxConfidentiality ceiling.
      const tx = runtime.edit();
      const srcRead = runtime.getCell(
        signer.did(),
        "ceiling-src",
        srcSchema,
        tx,
      );
      srcRead.get();
      const target = runtime.getCell(
        signer.did(),
        "ceiling-target",
        {
          type: "object",
          properties: {
            out: { type: "string", ifc: { maxConfidentiality: [] } },
          },
          required: ["out"],
        } as const satisfies JSONSchema,
        tx,
      );
      target.set({ out: "derived" });

      const digest = tx.prepareCfc();
      expect(digest).toBe("");
      const result = await tx.commit().settled;
      expect(result.error?.message).toContain("maxConfidentiality failed");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
