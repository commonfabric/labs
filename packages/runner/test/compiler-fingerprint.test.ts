import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import {
  COMPILE_FINGERPRINT_INPUTS,
  computeCompilerFingerprint,
  computeCompilerVersion,
  computeCurrentCompilerVersion,
  renderVersionModule,
  VERSION_NAMESPACE,
} from "../src/compilation-cache/compiler-fingerprint.deno.ts";
import type * as cellCacheModule from "../src/compilation-cache/cell-cache.ts";
import {
  COMPILE_CACHE_RUNTIME_VERSION,
  getCompileCacheRuntimeVersion,
  resolveBakedCompileCacheRuntimeVersionForTesting,
  SOURCE_COMPILE_CACHE_RUNTIME_VERSION,
} from "../src/compilation-cache/cell-cache.ts";

const versionModulePath = fromFileUrl(
  new URL("../src/compilation-cache/compile-cache-version.ts", import.meta.url),
);

const repoRoot = fromFileUrl(new URL("../../../", import.meta.url));

type CellCacheModule = typeof cellCacheModule;
type CompileCacheVersionGlobal = typeof globalThis & {
  __cfCompileCacheRuntimeVersion?: string;
};

/** Write a temp tree and return its root; caller removes it. */
async function makeTree(
  files: Record<string, string>,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "compile-fingerprint-" });
  for (const [rel, contents] of Object.entries(files)) {
    const abs = `${root}/${rel}`;
    await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(abs, contents);
  }
  return root;
}

async function importFreshCellCacheModule(): Promise<CellCacheModule> {
  const moduleUrl = new URL(
    "../src/compilation-cache/cell-cache.ts",
    import.meta.url,
  );
  moduleUrl.searchParams.set("testRun", crypto.randomUUID());
  return await import(moduleUrl.href);
}

