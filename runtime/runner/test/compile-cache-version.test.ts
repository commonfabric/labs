import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getCompileCacheRuntimeVersion,
  resolveBakedCompileCacheRuntimeVersionForTesting,
  setCompileCacheRuntimeVersionForTesting,
} from "../src/compilation-cache/cell-cache.ts";
import { SOURCE_COMPILE_CACHE_RUNTIME_VERSION } from "../src/compilation-cache/compile-cache-version.ts";

type VersionGlobal = typeof globalThis & {
  __cfCompileCacheRuntimeVersion?: unknown;
};

describe("compile-cache runtime-version resolution", () => {
  // The compile-cache runtimeVersion decides when deployed pieces recompile (a
  // version move sends every cold load through the recovery write-back), so
  // the resolution ladder is load-bearing: defined global override  >  baked
  // build version  >  live compiler fingerprint (Deno dev runtime)  >
  // undefined (no fingerprint source).

  it("a defined global version overrides everything", async () => {
    const g = globalThis as VersionGlobal;
    const previous = g.__cfCompileCacheRuntimeVersion;
    g.__cfCompileCacheRuntimeVersion = "cf/esm-compile/defined-by-build";
    try {
      // Even an explicit baked version loses to the build-time define.
      expect(
        await resolveBakedCompileCacheRuntimeVersionForTesting("baked-v1"),
      ).toBe("cf/esm-compile/defined-by-build");
    } finally {
      if (previous === undefined) {
        delete g.__cfCompileCacheRuntimeVersion;
      } else {
        g.__cfCompileCacheRuntimeVersion = previous;
      }
    }
  });

  it("an empty or non-string define is ignored, falling to the baked version", async () => {
    const g = globalThis as VersionGlobal;
    const previous = g.__cfCompileCacheRuntimeVersion;
    try {
      g.__cfCompileCacheRuntimeVersion = "";
      expect(
        await resolveBakedCompileCacheRuntimeVersionForTesting("baked-v2"),
      ).toBe("baked-v2");
      g.__cfCompileCacheRuntimeVersion = 42;
      expect(
        await resolveBakedCompileCacheRuntimeVersionForTesting("baked-v2"),
      ).toBe("baked-v2");
    } finally {
      if (previous === undefined) {
        delete g.__cfCompileCacheRuntimeVersion;
      } else {
        g.__cfCompileCacheRuntimeVersion = previous;
      }
    }
  });

  it("a baked (non-source) version is returned verbatim", async () => {
    expect(
      await resolveBakedCompileCacheRuntimeVersionForTesting("cf/esm/v42"),
    ).toBe("cf/esm/v42");
  });

  it("the source sentinel resolves the live compiler fingerprint under Deno", async () => {
    // Dev runtimes carry the source sentinel; the ladder then computes the
    // fingerprint from the compiler-relevant sources. This is the value whose
    // movement makes deployed pieces stale, so pin its shape: defined,
    // non-empty, not the sentinel itself, and stable across resolutions.
    const first = await resolveBakedCompileCacheRuntimeVersionForTesting(
      SOURCE_COMPILE_CACHE_RUNTIME_VERSION,
    );
    expect(typeof first).toBe("string");
    expect((first as string).length).toBeGreaterThan(0);
    expect(first).not.toBe(SOURCE_COMPILE_CACHE_RUNTIME_VERSION);
    const second = await resolveBakedCompileCacheRuntimeVersionForTesting(
      SOURCE_COMPILE_CACHE_RUNTIME_VERSION,
    );
    expect(second).toBe(first);
  });

  it("the test override stacks and restores like a scope", async () => {
    // The conflict/healing tests lean on this seam to simulate version bumps;
    // pin the restore discipline (LIFO, restores the PREVIOUS override, and
    // the ambient resolution returns once the stack unwinds).
    const ambient = await getCompileCacheRuntimeVersion();
    const restoreOuter = setCompileCacheRuntimeVersionForTesting("outer-v");
    try {
      expect(await getCompileCacheRuntimeVersion()).toBe("outer-v");
      const restoreInner = setCompileCacheRuntimeVersionForTesting("inner-v");
      expect(await getCompileCacheRuntimeVersion()).toBe("inner-v");
      restoreInner();
      expect(await getCompileCacheRuntimeVersion()).toBe("outer-v");
    } finally {
      restoreOuter();
    }
    expect(await getCompileCacheRuntimeVersion()).toBe(ambient);
  });
});
