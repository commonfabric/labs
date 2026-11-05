import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { factoryStateOf } from "@commonfabric/data-model/fabric-factory";

import {
  getCompileCacheRuntimeVersion,
  setCompileCacheRuntimeVersionForTesting,
  writeCompiledDocs,
} from "../src/compilation-cache/cell-cache.ts";
import type { Engine } from "../src/harness/engine.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { CommitError } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "pattern-manager artifact availability",
);
const spaceA = signer.did();
const spaceB = (await Identity.fromPassphrase(
  "pattern-manager artifact availability B",
)).did();
const resolvedRuntimeVersion = await getCompileCacheRuntimeVersion();
if (resolvedRuntimeVersion === undefined) {
  throw new Error("compile-cache runtime version unavailable in Deno test");
}
const runtimeVersion = resolvedRuntimeVersion;

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ value: number }>(({ value }) => ({ value }));",
    ].join("\n"),
  }],
};

function dependencyProgram(value: number): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        `export const offset = ${value};`,
        "export default pattern<{ value: number }>(({ value }) => ({ value: value + offset }));",
      ].join("\n"),
    }],
  };
}

function importerProgram(identity: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        `import dependency from "cf:pattern:${identity}";`,
        "export default pattern<{ value: number }>(({ value }) => ({ child: dependency({ value }) }));",
      ].join("\n"),
    }],
  };
}