describe("computeCompilerFingerprint", () => {
  it("is stable: identical inputs hash to the same value", async () => {
    const root = await makeTree({
      "transformer/a.ts": "export const a = 1;",
      "transformer/sub/b.ts": "export const b = 2;",
    });
    try {
      const first = await computeCompilerFingerprint(root, ["transformer"]);
      const second = await computeCompilerFingerprint(root, ["transformer"]);
      expect(first).toBe(second);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("changes when a fingerprinted file's contents change", async () => {
    const root = await makeTree({
      "transformer/a.ts": "export const a = 1;",
    });
    try {
      const before = await computeCompilerFingerprint(root, ["transformer"]);
      await Deno.writeTextFile(
        `${root}/transformer/a.ts`,
        "export const a = 2;",
      );
      const after = await computeCompilerFingerprint(root, ["transformer"]);
      expect(after).not.toBe(before);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("changes when a file is added under a fingerprinted directory", async () => {
    const root = await makeTree({
      "transformer/a.ts": "export const a = 1;",
    });
    try {
      const before = await computeCompilerFingerprint(root, ["transformer"]);
      await Deno.writeTextFile(
        `${root}/transformer/c.ts`,
        "export const c = 3;",
      );
      const after = await computeCompilerFingerprint(root, ["transformer"]);
      expect(after).not.toBe(before);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("ignores walk order and CRLF/LF differences", async () => {
    const lf = await makeTree({
      "transformer/a.ts": "export const a = 1;\nexport const b = 2;\n",
    });
    const crlf = await makeTree({
      "transformer/a.ts": "export const a = 1;\r\nexport const b = 2;\r\n",
    });
    try {
      const lfHash = await computeCompilerFingerprint(lf, ["transformer"]);
      const crlfHash = await computeCompilerFingerprint(crlf, ["transformer"]);
      expect(crlfHash).toBe(lfHash);
    } finally {
      await Deno.remove(lf, { recursive: true });
      await Deno.remove(crlf, { recursive: true });
    }
  });

  it("throws on a missing input", async () => {
    const root = await makeTree({ "present/a.ts": "x" });
    try {
      await expect(computeCompilerFingerprint(root, ["absent"]))
        .rejects.toThrow();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("compile-cache version axis", () => {
  it("committed const stays on the stable source marker", () => {
    expect(COMPILE_CACHE_RUNTIME_VERSION).toBe(
      SOURCE_COMPILE_CACHE_RUNTIME_VERSION,
    );
    expect(COMPILE_CACHE_RUNTIME_VERSION).toBe(`${VERSION_NAMESPACE}/source`);
  });

  it("from-source runtime version resolves to the real compiler-input fingerprint", async () => {
    const version = await computeCompilerVersion(
      repoRoot,
      COMPILE_FINGERPRINT_INPUTS,
    );
    expect(await getCompileCacheRuntimeVersion()).toBe(version);
    expect(await computeCurrentCompilerVersion()).toBe(version);
    expect(version.startsWith(`${VERSION_NAMESPACE}/`)).toBe(true);
    expect(version).not.toBe(SOURCE_COMPILE_CACHE_RUNTIME_VERSION);
  });

  it("skips the compiled cache when source fingerprint files cannot be read", async () => {
    const originalStat = Deno.stat;
    const freshCellCache = await importFreshCellCacheModule();
    try {
      Deno.stat = (() =>
        Promise.reject(
          new Deno.errors.PermissionDenied("blocked"),
        )) as typeof Deno.stat;
      expect(await freshCellCache.getCompileCacheRuntimeVersion()).toBe(
        undefined,
      );
    } finally {
      Deno.stat = originalStat;
    }
  });

  it("rethrows unexpected source fingerprint failures", async () => {
    const originalStat = Deno.stat;
    const freshCellCache = await importFreshCellCacheModule();
    try {
      Deno.stat = (() =>
        Promise.reject(
          new Error("unexpected fingerprint failure"),
        )) as typeof Deno.stat;
      await expect(freshCellCache.getCompileCacheRuntimeVersion())
        .rejects.toThrow("unexpected fingerprint failure");
    } finally {
      Deno.stat = originalStat;
    }
  });

  it("skips the compiled cache when the Deno file API is absent", async () => {
    const originalStat = Deno.stat;
    const freshCellCache = await importFreshCellCacheModule();
    try {
      Deno.stat = undefined as unknown as typeof Deno.stat;
      expect(await freshCellCache.getCompileCacheRuntimeVersion()).toBe(
        undefined,
      );
    } finally {
      Deno.stat = originalStat;
    }
  });

  it("uses a build-defined version when the Deno file API is absent", async () => {
    const originalStat = Deno.stat;
    const global = globalThis as CompileCacheVersionGlobal;
    const previousDefinedVersion = global.__cfCompileCacheRuntimeVersion;
    const freshCellCache = await importFreshCellCacheModule();
    const definedVersion = `${VERSION_NAMESPACE}/defined-test`;
    try {
      Deno.stat = undefined as unknown as typeof Deno.stat;
      global.__cfCompileCacheRuntimeVersion = definedVersion;
      expect(await freshCellCache.getCompileCacheRuntimeVersion()).toBe(
        definedVersion,
      );
    } finally {
      Deno.stat = originalStat;
      if (previousDefinedVersion === undefined) {
        delete global.__cfCompileCacheRuntimeVersion;
      } else {
        global.__cfCompileCacheRuntimeVersion = previousDefinedVersion;
      }
    }
  });

  it("uses a baked binary version directly", async () => {
    const bakedVersion = `${VERSION_NAMESPACE}/baked-test`;
    expect(
      await resolveBakedCompileCacheRuntimeVersionForTesting(bakedVersion),
    ).toBe(bakedVersion);
  });

  it("committed version module matches the rendered source marker", async () => {
    const onDisk = await Deno.readTextFile(versionModulePath);
    expect(onDisk).toBe(
      renderVersionModule(SOURCE_COMPILE_CACHE_RUNTIME_VERSION),
    );
  });

  it("fingerprints the inputs that shape emitted bytes and coverage spans", () => {
    // `api` carries the pattern-facing types the schema-generator lowers into
    // baked schemas, so it is fingerprinted alongside the pipeline. The
    // fingerprint's own source is in the set too, so that changing how the
    // value is computed moves it.
    for (
      const input of [
        "packages/ts-transformers",
        "packages/js-compiler",
        "packages/runner/src/harness",
        "packages/runner/src/pattern-coverage.ts",
        "packages/runner/src/sandbox",
        "packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts",
        "packages/schema-generator",
        "packages/api",
        "packages/static/assets/types",
        "deno.jsonc",
        "deno.lock",
      ]
    ) {
      expect(COMPILE_FINGERPRINT_INPUTS).toContain(input);
    }
  });
});
