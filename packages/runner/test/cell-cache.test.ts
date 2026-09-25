import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import {
  computeModuleHashes,
  resolveModuleImports,
} from "../src/harness/module-identity.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import type { JSONSchema } from "../src/builder/types.ts";

import {
  buildSourceDocs,
  codeFieldVerifies,
  COMPILED_INTEGRITY_ATOM,
  compiledDocKey,
  compiledDocWriteSchema,
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
  loadSourceClosure,
  loadVerifiedSourceClosure,
  ROOT_LINK_SPECIFIER,
  type SourceDoc,
  sourceDocKey,
  verifySourceDocs,
  writeCompiledDocs,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";
import { parseLink } from "../src/link-utils.ts";
import { compileCachePersistenceSlotKey } from "../src/pattern-manager.ts";
import type { URI } from "../src/sigil-types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { observeCacheWriteBacks } from "./support/telemetry-observers.ts";

import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";
import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { PatternCoverageCollector } from "../src/pattern-coverage.ts";
import { pattern } from "../src/builder/pattern.ts";
import {
  dataFileSpecifier,
  sourceRootSpecifier,
} from "../src/sandbox/module-record-compiler.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

// These tests drive the sync parse internals directly (below the async flow
// boundaries that normally load the deferred compiler stack), so load it here.
await ensureCompilerStack();

const signer = await Identity.fromPassphrase("cell-cache test");
const resolvedRuntimeVersion = await getCompileCacheRuntimeVersion();
if (resolvedRuntimeVersion === undefined) {
  throw new Error("compile-cache runtime version unavailable in Deno test");
}
const runtimeVersion = resolvedRuntimeVersion;

// Step 4.3.1–4.3.3 — content-addressed cache document model. The cache operates
// in identity space on the engine's `CacheableModule[]`; these tests synthesize
// an equivalent module set from a small program (computing the same per-module
// identities + import edges the engine would).

const PROGRAM = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        `import { helper } from "./util.ts";`,
        `import type { Thing } from "./types.ts";`,
        `export const run = (t: Thing) => helper(t.n);`,
      ].join("\n"),
    },
    {
      name: "/util.ts",
      contents: `export const helper = (n: number) => n + 1;`,
    },
    { name: "/types.ts", contents: `export interface Thing { n: number; }` },
  ],
};

/** Synthesize the engine's `CacheableModule[]` from an authored program. */
function toModules(
  program: RuntimeProgram,
): { modules: CacheableModule[]; entryIdentity: string } {
  const ids = computeModuleHashes(program);
  const edges = resolveModuleImports(program);
  const modules = program.files.map((f) => ({
    identity: ids.get(f.name)!,
    filename: f.name,
    source: f.contents,
    js: `/* compiled */ ${f.name}`,
    imports: (edges.get(f.name)?.internalDeps ?? []).map((d) => ({
      specifier: d.specifier,
      targetIdentity: ids.get(d.target)!,
    })),
  }));
  return { modules, entryIdentity: ids.get(program.main)! };
}

const identityOf = (program: typeof PROGRAM, path: string) =>
  computeModuleHashes(program).get(path)!;

function fabricLinkedModules(): {
  modules: CacheableModule[];
  importerIdentity: string;
  depIdentity: string;
  fabricSpecifier: string;
} {
  const depProgram = {
    main: "/dep.ts",
    files: [
      { name: "/dep.ts", contents: "export const x = 1;" },
    ],
  };
  const depIdentity = computeModuleHashes(depProgram).get("/dep.ts")!;
  const fabricSpecifier = `cf:pattern:${depIdentity}`;
  const importerProgram = {
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents:
          `import { x } from "${fabricSpecifier}";\nexport function y() { return x + 1; }`,
      },
    ],
  };
  const importerIdentity = computeModuleHashes(importerProgram).get(
    "/main.tsx",
  )!;
  return {
    importerIdentity,
    depIdentity,
    fabricSpecifier,
    modules: [
      {
        identity: importerIdentity,
        filename: "/main.tsx",
        source: importerProgram.files[0].contents,
        js: "/* compiled importer */",
        imports: [{ specifier: fabricSpecifier, targetIdentity: depIdentity }],
      },
      {
        identity: depIdentity,
        filename: "/dep.ts",
        source: depProgram.files[0].contents,
        js: "/* compiled dependency */",
        imports: [],
      },
    ],
  };
}

// Two distinct signers for the two "users" in the e2e describe.
// Declared at module level so top-level await applies.
const e2eSignerA = await Identity.fromPassphrase("cell-cache-e2e user A");
const e2eSignerB = await Identity.fromPassphrase("cell-cache-e2e user B");

