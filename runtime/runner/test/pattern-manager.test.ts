import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  storedFields,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { captureLogs } from "./support/captured-logs.ts";
import { Runtime } from "../src/runtime.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { getPatternProgram } from "../src/builder/pattern-metadata.ts";
import { pattern } from "../src/builder/pattern.ts";
import {
  sourceCfcMetadataProhibitsCrossSpaceCopy,
} from "../src/pattern-manager.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import {
  COMPILED_INTEGRITY_ATOM,
  loadVerifiedSourceClosure,
  sourceDocKey,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("pattern-manager", () => {
  describe("cross-space source policy", () => {
    const metadata = (
      path: string[],
      label: { confidentiality?: unknown[]; integrity?: unknown[] },
    ) =>
      ({
        version: 1,
        labelMap: {
          version: 1,
          entries: [{ path, label, origin: "declared" }],
        },
      }) as never;

    it("rejects confidentiality and non-compiler integrity labels", () => {
      expect(sourceCfcMetadataProhibitsCrossSpaceCopy(
        metadata(["code"], { confidentiality: ["private-source"] }),
      )).toBe(true);
      expect(sourceCfcMetadataProhibitsCrossSpaceCopy(
        metadata(["code"], { integrity: ["reviewed-source"] }),
      )).toBe(true);
    });

    it("allows only the compiler's delegation attestation", () => {
      expect(sourceCfcMetadataProhibitsCrossSpaceCopy(
        metadata(
          ["delegatedModuleIdentities"],
          { integrity: [COMPILED_INTEGRITY_ATOM] },
        ),
      )).toBe(false);
      expect(sourceCfcMetadataProhibitsCrossSpaceCopy(undefined)).toBe(false);
    });

    it("allows empty labels but rejects every other integrity shape", () => {
      expect(sourceCfcMetadataProhibitsCrossSpaceCopy(
        metadata(["code"], {}),
      )).toBe(false);
      expect(sourceCfcMetadataProhibitsCrossSpaceCopy(
        metadata(["other"], { integrity: [COMPILED_INTEGRITY_ATOM] }),
      )).toBe(true);
      expect(sourceCfcMetadataProhibitsCrossSpaceCopy(
        metadata(["delegatedModuleIdentities"], {
          integrity: [COMPILED_INTEGRITY_ATOM, "additional-attestation"],
        }),
      )).toBe(true);
    });
  });

  describe("program persistence", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: IExtendedStorageTransaction;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      tx = runtime.edit();
    });

    afterEach(async () => {
      await tx.commit().settled;
      await runtime?.dispose({ closeStorage: false });
      await storageManager?.close();
    });

    it("compiles multi-file program, attaches program, persists source docs and reloads by identity", async () => {
      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          {
            name: "/util.ts",
            contents: "export const double = (x:number)=>x*2;",
          },
          {
            name: "/main.tsx",
            contents: [
              "import { pattern, lift } from 'commonfabric';",
              "import { double } from './util.ts';",
              "const dbl = lift((x:number)=>double(x));",
              "export default pattern<{ value: number }>(({ value }) => {",
              "  return { result: dbl(value) };",
              "});",
            ].join("\n"),
          },
        ],
      };

      // Compiling INTO a space persists the content-addressed source +
      // compiled docs (the single durable source — no more meta cell).
      const compiled = await runtime.patternManager.compilePattern(program, {
        space,
      });
      expect(getPatternProgram(compiled)).toBeDefined();
      expect(getPatternProgram(compiled)?.main).toEqual("/main.tsx");
      // Ensure original file names are preserved (no injected prefix leaked here)
      const fileNames = (getPatternProgram(compiled)?.files ?? []).map((f) =>
        f.name
      ).sort();
      expect(fileNames).toEqual(["/main.tsx", "/util.ts"].sort());

      const entryRef = runtime.patternManager.getArtifactEntryRef(compiled);
      expect(entryRef).toBeDefined();

      // Recover the source files from the persisted source-doc closure. The
      // closure is the recovery unit, so it includes the authored modules plus
      // any injected helper modules (e.g. cfc.ts) — assert the authored files are
      // present rather than an exact set.
      const recovered = await runtime.patternManager
        .getPatternSourceProgramByIdentity(entryRef!.identity, space);
      expect(recovered?.main).toEqual("/main.tsx");
      const recoveredNames = (recovered?.files ?? []).map((f) => f.name);
      expect(recoveredNames).toContain("/main.tsx");
      expect(recoveredNames).toContain("/util.ts");

      // Verify we can re-load the pattern by its content identity and run it.
      const loaded = await runtime.patternManager.loadPatternByIdentity(
        entryRef!.identity,
        entryRef!.symbol,
        space,
      );
      expect(loaded).toBeDefined();
      const resultCell = runtime.getCell<{ result: number }>(
        space,
        "pattern-manager: run loaded",
        undefined,
        tx,
      );
      const result = runtime.run(tx, loaded!, { value: 3 }, resultCell);
      await tx.commit().settled;
      tx = runtime.edit();
      await result.pull();
      expect(result.getAsQueryResult()).toEqual({ result: 6 });
    });

    it("names the modules of a program for its main module, and for no other", async () => {
      // A release adopts only stamps of the program it installs, which setup
      // reads here for the pattern's defining module. A pattern defined in a
      // module that no evaluation ran as its main (a nested piece defined in a
      // dependency) has no program recorded, so its release adopts nothing:
      // fail closed. A default re-exported from another file is indexed under
      // the main module that re-exports it, which does name the program.
      const defined = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [
          { name: "/util.ts", contents: "export const one = 1;" },
          {
            name: "/main.tsx",
            contents: [
              "import { pattern } from 'commonfabric';",
              "import { one } from './util.ts';",
              "export default pattern<{ value: number }>(({ value }) => ({",
              "  value, one,",
              "}));",
            ].join("\n"),
          },
        ],
      });
      const entry = runtime.patternManager.getArtifactEntryRef(defined)!;
      const program = runtime.patternManager.programModuleIdentities(
        entry.identity,
      )!;
      expect(program.has(entry.identity)).toBe(true);
      const dependencies = [...program].filter((identity) =>
        identity !== entry.identity
      );
      expect(dependencies.length).toBeGreaterThan(0);
      for (const dependency of dependencies) {
        expect(runtime.patternManager.programModuleIdentities(dependency))
          .toBeUndefined();
      }

      const reexported = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [
          {
            name: "/inner.tsx",
            contents: [
              "import { pattern } from 'commonfabric';",
              "export default pattern<{ value: number }>(({ value }) => ({",
              "  value,",
              "}));",
            ].join("\n"),
          },
          {
            name: "/main.tsx",
            contents: "export { default } from './inner.tsx';",
          },
        ],
      });
      const reexportedEntry = runtime.patternManager.getArtifactEntryRef(
        reexported,
      )!;
      expect(
        runtime.patternManager.programModuleIdentities(reexportedEntry.identity)
          ?.size,
      ).toBe(2);
    });

    it("rejects cross-space recovery of confidential stored source", async () => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            "export default pattern(() => ({ value: 'private' }));",
          ].join("\n"),
        }],
      }, { space });
      await runtime.patternManager.flushCompileCacheWrites();

      const entryIdentity =
        runtime.patternManager.getArtifactEntryRef(compiled)!
          .identity;
      const seed = runtime.edit();
      const sourceCell = runtime.getCell(
        space,
        sourceDocKey(entryIdentity),
        undefined,
        seed,
      );
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, {
        space,
        id: sourceCell.getAsNormalizedFullLink().id,
        type: "application/json",
        path: [],
      }, {
        value: sourceCell.getRawUntyped(),
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["code"],
              label: { confidentiality: ["private-source"] },
            }],
          },
        },
      });
      expect((await seed.commit().settled).ok).toBeDefined();
      await storageManager.synced();

      const inspect = runtime.edit();
      const storedMetadata = readStoredCfcMetadata(inspect, {
        space,
        id: sourceCell.getAsNormalizedFullLink().id,
      });
      expect(storedMetadata?.labelMap.entries).toHaveLength(1);
      expect(sourceCfcMetadataProhibitsCrossSpaceCopy(storedMetadata)).toBe(
        true,
      );
      await inspect.commit().settled;

      const destinationSpace = (await Identity.fromPassphrase(
        "pattern source destination",
      )).did();
      expect(destinationSpace).not.toBe(space);
      const recoveryRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        await expect(
          recoveryRuntime.patternManager.getPatternSourceProgramByIdentity(
            entryIdentity,
            space,
            destinationSpace,
          ),
        ).rejects.toThrow(
          `pattern source ${entryIdentity} carries CFC provenance that cannot be copied`,
        );
      } finally {
        await recoveryRuntime.dispose({ closeStorage: false });
      }
    });
  });

  describe("loadPatternByIdentity() single-flight", () => {
    it("concurrent loads of one identity share a single evaluation's artifact", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      // Runtime A persists the closure; a FRESH runtime B then loads it with
      // cold in-memory indexes, so concurrent calls all miss the sync fast
      // paths and race into the storage/eval tail. Without the single-flight
      // dedup, each call ran its own full SES evaluation of the closure
      // (measured as 4 identical evaluations per cold worker boot); with it,
      // one leader evaluates and every caller resolves to the same shared
      // content-addressed artifact — the behavior sequential callers get.
      const runtimeA = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      let runtimeB: Runtime | undefined;
      try {
        const txA = runtimeA.edit();
        const compiled = await runtimeA.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: [
              "import { pattern, lift } from 'commonfabric';",
              "const inc = lift((x:number)=>x+1);",
              "export default pattern<{ value: number }>(({ value }) => {",
              "  return { result: inc(value) };",
              "});",
            ].join("\n"),
          }],
        }, { space, tx: txA });
        const { identity: entryIdentity, symbol } = runtimeA.patternManager
          .getArtifactEntryRef(compiled)!;
        // Make the closure durable before runtime B reads it.
        await runtimeA.patternManager.flushCompileCacheWrites();
        await txA.commit().settled;
        await storageManager.synced();

        // Runtime B shares the storage but has cold in-memory indexes, so the
        // three concurrent loads all miss the sync fast paths and race into
        // the single-flight tail.
        runtimeB = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        const [first, second, third] = await Promise.all([
          runtimeB.patternManager.loadPatternByIdentity(
            entryIdentity,
            symbol,
            space,
          ),
          runtimeB.patternManager.loadPatternByIdentity(
            entryIdentity,
            symbol,
            space,
          ),
          runtimeB.patternManager.loadPatternByIdentity(
            entryIdentity,
            symbol,
            space,
          ),
        ]);
        expect(first).toBeDefined();
        // One artifact, not three: followers resolve from the leader's indexes.
        expect(second).toBe(first);
        expect(third).toBe(first);
      } finally {
        await runtimeB?.dispose({ closeStorage: false });
        await runtimeA.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });
  });

  describe("loadPatternByIdentity() error handling", () => {
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
      await runtime?.dispose({ closeStorage: false });
      await storageManager?.close();
    });

    it("returns undefined for a missing identity, not a TypeError", async () => {
      const result = await runtime.patternManager.loadPatternByIdentity(
        "nonexistent-pattern-identity",
        "default",
        space,
      );
      expect(result).toBeUndefined();
    });
  });

  describe("compileOrGetPattern()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: IExtendedStorageTransaction;

    const simpleProgram: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "import { pattern } from 'commonfabric';",
            "export default pattern<{ x: number }>(({ x }) => ({ doubled: x }));",
          ].join("\n"),
        },
      ],
    };

    const differentProgram: RuntimeProgram = {
      main: "/main.ts",
      files: [
        {
          name: "/main.ts",
          contents: [
            "import { pattern } from 'commonfabric';",
            "export default pattern<{ y: number }>(({ y }) => ({ tripled: y }));",
          ].join("\n"),
        },
      ],
    };

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      tx = runtime.edit();
    });

    afterEach(async () => {
      await tx.commit().settled;
      await runtime?.dispose({ closeStorage: false });
      await storageManager?.close();
    });

    it("compiles and returns a pattern on first call", async () => {
      const pattern = await runtime.patternManager.compileOrGetPattern(
        simpleProgram,
      );
      expect(pattern).toBeDefined();
      expect(getPatternProgram(pattern)).toBeDefined();
      expect(getPatternProgram(pattern)?.main).toEqual("/main.ts");
    });

    it("returns cached pattern on second call (same instance)", async () => {
      const first = await runtime.patternManager.compileOrGetPattern(
        simpleProgram,
      );
      const second = await runtime.patternManager.compileOrGetPattern(
        simpleProgram,
      );

      // Should be the exact same object instance (cache hit)
      expect(second).toBe(first);
    });

    it("compiles different patterns for different programs", async () => {
      const first = await runtime.patternManager.compileOrGetPattern(
        simpleProgram,
      );
      const second = await runtime.patternManager.compileOrGetPattern(
        differentProgram,
      );

      // Should be different pattern instances
      expect(second).not.toBe(first);
      expect(getPatternProgram(first)?.files[0].contents).toContain("doubled");
      expect(getPatternProgram(second)?.files[0].contents).toContain("tripled");
    });

    it("caches query-result programs by content across cell updates and addresses", async () => {
      const schema = {
        type: "object",
        properties: {
          main: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                contents: { type: "string" },
              },
              required: ["name", "contents"],
            },
          },
        },
        required: ["main", "files"],
      } as const;
      const source = runtime.getCell<RuntimeProgram>(space, "compile-source");
      const otherSource = runtime.getCell<RuntimeProgram>(
        space,
        "other-source",
      );
      await Promise.all([source.sync(), otherSource.sync()]);
      await runtime.editWithRetry((writeTx) => {
        source.withTx(writeTx).set(simpleProgram);
        otherSource.withTx(writeTx).set(simpleProgram);
      });

      const [first, sameContent] = await Promise.all([
        runtime.patternManager.compileOrGetPattern(
          source.asSchema(schema).get(),
        ),
        runtime.patternManager.compileOrGetPattern(
          otherSource.asSchema(schema).get(),
        ),
      ]);
      expect(getPatternProgram(first)).toEqual(simpleProgram);

      await runtime.editWithRetry((writeTx) => {
        source.withTx(writeTx).set(differentProgram);
      });
      const changed = await runtime.patternManager.compileOrGetPattern(
        source.asSchema(schema).get(),
      );
      expect(changed).not.toBe(first);
      expect(sameContent).toBe(first);
      expect(getPatternProgram(changed)).toEqual(differentProgram);
      expect(getPatternProgram(first)).toEqual(simpleProgram);
      expect(await runtime.patternManager.compileOrGetPattern(differentProgram))
        .toBe(changed);
    });

    for (const inputKind of ["plain object", "query result"]) {
      it(`compiles a detached ${inputKind} snapshot across an asynchronous wait`, async () => {
        const program = {
          main: "/main.ts",
          mainExport: "chosen",
          files: [
            {
              name: "/main.ts",
              contents: [
                "import { pattern } from 'commonfabric';",
                "import { value } from './helper.ts';",
                "export const chosen = pattern(() => ({ value }));",
              ].join("\n"),
            },
            { name: "/helper.ts", contents: "export const value = 42;" },
            { name: "/retained.ts", contents: "export const retained = true;" },
            { name: "/data.txt", contents: "attached data" },
          ],
          dataFiles: ["/data.txt"],
          sourceRoots: ["/retained.ts"],
        };
        const source = runtime.getCell<RuntimeProgram>(
          space,
          "delayed-source",
          { type: "object", additionalProperties: true },
        );
        await source.sync();
        await runtime.editWithRetry((writeTx) =>
          source.withTx(writeTx).set(program)
        );
        const expected = {
          ...program,
          files: program.files.map((file) => ({ ...file })),
          dataFiles: [...program.dataFiles],
          sourceRoots: [...program.sourceRoots],
        };
        const compilePattern = runtime.patternManager.compilePattern.bind(
          runtime.patternManager,
        );
        const release = Promise.withResolvers<void>();
        runtime.patternManager.compilePattern = async (input, context) => {
          await release.promise;
          return await compilePattern(input, context);
        };

        const compilation = runtime.patternManager.compileOrGetPattern(
          inputKind === "query result" ? source.get() : program,
        );
        const duplicate = runtime.patternManager.compileOrGetPattern(expected);
        program.main = "/missing.ts";
        program.mainExport = "missing";
        program.files[0].contents = "invalid source";
        program.dataFiles[0] = "/missing.txt";
        program.sourceRoots[0] = "/missing-root.ts";
        await runtime.editWithRetry((writeTx) =>
          source.withTx(writeTx).set(program)
        );
        release.resolve();

        const [compiled, duplicateCompiled] = await Promise.all([
          compilation,
          duplicate,
        ]);
        expect(duplicate).toBe(compilation);
        expect(getPatternProgram(compiled)).toEqual(expected);
        expect(duplicateCompiled).toBe(compiled);
        expect(await runtime.patternManager.compileOrGetPattern(expected)).toBe(
          compiled,
        );
      });
    }

    it("single-flight: concurrent calls share one compilation", async () => {
      // Start multiple compilations concurrently
      const [first, second, third] = await Promise.all([
        runtime.patternManager.compileOrGetPattern(simpleProgram),
        runtime.patternManager.compileOrGetPattern(simpleProgram),
        runtime.patternManager.compileOrGetPattern(simpleProgram),
      ]);

      // All should return the same instance
      expect(second).toBe(first);
      expect(third).toBe(first);
    });

    it("works with string input (single file)", async () => {
      const source = [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ n: number }>(({ n }) => ({ result: n }));",
      ].join("\n");

      const pattern = await runtime.patternManager.compileOrGetPattern(source);
      expect(pattern).toBeDefined();
      expect(getPatternProgram(pattern)?.main).toEqual("/main.tsx");
    });

    it("pattern is cached and returns same instance on subsequent calls", async () => {
      const pattern = await runtime.patternManager.compileOrGetPattern(
        simpleProgram,
      );

      // The pattern should be cached - calling again returns same instance
      const pattern2 = await runtime.patternManager.compileOrGetPattern(
        simpleProgram,
      );
      expect(pattern2).toBe(pattern);

      // And the pattern should have its program attached
      expect(getPatternProgram(pattern)).toBeDefined();
      expect(getPatternProgram(pattern)?.main).toEqual("/main.ts");
    });
  });

  describe("associatePatternProgram()", () => {
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
      await runtime.dispose();
      await storageManager.close();
    });

    it("attaches a source string as a one-file program, which `getPatternProgramBySync()` returns", () => {
      const hand = pattern(() => ({}));
      const ref = { identity: "associate-program-string", symbol: "default" };
      runtime.patternManager.associatePatternIdentity(hand, ref);
      expect(
        runtime.patternManager.getPatternProgramBySync(
          ref.identity,
          ref.symbol,
        ),
      )
        .toBeUndefined();

      runtime.patternManager.associatePatternProgram(hand, "export default 1;");

      const expected = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 1;" }],
      };
      expect(getPatternProgram(hand)).toEqual(expected);
      expect(
        runtime.patternManager.getPatternProgramBySync(
          ref.identity,
          ref.symbol,
        ),
      )
        .toEqual(expected);
      expect(
        runtime.patternManager.getPatternProgramBySync("unindexed", "default"),
      )
        .toBeUndefined();
    });

    it("attaches a program as given, and leaves a pattern's program in place", () => {
      const hand = pattern(() => ({}));
      const program: RuntimeProgram = {
        main: "/entry.ts",
        files: [{ name: "/entry.ts", contents: "export default 2;" }],
      };

      runtime.patternManager.associatePatternProgram(hand, program);
      runtime.patternManager.associatePatternProgram(hand, "export default 3;");

      expect(getPatternProgram(hand)).toEqual(program);
    });
  });

  describe("compile-cache records of hand-written modules", () => {
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
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.dispose();
      await storageManager.close();
    });

    /** Writes a one-module program of `contents` and returns its identity. */
    const writeModule = async (contents: string): Promise<string> => {
      const program = {
        main: "/writer.ts",
        files: [{ name: "/writer.ts", contents }],
      };
      const module: CacheableModule = {
        identity: computeModuleHashes(program).get(program.main)!,
        filename: program.main,
        source: contents,
        js: contents,
        imports: [],
      };
      expect(
        (await runtime.editWithRetry((tx) =>
          writeSourceDocs(runtime, space, [module], module.identity, tx)
        )).error,
      ).toBeUndefined();
      return module.identity;
    };

    /** The address of `identity`'s source record. */
    const sourceRecord = (identity: string) => ({
      space,
      scope: "space" as const,
      id: runtime.getCell(space, sourceDocKey(identity))
        .getAsNormalizedFullLink().id,
      path: [],
    });

    /**
     * Labels `identity`'s source record with a flow stamp holding `atoms`,
     * `space` alone unless they are given.
     */
    const stamp = async (
      identity: string,
      atoms: string[] = [space],
    ): Promise<void> => {
      const tx = runtime.edit();
      writeSeedEnvelopeDoc(tx, space);
      seedStoredEnvelope(tx, sourceRecord(identity), {
        ...storedFields(tx, sourceRecord(identity)),
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              origin: "derived",
              observes: "value",
              label: { confidentiality: atoms },
            }],
          },
        },
      });
      expect((await tx.commit().settled).error).toBeUndefined();
    };

    /** The confidentiality atoms the label on `identity`'s source record holds. */
    const atomsOn = (identity: string): unknown[] => {
      const tx = runtime.edit();
      try {
        return (readStoredCfcMetadata(tx, sourceRecord(identity))?.labelMap
          .entries ?? []).flatMap((entry) => entry.label.confidentiality ?? []);
      } finally {
        tx.abort();
      }
    };

    const prepare = (identity: string) =>
      runtime.patternManager.prepareSourceClosureVerification(space, [
        identity,
      ]);

    describe("prepareSourceClosureVerification()", () => {
      it("tries the refused repair of a stamped closure once, and leaves the stamp", async () => {
        // A carriage return makes the stored code something other than what
        // its identity hashes, which a repair refuses to make canonical.
        const identity = await writeModule("export const a = 1;\r\n");
        await stamp(identity);
        using logs = captureLogs("pattern-manager");

        await prepare(identity);
        await prepare(identity);

        expect(logs.textsOf("compile-cache-stamp-repair")).toEqual([
          `entry=${identity} space=${space} refused`,
        ]);
        expect(atomsOn(identity)).toEqual([space]);
      });

      it("tries the refused repair of a stamped closure once for preparations that overlap", async () => {
        const identity = await writeModule("export const a = 1;\r\n");
        await stamp(identity);
        using logs = captureLogs("pattern-manager");

        await Promise.all([prepare(identity), prepare(identity)]);

        expect(logs.textsOf("compile-cache-stamp-repair")).toEqual([
          `entry=${identity} space=${space} refused`,
        ]);
        expect(atomsOn(identity)).toEqual([space]);
      });

      it("repairs a stamped closure for preparations that overlap, and each ends after the repair", async () => {
        const identity = await writeModule("export const a = 1;\n");
        await stamp(identity);
        using logs = captureLogs("pattern-manager");

        const atoms = await Promise.all(
          [prepare(identity), prepare(identity)].map((prepared) =>
            prepared.then(() => atomsOn(identity))
          ),
        );

        expect(logs.textsOf("compile-cache-stamp-repair")).toEqual([
          `entry=${identity} space=${space} repaired`,
        ]);
        expect(atoms).toEqual([[], []]);
      });

      it("runs one repair for preparations that overlap, and repairs the closure at the next preparation when that one conflicted", async () => {
        // The record changes as the shared repair starts to write, so the
        // repair conflicts and a repair after it would find the closure still
        // stamped.

        const identity = await writeModule("export const a = 1;\n");
        await stamp(identity);
        using logs = captureLogs("pattern-manager");
        const stampServerRun = runtime.stampServerRun.bind(runtime);
        const races: Promise<void>[] = [];

        {
          using _stamp = stub(runtime, "stampServerRun", (tx, info) => {
            if (
              races.length === 0 &&
              info.actionId.startsWith("compile-cache/stamp-repair/")
            ) {
              races.push(stamp(identity, [space, "racing"]));
            }
            stampServerRun(tx, info);
          });
          await Promise.all([prepare(identity), prepare(identity)]);
          await Promise.all(races);
        }
        expect(logs.textsOf("compile-cache-stamp-repair")).toEqual([
          `entry=${identity} space=${space} conflicted`,
        ]);
        expect(atomsOn(identity)).toEqual([space, "racing"]);

        await prepare(identity);

        expect(logs.textsOf("compile-cache-stamp-repair")).toEqual([
          `entry=${identity} space=${space} conflicted`,
          `entry=${identity} space=${space} repaired`,
        ]);
        expect(atomsOn(identity)).toEqual([]);
      });

      it("reports a repair that throws, and repairs the closure at the next preparation", async () => {
        const identity = await writeModule("export const a = 1;\n");
        await stamp(identity);
        using logs = captureLogs("pattern-manager");
        const stampServerRun = runtime.stampServerRun.bind(runtime);

        {
          using _stamp = stub(runtime, "stampServerRun", (tx, info) => {
            if (info.actionId.startsWith("compile-cache/stamp-repair/")) {
              throw new Error("stamp unavailable");
            }
            stampServerRun(tx, info);
          });
          await prepare(identity);
        }
        expect(logs.textsOf("compile-cache-stamp-repair-failed")).toEqual([
          `entry=${identity} space=${space} stamp unavailable`,
        ]);
        expect(atomsOn(identity)).toEqual([space]);

        await prepare(identity);

        expect(logs.textsOf("compile-cache-stamp-repair-failed")).toHaveLength(
          1,
        );
        expect(logs.textsOf("compile-cache-stamp-repair")).toEqual([
          `entry=${identity} space=${space} repaired`,
        ]);
        expect(atomsOn(identity)).toEqual([]);
      });
    });

    describe("proposedSourceUpdateDelegations()", () => {
      it("proposes the previous module for a stored candidate, and nothing for a candidate neither stored nor evaluated", async () => {
        const previous = await writeModule("export const revision = 'old';");
        const candidate = await writeModule("export const revision = 'new';");
        const manager = runtime.patternManager;

        expect(
          await manager.proposedSourceUpdateDelegations(
            space,
            previous,
            candidate,
          ),
        ).toStrictEqual(new Map([[candidate, new Set([previous])]]));
        expect(
          await manager.proposedSourceUpdateDelegations(
            space,
            previous,
            "unknown-candidate",
          ),
        ).toBeUndefined();
      });

      it("proposes nothing to a candidate evaluated with no source paths, whose modules name no file", async () => {
        const previous = await writeModule("export const revision = 'old';");
        const main = { revision: "new" };
        const manager = runtime.patternManager;

        manager.registerEvaluatedModules({
          main,
          exportsByIdentity: new Map([["evaluated-candidate", main]]),
        });

        expect(manager.programModuleIdentities("evaluated-candidate"))
          .toStrictEqual(new Set(["evaluated-candidate"]));
        expect(
          await manager.proposedSourceUpdateDelegations(
            space,
            previous,
            "evaluated-candidate",
          ),
        ).toStrictEqual(new Map());
      });
    });

    describe("the staging after a source update commits", () => {
      /**
       * Commits a source update from one hand-written module to another, waits
       * for the staging that follows, and returns the candidate's identity.
       */
      const commitSourceUpdate = async (): Promise<string> => {
        const previous = await writeModule("export const revision = 'old';");
        const candidate = await writeModule("export const revision = 'new';");
        const manager = runtime.patternManager;
        const prepared = await manager.prepareSourceUpdate(
          space,
          previous,
          candidate,
        );
        const tx = runtime.edit({ sourceUpdate: prepared });
        manager.stageSourceUpdate(prepared, space, previous, candidate, tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await manager.flushCompileCacheWrites();
        return candidate;
      };

      /** The predecessors `identity`'s stored source record lists. */
      const storedDelegations = async (identity: string) => {
        const tx = runtime.edit();
        try {
          const closure = await loadVerifiedSourceClosure(
            runtime,
            space,
            identity,
            tx,
          );
          return closure?.get(identity)?.delegatedModuleIdentities;
        } finally {
          tx.abort();
        }
      };

      it("stages the candidate's delegations on its record, and reports nothing", async () => {
        using logs = captureLogs("pattern-manager");

        const candidate = await commitSourceUpdate();

        expect(await storedDelegations(candidate)).toHaveLength(1);
        expect(logs.textsOf("delegation-staging-failed")).toEqual([]);
      });

      it("reports a staging that fails, and leaves the candidate's record as it was", async () => {
        using logs = captureLogs("pattern-manager");
        const stampServerRun = runtime.stampServerRun.bind(runtime);
        using _stamp = stub(runtime, "stampServerRun", (tx, info) => {
          if (info.actionId.startsWith("compile-cache/delegation-staging/")) {
            throw new Error("staging unavailable");
          }
          stampServerRun(tx, info);
        });

        const candidate = await commitSourceUpdate();

        expect(await storedDelegations(candidate)).toBeUndefined();
        expect(logs.messagesOf("delegation-staging-failed")).toEqual([[
          `staging the delegations of ${candidate} in ${space} failed`,
          expect.objectContaining({ reason: new Error("staging unavailable") }),
        ]]);
      });
    });
  });
});
