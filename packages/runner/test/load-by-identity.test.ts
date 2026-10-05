import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { Source } from "@commonfabric/js-compiler";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  injectCfHelpers,
  isLegacyInjectedEnvelope,
} from "@commonfabric/ts-transformers";

import {
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
  loadVerifiedSourceClosure,
  setCompileCacheRuntimeVersionForTesting,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";
import { Engine } from "../src/harness/engine.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import {
  PatternCoverageCollector,
  type PatternCoverageSpan,
} from "../src/pattern-coverage.ts";
import { Runtime } from "../src/runtime.ts";
import {
  buildRecordsFromCompiled,
  type CachedCompiledModule,
} from "../src/sandbox/module-record-compiler.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("load-by-identity");
const space = signer.did();

describe("load by module identity (warm + version-bump recovery)", () => {
  // The load-by-identity warm path: build + evaluate a pattern directly from
  // cached compiled modules (no TS source, no resolve, no recompile), and the
  // cold-recovery path: recreate the pattern from the stored TypeScript alone
  // (content-addressed source set) when the compiled set is unavailable — the
  // runtime-version-bump scenario.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let engine: Engine;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    engine = runtime.harness as Engine;
    tx = runtime.edit();
  });
  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  const PROGRAM: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      { name: "/util.ts", contents: "export const double = (x:number)=>x*2;" },
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

  const runPattern = async (
    main: Record<string, unknown> | undefined,
    value: number,
    cause: string,
  ): Promise<unknown> => {
    const pattern = (main as { default?: unknown })?.default;
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      cause,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const result = runtime.run(tx, pattern as any, { value }, resultCell);
    await tx.commit().settled;
    tx = runtime.edit();
    await result.pull();
    return result.getAsQueryResult();
  };

  const toCached = (
    modules: {
      identity: string;
      filename: string;
      js: string;
      imports: unknown;
    }[],
  ): CachedCompiledModule[] =>
    modules.map((m) => ({
      identity: m.identity,
      filename: m.filename,
      code: m.js,
      // deno-lint-ignore no-explicit-any
      imports: m.imports as any,
    }));

  it("evaluates a pattern from cached compiled modules (no resolve/compile)", async () => {
    const { modules, entryIdentity } = await engine.compileToRecordGraph(
      PROGRAM,
    );

    // Warm path: build records + evaluate straight from the cached bodies.
    const result = await engine.evaluateCachedModules(
      toCached(modules),
      entryIdentity,
      { sourceFiles: PROGRAM.files },
    );
    expect(result.main).toBeDefined();
    expect(await runPattern(result.main, 4, "warm cached run")).toEqual({
      result: 8,
    });
  });

  it("recreates the pattern from the stored TypeScript alone (runtime-version bump)", async () => {
    // First compile — capture the content-addressed source set (what
    // `pattern:<identity>` cells store: each module's resolved TS + identity).
    const first = await engine.compileToRecordGraph(PROGRAM);
    const storedSource: Source[] = first.modules.map((m) => ({
      name: m.filename,
      contents: m.source,
    }));
    const entryFilename =
      first.modules.find((m) => m.identity === first.entryIdentity)!.filename;

    // Simulate a runtime-version bump: the compiled set (keyed by
    // runtimeVersion) is now a miss, so recover from the stored source alone —
    // no in-hand program, no compiled cache. Recompiling is identity-stable.
    const recovered = await engine.compileResolvedToRecordGraph(
      storedSource,
      entryFilename,
    );

    // Content-addressed: recompiling the stored source reproduces the SAME
    // per-module identities (so the rebuilt compiled set is addressable, and
    // writable-back under the new runtimeVersion).
    expect(recovered.entryIdentity).toBe(first.entryIdentity);
    expect(new Set(recovered.modules.map((m) => m.identity))).toEqual(
      new Set(first.modules.map((m) => m.identity)),
    );

    // And the recreated pattern runs correctly.
    const result = await engine.evaluateCachedModules(
      toCached(recovered.modules),
      recovered.entryIdentity,
      { sourceFiles: storedSource },
    );
    expect(await runPattern(result.main, 5, "recovered run")).toEqual({
      result: 10,
    });
  });

  it("reconstructs a stored pattern an authoring gate now refuses", async () => {
    // This source's result declares a reserved key opaque — a shape older
    // stored patterns hold, and the shape the opaque-reserved-key authoring
    // gate refuses. Admission stays refused (the first assertion). But the
    // cold-recovery path reloads durable stored bytes nobody can re-author,
    // under an identity pin that admits nothing new — a piece pinned to
    // such a pattern must keep loading, or a new authoring rule bricks
    // every deployed piece of an older shape at the next runtime-version
    // bump.
    const legacy: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { NAME, pattern, lift } from 'commonfabric';",
            "const dbl = lift((x:number)=>x*2);",
            "export default pattern<{ value: number }, { [NAME]?: unknown; result: number }>(({ value }) => {",
            "  return { result: dbl(value) };",
            "});",
          ].join("\n"),
        },
      ],
    };

    await expect(engine.compileToRecordGraph(legacy)).rejects.toThrow(
      "declared `unknown`",
    );

    const storedSource: Source[] = legacy.files.map((f) => ({
      name: f.name,
      contents: f.contents,
    }));
    const recovered = await engine.compileResolvedToRecordGraph(
      storedSource,
      legacy.main,
    );
    // Deterministic under reconstruction: the demoted report changes no
    // emitted byte, so the identity a second reconstruction computes is the
    // one the first did — what the caller's stored-identity pin checks.
    const again = await engine.compileResolvedToRecordGraph(
      storedSource,
      legacy.main,
    );
    expect(again.entryIdentity).toBe(recovered.entryIdentity);

    const result = await engine.evaluateCachedModules(
      toCached(recovered.modules),
      recovered.entryIdentity,
      { sourceFiles: storedSource },
    );
    expect(await runPattern(result.main, 6, "legacy reconstruction")).toEqual({
      result: 12,
    });
  });

  it("cold-loads an exact attached source-root package", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      sourceRoots: ["/tests/main.test.tsx"],
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { pattern } from "commonfabric";',
            "export default pattern(() => ({ value: 1 }));",
          ].join("\n"),
        },
        {
          name: "/tests/main.test.tsx",
          contents: [
            'import { pattern } from "commonfabric";',
            'import { expected } from "./support.ts";',
            'import type { Expected } from "./types.d.ts";',
            "const typed: Expected = expected;",
            "export default pattern(() => ({ expected: typed }));",
          ].join("\n"),
        },
        {
          name: "/tests/support.ts",
          contents: "export const expected = 1;",
        },
        {
          name: "/tests/types.d.ts",
          contents: "export type Expected = number;",
        },
      ],
    };
    const compiled = await engine.compileToRecordGraph(program);
    writeSourceDocs(
      runtime,
      space,
      compiled.modules,
      compiled.entryIdentity,
      tx,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    await runtime.storageManager.synced();

    const coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const loaded = await coldRuntime.patternManager.loadPatternByIdentity(
        compiled.entryIdentity,
        "default",
        space,
      );
      expect(typeof loaded).toBe("function");
      const recovered = await coldRuntime.patternManager
        .getPatternSourceProgramByIdentity(compiled.entryIdentity, space);
      expect(recovered?.sourceRoots).toEqual(["/tests/main.test.tsx"]);
      expect(recovered?.files.map((file) => file.name)).toContain(
        "/tests/support.ts",
      );
      expect(recovered?.files.map((file) => file.name)).toContain(
        "/tests/types.d.ts",
      );
      await coldRuntime.patternManager.flushCompileCacheWrites();
      await coldRuntime.storageManager.synced();

      const warmRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const warm = await warmRuntime.patternManager.loadPatternByIdentity(
          compiled.entryIdentity,
          "default",
          space,
        );
        expect(typeof warm).toBe("function");
        const warmSource = await warmRuntime.patternManager
          .getPatternSourceProgramByIdentity(compiled.entryIdentity, space);
        expect(warmSource?.sourceRoots).toEqual(["/tests/main.test.tsx"]);
      } finally {
        await warmRuntime.dispose({ closeStorage: false });
      }
    } finally {
      await coldRuntime.dispose({ closeStorage: false });
    }
  });

  it("resolves a relative data read from cached bodies alone", async () => {
    // The warm path holds no source and no program: it builds records from
    // cached bodies keyed by identity. A read written relative to its module
    // therefore has to resolve from the module's own filename, which is all
    // that path carries.
    const program: RuntimeProgram = {
      main: "/main.tsx",
      dataFiles: ["/lists/cities.json"],
      files: [
        {
          name: "/main.tsx",
          contents: 'export { cities } from "./lists/read.ts";\n',
        },
        {
          name: "/lists/read.ts",
          contents: [
            'import { __cf_data, dataFile } from "commonfabric";',
            "export const cities = __cf_data(",
            '  JSON.parse(dataFile("./cities.json")).cities,',
            ");",
          ].join("\n"),
        },
        { name: "/lists/cities.json", contents: '{"cities": ["Oslo"]}' },
      ],
    };

    const { modules, entryIdentity } = await engine.compileToRecordGraph(
      program,
    );
    const cached: CachedCompiledModule[] = modules.map((m) => ({
      identity: m.identity,
      filename: m.filename,
      code: m.js,
      ...(m.isData ? { isData: true } : {}),
      // deno-lint-ignore no-explicit-any
      imports: m.imports as any,
    }));

    const result = await engine.evaluateCachedModules(cached, entryIdentity);
    expect((result.main as Record<string, unknown>).cities).toEqual(["Oslo"]);
  });

  it("leaves a module's own dataFile export alone on the warm path", async () => {
    // The two record builders each decide which namespaces carry the reader,
    // so each needs the case where a local module exports that name itself.
    const program: RuntimeProgram = {
      main: "/main.tsx",
      dataFiles: ["/cities.json"],
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { __cf_data } from "commonfabric";',
            'import { dataFile } from "./local.ts";',
            "export const read = __cf_data(dataFile('/cities.json'));",
          ].join("\n"),
        },
        {
          name: "/local.ts",
          contents:
            "export const dataFile = (path: string) => `local:${path}`;\n",
        },
        { name: "/cities.json", contents: '{"cities": []}' },
      ],
    };

    const { modules, entryIdentity } = await engine.compileToRecordGraph(
      program,
    );
    const cached: CachedCompiledModule[] = modules.map((m) => ({
      identity: m.identity,
      filename: m.filename,
      code: m.js,
      ...(m.isData ? { isData: true } : {}),
      // deno-lint-ignore no-explicit-any
      imports: m.imports as any,
    }));

    const result = await engine.evaluateCachedModules(cached, entryIdentity);
    expect((result.main as Record<string, unknown>).read).toBe(
      "local:/cities.json",
    );
  });

  it("cold-loads an exact attached data-file package", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      dataFiles: ["/data/cities.json", "/data/notes.txt"],
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { pattern } from "commonfabric";',
            "export default pattern(() => ({ value: 1 }));",
          ].join("\n"),
        },
        {
          name: "/data/cities.json",
          contents: '{"cities": ["Oslo", "Lima"]}',
        },
        {
          // Not TypeScript, and readable as an import edge by a parser that
          // should never see it.
          name: "/data/notes.txt",
          contents: 'import { pattern } from "commonfabric";\nplain text',
        },
      ],
    };
    const compiled = await engine.compileToRecordGraph(program);
    writeSourceDocs(
      runtime,
      space,
      compiled.modules,
      compiled.entryIdentity,
      tx,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    await runtime.storageManager.synced();

    const coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const loaded = await coldRuntime.patternManager.loadPatternByIdentity(
        compiled.entryIdentity,
        "default",
        space,
      );
      expect(typeof loaded).toBe("function");
      const recovered = await coldRuntime.patternManager
        .getPatternSourceProgramByIdentity(compiled.entryIdentity, space);
      expect(recovered?.dataFiles).toEqual([
        "/data/cities.json",
        "/data/notes.txt",
      ]);
      expect(
        recovered?.files.find((file) => file.name === "/data/cities.json")
          ?.contents,
      ).toBe('{"cities": ["Oslo", "Lima"]}');
      await coldRuntime.patternManager.flushCompileCacheWrites();
      await coldRuntime.storageManager.synced();

      const warmRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      try {
        const warm = await warmRuntime.patternManager.loadPatternByIdentity(
          compiled.entryIdentity,
          "default",
          space,
        );
        expect(typeof warm).toBe("function");
        const warmSource = await warmRuntime.patternManager
          .getPatternSourceProgramByIdentity(compiled.entryIdentity, space);
        expect(warmSource?.dataFiles).toEqual([
          "/data/cities.json",
          "/data/notes.txt",
        ]);
      } finally {
        await warmRuntime.dispose({ closeStorage: false });
      }
    } finally {
      await coldRuntime.dispose({ closeStorage: false });
    }
  });

  it("carries attached data-file bytes through the compiled set", async () => {
    // The warm path never reads the source set, so the compiled closure alone
    // has to carry everything the pattern needs — including its data.
    const program: RuntimeProgram = {
      main: "/main.tsx",
      dataFiles: ["/data/cities.json"],
      files: [
        {
          name: "/main.tsx",
          contents: [
            'import { pattern } from "commonfabric";',
            "export default pattern(() => ({ value: 1 }));",
          ].join("\n"),
        },
        { name: "/data/cities.json", contents: '{"cities": ["Oslo"]}' },
      ],
    };
    const compiled = await engine.compileToRecordGraph(program);
    expect(compiled.graph.dataByPath.get("/data/cities.json")).toBe(
      '{"cities": ["Oslo"]}',
    );

    writeSourceDocs(
      runtime,
      space,
      compiled.modules,
      compiled.entryIdentity,
      tx,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    await runtime.storageManager.synced();

    // Cold load first, so the compiled set gets written back.
    const coldRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      expect(
        typeof await coldRuntime.patternManager.loadPatternByIdentity(
          compiled.entryIdentity,
          "default",
          space,
        ),
      ).toBe("function");
      await coldRuntime.patternManager.flushCompileCacheWrites();
      await coldRuntime.storageManager.synced();
    } finally {
      await coldRuntime.dispose({ closeStorage: false });
    }

    // Warm load: the compiled closure alone must yield the data bytes, and the
    // data entry must never become a module record.
    const warmRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const runtimeVersion = await getCompileCacheRuntimeVersion();
      expect(runtimeVersion).toBeDefined();
      const readTx = warmRuntime.edit();
      const closure = await loadCompiledClosure(
        warmRuntime,
        space,
        compiled.entryIdentity,
        { runtimeVersion: runtimeVersion! },
        readTx,
      );
      readTx.abort?.("warm data-file read complete");

      const dataDoc = [...closure.values()].find((doc) =>
        doc.filename === "/data/cities.json"
      );
      expect(dataDoc?.kind).toBe("data");
      expect(dataDoc?.code).toBe('{"cities": ["Oslo"]}');

      const graph = buildRecordsFromCompiled(
        [...closure].map(([identity, doc]) => ({
          identity,
          filename: doc.filename,
          code: doc.code,
          ...(doc.kind === "data" ? { isData: true } : {}),
          imports: doc.imports.map((edge) => ({
            specifier: edge.specifier,
            targetIdentity: edge.identity,
          })),
        })),
      );
      expect(graph.dataByPath.get("/data/cities.json")).toBe(
        '{"cities": ["Oslo"]}',
      );
      expect(
        [...graph.specifierByPath.keys()].includes("/data/cities.json"),
      ).toBe(false);

      expect(
        typeof await warmRuntime.patternManager.loadPatternByIdentity(
          compiled.entryIdentity,
          "default",
          space,
        ),
      ).toBe("function");
    } finally {
      await warmRuntime.dispose({ closeStorage: false });
    }
  });

  it("trusts integrity-gated cached bodies and skips body re-verification", async () => {
    // Spec (module-loading.md, threat model): a warm hit loaded from the
    // integrity-gated compiled set trusts the CFC label, so `trustedBodies`
    // skips the per-module SES verifier. Tamper the entry body with a
    // verify-rejectable but eval-safe top-level statement (a bare call
    // expression — rejected by classification, harmless to execute) appended
    // after the module's exports so `default` still resolves.
    const { modules, entryIdentity } = await engine.compileToRecordGraph(
      PROGRAM,
    );
    const tamperedCached = toCached(modules).map((m) =>
      m.identity === entryIdentity
        ? { ...m, code: `${m.code}\nObject.keys({});\n` }
        : m
    );
    // Untrusted: the SES body verifier rejects the tampered body before eval.
    await expect(
      engine.evaluateCachedModules(tamperedCached, entryIdentity, {
        sourceFiles: PROGRAM.files,
      }),
    ).rejects.toThrow();
    // Trusted (integrity-gated warm hit): body verification is skipped, so the
    // graph evaluates and the pattern runs correctly.
    const trusted = await engine.evaluateCachedModules(
      tamperedCached,
      entryIdentity,
      { sourceFiles: PROGRAM.files, trustedBodies: true },
    );
    expect(await runPattern(trusted.main, 3, "trusted cached run")).toEqual({
      result: 6,
    });
  });
});