describe("cell-cache", () => {
  describe("keys", () => {
    it("formats source and compiled document keys", () => {
      expect(sourceDocKey("abc")).toBe("pattern:abc");
      expect(compiledDocKey("rt1", "abc")).toBe("compileCache:rt1/abc");
    });
  });

  describe("buildSourceDocs", () => {
    it("keys each module by its identity and records resolved import links", () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const docs = buildSourceDocs(modules, entryIdentity);

      // One document per module, keyed by identity.
      expect(docs.size).toBe(3);

      const entry = docs.get(identityOf(PROGRAM, "/main.tsx"))!;
      expect(entry.kind).toBe("source");
      expect(entry.filename).toBe("/main.tsx");
      // Both the value import (util) and the type import (types) are linked.
      const linked = entry.imports
        .map((i) => `${i.specifier}->${i.identity}`)
        .sort();
      expect(linked).toEqual([
        `./types.ts->${identityOf(PROGRAM, "/types.ts")}`,
        `./util.ts->${identityOf(PROGRAM, "/util.ts")}`,
      ]);
    });

    it("links otherwise-unreachable modules from the entry document", () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      // Append an isolated module (like the injected cfc.ts helper): part of
      // the emitted set, but with no incoming import edge.
      const isolated: CacheableModule = {
        identity: "iso-identity",
        filename: "cfc.ts",
        source: "export {};",
        js: "/* iso */",
        imports: [],
      };
      const docs = buildSourceDocs([...modules, isolated], entryIdentity);
      const entry = docs.get(entryIdentity)!;
      // The entry now carries a synthetic root link to the isolated module.
      const rootLink = entry.imports.find((i) =>
        i.specifier === `${ROOT_LINK_SPECIFIER}iso-identity`
      );
      expect(rootLink?.identity).toBe("iso-identity");
    });
  });

  describe("`verifySourceDocs()` (Merkle self-verification)", () => {
    it("accepts a faithfully-built closure", () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const docs = buildSourceDocs(modules, entryIdentity);
      const v = verifySourceDocs(entryIdentity, docs);
      expect(v.ok).toBe(true);
      expect(v.entryFilename).toBe("/main.tsx");
      expect(v.mismatches).toEqual([]);
      expect(v.missing).toEqual([]);
    });

    it("flags a missing entry document", () => {
      const v = verifySourceDocs("missing-entry", new Map());
      expect(v.ok).toBe(false);
      expect(v.mismatches).toEqual([]);
      expect(v.missing).toEqual(["missing-entry"]);
    });

    it("rejects a tampered document (recomputed identity != key)", () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const docs = new Map(buildSourceDocs(modules, entryIdentity));
      const utilIdentity = identityOf(PROGRAM, "/util.ts");
      const util = docs.get(utilIdentity)!;
      // Keep the key, change the body — content no longer hashes to its key.
      docs.set(utilIdentity, {
        ...util,
        code: `export const helper = (n) => n + 999;`,
      });

      const v = verifySourceDocs(entryIdentity, docs);
      expect(v.ok).toBe(false);
      expect(v.mismatches).toContain(utilIdentity);
    });

    it("flags a missing import-link target", () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const docs = new Map(buildSourceDocs(modules, entryIdentity));
      docs.delete(identityOf(PROGRAM, "/util.ts"));
      const v = verifySourceDocs(entryIdentity, docs);
      expect(v.ok).toBe(false);
      expect(v.missing).toContain(identityOf(PROGRAM, "/util.ts"));
    });

    it("rejects removing a source-package root edge", () => {
      const files = [
        { name: "/main.tsx", contents: "export default 1;" },
        { name: "/main.test.tsx", contents: "export default 2;" },
      ];
      const rootSpecifier = sourceRootSpecifier("/main.test.tsx");
      const identities = computeModuleHashes(
        { main: "/main.tsx", files },
        {
          additionalInternalDeps: new Map([
            [
              "/main.tsx",
              [{ specifier: rootSpecifier, target: "/main.test.tsx" }],
            ],
          ]),
        },
      );
      const entryIdentity = identities.get("/main.tsx")!;
      const testIdentity = identities.get("/main.test.tsx")!;
      const docs = buildSourceDocs(
        [
          {
            identity: entryIdentity,
            filename: "/main.tsx",
            source: files[0].contents,
            js: "",
            imports: [{
              specifier: rootSpecifier,
              targetIdentity: testIdentity,
            }],
          },
          {
            identity: testIdentity,
            filename: "/main.test.tsx",
            source: files[1].contents,
            js: "",
            imports: [],
          },
        ],
        entryIdentity,
      );
      expect(verifySourceDocs(entryIdentity, docs).ok).toBe(true);

      const tampered = new Map(docs);
      tampered.set(entryIdentity, {
        ...docs.get(entryIdentity)!,
        imports: [],
      });
      const verification = verifySourceDocs(entryIdentity, tampered);
      expect(verification.ok).toBe(false);
      expect(verification.mismatches).toContain(entryIdentity);
    });

    it("rejects removing a source-package data-file edge", () => {
      // The data file's bytes parse as an import in TypeScript. Verification
      // must hash it as a leaf, or its identity will not reproduce.
      const files = [
        { name: "/main.tsx", contents: "export default 1;" },
        { name: "/notes.txt", contents: 'import x from "./main.tsx";' },
      ];
      const dataSpecifier = dataFileSpecifier("/notes.txt");
      const identities = computeModuleHashes(
        { main: "/main.tsx", files },
        {
          additionalInternalDeps: new Map([
            ["/main.tsx", [{ specifier: dataSpecifier, target: "/notes.txt" }]],
          ]),
          dataFiles: new Set(["/notes.txt"]),
        },
      );
      const entryIdentity = identities.get("/main.tsx")!;
      const dataIdentity = identities.get("/notes.txt")!;
      const docs = buildSourceDocs(
        [
          {
            identity: entryIdentity,
            filename: "/main.tsx",
            source: files[0].contents,
            js: "",
            imports: [{
              specifier: dataSpecifier,
              targetIdentity: dataIdentity,
            }],
          },
          {
            identity: dataIdentity,
            filename: "/notes.txt",
            source: files[1].contents,
            js: "",
            imports: [],
          },
        ],
        entryIdentity,
      );
      expect(verifySourceDocs(entryIdentity, docs).ok).toBe(true);

      const tampered = new Map(docs);
      tampered.set(entryIdentity, {
        ...docs.get(entryIdentity)!,
        imports: [],
      });
      const verification = verifySourceDocs(entryIdentity, tampered);
      expect(verification.ok).toBe(false);
      expect(verification.mismatches).toContain(entryIdentity);
    });

    it("rejects tampering with an attached data file's bytes", () => {
      const files = [
        { name: "/main.tsx", contents: "export default 1;" },
        { name: "/data.json", contents: '{"a": 1}' },
      ];
      const dataSpecifier = dataFileSpecifier("/data.json");
      const identities = computeModuleHashes(
        { main: "/main.tsx", files },
        {
          additionalInternalDeps: new Map([
            ["/main.tsx", [{ specifier: dataSpecifier, target: "/data.json" }]],
          ]),
          dataFiles: new Set(["/data.json"]),
        },
      );
      const entryIdentity = identities.get("/main.tsx")!;
      const dataIdentity = identities.get("/data.json")!;
      const docs = buildSourceDocs(
        [
          {
            identity: entryIdentity,
            filename: "/main.tsx",
            source: files[0].contents,
            js: "",
            imports: [{
              specifier: dataSpecifier,
              targetIdentity: dataIdentity,
            }],
          },
          {
            identity: dataIdentity,
            filename: "/data.json",
            source: files[1].contents,
            js: "",
            imports: [],
          },
        ],
        entryIdentity,
      );

      const tampered = new Map(docs);
      tampered.set(dataIdentity, {
        ...docs.get(dataIdentity)!,
        code: '{"a": 2}',
      });
      const verification = verifySourceDocs(entryIdentity, tampered);
      expect(verification.ok).toBe(false);
      expect(verification.mismatches).toContain(dataIdentity);
    });

    it("is entry-point independent (util identity is stable across entries)", () => {
      const viaMain = identityOf(PROGRAM, "/util.ts");
      const utilEntry = { ...PROGRAM, main: "/util.ts" };
      const viaUtil = computeModuleHashes(utilEntry).get("/util.ts")!;
      expect(viaUtil).toBe(viaMain);
    });

    it("accepts a closure holding two generations of one ambient filename (2026-07-10 board outage)", () => {
      // Seal 1 (older runtime): a leaf pattern plus that runtime's injected
      // ambient helper. The ambient has no import edge, so buildSourceDocs
      // root-links it from the seal's entry — the leaf document.
      const ambientModule = (source: string): CacheableModule => ({
        identity: computeModuleHashes({
          main: "/cfc.ts",
          files: [{ name: "/cfc.ts", contents: source }],
        }).get("/cfc.ts")!,
        filename: "/cfc.ts",
        source,
        js: "/* ambient */",
        imports: [],
      });
      const oldAmbient = ambientModule("export const gen = 'old';");
      const leafProgram = {
        main: "/leaf.tsx",
        files: [{ name: "/leaf.tsx", contents: "export const leaf = 1;" }],
      };
      const { modules: leafModules, entryIdentity: leafIdentity } = toModules(
        leafProgram,
      );
      const sealOne = buildSourceDocs(
        [...leafModules, oldAmbient],
        leafIdentity,
      );
      expect(
        sealOne.get(leafIdentity)!.imports.map((i) => i.specifier),
      ).toContain(`${ROOT_LINK_SPECIFIER}${oldAmbient.identity}`);

      // Seal 2 (newer runtime): an entry importing the same leaf module, plus
      // the newer helper generation at the SAME ambient path. The leaf's
      // identity is entry-point independent, so both seals share the
      // `pattern:<leaf>` doc.
      const newAmbient = ambientModule("export const gen = 'new';");
      const boardProgram = {
        main: "/main.tsx",
        files: [
          {
            name: "/main.tsx",
            contents:
              `import { leaf } from "./leaf.tsx";\nexport const n = leaf;`,
          },
          ...leafProgram.files,
        ],
      };
      const { modules: boardModules, entryIdentity: boardIdentity } = toModules(
        boardProgram,
      );
      expect(computeModuleHashes(boardProgram).get("/leaf.tsx")).toBe(
        leafIdentity,
      );
      const sealTwo = buildSourceDocs(
        [...boardModules, newAmbient],
        boardIdentity,
      );

      // The stored state after both seals: the shared leaf doc carries seal 1's
      // root link (last write of that cell), so the board's link walk reaches
      // BOTH helper generations — two byte-intact docs at /cfc.ts.
      const merged = new Map(sealTwo);
      merged.set(leafIdentity, sealOne.get(leafIdentity)!);
      merged.set(oldAmbient.identity, sealOne.get(oldAmbient.identity)!);
      expect(
        [...merged.values()].filter((d) => d.filename === "/cfc.ts").length,
      ).toBe(2);

      // Regression: filename-keyed recomputation could never verify both
      // generations (one always shadowed → mismatch → pattern bricked on every
      // cold recompile). Per-view verification accepts the closure.
      const v = verifySourceDocs(boardIdentity, merged);
      expect(v.mismatches).toEqual([]);
      expect(v.missing).toEqual([]);
      expect(v.ok).toBe(true);
    });

    it("still rejects a view whose authored imports reach two files at one path", () => {
      // Rewired/corrupt closure: the entry's authored edges point at two
      // documents that both claim /dup.ts. No single emission can produce that
      // view, so the entry must not verify — but each intact dependency still
      // verifies standalone in its own view.
      const depA: CacheableModule = {
        identity: "",
        filename: "/dup.ts",
        source: "export const a = 1;",
        js: "",
        imports: [],
      };
      const depB: CacheableModule = {
        identity: "",
        filename: "/dup.ts",
        source: "export const b = 2;",
        js: "",
        imports: [],
      };
      const idOfSingle = (m: CacheableModule) =>
        computeModuleHashes({
          main: m.filename,
          files: [{ name: m.filename, contents: m.source }],
        }).get(m.filename)!;
      const a = { ...depA, identity: idOfSingle(depA) };
      const b = { ...depB, identity: idOfSingle(depB) };
      const entrySource = `import { a } from "./dup.ts";\nexport const n = a;`;
      const entryIdentity = "corrupt-entry";
      const docs = new Map<string, SourceDoc>(
        [a, b].map((m) => [m.identity, {
          kind: "source",
          code: m.source,
          filename: m.filename,
          imports: [],
        }]),
      );
      docs.set(entryIdentity, {
        kind: "source",
        code: entrySource,
        filename: "/main.tsx",
        imports: [
          { specifier: "./dup.ts", identity: a.identity },
          { specifier: "./also-dup.ts", identity: b.identity },
        ],
      });

      const v = verifySourceDocs(entryIdentity, docs);
      expect(v.ok).toBe(false);
      expect(v.mismatches).toContain(entryIdentity);
      // The intact same-filename dependencies are not condemned by the corrupt
      // root's view.
      expect(v.mismatches).not.toContain(a.identity);
      expect(v.mismatches).not.toContain(b.identity);
    });

    it("ignores non-normative annotations (W4): annotated and unannotated docs verify identically", () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const plain = buildSourceDocs(modules, entryIdentity);
      const plainResult = verifySourceDocs(entryIdentity, plain);
      expect(plainResult.ok).toBe(true);

      // Attach product annotations to the entry doc only — verification must
      // hash ONLY code/filename/imports, so the result is byte-for-byte
      // identical.
      const annotated = new Map(plain);
      const entry = annotated.get(entryIdentity)!;
      annotated.set(entryIdentity, {
        ...entry,
        annotations: {
          name: { "/": "name-doc-link" },
          spec: { "/": "spec-doc-link" },
        },
      });
      const annotatedResult = verifySourceDocs(entryIdentity, annotated);

      expect(annotatedResult).toEqual(plainResult);
      expect(annotatedResult.ok).toBe(true);
      // The annotated entry's recomputed identity still equals its key.
      expect(annotatedResult.mismatches).toEqual([]);
    });
  });

  describe("source-set store (per space, link-following)", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    const spaceA = signer.did();

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

    it("writes the closure and loads it back via import links", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const tx = runtime.edit();
      writeSourceDocs(runtime, spaceA, modules, entryIdentity, tx);

      const loaded = (await loadSourceClosure(
        runtime,
        spaceA,
        entryIdentity,
        tx,
      ))!;

      // All three modules reached by following links from the entry.
      expect(loaded.size).toBe(3);
      expect(new Set([...loaded.values()].map((d) => d.filename))).toEqual(
        new Set(["/main.tsx", "/util.ts", "/types.ts"]),
      );
      // Loaded closure self-verifies (recomputed identities match the keys).
      expect(verifySourceDocs(entryIdentity, loaded).ok).toBe(true);
    });

    it("stores a module's code as a link to the document holding it", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const tx = runtime.edit();
      writeSourceDocs(runtime, spaceA, modules, entryIdentity, tx);

      const entry = modules.find((m) => m.identity === entryIdentity)!;
      const codeId = `cid:${taggedHashStringOf(entry.source)}` as URI;
      const record = runtime.getCell(
        spaceA,
        sourceDocKey(entryIdentity),
        undefined,
        tx,
      );
      const stored = record.getRaw() as { code?: unknown };
      expect(parseLink(stored.code, record)?.id).toBe(codeId);
      expect(
        tx.readOrThrow({
          space: spaceA,
          id: codeId,
          type: "application/json",
          path: [],
        }),
      ).toEqual({ value: entry.source });
      const loaded = (await loadSourceClosure(
        runtime,
        spaceA,
        entryIdentity,
        tx,
      ))!;
      expect(loaded.get(entryIdentity)?.code).toBe(entry.source);
    });

    it("loads a record that stores its code inline", async () => {
      const identity = "source-inline-code";
      const code = "export const value = 1;";
      const tx = runtime.edit();
      runtime.getCell(spaceA, sourceDocKey(identity), undefined, tx).set({
        kind: "source",
        identity,
        code,
        filename: "/inline.ts",
        imports: [],
      });

      const loaded = await loadSourceClosure(runtime, spaceA, identity, tx);

      expect(loaded?.get(identity)?.code).toBe(code);
    });

    it("verifies a record's code against the document its link names", () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const tx = runtime.edit();
      writeSourceDocs(runtime, spaceA, modules, entryIdentity, tx);
      const entry = modules.find((m) => m.identity === entryIdentity)!;
      const record = runtime.getCell(
        spaceA,
        sourceDocKey(entryIdentity),
        undefined,
        tx,
      );

      expect(codeFieldVerifies(record, entry.source)).toBe(true);
      // A string the link's document does not hash to, and no string at all.
      expect(codeFieldVerifies(record, `${entry.source}\n`)).toBe(false);
      expect(codeFieldVerifies(record, undefined)).toBe(false);

      const inlineIdentity = "source-inline-verify";
      const inline = runtime.getCell(
        spaceA,
        sourceDocKey(inlineIdentity),
        undefined,
        tx,
      );
      inline.set({
        kind: "source",
        identity: inlineIdentity,
        code: "inline",
        filename: "/inline.ts",
        imports: [],
      });
      expect(codeFieldVerifies(inline, "inline")).toBe(true);
      expect(codeFieldVerifies(inline, "other")).toBe(false);
    });

    it("loads duplicate source import links once", async () => {
      const entryIdentity = "source-entry-with-duplicate-imports";
      const childIdentity = "source-duplicate-child";
      const modules: CacheableModule[] = [
        {
          identity: entryIdentity,
          filename: "/entry.ts",
          source: `import "./child.ts";\nimport "./again.ts";`,
          js: "/* compiled entry */",
          imports: [
            { specifier: "./child.ts", targetIdentity: childIdentity },
            { specifier: "./again.ts", targetIdentity: childIdentity },
          ],
        },
        {
          identity: childIdentity,
          filename: "/child.ts",
          source: `export const value = 1;`,
          js: "/* compiled child */",
          imports: [],
        },
      ];
      const tx = runtime.edit();
      writeSourceDocs(runtime, spaceA, modules, entryIdentity, tx);

      const loaded = await loadSourceClosure(
        runtime,
        spaceA,
        entryIdentity,
        tx,
      );

      expect(loaded?.size).toBe(2);
      expect(loaded?.get(entryIdentity)?.imports).toEqual([
        { specifier: "./child.ts", identity: childIdentity },
        { specifier: "./again.ts", identity: childIdentity },
      ]);
    });

    it("rejects a source closure linked to another space's attestation", async () => {
      const attackerSpace = "did:key:z6MkSourceClosureAttacker";
      const { modules, entryIdentity } = toModules(PROGRAM);
      const utilIdentity = identityOf(PROGRAM, "/util.ts");
      const predecessorIdentity = "victim-source-predecessor";
      const delegations = new Map([
        [utilIdentity, new Set([predecessorIdentity])],
      ]);

      const attackerTx = runtime.edit();
      writeSourceDocs(
        runtime,
        attackerSpace,
        modules,
        entryIdentity,
        attackerTx,
        delegations,
      );
      runtime.prepareTxForCommit(attackerTx);
      expect((await attackerTx.commit()).error).toBeUndefined();

      const victimTx = runtime.edit();
      writeSourceDocs(runtime, spaceA, modules, entryIdentity, victimTx);
      runtime.prepareTxForCommit(victimTx);
      expect((await victimTx.commit()).error).toBeUndefined();

      const entryModule = modules.find((module) =>
        module.identity === entryIdentity
      )!;
      const rewireTx = runtime.edit();
      runtime.getCell(
        spaceA,
        sourceDocKey(entryIdentity),
        undefined,
        rewireTx,
      ).set({
        kind: "source",
        identity: entryIdentity,
        code: entryModule.source,
        filename: entryModule.filename,
        imports: entryModule.imports.map((imp) => ({
          specifier: imp.specifier,
          link: runtime.getCell(
            imp.targetIdentity === utilIdentity ? attackerSpace : spaceA,
            sourceDocKey(imp.targetIdentity),
            undefined,
            rewireTx,
          ).getAsLink(),
        })),
      });
      runtime.prepareTxForCommit(rewireTx);
      expect((await rewireTx.commit()).error).toBeUndefined();

      const loadTx = runtime.edit();
      const loaded = await loadVerifiedSourceClosure(
        runtime,
        spaceA,
        entryIdentity,
        loadTx,
      );
      loadTx.abort?.("mixed-space source closure rejected");
      expect(loaded).toBeUndefined();

      const snapshotTx = runtime.edit();
      expect(snapshotTx.getCfcState().moduleDelegations.get(spaceA))
        .toBeUndefined();
      snapshotTx.abort?.("mixed-space source snapshot inspected");
    });

    it("skips source imports that do not point to source documents", async () => {
      const entryIdentity = "source-entry-with-broken-imports";
      const missingIdentity = "source-missing-child";
      const tx = runtime.edit();
      const missingLink = runtime.getCell(
        spaceA,
        sourceDocKey(missingIdentity),
        undefined,
        tx,
      ).getAsLink();
      runtime.getCell(spaceA, sourceDocKey(entryIdentity), undefined, tx).set({
        kind: "source",
        identity: entryIdentity,
        code: `export const value = 1;`,
        filename: "/entry.ts",
        imports: [
          { specifier: "./plain.ts" },
          { specifier: "./missing.ts", link: missingLink },
        ],
      });

      const loaded = await loadSourceClosure(
        runtime,
        spaceA,
        entryIdentity,
        tx,
      );

      expect(loaded?.size).toBe(1);
      expect(loaded?.get(entryIdentity)?.imports).toEqual([]);
    });

    it("annotatePattern is non-normative (W4): the closure still verifies and the identity is unchanged", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      let tx = runtime.edit();
      writeSourceDocs(runtime, spaceA, modules, entryIdentity, tx);
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      // Attach a product annotation to the entry source doc.
      await runtime.patternManager.annotatePattern(
        entryIdentity,
        spaceA,
        "name",
        { "/": "name-doc-link" },
      );

      tx = runtime.edit();
      // The verified closure is unaffected — annotations are excluded from the
      // content hash, so the entry's recomputed identity still equals its key.
      const verified = await loadVerifiedSourceClosure(
        runtime,
        spaceA,
        entryIdentity,
        tx,
      );
      expect(verified?.size).toBe(3);
      expect(verifySourceDocs(entryIdentity, verified!).ok).toBe(true);
      // The annotation rode along on the entry doc.
      expect(verified?.get(entryIdentity)?.annotations).toEqual({
        name: { "/": "name-doc-link" },
      });

      // A re-write of the identical source (idempotent recompile) preserves the
      // annotation rather than clobbering it.
      const rewriteTx = runtime.edit();
      writeSourceDocs(runtime, spaceA, modules, entryIdentity, rewriteTx);
      runtime.prepareTxForCommit(rewriteTx);
      await rewriteTx.commit();
      const afterRewriteTx = runtime.edit();
      const afterRewrite = await loadVerifiedSourceClosure(
        runtime,
        spaceA,
        entryIdentity,
        afterRewriteTx,
      );
      expect(afterRewrite?.get(entryIdentity)?.annotations).toEqual({
        name: { "/": "name-doc-link" },
      });
    });

    it("keeps an annotation that links to another document a link across a rewrite", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      let tx = runtime.edit();
      writeSourceDocs(runtime, spaceA, modules, entryIdentity, tx);
      const nameDoc = runtime.getCell<{ title: string }>(
        spaceA,
        "annotated-name-doc",
        undefined,
        tx,
      );
      nameDoc.set({ title: "Annotated" });
      runtime.prepareTxForCommit(tx);
      await tx.commit();
      const nameLink = nameDoc.getAsLink();
      await runtime.patternManager.annotatePattern(
        entryIdentity,
        spaceA,
        "name",
        nameLink,
      );

      tx = runtime.edit();
      writeSourceDocs(runtime, spaceA, modules, entryIdentity, tx);
      runtime.prepareTxForCommit(tx);
      await tx.commit();

      // The stored document, not a read through it: a loaded closure hands
      // back the document the annotation links to.
      const stored = runtime.getCell<{ annotations?: unknown }>(
        spaceA,
        sourceDocKey(entryIdentity),
        undefined,
        runtime.edit(),
      ).getRaw();
      expect(stored?.annotations).toEqual({ name: nameLink });
    });

    it("is empty for an entry that was never written", async () => {
      const tx = runtime.edit();
      const loaded = await loadSourceClosure(
        runtime,
        spaceA,
        "no-such-identity",
        tx,
      );
      expect(loaded).toBe(undefined);
    });

    it("loadVerifiedSourceClosure returns a faithful closure but rejects a tampered one", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const tx = runtime.edit();
      writeSourceDocs(runtime, spaceA, modules, entryIdentity, tx);

      // Happy path: the written closure graph-wiring-verifies.
      const ok = await loadVerifiedSourceClosure(
        runtime,
        spaceA,
        entryIdentity,
        tx,
      );
      expect(ok?.size).toBe(3);

      // Tamper util's stored source (keep its key) → recomputed identity
      // diverges.
      const utilIdentity = identityOf(PROGRAM, "/util.ts");
      runtime.getCell(spaceA, sourceDocKey(utilIdentity), undefined, tx).set({
        kind: "source",
        identity: utilIdentity,
        code: "export const helper = (n) => n + 999;",
        filename: "/util.ts",
        imports: [],
      });
      const tampered = await loadVerifiedSourceClosure(
        runtime,
        spaceA,
        entryIdentity,
        tx,
      );
      expect(tampered).toBe(undefined);
    });

    it("does not store fabric imports as source links", async () => {
      const { modules, importerIdentity, fabricSpecifier } =
        fabricLinkedModules();
      const tx = runtime.edit();
      writeSourceDocs(runtime, spaceA, modules, importerIdentity, tx);

      const loaded = await loadVerifiedSourceClosure(
        runtime,
        spaceA,
        importerIdentity,
        tx,
      );

      expect(loaded?.size).toBe(1);
      const importer = loaded?.get(importerIdentity);
      expect(importer?.imports.map((imp) => imp.specifier)).not.toContain(
        fabricSpecifier,
      );
    });
  });

  describe("compiled-set store (CFC integrity, fail-closed)", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    const spaceA = signer.did();
    const RTVER = "rt-test-1";

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        trustSnapshotProvider: () => ({
          id: "cell-cache-test",
          actingPrincipal: signer.did(),
        }),
      });
    });
    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    const opts = () => ({ runtimeVersion: RTVER });

    it("writes compiled docs with integrity and loads them back (warm hit)", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const wtx = runtime.edit();
      writeCompiledDocs(runtime, spaceA, modules, entryIdentity, opts(), wtx);
      wtx.prepareCfc();
      await wtx.commit();

      const rtx = runtime.edit();
      const loaded = await loadCompiledClosure(
        runtime,
        spaceA,
        entryIdentity,
        opts(),
        rtx,
      );
      rtx.abort?.();

      expect(loaded.size).toBe(3);
      const main = loaded.get(entryIdentity)!;
      expect(main.code).toBe("/* compiled */ /main.tsx");
      expect(new Set([...loaded.values()].map((d) => d.filename))).toEqual(
        new Set(["/main.tsx", "/util.ts", "/types.ts"]),
      );
    });

    it("links records with byte-identical code to one code document", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const wtx = runtime.edit();
      writeCompiledDocs(runtime, spaceA, modules, entryIdentity, opts(), wtx);
      writeCompiledDocs(
        runtime,
        spaceA,
        modules,
        entryIdentity,
        { runtimeVersion: "rt-test-2" },
        wtx,
      );
      wtx.prepareCfc();
      await wtx.commit();

      const rtx = runtime.edit();
      const codeIdOf = (version: string) => {
        const record = runtime.getCell(
          spaceA,
          compiledDocKey(version, entryIdentity),
          undefined,
          rtx,
        );
        const stored = record.getRaw() as { code?: unknown };
        return parseLink(stored.code, record)?.id;
      };
      const entry = modules.find((m) => m.identity === entryIdentity)!;
      expect(codeIdOf(RTVER)).toBe(`cid:${taggedHashStringOf(entry.js)}`);
      expect(codeIdOf("rt-test-2")).toBe(codeIdOf(RTVER));
      rtx.abort?.();
    });

    it("loads a compiled record that stores its code inline", async () => {
      const utilIdentity = identityOf(PROGRAM, "/util.ts");
      const wtx = runtime.edit();
      const prior = wtx.getCfcState().implementationIdentity;
      setCfcImplementationIdentity(wtx, {
        kind: "builtin",
        builtinId: "compile-cache",
      });
      runtime.getCell(
        spaceA,
        compiledDocKey(RTVER, utilIdentity),
        compiledDocWriteSchema(),
        wtx,
      ).set({
        kind: "compiled",
        identity: utilIdentity,
        code: "/* inline */",
        filename: "/util.ts",
        imports: [],
      });
      setCfcImplementationIdentity(wtx, prior);
      wtx.prepareCfc();
      await wtx.commit();

      const rtx = runtime.edit();
      const loaded = await loadCompiledClosure(
        runtime,
        spaceA,
        utilIdentity,
        opts(),
        rtx,
      );
      rtx.abort?.();
      expect(loaded.get(utilIdentity)?.code).toBe("/* inline */");
    });

    it("round-trips JSON coverage spans and rejects unsupported stored spans", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const spans = [{
        fileName: "/main.tsx",
        id: 1,
        kind: "runtime" as const,
        startLine: 3,
        endLine: 3,
        startColumn: 1,
        endColumn: 20,
      }];
      modules[0] = { ...modules[0]!, patternCoverageSpans: spans };
      const wtx = runtime.edit();
      writeCompiledDocs(runtime, spaceA, modules, entryIdentity, opts(), wtx);
      wtx.prepareCfc();
      await wtx.commit();

      const inspectTx = runtime.edit();
      const storedDoc = runtime.getCell(
        spaceA,
        compiledDocKey(RTVER, entryIdentity),
        compiledDocWriteSchema(),
        inspectTx,
      ).get() as Record<string, unknown>;
      expect(typeof storedDoc.patternCoverageSpansJson).toBe("string");
      expect(storedDoc.patternCoverageSpans).toBeUndefined();
      inspectTx.abort?.();

      const coldLoad = async () => {
        const rtx = runtime.edit();
        const loaded = await loadCompiledClosure(
          runtime,
          spaceA,
          entryIdentity,
          opts(),
          rtx,
        );
        rtx.abort?.();
        return loaded;
      };

      // Valid spans survive the round trip.
      expect((await coldLoad()).get(entryIdentity)?.patternCoverageSpans)
        .toEqual(spans);

      // Overwrite the stored doc's spans with malformed values, bypassing the
      // write path's integrity via the compile-cache implementation identity.
      const replaceSpans = async (
        value: {
          patternCoverageSpansJson?: unknown;
          patternCoverageSpans?: unknown;
        },
      ) => {
        const tx = runtime.edit();
        const previousIdentity = tx.getCfcState().implementationIdentity;
        setCfcImplementationIdentity(tx, {
          kind: "builtin",
          builtinId: "compile-cache",
        });
        try {
          const cell = runtime.getCell(
            spaceA,
            compiledDocKey(RTVER, entryIdentity),
            compiledDocWriteSchema(),
            tx,
          );
          const next = { ...(cell.get() as Record<string, unknown>) };
          delete next.patternCoverageSpansJson;
          delete next.patternCoverageSpans;
          cell.set({ ...next, ...value });
        } finally {
          setCfcImplementationIdentity(tx, previousIdentity);
        }
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();
      };

      // A span whose id is the wrong type is dropped rather than reported
      // against malformed coordinates.
      await replaceSpans({
        patternCoverageSpansJson: JSON.stringify([{
          ...spans[0],
          id: "not-a-number",
        }]),
      });
      expect((await coldLoad()).get(entryIdentity)?.patternCoverageSpans)
        .toBeUndefined();

      // Malformed JSON is dropped too.
      await replaceSpans({ patternCoverageSpansJson: "not-json" });
      expect((await coldLoad()).get(entryIdentity)?.patternCoverageSpans)
        .toBeUndefined();

      // Valid JSON still has to describe an array of span records.
      await replaceSpans({ patternCoverageSpansJson: JSON.stringify({}) });
      expect((await coldLoad()).get(entryIdentity)?.patternCoverageSpans)
        .toBeUndefined();
      await replaceSpans({ patternCoverageSpansJson: JSON.stringify([null]) });
      expect((await coldLoad()).get(entryIdentity)?.patternCoverageSpans)
        .toBeUndefined();

      // The durable format accepts only the scalar JSON field.
      await replaceSpans({ patternCoverageSpans: spans });
      expect((await coldLoad()).get(entryIdentity)?.patternCoverageSpans)
        .toBeUndefined();
    });

    it("round-trips builder source sites and drops malformed debug metadata", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const sidecar = {
        formatVersion: 1 as const,
        sites: {
          default: { line: 4, col: 15 },
          named: { line: 7, col: 2, bindingName: "named" },
        },
      };
      modules[0] = { ...modules[0]!, builderSourceSites: sidecar };
      const wtx = runtime.edit();
      writeCompiledDocs(runtime, spaceA, modules, entryIdentity, opts(), wtx);
      wtx.prepareCfc();
      await wtx.commit();

      const load = async () => {
        const rtx = runtime.edit();
        const loaded = await loadCompiledClosure(
          runtime,
          spaceA,
          entryIdentity,
          opts(),
          rtx,
        );
        rtx.abort?.();
        return loaded.get(entryIdentity)?.builderSourceSites;
      };

      const inspectTx = runtime.edit();
      const stored = runtime.getCell(
        spaceA,
        compiledDocKey(RTVER, entryIdentity),
        compiledDocWriteSchema(),
        inspectTx,
      ).get() as Record<string, unknown>;
      expect(typeof stored.builderSourceSitesJson).toBe("string");
      expect(stored.builderSourceSites).toBeUndefined();
      inspectTx.abort?.();
      expect(await load()).toEqual(sidecar);

      const replace = async (value: Record<string, unknown>) => {
        const tx = runtime.edit();
        const previousIdentity = tx.getCfcState().implementationIdentity;
        setCfcImplementationIdentity(tx, {
          kind: "builtin",
          builtinId: "compile-cache",
        });
        try {
          const cell = runtime.getCell(
            spaceA,
            compiledDocKey(RTVER, entryIdentity),
            compiledDocWriteSchema(),
            tx,
          );
          const next = { ...(cell.get() as Record<string, unknown>) };
          delete next.builderSourceSitesJson;
          delete next.builderSourceSites;
          cell.set({ ...next, ...value });
        } finally {
          setCfcImplementationIdentity(tx, previousIdentity);
        }
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();
      };

      await replace({
        builderSourceSitesJson: JSON.stringify({
          ...sidecar,
          sites: { named: { line: 0, col: 2 } },
        }),
      });
      expect(await load()).toBeUndefined();

      await replace({ builderSourceSites: sidecar });
      expect(await load()).toBeUndefined();
    });

    it("persists and cold-loads verified policy manifests without module evaluation", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const artifact = buildCfcPolicyArtifactManifest({
        formatVersion: 1,
        moduleIdentity: entryIdentity,
        symbol: "rules",
        template: {
          templateVersion: 1,
          exchangeRules: [{
            name: "release",
            preCondition: {
              confidentiality: [{ thisPolicy: true }],
              integrity: [{ type: "IntegrityEvidence" }],
            },
            postCondition: { confidentiality: [], integrity: [] },
          }],
          dependencies: { authorityOnly: [], dataBearing: [] },
          integrityRequirements: {},
        },
      });
      modules[0] = { ...modules[0]!, policyManifests: [artifact] };
      const reference = {
        moduleIdentity: artifact.manifest.moduleIdentity,
        symbol: artifact.manifest.symbol,
        policyDigest: artifact.policyDigest,
      };

      for (let attempt = 0; attempt < 2; attempt++) {
        const wtx = runtime.edit();
        writeCompiledDocs(runtime, spaceA, modules, entryIdentity, opts(), wtx);
        wtx.prepareCfc();
        await wtx.commit();
      }
      expect(runtime.hasCfcPolicyManifest(spaceA, reference)).toBe(false);

      const rtx = runtime.edit();
      const loaded = await loadCompiledClosure(
        runtime,
        spaceA,
        entryIdentity,
        opts(),
        rtx,
      );
      rtx.abort?.();
      expect(loaded.get(entryIdentity)?.policyManifests).toEqual([artifact]);
      expect(runtime.hasCfcPolicyManifest(spaceA, reference)).toBe(false);

      const tampered = {
        ...artifact,
        manifest: { ...artifact.manifest, symbol: "substituted" },
      };
      const bad = modules.map((module) =>
        module.identity === entryIdentity
          ? { ...module, policyManifests: [tampered] }
          : module
      );
      const badTx = runtime.edit();
      try {
        expect(() =>
          writeCompiledDocs(runtime, spaceA, bad, entryIdentity, opts(), badTx)
        ).toThrow("policyDigest mismatch");
      } finally {
        badTx.abort?.();
      }

      const wrongModuleArtifact = buildCfcPolicyArtifactManifest({
        ...artifact.manifest,
        moduleIdentity: "sha256:another-module",
      });
      const wrongModule = modules.map((module) =>
        module.identity === entryIdentity
          ? { ...module, policyManifests: [wrongModuleArtifact] }
          : module
      );
      const wrongModuleTx = runtime.edit();
      try {
        expect(() =>
          writeCompiledDocs(
            runtime,
            spaceA,
            wrongModule,
            entryIdentity,
            opts(),
            wrongModuleTx,
          )
        ).toThrow("module identity mismatch");
      } finally {
        wrongModuleTx.abort?.();
      }
    });

    it("fails closed on malformed cold-cache policy manifests", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const artifact = buildCfcPolicyArtifactManifest({
        formatVersion: 1,
        moduleIdentity: entryIdentity,
        symbol: "rules",
        template: {
          templateVersion: 1,
          exchangeRules: [],
          dependencies: { authorityOnly: [], dataBearing: [] },
          integrityRequirements: {},
        },
      });
      modules[0] = { ...modules[0]!, policyManifests: [artifact] };
      const wtx = runtime.edit();
      writeCompiledDocs(runtime, spaceA, modules, entryIdentity, opts(), wtx);
      wtx.prepareCfc();
      await wtx.commit();

      const replaceEntryFields = async (fields: Record<string, unknown>) => {
        const tx = runtime.edit();
        const previousIdentity = tx.getCfcState().implementationIdentity;
        setCfcImplementationIdentity(tx, {
          kind: "builtin",
          builtinId: "compile-cache",
        });
        try {
          const cell = runtime.getCell(
            spaceA,
            compiledDocKey(RTVER, entryIdentity),
            compiledDocWriteSchema(),
            tx,
          );
          cell.set({
            ...(cell.get() as Record<string, unknown>),
            ...fields,
          });
        } finally {
          setCfcImplementationIdentity(tx, previousIdentity);
        }
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();
      };
      const coldLoad = async () => {
        const rtx = runtime.edit();
        const loaded = await loadCompiledClosure(
          runtime,
          spaceA,
          entryIdentity,
          opts(),
          rtx,
        );
        rtx.abort?.();
        return loaded;
      };

      await replaceEntryFields({ policyManifests: [{ forged: true }] });
      expect((await coldLoad()).size).toBe(0);

      const wrongModule = buildCfcPolicyArtifactManifest({
        ...artifact.manifest,
        moduleIdentity: "sha256:wrong-module",
      });
      await replaceEntryFields({ policyManifests: [wrongModule] });
      expect((await coldLoad()).size).toBe(0);

      await replaceEntryFields({ identity: null, policyManifests: [] });
      expect((await coldLoad()).size).toBe(0);
    });

    it("loads duplicate compiled import links once", async () => {
      const entryIdentity = "compiled-entry-with-duplicate-imports";
      const childIdentity = "compiled-duplicate-child";
      const modules: CacheableModule[] = [
        {
          identity: entryIdentity,
          filename: "/entry.ts",
          source: `import "./child.ts";\nimport "./again.ts";`,
          js: "/* compiled entry */",
          imports: [
            { specifier: "./child.ts", targetIdentity: childIdentity },
            { specifier: "./again.ts", targetIdentity: childIdentity },
          ],
        },
        {
          identity: childIdentity,
          filename: "/child.ts",
          source: `export const value = 1;`,
          js: "/* compiled child */",
          imports: [],
        },
      ];
      const wtx = runtime.edit();
      writeCompiledDocs(runtime, spaceA, modules, entryIdentity, opts(), wtx);
      wtx.prepareCfc();
      await wtx.commit();

      const rtx = runtime.edit();
      const loaded = await loadCompiledClosure(
        runtime,
        spaceA,
        entryIdentity,
        opts(),
        rtx,
      );
      rtx.abort?.();

      expect(loaded.size).toBe(2);
      expect(loaded.get(entryIdentity)?.imports).toEqual([
        { specifier: "./child.ts", identity: childIdentity },
        { specifier: "./again.ts", identity: childIdentity },
      ]);
    });

    it("rejects a compiled closure linked to another space's attestation", async () => {
      const attackerSpace = "did:key:z6MkCompiledClosureAttacker";
      const { modules, entryIdentity } = toModules(PROGRAM);
      const utilIdentity = identityOf(PROGRAM, "/util.ts");
      const predecessorIdentity = "victim-compiled-predecessor";
      const delegations = new Map([
        [utilIdentity, new Set([predecessorIdentity])],
      ]);

      const attackerTx = runtime.edit();
      writeCompiledDocs(
        runtime,
        attackerSpace,
        modules,
        entryIdentity,
        { ...opts(), moduleDelegations: delegations },
        attackerTx,
      );
      attackerTx.prepareCfc();
      expect((await attackerTx.commit()).error).toBeUndefined();

      const victimTx = runtime.edit();
      writeCompiledDocs(
        runtime,
        spaceA,
        modules,
        entryIdentity,
        opts(),
        victimTx,
      );
      victimTx.prepareCfc();
      expect((await victimTx.commit()).error).toBeUndefined();

      const entryModule = modules.find((module) =>
        module.identity === entryIdentity
      )!;
      const rewireTx = runtime.edit();
      const previousIdentity = rewireTx.getCfcState().implementationIdentity;
      setCfcImplementationIdentity(rewireTx, {
        kind: "builtin",
        builtinId: "compile-cache",
      });
      try {
        const entryCell = runtime.getCell<Record<string, unknown>>(
          spaceA,
          compiledDocKey(RTVER, entryIdentity),
          compiledDocWriteSchema(),
          rewireTx,
        );
        entryCell.set({
          ...entryCell.get(),
          imports: entryModule.imports.map((imp) => ({
            specifier: imp.specifier,
            link: runtime.getCell(
              imp.targetIdentity === utilIdentity ? attackerSpace : spaceA,
              compiledDocKey(RTVER, imp.targetIdentity),
              undefined,
              rewireTx,
            ).getAsLink(),
          })),
        });
      } finally {
        setCfcImplementationIdentity(rewireTx, previousIdentity);
      }
      rewireTx.prepareCfc();
      expect((await rewireTx.commit()).error).toBeUndefined();

      const loadTx = runtime.edit();
      const loaded = await loadCompiledClosure(
        runtime,
        spaceA,
        entryIdentity,
        opts(),
        loadTx,
      );
      loadTx.abort?.("mixed-space compiled closure rejected");
      expect(loaded.size).toBe(0);

      const snapshotTx = runtime.edit();
      expect(snapshotTx.getCfcState().moduleDelegations.get(spaceA))
        .toBeUndefined();
      snapshotTx.abort?.("mixed-space compiled snapshot inspected");
    });

    it("skips compiled import links without integrity", async () => {
      const entryIdentity = "compiled-entry-with-unstamped-import";
      const missingIdentity = "compiled-unstamped-child";
      const modules: CacheableModule[] = [
        {
          identity: entryIdentity,
          filename: "/entry.ts",
          source: `import "./missing.ts";`,
          js: "/* compiled entry */",
          imports: [
            { specifier: "./missing.ts", targetIdentity: missingIdentity },
          ],
        },
      ];
      const wtx = runtime.edit();
      writeCompiledDocs(runtime, spaceA, modules, entryIdentity, opts(), wtx);
      wtx.prepareCfc();
      await wtx.commit();

      const rtx = runtime.edit();
      const loaded = await loadCompiledClosure(
        runtime,
        spaceA,
        entryIdentity,
        opts(),
        rtx,
      );
      rtx.abort?.();

      expect(loaded.size).toBe(1);
      expect(loaded.get(entryIdentity)?.imports).toEqual([]);
    });

    it("skips compiled imports that do not carry links", async () => {
      const entryIdentity = "compiled-entry-with-missing-link";
      const wtx = runtime.edit();
      const previousIdentity = wtx.getCfcState().implementationIdentity;
      setCfcImplementationIdentity(wtx, {
        kind: "builtin",
        builtinId: "compile-cache",
      });
      try {
        runtime.getCell(
          spaceA,
          compiledDocKey(RTVER, entryIdentity),
          compiledDocWriteSchema(),
          wtx,
        ).set({
          kind: "compiled",
          identity: entryIdentity,
          code: "/* compiled entry */",
          filename: "/entry.ts",
          imports: [
            { specifier: "./plain.ts" },
          ],
        });
      } finally {
        setCfcImplementationIdentity(wtx, previousIdentity);
      }
      wtx.prepareCfc();
      await wtx.commit();

      const rtx = runtime.edit();
      const loaded = await loadCompiledClosure(
        runtime,
        spaceA,
        entryIdentity,
        opts(),
        rtx,
      );
      rtx.abort?.();

      expect(loaded.size).toBe(1);
      expect(loaded.get(entryIdentity)?.imports).toEqual([]);
    });

    it("reaches an otherwise-unreachable module via the entry root link", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const isolated: CacheableModule = {
        identity: "iso-compiled-identity",
        filename: "cfc.ts",
        source: "export {};",
        js: "/* iso compiled */",
        imports: [],
      };
      const wtx = runtime.edit();
      writeCompiledDocs(
        runtime,
        spaceA,
        [...modules, isolated],
        entryIdentity,
        opts(),
        wtx,
      );
      wtx.prepareCfc();
      await wtx.commit();

      const rtx = runtime.edit();
      const loaded = await loadCompiledClosure(
        runtime,
        spaceA,
        entryIdentity,
        opts(),
        rtx,
      );
      rtx.abort?.();
      // The isolated module is reached only because the entry links it.
      expect(loaded.has("iso-compiled-identity")).toBe(true);
      expect(loaded.size).toBe(4);
    });

    it("fail-closed: an unstamped compiled cell is not accepted", async () => {
      const utilIdentity = identityOf(PROGRAM, "/util.ts");
      // Write util's compiled cell PLAINLY (no addIntegrity schema → no label).
      const wtx = runtime.edit();
      runtime.getCell(
        spaceA,
        compiledDocKey(RTVER, utilIdentity),
        undefined,
        wtx,
      )
        .set({
          kind: "compiled",
          identity: utilIdentity,
          code: "/* unstamped */",
          filename: "/util.ts",
          imports: [],
        });
      wtx.prepareCfc();
      await wtx.commit();

      // Loading util directly as the entry: present but unstamped → dropped.
      const rtx = runtime.edit();
      const loaded = await loadCompiledClosure(
        runtime,
        spaceA,
        utilIdentity,
        opts(),
        rtx,
      );
      rtx.abort?.();
      expect(loaded.size).toBe(0);
    });

    it("fail-closed: a forged cf-compiled-by stamp from a non-builtin write is stripped", async () => {
      // A write that self-attaches the compiler attestation through an authored
      // schema, WITHOUT the compile-cache builtin authoring the write (audit
      // S4: unattributed writes may not mint evidence). The atom must be
      // stripped from the persisted label, so the loader treats the doc as
      // unstamped.
      const utilIdentity = identityOf(PROGRAM, "/util.ts");
      const forgedSchema = {
        type: "object",
        ifc: { addIntegrity: [COMPILED_INTEGRITY_ATOM] },
      } as const;
      const wtx = runtime.edit();
      runtime.getCell(
        spaceA,
        compiledDocKey(RTVER, utilIdentity),
        forgedSchema,
        wtx,
      )
        .set({
          kind: "compiled",
          identity: utilIdentity,
          code: "/* forged */",
          filename: "/util.ts",
          imports: [],
        });
      wtx.prepareCfc();
      const { error } = await wtx.commit();
      expect(error).toBe(undefined);

      const rtx = runtime.edit();
      const loaded = await loadCompiledClosure(
        runtime,
        spaceA,
        utilIdentity,
        opts(),
        rtx,
      );
      rtx.abort?.();
      expect(loaded.size).toBe(0);
    });

    it("keeps fabric imports as compiled links", async () => {
      const { modules, importerIdentity, depIdentity, fabricSpecifier } =
        fabricLinkedModules();
      const wtx = runtime.edit();
      writeCompiledDocs(
        runtime,
        spaceA,
        modules,
        importerIdentity,
        opts(),
        wtx,
      );
      wtx.prepareCfc();
      await wtx.commit();

      const rtx = runtime.edit();
      const loaded = await loadCompiledClosure(
        runtime,
        spaceA,
        importerIdentity,
        opts(),
        rtx,
      );
      rtx.abort?.();

      expect(loaded.has(importerIdentity)).toBe(true);
      expect(loaded.has(depIdentity)).toBe(true);
      expect(loaded.get(importerIdentity)?.imports).toContainEqual({
        specifier: fabricSpecifier,
        identity: depIdentity,
      });
    });

    it("refuses to persist modules carrying unpinned fabric edges", () => {
      // An unpinned specifier folds into the module identity AS TEXT, so the
      // resolution result (the edge's target) can vary under a fixed identity —
      // persisting such a module would make cache content key-unstable.
      const { modules, importerIdentity, depIdentity } = fabricLinkedModules();
      const unpinned: CacheableModule = {
        ...modules[0],
        source:
          `import { x } from "cf:dep";\nexport function y() { return x + 1; }`,
        imports: [{ specifier: "cf:dep", targetIdentity: depIdentity }],
      };
      const wtx = runtime.edit();
      try {
        expect(() =>
          writeSourceDocs(
            runtime,
            spaceA,
            [unpinned, modules[1]],
            importerIdentity,
            wtx,
          )
        ).toThrow("unpinned fabric import 'cf:dep'");
        expect(() =>
          writeCompiledDocs(
            runtime,
            spaceA,
            [unpinned, modules[1]],
            importerIdentity,
            opts(),
            wtx,
          )
        ).toThrow("unpinned fabric import 'cf:dep'");
      } finally {
        wtx.abort?.();
      }
    });

    it("skips same-space and keyless pattern replication", async () => {
      const keyed = pattern(() => ({}));
      const keyless = pattern(() => ({}));
      const ref = { identity: "same-space-entry", symbol: "default" };
      runtime.patternManager.associatePatternIdentity(keyed, ref);
      expect(runtime.patternManager.getArtifactEntryRef(keyed)).toEqual(ref);
      expect(runtime.patternManager.getArtifactEntryRef(keyless))
        .toBeUndefined();

      // An issued replication registers in the manager's write set at once,
      // so the set's size says whether either call issued one.
      const writes =
        runtime.patternManager.accessForTestingOnly.compileCacheWrites;
      const before = writes.size;
      runtime.patternManager.replicatePatternToSpace(keyed, spaceA, spaceA);
      runtime.patternManager.replicatePatternToSpace(
        keyless,
        "did:key:z6MkCellCacheKeylessReplicationTarget",
        spaceA,
      );
      expect(writes.size).toBe(before);
      await runtime.patternManager.flushCompileCacheWrites();
    });

    it("replicates fabric dependencies without importing authority", async () => {
      const spaceB = "did:key:z6MkCellCacheFabricReplicationTarget";
      const { modules, importerIdentity, depIdentity } = fabricLinkedModules();
      const coverageSpans = [{
        fileName: "/main.tsx",
        id: 1,
        kind: "runtime" as const,
        startLine: 1,
        endLine: 1,
        startColumn: 1,
        endColumn: 20,
      }];
      const policyManifest = buildCfcPolicyArtifactManifest({
        formatVersion: 1,
        moduleIdentity: importerIdentity,
        symbol: "rules",
        template: {
          templateVersion: 1,
          exchangeRules: [],
          dependencies: { authorityOnly: [], dataBearing: [] },
          integrityRequirements: {},
        },
      });
      modules[0] = {
        ...modules[0]!,
        patternCoverageSpans: coverageSpans,
        policyManifests: [policyManifest],
      };
      const replicationOpts = {
        runtimeVersion,
      };
      const predecessorIdentity = "replicated-predecessor";
      const moduleDelegations = new Map([
        [importerIdentity, new Set([predecessorIdentity])],
      ]);
      const wtx = runtime.edit();
      writeSourceDocs(
        runtime,
        spaceA,
        modules,
        importerIdentity,
        wtx,
        moduleDelegations,
      );
      writeCompiledDocs(
        runtime,
        spaceA,
        modules,
        importerIdentity,
        { ...replicationOpts, moduleDelegations },
        wtx,
      );
      wtx.prepareCfc();
      await wtx.commit();

      const manager = runtime.patternManager.accessForTestingOnly;
      await manager.replicateClosures(importerIdentity, spaceA, spaceB);

      const rtx = runtime.edit();
      const importerSource = await loadVerifiedSourceClosure(
        runtime,
        spaceB,
        importerIdentity,
        rtx,
      );
      const depSource = await loadVerifiedSourceClosure(
        runtime,
        spaceB,
        depIdentity,
        rtx,
      );
      const compiled = await loadCompiledClosure(
        runtime,
        spaceB,
        importerIdentity,
        replicationOpts,
        rtx,
      );
      rtx.abort?.();

      expect(importerSource?.has(importerIdentity)).toBe(true);
      expect(depSource?.has(depIdentity)).toBe(true);
      expect(compiled.has(importerIdentity)).toBe(true);
      expect(compiled.has(depIdentity)).toBe(true);
      expect(compiled.get(importerIdentity)?.patternCoverageSpans).toEqual(
        coverageSpans,
      );
      expect(compiled.get(importerIdentity)?.policyManifests).toEqual([
        policyManifest,
      ]);
      expect(importerSource?.get(importerIdentity)?.delegatedModuleIdentities)
        .toBeUndefined();
      expect(compiled.get(importerIdentity)?.delegatedModuleIdentities)
        .toBeUndefined();

      const snapshotTx = runtime.edit();
      expect(
        snapshotTx.getCfcState().moduleDelegations.get(spaceA)?.get(
          importerIdentity,
        ),
      ).toEqual([predecessorIdentity]);
      expect(snapshotTx.getCfcState().moduleDelegations.get(spaceB))
        .toBeUndefined();
      snapshotTx.abort?.("cross-space replication snapshot inspected");

      const protectedSchema = {
        type: "object",
        properties: {
          value: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  moduleIdentity: predecessorIdentity,
                  file: "/main.tsx",
                  path: ["setValue"],
                },
              },
            },
          },
        },
        required: ["value"],
      } as unknown as JSONSchema;
      const protectedCell = runtime.getCell<{ value: string }>(
        spaceB,
        "cell-cache-cross-space-replication-authority",
        protectedSchema,
      );
      const seed = await runtime.editWithRetry((tx) => {
        setCfcImplementationIdentity(tx, {
          kind: "verified",
          moduleIdentity: predecessorIdentity,
          sourceFile: "/main.tsx",
          bindingPath: ["setValue"],
        });
        protectedCell.withTx(tx).set({ value: "seed" });
      });
      expect(seed.error).toBeUndefined();

      const denied = await runtime.editWithRetry((tx) => {
        setCfcImplementationIdentity(tx, {
          kind: "verified",
          moduleIdentity: importerIdentity,
          sourceFile: "/main.tsx",
          bindingPath: ["setValue"],
        });
        protectedCell.withTx(tx).set({ value: "replicated" });
      }, 0);
      expect(denied.error?.message).toContain("writeAuthorizedBy failed");
      expect(protectedCell.get()).toEqual({ value: "seed" });

      const damageTx = runtime.edit();
      const previousIdentity = damageTx.getCfcState().implementationIdentity;
      setCfcImplementationIdentity(damageTx, {
        kind: "builtin",
        builtinId: "compile-cache",
      });
      try {
        runtime.getCell(
          spaceB,
          sourceDocKey(importerIdentity),
          undefined,
          damageTx,
        ).set({ damaged: true });
        runtime.getCell(
          spaceB,
          compiledDocKey(runtimeVersion, importerIdentity),
          undefined,
          damageTx,
        ).set({ damaged: true });
      } finally {
        setCfcImplementationIdentity(damageTx, previousIdentity);
      }
      damageTx.prepareCfc();
      expect((await damageTx.commit()).error).toBeUndefined();

      await manager.replicateClosures(importerIdentity, spaceA, spaceB);
      const repairedTx = runtime.edit();
      const repairedSource = await loadVerifiedSourceClosure(
        runtime,
        spaceB,
        importerIdentity,
        repairedTx,
      );
      const repairedCompiled = await loadCompiledClosure(
        runtime,
        spaceB,
        importerIdentity,
        replicationOpts,
        repairedTx,
      );
      repairedTx.abort?.();
      expect(repairedSource?.has(importerIdentity)).toBe(true);
      expect(repairedCompiled.has(importerIdentity)).toBe(true);
    });

    it("rejects replication from an incomplete origin closure", async () => {
      const targetSpace = "did:key:z6MkCellCacheIncompleteReplicationTarget";
      const { modules, entryIdentity } = toModules(PROGRAM);
      const manager = runtime.patternManager.accessForTestingOnly;

      const visitKey = `${spaceA}\0${targetSpace}\0${entryIdentity}`;
      await expect(
        manager.replicateClosures(
          entryIdentity,
          spaceA,
          targetSpace,
          new Set([visitKey]),
        ),
      ).resolves.toBeUndefined();

      await expect(
        manager.replicateClosures(entryIdentity, spaceA, targetSpace),
      ).rejects.toThrow("source closure unavailable in origin space");

      const sourceOnlyWrite = runtime.edit();
      writeSourceDocs(
        runtime,
        spaceA,
        modules,
        entryIdentity,
        sourceOnlyWrite,
      );
      sourceOnlyWrite.prepareCfc();
      expect((await sourceOnlyWrite.commit()).error).toBeUndefined();

      await expect(
        manager.replicateClosures(entryIdentity, spaceA, targetSpace),
      ).rejects.toThrow(`compiled doc missing for ${entryIdentity}`);
    });

    it("rejects coverage replication when compiled spans are absent", async () => {
      const coverageStorageManager = StorageManager.emulate({ as: signer });
      const coverageRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: coverageStorageManager,
        trustSnapshotProvider: () => ({
          id: "cell-cache-coverage-replication-test",
          actingPrincipal: signer.did(),
        }),
        patternCoverage: new PatternCoverageCollector(),
      });
      const targetSpace = "did:key:z6MkCellCacheCoverageReplicationTarget";
      const { modules, entryIdentity } = toModules(PROGRAM);
      const coverageRuntimeVersion = `${runtimeVersion}/pattern-coverage`;

      try {
        const writeTx = coverageRuntime.edit();
        writeSourceDocs(
          coverageRuntime,
          spaceA,
          modules,
          entryIdentity,
          writeTx,
        );
        writeCompiledDocs(
          coverageRuntime,
          spaceA,
          modules,
          entryIdentity,
          { runtimeVersion: coverageRuntimeVersion },
          writeTx,
        );
        writeTx.prepareCfc();
        expect((await writeTx.commit()).error).toBeUndefined();

        const manager = coverageRuntime.patternManager.accessForTestingOnly;
        await expect(
          manager.replicateClosures(entryIdentity, spaceA, targetSpace),
        ).rejects.toThrow("coverage spans unavailable in origin space");
      } finally {
        await coverageRuntime.dispose();
        await coverageStorageManager.close();
      }
    });

    it("does not reuse a closure missing required delegation metadata", async () => {
      const targetSpace = "did:key:z6MkCellCacheDelegationPersistenceTarget";
      const { modules, entryIdentity } = toModules(PROGRAM);
      const requiredDelegations = new Map([
        [entryIdentity, new Set(["required-predecessor"])],
      ]);
      const manager = runtime.patternManager.accessForTestingOnly;

      const initialWrite = runtime.edit();
      writeSourceDocs(
        runtime,
        targetSpace,
        modules,
        entryIdentity,
        initialWrite,
      );
      writeCompiledDocs(
        runtime,
        targetSpace,
        modules,
        entryIdentity,
        opts(),
        initialWrite,
      );
      initialWrite.prepareCfc();
      expect((await initialWrite.commit()).error).toBeUndefined();

      const missingModule: CacheableModule = {
        identity: "missing-source-module",
        filename: "/missing.ts",
        source: "export {};",
        js: "export {};",
        imports: [],
      };
      expect(
        await manager.hasStoredCompileCacheClosure(
          targetSpace,
          [...modules, missingModule],
          entryIdentity,
          opts(),
          new Map(),
        ),
      ).toBe(false);

      const coverageRuntimeVersion = `${RTVER}/pattern-coverage`;
      const uninstrumentedCoverageWrite = runtime.edit();
      writeCompiledDocs(
        runtime,
        targetSpace,
        modules,
        entryIdentity,
        { runtimeVersion: coverageRuntimeVersion },
        uninstrumentedCoverageWrite,
      );
      uninstrumentedCoverageWrite.prepareCfc();
      expect((await uninstrumentedCoverageWrite.commit()).error)
        .toBeUndefined();
      expect(
        await manager.hasStoredCompileCacheClosure(
          targetSpace,
          modules,
          entryIdentity,
          { runtimeVersion: coverageRuntimeVersion },
          new Map(),
        ),
      ).toBe(false);

      // The source set does not yet carry the requested authority.
      expect(
        await manager.hasStoredCompileCacheClosure(
          targetSpace,
          modules,
          entryIdentity,
          opts(),
          requiredDelegations,
        ),
      ).toBe(false);

      const sourceOnlyRepair = runtime.edit();
      writeSourceDocs(
        runtime,
        targetSpace,
        modules,
        entryIdentity,
        sourceOnlyRepair,
        requiredDelegations,
      );
      sourceOnlyRepair.prepareCfc();
      expect((await sourceOnlyRepair.commit()).error).toBeUndefined();

      // A source-only repair is insufficient: a later warm load could trust the
      // still-stale compiled set without ever consulting source metadata.
      expect(
        await manager.hasStoredCompileCacheClosure(
          targetSpace,
          modules,
          entryIdentity,
          opts(),
          requiredDelegations,
        ),
      ).toBe(false);

      const compiledRepair = runtime.edit();
      writeCompiledDocs(
        runtime,
        targetSpace,
        modules,
        entryIdentity,
        { ...opts(), moduleDelegations: requiredDelegations },
        compiledRepair,
      );
      compiledRepair.prepareCfc();
      expect((await compiledRepair.commit()).error).toBeUndefined();

      expect(
        await manager.hasStoredCompileCacheClosure(
          targetSpace,
          modules,
          entryIdentity,
          opts(),
          requiredDelegations,
        ),
      ).toBe(true);
    });

    it("distinguishes persisted closures that share an entry module", async () => {
      const targetSpace = "did:key:z6MkCellCacheSharedEntryTarget";
      const main = {
        name: "/main.ts",
        contents: "export const main = 1;",
      };
      const first = toModules({
        main: main.name,
        files: [
          main,
          { name: "/first.ts", contents: "export const first = 1;" },
        ],
      });
      const second = toModules({
        main: main.name,
        files: [
          main,
          { name: "/second.ts", contents: "export const second = 2;" },
        ],
      });
      expect(second.entryIdentity).toBe(first.entryIdentity);

      const manager = runtime.patternManager.accessForTestingOnly;
      await manager.persistCompileCacheTracked(
        targetSpace,
        first.modules,
        first.entryIdentity,
        { runtimeVersion },
      );
      await manager.persistCompileCacheTracked(
        targetSpace,
        second.modules,
        second.entryIdentity,
        { runtimeVersion },
      );

      const firstExtraIdentity =
        first.modules.find((module) => module.filename === "/first.ts")!
          .identity;
      const secondExtraIdentity =
        second.modules.find((module) => module.filename === "/second.ts")!
          .identity;
      const readTx = runtime.edit();
      const loaded = await loadCompiledClosure(
        runtime,
        targetSpace,
        second.entryIdentity,
        { runtimeVersion },
        readTx,
      );
      readTx.abort?.();

      expect(loaded.has(secondExtraIdentity)).toBe(true);
      expect(loaded.has(firstExtraIdentity)).toBe(false);

      await manager.persistCompileCacheTracked(
        targetSpace,
        first.modules,
        first.entryIdentity,
        { runtimeVersion },
      );
      const replayTx = runtime.edit();
      const replayed = await loadCompiledClosure(
        runtime,
        targetSpace,
        first.entryIdentity,
        { runtimeVersion },
        replayTx,
      );
      replayTx.abort?.();
      expect(replayed.has(firstExtraIdentity)).toBe(true);
      expect(replayed.has(secondExtraIdentity)).toBe(false);
    });

    it("tracks a queued replacement write before its predecessor completes", async () => {
      const targetSpace = "did:key:z6MkCellCacheQueuedWriteTarget";
      const main = {
        name: "/main.ts",
        contents: "export const main = 1;",
      };
      const first = toModules({
        main: main.name,
        files: [
          main,
          { name: "/first.ts", contents: "export const first = 1;" },
        ],
      });
      const second = toModules({
        main: main.name,
        files: [
          main,
          { name: "/second.ts", contents: "export const second = 2;" },
        ],
      });
      const manager = runtime.patternManager.accessForTestingOnly;
      const writeBacks = observeCacheWriteBacks(runtime);
      const firstStarted = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      const secondStarted = Promise.withResolvers<void>();
      const releaseSecond = Promise.withResolvers<void>();
      let writeCount = 0;
      let firstWrite: Promise<void> | undefined;
      let secondWrite: Promise<void> | undefined;
      manager.compileCacheWriter = async () => {
        writeCount++;
        if (writeCount === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else {
          secondStarted.resolve();
          await releaseSecond.promise;
        }
      };

      try {
        firstWrite = manager.persistCompileCacheTracked(
          targetSpace,
          first.modules,
          first.entryIdentity,
          { runtimeVersion },
        );
        await firstStarted.promise;
        secondWrite = manager.persistCompileCacheTracked(
          targetSpace,
          second.modules,
          second.entryIdentity,
          { runtimeVersion },
        );

        expect(writeBacks.inFlight()).toBe(2);
        releaseFirst.resolve();
        await secondStarted.promise;
        releaseSecond.resolve();
        await Promise.all([firstWrite, secondWrite]);
        expect(writeCount).toBe(2);
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
        await Promise.allSettled(
          [firstWrite, secondWrite].filter(
            (write): write is Promise<void> => write !== undefined,
          ),
        );
        writeBacks.restore();
        manager.compileCacheWriter = undefined;
      }
    });

    it("retains persistence entries for the runner session", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const manager = runtime.patternManager.accessForTestingOnly;
      manager.compileCacheWriter = () => Promise.resolve();
      try {
        for (let index = 0; index <= 1000; index++) {
          await manager.persistCompileCacheTracked(
            `did:key:z6MkPersistenceSlot${index}`,
            modules,
            entryIdentity,
            { runtimeVersion },
          );
        }
      } finally {
        manager.compileCacheWriter = undefined;
      }

      expect(manager.persistedCompileCacheClosures.size).toBe(1001);
      expect(
        manager.persistedCompileCacheClosures.has(
          compileCachePersistenceSlotKey(
            "did:key:z6MkPersistenceSlot0",
            entryIdentity,
            { runtimeVersion },
          ),
        ),
      ).toBe(true);
    });

    it("commits a second user's writeback of the same content cleanly", async () => {
      // Compiled docs carry the constant system-compiler atom
      // (`COMPILED_INTEGRITY_ATOM`), which is what makes the cache shared: a
      // re-write of the same content by any user merges cleanly with the
      // deployer's, both sides carrying the identical atom.

      const { modules, entryIdentity } = toModules(PROGRAM);

      // First writer (the deployer) populates the cache.
      const wtxA = runtime.edit();
      writeCompiledDocs(
        runtime,
        spaceA,
        modules,
        entryIdentity,
        opts(),
        wtxA,
      );
      wtxA.prepareCfc();
      const a = await wtxA.commit();
      expect(a.error).toBe(undefined);

      // Second writer (another user's runtime cold-compiling the same content)
      // writes the same docs back. Same content identity, same constant atom —
      // the label merge must accept it without "addIntegrity cannot be
      // weakened".
      const wtxB = runtime.edit();
      writeCompiledDocs(
        runtime,
        spaceA,
        modules,
        entryIdentity,
        opts(),
        wtxB,
      );
      wtxB.prepareCfc();
      const b = await wtxB.commit();
      expect(b.error?.message).toBe(undefined);

      // Any member can then warm-hit the cache.
      const rtx = runtime.edit();
      const loaded = await loadCompiledClosure(
        runtime,
        spaceA,
        entryIdentity,
        opts(),
        rtx,
      );
      rtx.abort?.();
      expect(loaded.size).toBe(3);
    });
  });

  describe("two-identity shared-space compile cache (e2e)", () => {
    // The shared compile-cache space — owned by signerA (its DID is the
    // address).
    const sharedSpace = e2eSignerA.did();
    const RTVER = runtimeVersion;

    // Minimal two-file program for the e2e compile cycle.
    const E2E_PROGRAM: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/util.ts",
          contents: "export const triple = (x:number)=>x*3;",
        },
        {
          name: "/main.tsx",
          contents: [
            "import { pattern, lift } from 'commonfabric';",
            "import { triple } from './util.ts';",
            "const t = lift((x:number)=>triple(x));",
            "export default pattern<{ value: number }>(({ value }) => ({ result: t(value) }));",
          ].join("\n"),
        },
      ],
    };

    let server: MemoryV2Server.Server;
    let smA: EmulatedStorageManager;
    let smB: EmulatedStorageManager;
    let rtA: Runtime;
    let rtB: Runtime;

    beforeEach(() => {
      server = newSharedServer();
      smA = EmulatedStorageManager.connectTo(server, { as: e2eSignerA });
      smB = EmulatedStorageManager.connectTo(server, { as: e2eSignerB });
      rtA = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smA,
        trustSnapshotProvider: () => ({
          id: "e2e-user-a",
          actingPrincipal: e2eSignerA.did(),
        }),
      });
      rtB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smB,
        trustSnapshotProvider: () => ({
          id: "e2e-user-b",
          actingPrincipal: e2eSignerB.did(),
        }),
      });
    });

    afterEach(async () => {
      await rtA?.dispose();
      await rtB?.dispose();
      await smA?.close();
      await smB?.close();
      await server?.close();
    });

    it("runtime B warms from A's cache write and B's cold-compile writeback commits without error", async () => {
      // Session A: cold compile + write-back
      const pmA = rtA.patternManager;
      const txA = rtA.edit();
      await pmA.compilePattern(E2E_PROGRAM, { space: sharedSpace, tx: txA });
      await pmA.flushCompileCacheWrites();
      await txA.commit();
      // Ensure the docs have propagated through the in-process server.
      await smA.synced();

      expect(pmA.getCompileCacheStats()).toEqual({
        hits: 0,
        misses: 1,
        byIdentityHits: 0,
      });

      // Session B: should warm-hit A's committed cache smB has its own
      // per-space client replicas, so it must fetch from the shared server.
      // compilePattern drives the storage read-through internally.
      const pmB = rtB.patternManager;
      const txB = rtB.edit();
      const compiled = await pmB.compilePattern(E2E_PROGRAM, {
        space: sharedSpace,
        tx: txB,
      });
      await txB.commit();

      // (a) Warm hit: B found A's compiled docs without recompiling.
      expect(pmB.getCompileCacheStats()).toEqual({
        hits: 1,
        misses: 0,
        byIdentityHits: 0,
      });
      // The pattern is a runnable function.
      expect(typeof compiled).toBe("function");

      // (b) B's own cold-compile writeback (if it had been a miss) also
      // commits cleanly — the constant atom merges without "addIntegrity cannot
      // be weakened". Exercise this directly via writeCompiledDocs + commit.
      const { modules, entryIdentity } = toModules({
        main: E2E_PROGRAM.main,
        files: E2E_PROGRAM.files,
      });
      const wtxB2 = rtB.edit();
      writeCompiledDocs(
        rtB,
        sharedSpace,
        modules,
        entryIdentity,
        { runtimeVersion: RTVER },
        wtxB2,
      );
      wtxB2.prepareCfc();
      const result = await wtxB2.commit();
      expect(result.error).toBe(undefined);
    });

    it("cold writeback recovers from a partial source cache already committed by another replica", async () => {
      const { modules, entryIdentity } = toModules(E2E_PROGRAM);
      const utilModule = modules.find((module) =>
        module.filename === "/util.ts"
      );
      expect(utilModule).toBeDefined();

      // A partially committed cache graph: only an imported source doc is
      // present in the shared space. Runtime B has not pulled it yet, so its
      // local replica would otherwise build the writeback transaction from a
      // stale seq-0 view.
      const partialTx = rtA.edit();
      writeSourceDocs(
        rtA,
        sharedSpace,
        [utilModule!],
        utilModule!.identity,
        partialTx,
      );
      rtA.prepareTxForCommit(partialTx);
      const partialResult = await partialTx.commit();
      expect(partialResult.error).toBe(undefined);
      await smA.synced();

      const txB = rtB.edit();
      const compiled = await rtB.patternManager.compilePattern(E2E_PROGRAM, {
        space: sharedSpace,
        tx: txB,
      });
      await txB.commit();
      expect(typeof compiled).toBe("function");
      expect(rtB.patternManager.getCompileCacheStats()).toEqual({
        hits: 0,
        misses: 1,
        byIdentityHits: 0,
      });

      const readTx = rtB.edit();
      const source = await loadVerifiedSourceClosure(
        rtB,
        sharedSpace,
        entryIdentity,
        readTx,
      );
      const compiledClosure = await loadCompiledClosure(
        rtB,
        sharedSpace,
        entryIdentity,
        { runtimeVersion: RTVER },
        readTx,
      );
      readTx.abort?.();

      expect(source?.has(entryIdentity)).toBe(true);
      expect(source?.has(utilModule!.identity)).toBe(true);
      expect(compiledClosure.has(entryIdentity)).toBe(true);
      expect(compiledClosure.has(utilModule!.identity)).toBe(true);
    });
  });

  describe("code documents forged below the commit boundary", () => {
    // The commit boundary admits no code document whose string does not hash
    // to its id, so a forgery reaches a store only out of band. These cases
    // model that with direct database manipulation on the shared server and
    // pin that a replica syncing the result refuses the record, on the source
    // path and the compiled path alike.

    let server: MemoryV2Server.Server;
    let smA: EmulatedStorageManager;
    let smB: EmulatedStorageManager;
    let rtA: Runtime;
    let rtB: Runtime;
    const space = e2eSignerA.did();
    const RTVER = "rt-forged-1";

    beforeEach(() => {
      server = newSharedServer();
      smA = EmulatedStorageManager.connectTo(server, { as: e2eSignerA });
      smB = EmulatedStorageManager.connectTo(server, { as: e2eSignerB });
      rtA = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smA,
        trustSnapshotProvider: () => ({
          id: "forged-user-a",
          actingPrincipal: e2eSignerA.did(),
        }),
      });
      rtB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: smB,
        trustSnapshotProvider: () => ({
          id: "forged-user-b",
          actingPrincipal: e2eSignerB.did(),
        }),
      });
    });

    afterEach(async () => {
      await rtA?.dispose();
      await rtB?.dispose();
      await smA?.close();
      await smB?.close();
      await server?.close();
    });

    // Rewrites the stored document holding `code` to hold `forged` instead,
    // then syncs it into the READER's replica and returns a transaction there
    // that has read the forged string back — so what the loaders below refuse
    // is a document that is present and holds the wrong content, never one
    // that is absent.
    const forgeCodeDocument = async (
      code: string,
      forged: string,
    ): Promise<IExtendedStorageTransaction> => {
      const id = `cid:${taggedHashStringOf(code)}` as URI;
      const engine = await server.engineForSpace(space);
      engine.database.prepare(
        `UPDATE revision SET data = :data, seq = seq + 1 WHERE id = :id`,
      ).run({ data: encodeMemoryBoundary({ value: forged }), id });
      engine.database.prepare(
        `UPDATE head SET seq = seq + 1 WHERE id = :id`,
      ).run({ id });
      const synced = await smB.open(space).sync(id, {
        path: [],
        schema: false,
      });
      expect(synced.error).toBeUndefined();
      const rtx = rtB.edit();
      expect(
        rtx.readOrThrow({ space, id, type: "application/json", path: [] }),
      ).toEqual({ value: forged });
      return rtx;
    };

    it("leaves a source record out of the closure when its code document holds other content", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const wtx = rtA.edit();
      writeSourceDocs(rtA, space, modules, entryIdentity, wtx);
      expect((await wtx.commit()).error).toBeUndefined();
      await smA.synced();
      const entry = modules.find((m) => m.identity === entryIdentity)!;
      const rtx = await forgeCodeDocument(
        entry.source,
        `${entry.source}\n// tampered`,
      );

      const loaded = await loadSourceClosure(rtB, space, entryIdentity, rtx);
      rtx.abort?.();

      expect(loaded?.has(entryIdentity)).toBe(false);
    });

    it("treats a compiled record whose code document holds other content as a miss", async () => {
      const { modules, entryIdentity } = toModules(PROGRAM);
      const wtx = rtA.edit();
      writeCompiledDocs(
        rtA,
        space,
        modules,
        entryIdentity,
        { runtimeVersion: RTVER },
        wtx,
      );
      wtx.prepareCfc();
      expect((await wtx.commit()).error).toBeUndefined();
      await smA.synced();
      const entry = modules.find((m) => m.identity === entryIdentity)!;
      const rtx = await forgeCodeDocument(
        entry.js,
        `${entry.js} /* tampered */`,
      );

      const loaded = await loadCompiledClosure(
        rtB,
        space,
        entryIdentity,
        { runtimeVersion: RTVER },
        rtx,
      );
      rtx.abort?.();

      expect(loaded.size).toBe(0);
    });
  });
});
