import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createCompileByteCache,
  flushCompileByteCache,
  type ModuleByteCache,
  ProcessModuleByteCache,
  restoreCompileByteCacheForTesting,
  writeCompileByteCacheForTesting,
} from "./compile-byte-cache.ts";

const RT = "rtv";
const SPAN = {
  fileName: "/subject.tsx",
  id: 1,
  kind: "runtime" as const,
  startLine: 3,
  endLine: 4,
  startColumn: 5,
  endColumn: 6,
};
const POLICY_MANIFEST = { policyDigest: "sha256:policy", manifest: {} };
const BUILDER_SOURCE_SITES = {
  formatVersion: 1 as const,
  sites: { named: { line: 3, col: 4, bindingName: "named" } },
};

describe("ProcessModuleByteCache", () => {
  it("returns stored bytes by identity and reports a full set", () => {
    const cache = new ProcessModuleByteCache();
    cache.put(RT, "a", { js: "JS_A" });
    cache.put(RT, "b", { js: "JS_B", sourceMap: "MAP_B" });

    expect(cache.get(RT, "a")).toEqual({ js: "JS_A" });
    expect(cache.get(RT, "b")).toEqual({ js: "JS_B", sourceMap: "MAP_B" });
    expect(cache.get(RT, "missing")).toBeUndefined();

    expect(cache.getCompleteSet(RT, ["a", "b"])?.size).toBe(2);
    expect(cache.getCompleteSet(RT, ["a", "missing"])).toBeUndefined();
  });

  it("scopes by runtimeVersion (a version bump misses)", () => {
    const cache = new ProcessModuleByteCache();
    cache.put("v1", "id", { js: "JS" });
    expect(cache.get("v1", "id")).toEqual({ js: "JS" });
    expect(cache.get("v2", "id")).toBeUndefined();
  });

  it("putAll loads a module set; clear empties it", () => {
    const cache = new ProcessModuleByteCache();
    cache.putAll(RT, [
      { identity: "a", js: "JS_A" },
      {
        identity: "b",
        js: "JS_B",
        sourceMap: "MAP_B",
        patternCoverageSpans: [SPAN],
        builderSourceSites: BUILDER_SOURCE_SITES,
        policyManifests: [POLICY_MANIFEST],
      },
    ]);
    expect(cache.getCompleteSet(RT, ["a", "b"])?.size).toBe(2);
    expect(cache.get(RT, "b")).toEqual({
      js: "JS_B",
      sourceMap: "MAP_B",
      patternCoverageSpans: [SPAN],
      builderSourceSites: BUILDER_SOURCE_SITES,
      policyManifests: [POLICY_MANIFEST],
    });
    cache.clear();
    expect(cache.getCompleteSet(RT, ["a", "b"])).toBeUndefined();
    expect(cache.stats().entries).toBe(0);
  });

  it("evicts oldest entries past the byte cap", () => {
    const cache = new ProcessModuleByteCache(10); // 10 chars
    cache.put(RT, "a", { js: "12345" }); // 5
    cache.put(RT, "b", { js: "67890" }); // 5 -> total 10
    cache.put(RT, "c", { js: "ABCDE" }); // 5 -> evicts "a"
    expect(cache.get(RT, "a")).toBeUndefined();
    expect(cache.get(RT, "b")).toEqual({ js: "67890" });
    expect(cache.get(RT, "c")).toEqual({ js: "ABCDE" });
  });

  it("includes policy manifests in the byte cap", () => {
    const cache = new ProcessModuleByteCache(10);
    cache.put(RT, "policy", { js: "x", policyManifests: [POLICY_MANIFEST] });
    expect(cache.get(RT, "policy")).toBeUndefined();
  });

  it("includes a parsed source map in the byte cap", () => {
    // The compiler hands over the map parsed, not as text: 107 characters
    // serialized, beside 5 of JavaScript. One such entry fits a 150-byte
    // cap and two do not, so the second put evicts the first only if the
    // map is counted.
    const cache = new ProcessModuleByteCache(150);
    const sourceMap = { version: 3, mappings: "A".repeat(80) };
    cache.put(RT, "a", { js: "12345", sourceMap });
    expect(cache.get(RT, "a")).toEqual({ js: "12345", sourceMap });
    cache.put(RT, "b", { js: "67890", sourceMap });
    expect(cache.get(RT, "a")).toBeUndefined();
    expect(cache.get(RT, "b")).toEqual({ js: "67890", sourceMap });
  });

  it("round-trips through snapshot/restore into a fresh cache", () => {
    const a = new ProcessModuleByteCache();
    a.put(RT, "x", { js: "JS_X" });
    a.put(RT, "y", {
      js: "JS_Y",
      sourceMap: "MAP_Y",
      patternCoverageSpans: [SPAN],
      builderSourceSites: BUILDER_SOURCE_SITES,
      policyManifests: [POLICY_MANIFEST],
    });
    a.put("v2", "z", { js: "JS_Z" });

    const serialized = JSON.parse(JSON.stringify(a.snapshot())); // survives JSON
    const b = new ProcessModuleByteCache();
    b.restore(serialized);

    expect(b.get(RT, "x")).toEqual({ js: "JS_X" });
    expect(b.get(RT, "y")).toEqual({
      js: "JS_Y",
      sourceMap: "MAP_Y",
      patternCoverageSpans: [SPAN],
      builderSourceSites: BUILDER_SOURCE_SITES,
      policyManifests: [POLICY_MANIFEST],
    });
    expect(b.get("v2", "z")).toEqual({ js: "JS_Z" });
    expect(b.getCompleteSet(RT, ["x", "y"])?.size).toBe(2);
  });

  it("put replaces an existing artifact for the same key", () => {
    const cache = new ProcessModuleByteCache();
    cache.restore([{ key: `${RT}\0id`, js: "OLD" }]);

    cache.put(RT, "id", { js: "NEW", patternCoverageSpans: [SPAN] });

    expect(cache.get(RT, "id")).toEqual({
      js: "NEW",
      patternCoverageSpans: [SPAN],
    });
  });

  it("restore preserves an existing in-memory artifact for the same key", () => {
    const cache = new ProcessModuleByteCache();
    cache.put(RT, "id", { js: "NEW", patternCoverageSpans: [SPAN] });

    cache.restore([{ key: `${RT}\0id`, js: "OLD" }]);

    expect(cache.get(RT, "id")).toEqual({
      js: "NEW",
      patternCoverageSpans: [SPAN],
    });
  });

  it("restore skips malformed entries and tolerates junk", () => {
    const cache = new ProcessModuleByteCache();
    cache.restore([
      { key: `${RT}\0ok`, js: "GOOD" },
      { key: 42, js: "no" }, // bad key
      { key: `${RT}\0nojs` }, // missing js
      { key: `${RT}\0badspans`, js: "NO", patternCoverageSpans: ["bad"] },
      { key: `${RT}\0badspanstype`, js: "NO", patternCoverageSpans: "bad" },
      {
        key: `${RT}\0badsites`,
        js: "NO",
        builderSourceSites: { formatVersion: 2 },
      },
      { key: `${RT}\0badmanifests`, js: "NO", policyManifests: "bad" },
      null,
      "garbage",
    ] as unknown[]);
    expect(cache.get(RT, "ok")).toEqual({ js: "GOOD" });
    expect(cache.stats().entries).toBe(1);
  });

  it("restore rejects malformed builder source sidecars", () => {
    const malformedSidecars: unknown[] = [
      null,
      [],
      { formatVersion: 2, sites: {} },
      { formatVersion: 1, sites: null },
      { formatVersion: 1, sites: [] },
      { formatVersion: 1, sites: { "": { line: 1, col: 0 } } },
      { formatVersion: 1, sites: { named: null } },
      { formatVersion: 1, sites: { named: { line: 1.5, col: 0 } } },
      { formatVersion: 1, sites: { named: { line: 0, col: 0 } } },
      { formatVersion: 1, sites: { named: { line: 1, col: 0.5 } } },
      { formatVersion: 1, sites: { named: { line: 1, col: -1 } } },
      {
        formatVersion: 1,
        sites: { named: { line: 1, col: 0, bindingName: 42 } },
      },
      {
        formatVersion: 1,
        sites: { named: { line: 1, col: 0, bindingName: "" } },
      },
    ];
    const cache = new ProcessModuleByteCache();

    cache.restore(malformedSidecars.map((builderSourceSites, index) => ({
      key: `${RT}\0bad-sidecar-${index}`,
      js: "NO",
      builderSourceSites,
    })));

    expect(cache.stats().entries).toBe(0);
  });
});

