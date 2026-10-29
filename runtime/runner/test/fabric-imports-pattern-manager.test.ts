import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
  loadVerifiedSourceClosure,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";

const signer = await Identity.fromPassphrase(
  "fabric imports pattern manager test",
);
const space = signer.did();
const otherSpace = "did:key:z6MkFabricImportsPatternManagerOther";
const resolvedRuntimeVersion = await getCompileCacheRuntimeVersion();
if (resolvedRuntimeVersion === undefined) {
  throw new Error("compile-cache runtime version unavailable in Deno test");
}
const runtimeVersion = resolvedRuntimeVersion;

describe("PatternManager fabric imports", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await storageManager?.close();
  });

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

  function dependencyProgram(value: number): RuntimeProgram {
    return {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            `import { pattern } from "commonfabric";`,
            `export const x = ${value};`,
            `export default pattern<{ value: number }>(({ value }) => ({ dep: value + x }));`,
          ].join("\n"),
        },
      ],
    };
  }

  function importerProgram(specifier: string): RuntimeProgram {
    return {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            `import { pattern } from "commonfabric";`,
            `import dep, { x } from "${specifier}";`,
            `export function y() { return x + 1; }`,
            `export default pattern<{ value: number }>(({ value }) => {`,
            `  const child = dep({ value });`,
            `  return { result: value + x + 1, child };`,
            `});`,
          ].join("\n"),
        },
      ],
    };
  }

  async function runPattern(
    runtime: Runtime,
    pattern: unknown,
    value: number,
    cause: string,
  ): Promise<unknown> {
    const tx = runtime.edit();
    const resultCell = runtime.getCell<{
      result: number;
      child: { dep: number };
    }>(space, cause, undefined, tx);
    // deno-lint-ignore no-explicit-any
    const result = runtime.run(tx, pattern as any, { value }, resultCell);
    await tx.commit().settled;
    await result.pull();
    return result.getAsQueryResult();
  }

  it("compiles cache-backed fabric imports and warm-reloads them by identity", async () => {
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      const pm1 = rt1.patternManager;
      const tx1 = rt1.edit();
      const dependency = await pm1.compilePattern(dependencyProgram(10), {
        space,
        tx: tx1,
      });
      const dependencyIdentity = pm1.getArtifactEntryRef(dependency)!.identity;
      await pm1.flushCompileCacheWrites();

      const importer = await pm1.compilePattern(
        importerProgram(`cf:pattern:${dependencyIdentity}`),
        { space, tx: tx1 },
      );
      const importerIdentity = pm1.getArtifactEntryRef(importer)!.identity;
      await pm1.flushCompileCacheWrites();
      await tx1.commit().settled;
      await rt1.storageManager.synced();

      const loaded = await rt2.patternManager.loadPatternByIdentity(
        importerIdentity,
        "default",
        space,
      );

      expect(typeof loaded).toBe("function");
      expect(rt2.patternManager.getCompileCacheStats().byIdentityHits).toBe(1);
      const out = await runPattern(rt2, loaded, 5, "warm fabric reload") as {
        result: number;
        child: { dep: number };
      };
      expect(out.result).toBe(16);
      expect(out.child).toEqual({ dep: 15 });
      expect(
        rt2.patternManager.artifactFromIdentitySync(
          dependencyIdentity,
          "default",
        ),
      ).toBeDefined();
      // Importer and dependency share the filename `/main.tsx`. The cached
      // record path must not let one shadow the other in its filename-keyed
      // side tables — the IMPORTER's exports must be indexed by identity too.
      expect(
        rt2.patternManager.artifactFromIdentitySync(
          importerIdentity,
          "default",
        ),
      ).toBeDefined();
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("cold-reloads fabric imports by identity from verified source docs", async () => {
    const runtime = newRuntime();
    try {
      const engine = runtime.harness as Engine;
      const dependency = await engine.compileToRecordGraph(
        dependencyProgram(20),
      );
      const depTx = runtime.edit();
      writeSourceDocs(
        runtime,
        space,
        dependency.modules,
        dependency.entryIdentity,
        depTx,
      );
      await depTx.commit().settled;

      const importer = await engine.compileToRecordGraph(
        importerProgram(`cf:pattern:${dependency.entryIdentity}`),
        { fabricImports: { space } },
      );
      const importerTx = runtime.edit();
      writeSourceDocs(
        runtime,
        space,
        importer.modules,
        importer.entryIdentity,
        importerTx,
      );
      await importerTx.commit().settled;

      const loaded = await runtime.patternManager.loadPatternByIdentity(
        importer.entryIdentity,
        "default",
        space,
      );

      expect(typeof loaded).toBe("function");
      const out = await runPattern(
        runtime,
        loaded,
        2,
        "cold fabric reload",
      ) as {
        result: number;
        child: { dep: number };
      };
      expect(out.result).toBe(23);
      expect(out.child).toEqual({ dep: 22 });
      expect(
        runtime.patternManager.artifactFromIdentitySync(
          dependency.entryIdentity,
          "default",
        ),
      ).toBeDefined();

      await runtime.patternManager.flushCompileCacheWrites();
      const readTx = runtime.edit();
      const compiled = await loadCompiledClosure(
        runtime,
        space,
        importer.entryIdentity,
        { runtimeVersion },
        readTx,
      );
      readTx.abort?.();
      expect(compiled.has(importer.entryIdentity)).toBe(true);
      expect(compiled.has(dependency.entryIdentity)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it("copies cross-space fabric imports into the compiling space cache", async () => {
    const runtime = newRuntime();
    try {
      const engine = runtime.harness as Engine;
      const dependency = await engine.compileToRecordGraph(
        dependencyProgram(30),
      );
      const depTx = runtime.edit();
      writeSourceDocs(
        runtime,
        otherSpace,
        dependency.modules,
        dependency.entryIdentity,
        depTx,
      );
      await depTx.commit().settled;

      const importer = await runtime.patternManager.compilePattern(
        importerProgram(
          `cf:/${otherSpace}/pattern:${dependency.entryIdentity}`,
        ),
        { space },
      );
      const importerIdentity = runtime.patternManager.getArtifactEntryRef(
        importer,
      )!.identity;
      await runtime.patternManager.flushCompileCacheWrites();

      const readTx = runtime.edit();
      const copiedDependency = await loadVerifiedSourceClosure(
        runtime,
        space,
        dependency.entryIdentity,
        readTx,
      );
      const copiedImporter = await loadVerifiedSourceClosure(
        runtime,
        space,
        importerIdentity,
        readTx,
      );
      readTx.abort?.();

      expect(copiedDependency?.has(dependency.entryIdentity)).toBe(true);
      expect(copiedImporter?.has(importerIdentity)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
});