describe("PatternManager exact-space artifact availability", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("does not treat warm evaluation or indexing as durable availability", async () => {
    const pattern = await runtime.patternManager.compilePattern(PROGRAM);
    const ref = runtime.patternManager.getArtifactEntryRef(pattern)!;

    expect(
      runtime.patternManager.isArtifactAvailableInSpace(ref.identity, spaceA),
    ).toBe(false);
    expect(
      runtime.patternManager.isArtifactAvailableInSpace(ref.identity, spaceB),
    ).toBe(false);
    expect(() =>
      runtime.patternManager.assertArtifactAvailableInSpace(
        ref.identity,
        spaceA,
      )
    ).toThrow(
      `Factory artifact ${ref.identity} is not available in space ${spaceA}`,
    );
  });

  it("keeps indexed factory refs separate from publication availability", async () => {
    const pattern = await runtime.patternManager.compilePattern(PROGRAM);
    const ref = runtime.patternManager.getArtifactEntryRef(pattern)!;

    expect(factoryStateOf(pattern).ref).toEqual(ref);

    runtime.patternManager.noteArtifactPublicationConfirmed(
      ref.identity,
      spaceA,
    );

    expect(factoryStateOf(pattern).ref).toEqual(ref);
    expect(
      runtime.patternManager.isArtifactAvailableInSpace(ref.identity, spaceA),
    ).toBe(true);
  });

  it("marks only the exact space after awaited source and compiled persistence", async () => {
    const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
      space: spaceA,
    });
    const ref = runtime.patternManager.getArtifactEntryRef(pattern)!;

    expect(
      runtime.patternManager.isArtifactAvailableInSpace(ref.identity, spaceA),
    ).toBe(true);
    expect(
      runtime.patternManager.isArtifactAvailableInSpace(ref.identity, spaceB),
    ).toBe(false);
    expect(() =>
      runtime.patternManager.assertArtifactAvailableInSpace(
        ref.identity,
        spaceA,
      )
    ).not.toThrow();
    expect(() =>
      runtime.patternManager.assertArtifactAvailableInSpace(
        ref.identity,
        spaceB,
      )
    ).toThrow(
      `Factory artifact ${ref.identity} is not available in space ${spaceB}`,
    );
  });

  it("marks source-only persistence only after its awaited write succeeds", async () => {
    const restoreRuntimeVersion = setCompileCacheRuntimeVersionForTesting(
      undefined,
    );
    try {
      const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
        space: spaceA,
      });
      const ref = runtime.patternManager.getArtifactEntryRef(pattern)!;
      expect(
        runtime.patternManager.isArtifactAvailableInSpace(
          ref.identity,
          spaceA,
        ),
      ).toBe(true);
      expect(
        runtime.patternManager.isArtifactAvailableInSpace(
          ref.identity,
          spaceB,
        ),
      ).toBe(false);
    } finally {
      restoreRuntimeVersion();
    }
  });

  it("does not mark availability when awaited persistence fails", async () => {
    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const failure = {
      name: "StorageTransactionAborted" as const,
      message: "forced artifact persistence failure",
      reason: "synthetic availability test failure",
    } satisfies CommitError;
    let entryIdentity: string | undefined;
    runtime.editWithRetry =
      (() =>
        Promise.resolve({ error: failure })) as typeof runtime.editWithRetry;

    try {
      let thrown: unknown;
      try {
        await runtime.patternManager.compilePattern(PROGRAM, {
          space: spaceA,
          onEntryIdentity(identity) {
            entryIdentity = identity;
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(entryIdentity).toBeDefined();
      expect(
        runtime.patternManager.isArtifactAvailableInSpace(
          entryIdentity!,
          spaceA,
        ),
      ).toBe(false);
    } finally {
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("reuses a warm artifact when a read-only destination refuses its copy", async () => {
    const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
      space: spaceA,
    });
    const ref = runtime.patternManager.getArtifactEntryRef(pattern)!;

    const coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      expect(
        coldRuntime.patternManager.isArtifactAvailableInSpace(
          ref.identity,
          spaceA,
        ),
      ).toBe(false);

      const loaded = await coldRuntime.patternManager.loadPatternByIdentity(
        ref.identity,
        ref.symbol,
        spaceA,
      );
      expect(loaded).toBeDefined();
      expect(
        coldRuntime.patternManager.isArtifactAvailableInSpace(
          ref.identity,
          spaceA,
        ),
      ).toBe(true);

      // The verified source in A lets an ordinary pattern load reuse the live
      // callable while it attempts to supply B. This signer cannot write the
      // other identity's space, so the best-effort copy is refused and must
      // not turn the in-memory hit into a false availability grant.
      const warmInOtherSpace = await coldRuntime.patternManager
        .loadPatternByIdentity(ref.identity, ref.symbol, spaceB);
      expect(warmInOtherSpace).toBe(loaded);
      await coldRuntime.patternManager.flushCompileCacheWrites();
      await coldRuntime.storageManager.synced();
      expect(
        coldRuntime.patternManager.isArtifactAvailableInSpace(
          ref.identity,
          spaceB,
        ),
      ).toBe(false);
    } finally {
      await coldRuntime.dispose();
    }
  });

  it("fails closed on a compiled-only cache and repairs it when source is available from the program", async () => {
    const compiled = await (runtime.harness as Engine).compileToRecordGraph(
      PROGRAM,
      { fabricImports: { space: spaceA } },
    );
    const writeTx = runtime.edit();
    writeCompiledDocs(
      runtime,
      spaceA,
      compiled.modules,
      compiled.entryIdentity,
      { runtimeVersion },
      writeTx,
    );
    runtime.prepareTxForCommit(writeTx);
    expect((await writeTx.commit().settled).error).toBeUndefined();

    const loaded = await runtime.patternManager.loadPatternByIdentity(
      compiled.entryIdentity,
      "default",
      spaceA,
    );
    expect(loaded).toBeUndefined();
    expect(
      runtime.patternManager.isArtifactAvailableInSpace(
        compiled.entryIdentity,
        spaceA,
      ),
    ).toBe(false);

    const repaired = await runtime.patternManager.compilePattern(PROGRAM, {
      space: spaceA,
      knownEntryIdentity: compiled.entryIdentity,
    });
    expect(repaired).toBeDefined();
    expect(
      runtime.patternManager.isArtifactAvailableInSpace(
        compiled.entryIdentity,
        spaceA,
      ),
    ).toBe(true);
  });

  it("verifies and marks transitive fabric-import source closures on a warm load", async () => {
    const dependency = await runtime.patternManager.compilePattern(
      dependencyProgram(10),
      { space: spaceA },
    );
    const dependencyRef = runtime.patternManager.getArtifactEntryRef(
      dependency,
    )!;
    const importer = await runtime.patternManager.compilePattern(
      importerProgram(dependencyRef.identity),
      { space: spaceA },
    );
    const importerRef = runtime.patternManager.getArtifactEntryRef(importer)!;
    await runtime.storageManager.synced();

    const coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const sourceOnlyRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const loaded = await coldRuntime.patternManager.loadPatternByIdentity(
        importerRef.identity,
        importerRef.symbol,
        spaceA,
      );
      expect(loaded).toBeDefined();
      expect(
        coldRuntime.patternManager.isArtifactAvailableInSpace(
          importerRef.identity,
          spaceA,
        ),
      ).toBe(true);
      expect(
        coldRuntime.patternManager.isArtifactAvailableInSpace(
          dependencyRef.identity,
          spaceA,
        ),
      ).toBe(true);
      expect(coldRuntime.patternManager.getCompileCacheStats().byIdentityHits)
        .toBe(1);

      const restoreRuntimeVersion = setCompileCacheRuntimeVersionForTesting(
        undefined,
      );
      try {
        const sourceLoaded = await sourceOnlyRuntime.patternManager
          .loadPatternByIdentity(
            importerRef.identity,
            importerRef.symbol,
            spaceA,
          );
        expect(sourceLoaded).toBeDefined();
        expect(
          sourceOnlyRuntime.patternManager.isArtifactAvailableInSpace(
            importerRef.identity,
            spaceA,
          ),
        ).toBe(true);
        expect(
          sourceOnlyRuntime.patternManager.isArtifactAvailableInSpace(
            dependencyRef.identity,
            spaceA,
          ),
        ).toBe(true);
      } finally {
        restoreRuntimeVersion();
      }
    } finally {
      await sourceOnlyRuntime.dispose();
      await coldRuntime.dispose();
    }
  });
});