describe("createCompileByteCache", () => {
  it("does not flush caches without disk persistence", () => {
    const fakeCache: ModuleByteCache = {
      getCompleteSet: () => undefined,
      putAll: () => {},
    };

    expect(flushCompileByteCache(fakeCache)).toBeUndefined();
    expect(flushCompileByteCache(new ProcessModuleByteCache())).toBeUndefined();
  });

  it("creates an in-memory cache when CF_COMPILE_CACHE_FILE is unset", () => {
    const previous = Deno.env.get("CF_COMPILE_CACHE_FILE");
    try {
      Deno.env.delete("CF_COMPILE_CACHE_FILE");
      const cache = createCompileByteCache();
      cache.putAll(RT, [{ identity: "id", js: "JS" }]);
      expect(cache.getCompleteSet(RT, ["id"])).toEqual(
        new Map([["id", { js: "JS" }]]),
      );
    } finally {
      if (previous === undefined) {
        Deno.env.delete("CF_COMPILE_CACHE_FILE");
      } else {
        Deno.env.set("CF_COMPILE_CACHE_FILE", previous);
      }
    }
  });

  it("restores from CF_COMPILE_CACHE_FILE and writes on unload", () => {
    const previous = Deno.env.get("CF_COMPILE_CACHE_FILE");
    const originalLog = console.log;
    const messages: string[] = [];
    const dir = Deno.makeTempDirSync({ prefix: "compile-byte-cache-env-" });
    const cacheFile = `${dir}/cache.json`;
    let registeredUnloadWriter = false;

    console.log = (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    };

    try {
      Deno.writeTextFileSync(
        cacheFile,
        JSON.stringify([{ key: `${RT}\0from-env`, js: "ENV" }]),
      );
      Deno.env.set("CF_COMPILE_CACHE_FILE", cacheFile);

      const cache = createCompileByteCache();
      registeredUnloadWriter = true;
      expect(cache.getCompleteSet(RT, ["from-env"])).toEqual(
        new Map([["from-env", { js: "ENV" }]]),
      );
      cache.putAll(RT, [{ identity: "from-unload", js: "UNLOAD" }]);

      globalThis.dispatchEvent(new Event("unload"));

      const restored = new ProcessModuleByteCache();
      restored.restore(JSON.parse(Deno.readTextFileSync(cacheFile)));
      expect(restored.getCompleteSet(RT, ["from-env", "from-unload"]))
        .toEqual(
          new Map([
            ["from-env", { js: "ENV" }],
            ["from-unload", { js: "UNLOAD" }],
          ]),
        );
      expect(
        messages.some((message) =>
          message.includes("[compile-byte-cache] restored 1 modules")
        ),
      ).toBe(true);
      expect(
        messages.some((message) =>
          message.includes("[compile-byte-cache] wrote 2 modules")
        ),
      ).toBe(true);
    } finally {
      console.log = originalLog;
      if (previous === undefined) {
        Deno.env.delete("CF_COMPILE_CACHE_FILE");
      } else {
        Deno.env.set("CF_COMPILE_CACHE_FILE", previous);
      }
      if (registeredUnloadWriter) {
        globalThis.addEventListener("unload", () => {
          try {
            Deno.removeSync(dir, { recursive: true });
          } catch {
            // The test may have already removed the directory.
          }
        });
      }
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch {
        // The unload cleanup listener also removes this directory.
      }
    }
  });

  it("restores from disk and writes a merged snapshot", () => {
    const dir = Deno.makeTempDirSync({ prefix: "compile-byte-cache-" });
    const cacheFile = `${dir}/cache.json`;
    try {
      Deno.writeTextFileSync(
        cacheFile,
        JSON.stringify([{ key: `${RT}\0from-disk`, js: "DISK" }]),
      );

      const cache = new ProcessModuleByteCache();
      expect(restoreCompileByteCacheForTesting(cache, cacheFile)).toBe(1);
      expect(cache.getCompleteSet(RT, ["from-disk"])).toEqual(
        new Map([["from-disk", { js: "DISK" }]]),
      );
      cache.putAll(RT, [{ identity: "from-run", js: "RUN" }]);

      expect(writeCompileByteCacheForTesting(cache, cacheFile)).toBe(2);

      const restored = new ProcessModuleByteCache();
      restored.restore(JSON.parse(Deno.readTextFileSync(cacheFile)));
      expect(restored.getCompleteSet(RT, ["from-disk", "from-run"]))
        .toEqual(
          new Map([
            ["from-disk", { js: "DISK" }],
            ["from-run", { js: "RUN" }],
          ]),
        );
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  });
});