describe("legacy-envelope tolerance on cold load", () => {
  // A stored pattern may hold the helper-INJECTED pretransform form as its
  // source-of-record. The authoring guard rejects the reserved `__cfHelpers`
  // symbol, so without tolerance every such stored pattern bricks on cold
  // load — and, via the default pattern, all piece creation in aged spaces.
  // These tests pin the tolerance: exact-envelope stored docs self-heal on
  // load (T1/T2), the authoring guard is untouched (T3), the tolerance is
  // exact-envelope-only (T4), mixed and replicated closures work (T5/T6/T9),
  // and a new pattern can fabric-import a legacy one (T10). The fixture
  // shape is byte-calibrated against a poisoned doc as a real space stores
  // it (see packages/ts-transformers/test/core/legacy-envelope.test.ts):
  // stored bytes = [HELPERS_STMT, source, usedStmt].join("\n"), identities
  // computed over the INJECTED bytes.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  const runtimes: Runtime[] = [];

  const newRuntime = (patternCoverage?: PatternCoverageCollector) => {
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...(patternCoverage === undefined ? {} : { patternCoverage }),
    });
    runtimes.push(rt);
    return rt;
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    for (const rt of runtimes.splice(0)) {
      try {
        await rt.patternManager.flushCompileCacheWrites();
      } catch {
        // Dispose regardless; individual tests assert on write-back success.
      }
      await rt.dispose();
    }
    await storageManager?.close();
  });

  const PROGRAM: RuntimeProgram = {
    main: "/main.tsx",
    files: [
      { name: "/util.ts", contents: "export const double = (x:number)=>x*2;" },
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

  // Simulate the legacy writer: stored source = the INJECTED bytes, identities
  // computed over the injected bytes, no compiled set. The authored compile
  // below is used only to learn the module structure/import graph; its
  // (authored-byte) identities are remapped to the legacy (injected-byte) ones.
  const buildLegacyClosure = async (
    engine: Engine,
    program: RuntimeProgram,
  ): Promise<{ modules: CacheableModule[]; entryIdentity: string }> => {
    const authored = await engine.compileToRecordGraph(program);
    const entryFilename = authored.modules
      .find((m) => m.identity === authored.entryIdentity)!.filename;
    const injectedByFilename = new Map(
      authored.modules.map((m) =>
        [m.filename, injectCfHelpers(m.source, m.filename)] as const
      ),
    );
    const legacyHashes = computeModuleHashes({
      main: entryFilename,
      files: [...injectedByFilename].map(([name, contents]) => ({
        name,
        contents,
      })),
    });
    const legacyByAuthored = new Map(
      authored.modules.map(
        (m) => [m.identity, legacyHashes.get(m.filename)!] as const,
      ),
    );
    const modules: CacheableModule[] = authored.modules.map((m) => ({
      identity: legacyHashes.get(m.filename)!,
      filename: m.filename,
      source: injectedByFilename.get(m.filename)!,
      js: "",
      imports: m.imports.map((i) => ({
        specifier: i.specifier,
        targetIdentity: legacyByAuthored.get(i.targetIdentity) ??
          i.targetIdentity,
      })),
    }));
    return {
      modules,
      entryIdentity: legacyByAuthored.get(authored.entryIdentity)!,
    };
  };

  // Hand-built stored modules (for shapes injectCfHelpers itself refuses to
  // produce, e.g. broken envelopes): identity = hash over the given bytes.
  const storedModules = async (
    entryFilename: string,
    files: { name: string; contents: string }[],
    imports: Record<string, { specifier: string; target: string }[]> = {},
  ): Promise<{ modules: CacheableModule[]; entryIdentity: string }> => {
    await ensureCompilerStack();
    const hashes = computeModuleHashes({ main: entryFilename, files });
    const modules: CacheableModule[] = files.map((f) => ({
      identity: hashes.get(f.name)!,
      filename: f.name,
      source: f.contents,
      js: "",
      imports: (imports[f.name] ?? []).map((i) => ({
        specifier: i.specifier,
        targetIdentity: hashes.get(i.target)!,
      })),
    }));
    return { modules, entryIdentity: hashes.get(entryFilename)! };
  };

  const persist = async (
    runtime: Runtime,
    fixture: { modules: CacheableModule[]; entryIdentity: string },
    toSpace = space,
  ) => {
    const tx = runtime.edit();
    writeSourceDocs(
      runtime,
      toSpace,
      fixture.modules,
      fixture.entryIdentity,
      tx,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.storageManager.synced();
  };

  const runPattern = async (
    runtime: Runtime,
    pattern: unknown,
    value: number,
    cause: string,
    inSpace = space,
  ): Promise<unknown> => {
    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ result: number }>(
      inSpace,
      cause,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const result = runtime.run(tx, pattern as any, { value }, resultCell);
    await tx.commit().settled;
    await result.pull();
    return result.getAsQueryResult();
  };

  for (const withData of [false, true]) {
    it(`cold-loads a child with its parent's source roots${withData ? " and data" : ""}`, async () => {
      const writer = newRuntime();
      const fixture = await writer.harness.compileToRecordGraph({
        main: "/parent.tsx",
        sourceRoots: ["/attached.test.ts"],
        dataFiles: withData ? ["/note.txt"] : [],
        files: [
          {
            name: "/parent.tsx",
            contents: `
import { pattern } from "commonfabric";
import Child from "./child.tsx";
export const offset = 11;
export const childPattern = () => Child;
export default pattern<{value: number}>(({value}) => ({value}));
`,
          },
          {
            name: "/child.tsx",
            contents: `
import { computed, pattern, dataFile } from "commonfabric";
import { offset } from "./parent.tsx";
export default pattern<{value: number}>(({value}) => ({
  result: computed(() => value + offset),
${withData ? '  note: dataFile("./note.txt"),' : ""}
}));
`,
          },
          { name: "/attached.test.ts", contents: "export const fixture = 17;" },
          { name: "/note.txt", contents: "Attached bytes, not TypeScript." },
        ],
      });
      await persist(writer, fixture);
      const child = fixture.modules.find((module) =>
        module.filename === "/child.tsx"
      );
      expect(child).toBeDefined();
      if (!child) throw new Error("Missing child fixture");
      const reader = newRuntime();
      const loaded = await reader.patternManager.loadPatternByIdentity(
        child.identity,
        "default",
        space,
      );
      expect(typeof loaded).toBe("function");
      expect(await runPattern(reader, loaded, 4, "source-package child"))
        .toEqual(
          {
            result: 15,
            ...(withData ? { note: "Attached bytes, not TypeScript." } : {}),
          },
        );
      await reader.patternManager.flushCompileCacheWrites();
      const runtimeVersion = await getCompileCacheRuntimeVersion();
      expect(runtimeVersion).toBeDefined();
      if (!runtimeVersion) throw new Error("Missing runtime version");
      const readTx = reader.edit();
      try {
        const repaired = await loadCompiledClosure(
          reader,
          space,
          child.identity,
          { runtimeVersion },
          readTx,
        );
        const parent = repaired?.get(fixture.entryIdentity);
        expect(
          parent?.imports.filter((edge) =>
            edge.specifier.startsWith("cf:source-root/") ||
            edge.specifier.startsWith("cf:data-file/")
          ),
        )
          .toEqual(
            fixture.modules.find((module) =>
              module.identity === fixture.entryIdentity
            )?.imports.filter((edge) =>
              edge.specifier.startsWith("cf:source-root/") ||
              edge.specifier.startsWith("cf:data-file/")
            ).map(({ specifier, targetIdentity }) => ({
              specifier,
              identity: targetIdentity,
            })),
          );
      } finally {
        readTx.abort("source-package assertions complete");
      }
    });
  }

  it("T1: heals a legacy-envelope closure on cold load, preserving identity", async () => {
    const rt1 = newRuntime();
    const legacy = await buildLegacyClosure(rt1.harness as Engine, PROGRAM);
    // The fixture really is envelope-form, both files.
    for (const m of legacy.modules) {
      expect(isLegacyInjectedEnvelope(m.source)).toBe(true);
    }
    await persist(rt1, legacy);

    // Fresh runtime: no in-memory index, no compiled set → cold recovery.
    const rt2 = newRuntime();
    const loaded = await rt2.patternManager.loadPatternByIdentity(
      legacy.entryIdentity,
      "default",
      space,
    );
    // Load succeeding IS the identity check: pattern-manager throws (and
    // returns undefined) when the recompiled entryIdentity differs from the
    // stored key.
    expect(typeof loaded).toBe("function");
    expect(await runPattern(rt2, loaded, 4, "T1 healed run")).toEqual({
      result: 8,
    });
  });

  it("T2: write-back makes the next load warm, with no source-doc rewrites", async () => {
    const rt1 = newRuntime();
    const legacy = await buildLegacyClosure(rt1.harness as Engine, PROGRAM);
    await persist(rt1, legacy);

    const rt2 = newRuntime();
    const healed = await rt2.patternManager.loadPatternByIdentity(
      legacy.entryIdentity,
      "default",
      space,
    );
    expect(typeof healed).toBe("function");
    await rt2.patternManager.flushCompileCacheWrites();
    await rt2.storageManager.synced();

    const runtimeVersion = await getCompileCacheRuntimeVersion();
    expect(runtimeVersion).toBeDefined();

    // Compiled set exists under the CURRENT runtimeVersion, keyed by the
    // LEGACY identities.
    const readTx = rt2.edit();
    try {
      const compiled = await loadCompiledClosure(
        rt2,
        space,
        legacy.entryIdentity,
        { runtimeVersion: runtimeVersion! },
        readTx,
      );
      expect(compiled.has(legacy.entryIdentity)).toBe(true);
      // The write-back's source-doc write was byte-idempotent: stored source
      // is STILL the verbatim legacy envelope (not normalized/re-injected).
      const source = await loadVerifiedSourceClosure(
        rt2,
        space,
        legacy.entryIdentity,
        readTx,
      );
      const entryDoc = source?.get(legacy.entryIdentity);
      expect(entryDoc?.code).toBe(
        legacy.modules.find((m) => m.identity === legacy.entryIdentity)!
          .source,
      );
      expect(isLegacyInjectedEnvelope(entryDoc!.code)).toBe(true);
    } finally {
      readTx.abort?.("T2 assertion read complete");
    }

    // Third runtime: warm by-identity load — NO cold recompile. No cold
    // compile also means no write-back, i.e. no source-doc writes on the
    // second load.
    const rt3 = newRuntime();
    const engine3 = rt3.harness as Engine;
    let coldCompiles = 0;
    const original = engine3.compileResolvedToRecordGraph.bind(engine3);
    engine3.compileResolvedToRecordGraph =
      ((...args: Parameters<typeof original>) => {
        coldCompiles++;
        return original(...args);
      }) as typeof engine3.compileResolvedToRecordGraph;
    const warm = await rt3.patternManager.loadPatternByIdentity(
      legacy.entryIdentity,
      "default",
      space,
    );
    expect(typeof warm).toBe("function");
    expect(coldCompiles).toBe(0);
    expect(await runPattern(rt3, warm, 6, "T2 warm run")).toEqual({
      result: 12,
    });
  });

  it("T3: authoring guard intact — fresh source with __cfHelpers still throws", async () => {
    const rt = newRuntime();
    const engine = rt.harness as Engine;
    // Mid-file reserved identifier.
    await expect(engine.compileToRecordGraph({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: "const steal = __cfHelpers;\nexport default 1;\n",
      }],
    })).rejects.toThrow("reserved helper symbol");
    // Even a byte-exact ENVELOPE is rejected on the AUTHORING path: tolerance
    // exists only for storage-fetched, Merkle-verified input.
    const envelope = injectCfHelpers(
      "import { pattern } from 'commonfabric';\n" +
        "export default pattern<{ value: number }>(({ value }) => ({ value }));\n",
      "/main.tsx",
    );
    expect(isLegacyInjectedEnvelope(envelope)).toBe(true);
    await expect(engine.compileToRecordGraph({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: envelope }],
    })).rejects.toThrow("reserved helper symbol");
  });

  it("T4: cold tolerance is exact-envelope-only; non-envelope __cfHelpers docs still fail", async () => {
    const rt = newRuntime();
    // Stored doc whose bytes contain __cfHelpers but are NOT the exact
    // envelope (helper import not on line 1).
    const nonEnvelope = "// leading comment\n" + injectCfHelpers(
      "import { pattern } from 'commonfabric';\n" +
        "export default pattern<{ value: number }>(({ value }) => ({ result: value }));\n",
      "/main.tsx",
    );
    expect(isLegacyInjectedEnvelope(nonEnvelope)).toBe(false);
    const bad = await storedModules("/main.tsx", [
      { name: "/main.tsx", contents: nonEnvelope },
    ]);
    await persist(rt, bad);
    const rt2 = newRuntime();
    expect(
      await rt2.patternManager.loadPatternByIdentity(
        bad.entryIdentity,
        "default",
        space,
      ),
    ).toBeUndefined();
  });

  it("T4-pin: interior __cfHelpers INSIDE a valid envelope heals (chosen behavior)", async () => {
    // The predicate is prefix+suffix only, so interior reserved-identifier
    // use within a valid envelope is tolerated. Chosen:
    // `__cfHelpers` grants nothing beyond what injection gives every
    // pattern, and this path only ever sees Merkle-verified stored input.
    // (injectCfHelpers itself refuses such source, so build it by hand —
    // exactly what a raw-cell writer could have stored.)
    const rt = newRuntime();
    await ensureCompilerStack();
    const HELPERS_STMT = 'import { __cfHelpers } from "commonfabric";';
    const TS_TRAILER = "// @ts-ignore: Internals\n" +
      "function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }\n";
    const interior = HELPERS_STMT + "\n" +
      "import { pattern } from 'commonfabric';\n" +
      "const also = __cfHelpers;\n" +
      "export default pattern<{ value: number }>(({ value }) => ({ result: value, kind: typeof also }));\n" +
      "\n" + TS_TRAILER;
    expect(isLegacyInjectedEnvelope(interior)).toBe(true);
    const fixture = await storedModules("/main.tsx", [
      { name: "/main.tsx", contents: interior },
    ]);
    await persist(rt, fixture);
    const rt2 = newRuntime();
    const loaded = await rt2.patternManager.loadPatternByIdentity(
      fixture.entryIdentity,
      "default",
      space,
    );
    expect(typeof loaded).toBe("function");
  });

  it("T5: mixed closures heal per-file, in both directions", async () => {
    await ensureCompilerStack();
    const utilAuthored = "export const double = (x:number)=>x*2;";
    const entryAuthored = [
      "import { pattern, lift } from 'commonfabric';",
      "import { double } from './util.ts';",
      "const dbl = lift((x:number)=>double(x));",
      "export default pattern<{ value: number }>(({ value }) => {",
      "  return { result: dbl(value) };",
      "});",
    ].join("\n");

    // (a) LEGACY entry importing an AUTHORED-form module.
    const rtA = newRuntime();
    const mixedA = await storedModules("/main.tsx", [
      { name: "/util.ts", contents: utilAuthored },
      {
        name: "/main.tsx",
        contents: injectCfHelpers(entryAuthored, "/main.tsx"),
      },
    ], {
      "/main.tsx": [{ specifier: "./util.ts", target: "/util.ts" }],
    });
    await persist(rtA, mixedA);
    const rtA2 = newRuntime();
    const loadedA = await rtA2.patternManager.loadPatternByIdentity(
      mixedA.entryIdentity,
      "default",
      space,
    );
    expect(typeof loadedA).toBe("function");
    expect(await runPattern(rtA2, loadedA, 3, "T5a mixed run")).toEqual({
      result: 6,
    });

    // (b) AUTHORED entry importing a LEGACY-form module.
    const rtB = newRuntime();
    const mixedB = await storedModules("/main.tsx", [
      {
        name: "/util.ts",
        contents: injectCfHelpers(utilAuthored, "/util.ts"),
      },
      { name: "/main.tsx", contents: entryAuthored },
    ], {
      "/main.tsx": [{ specifier: "./util.ts", target: "/util.ts" }],
    });
    await persist(rtB, mixedB);
    const rtB2 = newRuntime();
    const loadedB = await rtB2.patternManager.loadPatternByIdentity(
      mixedB.entryIdentity,
      "default",
      space,
    );
    expect(typeof loadedB).toBe("function");
    expect(await runPattern(rtB2, loadedB, 5, "T5b mixed run")).toEqual({
      result: 10,
    });
  });

  it("T6: replication copies legacy bytes VERBATIM; destination cold load heals", async () => {
    const spaceB = (await Identity.fromPassphrase("legacy replication B"))
      .did();
    const rt1 = newRuntime();
    const legacy = await buildLegacyClosure(rt1.harness as Engine, PROGRAM);
    await persist(rt1, legacy);

    // Heal in the origin space (writes back compiled docs), then replicate.
    const rt2 = newRuntime();
    const loaded = await rt2.patternManager.loadPatternByIdentity(
      legacy.entryIdentity,
      "default",
      space,
    );
    expect(typeof loaded).toBe("function");
    await rt2.patternManager.flushCompileCacheWrites();
    rt2.patternManager.replicatePatternToSpace(loaded!, spaceB, space);
    await rt2.patternManager.flushCompileCacheWrites();
    await rt2.storageManager.synced();

    // Destination stored source is the VERBATIM legacy envelope — no
    // normalization in `PatternManager.#replicateClosures()` (normalizing
    // would rotate the identity, the exact failure the design rules out).
    const readTx = rt2.edit();
    try {
      const replicated = await loadVerifiedSourceClosure(
        rt2,
        spaceB,
        legacy.entryIdentity,
        readTx,
      );
      const entryDoc = replicated?.get(legacy.entryIdentity);
      expect(entryDoc?.code).toBe(
        legacy.modules.find((m) => m.identity === legacy.entryIdentity)!
          .source,
      );
      expect(isLegacyInjectedEnvelope(entryDoc!.code)).toBe(true);
    } finally {
      readTx.abort?.("T6 assertion read complete");
    }

    // Force a COLD load in the destination (a later pin bump: compiled set
    // is keyed by runtimeVersion, so a bumped version misses it) — the
    // replicated legacy source must heal again.
    const restore = setCompileCacheRuntimeVersionForTesting(
      "cf-test-bumped-runtime-version",
    );
    try {
      const rt3 = newRuntime();
      const engine3 = rt3.harness as Engine;
      let coldCompiles = 0;
      const original = engine3.compileResolvedToRecordGraph.bind(engine3);
      engine3.compileResolvedToRecordGraph =
        ((...args: Parameters<typeof original>) => {
          coldCompiles++;
          return original(...args);
        }) as typeof engine3.compileResolvedToRecordGraph;
      const healed = await rt3.patternManager.loadPatternByIdentity(
        legacy.entryIdentity,
        "default",
        spaceB,
      );
      expect(typeof healed).toBe("function");
      expect(coldCompiles).toBe(1);
      expect(
        await runPattern(rt3, healed, 7, "T6 destination run", spaceB),
      ).toEqual({ result: 14 });
    } finally {
      restore();
    }
  });

  //
  // Companion negative-memo coverage
  //
  // Only failures explicitly classified after source verification may suppress
  // later attempts. Every transient boundary is exercised by making the missing
  // state arrive in-session.
  //

  it("T8a: a deterministic compile failure is memoized", async () => {
    const rt = newRuntime();
    const nonEnvelope = "// leading comment\n" + injectCfHelpers(
      "import { pattern } from 'commonfabric';\n" +
        "export default pattern<{ value: number }>(({ value }) => ({ result: value }));\n",
      "/main.tsx",
    );
    const bad = await storedModules("/main.tsx", [
      { name: "/main.tsx", contents: nonEnvelope },
    ]);
    await persist(rt, bad);

    const rt2 = newRuntime();
    const engine2 = rt2.harness as Engine;
    let coldCompiles = 0;
    const original = engine2.compileResolvedToRecordGraph.bind(engine2);
    engine2.compileResolvedToRecordGraph =
      ((...args: Parameters<typeof original>) => {
        coldCompiles++;
        return original(...args);
      }) as typeof engine2.compileResolvedToRecordGraph;
    expect(
      await rt2.patternManager.loadPatternByIdentity(
        bad.entryIdentity,
        "default",
        space,
      ),
    ).toBeUndefined();
    expect(coldCompiles).toBe(1);
    expect(
      await rt2.patternManager.loadPatternByIdentity(
        bad.entryIdentity,
        "default",
        space,
      ),
    ).toBeUndefined();
    expect(coldCompiles).toBe(1);
  });

  it("T8b: an absent closure is never memoized", async () => {
    const rt = newRuntime();
    const rt2 = newRuntime();
    const late = await storedModules("/late.tsx", [{
      name: "/late.tsx",
      contents: "import { pattern } from 'commonfabric';\n" +
        "export default pattern<{ value: number }>(({ value }) => ({ result: value }));\n",
    }]);
    expect(
      await rt2.patternManager.loadPatternByIdentity(
        late.entryIdentity,
        "default",
        space,
      ),
    ).toBeUndefined();
    await persist(rt, late);
    expect(
      typeof await rt2.patternManager.loadPatternByIdentity(
        late.entryIdentity,
        "default",
        space,
      ),
    ).toBe("function");
  });

  it("T8c: a partial closure verify failure is never memoized", async () => {
    // When a linked child has not arrived yet, loadSourceClosure omits that
    // edge; verification reports a root hash mismatch rather than `missing`.
    // The classification must therefore stay retryable regardless of the
    // exact verification detail.
    const rt = newRuntime();
    const rt2 = newRuntime();
    const fixture = await storedModules("/main.tsx", [
      {
        name: "/dep.ts",
        contents: "export const add = (value: number) => value + 2;",
      },
      {
        name: "/main.tsx",
        contents: "import { pattern } from 'commonfabric';\n" +
          "import { add } from './dep.ts';\n" +
          "export default pattern<{ value: number }>(({ value }) => ({ result: add(value) }));\n",
      },
    ], {
      "/main.tsx": [{ specifier: "./dep.ts", target: "/dep.ts" }],
    });
    const entry = fixture.modules.find((module) =>
      module.identity === fixture.entryIdentity
    )!;
    // Publish only the root; its stored link points to the not-yet-present dep.
    await persist(rt, {
      modules: [entry],
      entryIdentity: fixture.entryIdentity,
    });
    expect(
      await rt2.patternManager.loadPatternByIdentity(
        fixture.entryIdentity,
        "default",
        space,
      ),
    ).toBeUndefined();

    // Once the dependency arrives, the same PatternManager session retries
    // verification/compile and succeeds.
    await persist(rt, fixture);
    const loaded = await rt2.patternManager.loadPatternByIdentity(
      fixture.entryIdentity,
      "default",
      space,
    );
    expect(typeof loaded).toBe("function");
    expect(await runPattern(rt2, loaded, 5, "T8c partial retry")).toEqual({
      result: 7,
    });
  });

  it("T8d: a runtimeVersion change reopens a memoized identity", async () => {
    const rt = newRuntime();
    const nonEnvelope = "// bad versioned\n" + injectCfHelpers(
      "import { pattern } from 'commonfabric';\n" +
        "export default pattern<{ value: number }>(({ value }) => ({ result: value }));\n",
      "/main.tsx",
    );
    const bad = await storedModules("/main.tsx", [
      { name: "/main.tsx", contents: nonEnvelope },
    ]);
    await persist(rt, bad);

    const restoreV1 = setCompileCacheRuntimeVersionForTesting("memo-v1");
    try {
      const rt2 = newRuntime();
      const engine2 = rt2.harness as Engine;
      let coldCompiles = 0;
      const original = engine2.compileResolvedToRecordGraph.bind(engine2);
      engine2.compileResolvedToRecordGraph =
        ((...args: Parameters<typeof original>) => {
          coldCompiles++;
          return original(...args);
        }) as typeof engine2.compileResolvedToRecordGraph;
      const load = () =>
        rt2.patternManager.loadPatternByIdentity(
          bad.entryIdentity,
          "default",
          space,
        );
      expect(await load()).toBeUndefined();
      expect(await load()).toBeUndefined();
      expect(coldCompiles).toBe(1);

      const restoreV2 = setCompileCacheRuntimeVersionForTesting("memo-v2");
      try {
        expect(await load()).toBeUndefined();
        expect(coldCompiles).toBe(2);
      } finally {
        restoreV2();
      }
    } finally {
      restoreV1();
    }
  });

  it("T8e: a transient fabric-resolution miss is never memoized", async () => {
    const rt = newRuntime();
    const rt2 = newRuntime();
    const dependency = await storedModules("/dep.tsx", [{
      name: "/dep.tsx",
      contents: "import { pattern } from 'commonfabric';\n" +
        "export default pattern<{ value: number }>(({ value }) => ({ doubled: value * 2 }));\n",
    }]);
    const importer = await storedModules("/main.tsx", [{
      name: "/main.tsx",
      contents: "import { pattern } from 'commonfabric';\n" +
        `import dep from "cf:pattern:${dependency.entryIdentity}";\n` +
        "export default pattern<{ value: number }>(({ value }) => ({ child: dep({ value }) }));\n",
    }]);
    await persist(rt, importer);

    // The verified importer exists, but resolving its fabric mount cannot yet
    // find the dependency. Resolution sits outside the deterministic marker.
    expect(
      await rt2.patternManager.loadPatternByIdentity(
        importer.entryIdentity,
        "default",
        space,
      ),
    ).toBeUndefined();
    await persist(rt, dependency);

    const loaded = await rt2.patternManager.loadPatternByIdentity(
      importer.entryIdentity,
      "default",
      space,
    );
    expect(typeof loaded).toBe("function");
    expect(await runPattern(rt2, loaded, 6, "T8e resolver retry")).toEqual({
      child: { doubled: 12 },
    });
  });

  it("T8f: a recompiled-identity mismatch is memoized", async () => {
    const rt = newRuntime();
    const fixture = await storedModules("/main.tsx", [{
      name: "/main.tsx",
      contents: "import { pattern } from 'commonfabric';\n" +
        "export default pattern<{ value: number }>(({ value }) => ({ result: value }));\n",
    }]);
    await persist(rt, fixture);

    // Compiler drift: the recompile succeeds but emits a different entry
    // identity than the stored reference. That mismatch is deterministic for
    // this runtime version, so the memo suppresses the second attempt.
    const rt2 = newRuntime();
    const engine2 = rt2.harness as Engine;
    let coldCompiles = 0;
    const original = engine2.compileResolvedToRecordGraph.bind(engine2);
    engine2.compileResolvedToRecordGraph = (async (
      ...args: Parameters<typeof original>
    ) => {
      coldCompiles++;
      const compiled = await original(...args);
      return { ...compiled, entryIdentity: `${compiled.entryIdentity}-drift` };
    }) as typeof engine2.compileResolvedToRecordGraph;
    const load = () =>
      rt2.patternManager.loadPatternByIdentity(
        fixture.entryIdentity,
        "default",
        space,
      );
    expect(await load()).toBeUndefined();
    expect(await load()).toBeUndefined();
    expect(coldCompiles).toBe(1);
  });

  it("retries a coverage-collector failure", async () => {
    class FailOnceCoverage extends PatternCoverageCollector {
      #failed = false;

      override registerSpan(span: PatternCoverageSpan): void {
        if (!this.#failed) {
          this.#failed = true;
          throw new Error("transient coverage sink failure");
        }
        super.registerSpan(span);
      }
    }

    const rt = newRuntime();
    const fixture = await storedModules("/main.tsx", [{
      name: "/main.tsx",
      contents: "import { pattern } from 'commonfabric';\n" +
        "export default pattern<{ value: number }>(({ value }) => ({ result: value }));\n",
    }]);
    await persist(rt, fixture);

    const rt2 = newRuntime(new FailOnceCoverage());
    expect(
      await rt2.patternManager.loadPatternByIdentity(
        fixture.entryIdentity,
        "default",
        space,
      ),
    ).toBeUndefined();

    const loaded = await rt2.patternManager.loadPatternByIdentity(
      fixture.entryIdentity,
      "default",
      space,
    );
    expect(typeof loaded).toBe("function");
  });

  //
  // Tolerance on the remaining load paths
  //
  // The T1-T6 battery drives the plain cold load. T9 crosses a JS-trailer
  // module variant through that same path, and T10 the authoring path, which
  // feeds storage-fetched mounts through its own `injectMountSources` call
  // and so needs the tolerance in a second place.
  //

  it("T9: JS-trailer variant (.jsx module) heals through the cold path", async () => {
    await ensureCompilerStack();
    const utilJs = "export const double = (x)=>x*2;";
    const utilInjected = injectCfHelpers(utilJs, "/util.jsx");
    // The JS variant really did take the syntax-neutral trailer.
    expect(utilInjected).toContain("function h(...args) {");
    expect(isLegacyInjectedEnvelope(utilInjected)).toBe(true);
    const entryAuthored = [
      "import { pattern, lift } from 'commonfabric';",
      "import { double } from './util.jsx';",
      "const dbl = lift((x:number)=>double(x));",
      "export default pattern<{ value: number }>(({ value }) => {",
      "  return { result: dbl(value) };",
      "});",
    ].join("\n");
    const rt = newRuntime();
    const fixture = await storedModules("/main.tsx", [
      { name: "/util.jsx", contents: utilInjected },
      {
        name: "/main.tsx",
        contents: injectCfHelpers(entryAuthored, "/main.tsx"),
      },
    ], {
      "/main.tsx": [{ specifier: "./util.jsx", target: "/util.jsx" }],
    });
    await persist(rt, fixture);
    const rt2 = newRuntime();
    const loaded = await rt2.patternManager.loadPatternByIdentity(
      fixture.entryIdentity,
      "default",
      space,
    );
    expect(typeof loaded).toBe("function");
    expect(await runPattern(rt2, loaded, 4, "T9 jsx run")).toEqual({
      result: 8,
    });
  });

  it("T10: authoring-path compile of a NEW pattern fabric-importing the legacy fixture succeeds", async () => {
    // The warm/authoring path (`compileToRecordGraph`) has its own
    // `injectMountSources` call feeding storage-fetched mounts into the
    // transformer, so the tolerance must live INSIDE injectMountSources too:
    // without it, a new pattern fabric-importing a legacy (envelope-form)
    // pattern is bricked whatever the cold path does.
    const rt = newRuntime();
    const legacyDep = await buildLegacyClosure(rt.harness as Engine, {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export const x = 7;",
          "export default pattern<{ value: number }>(({ value }) => ({ dep: value + x }));",
        ].join("\n"),
      }],
    });
    await persist(rt, legacyDep);

    const rt2 = newRuntime();
    const importer = await rt2.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern } from 'commonfabric';",
          `import dep, { x } from "cf:pattern:${legacyDep.entryIdentity}";`,
          "export default pattern<{ value: number }>(({ value }) => {",
          "  const child = dep({ value });",
          "  return { result: value + x, child };",
          "});",
        ].join("\n"),
      }],
    }, { space });
    expect(typeof importer).toBe("function");
    await rt2.patternManager.flushCompileCacheWrites();
    const out = await runPattern(rt2, importer, 2, "T10 importer run") as {
      result: number;
      child: { dep: number };
    };
    expect(out.result).toBe(9);
    expect(out.child).toEqual({ dep: 9 });
  });
});
