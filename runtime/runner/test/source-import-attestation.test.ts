import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime, type RuntimeFetch } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import {
  compilerStack,
  ensureCompilerStack,
  observeCompilerStackDemandsForTestingOnly,
} from "../src/harness/deferred-compiler-stack.ts";
import {
  compiledDocKey,
  loadCompiledClosure,
  loadVerifiedSourceClosure,
  readVerifiedSourceClosure,
  setCompileCacheRuntimeVersionForTesting,
  type SourceDoc,
  verifySourceDocs,
  writeCompiledDocs,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";
import {
  ensureSpaceRootPattern,
  resolveSpaceRootPattern,
} from "../src/ensure-space-root.ts";
import { getPieceSourceRevisions } from "../src/index.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

await ensureCompilerStack();

const signer = await Identity.fromPassphrase("source import attestation");
const space = signer.did() as MemorySpace;
const otherSpace = "did:key:z6MkSourceImportAttestationOtherSpace";

/**
 * A program whose entry names a value import, a type-only import, and an
 * import type: every kind of edge the identity scan reads.
 */
const program: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "import { label } from './label.ts';",
        "import type { Shape } from './shape.ts';",
        "type Alias = import('./shape.ts').Shape;",
        "export default pattern<{ shape?: Shape; alias?: Alias }, " +
        "{ label: string }>(() => ({ label }));",
      ].join("\n"),
    },
    { name: "/label.ts", contents: "export const label = 'label';\n" },
    { name: "/shape.ts", contents: "export interface Shape { n: number }\n" },
  ],
};

/** Runs `fn` and returns how many times it asked for the compiler. */
async function compilerDemandsOf(fn: () => Promise<unknown>): Promise<number> {
  let demands = 0;
  const stop = observeCompilerStackDemandsForTestingOnly(() => demands++);
  try {
    await fn();
  } finally {
    stop();
  }
  return demands;
}

/** The import list the identity scan reads from `doc`'s source. */
function scannedImports(doc: SourceDoc): readonly string[] {
  const { scanModuleDeclarations, ts } = compilerStack();
  return scanModuleDeclarations(
    { name: doc.filename, contents: doc.code },
    ts.ScriptTarget.ES2023,
  ).imports;
}

describe("source import attestation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  const runtimes: Runtime[] = [];

  const newRuntime = (
    options: {
      fetch?: RuntimeFetch;
      navigateCallback?: (target: Cell<unknown>) => void;
    } = {},
  ): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      ...options,
    });
    runtimes.push(runtime);
    return runtime;
  };

  /** Compiles `program` into `space`, persisting both sets, and returns the
   * entry identity. */
  const compileIntoSpace = async (runtime: Runtime): Promise<string> => {
    const pattern = await runtime.patternManager.compilePattern(program, {
      space,
    });
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.idle();
    return runtime.patternManager.getArtifactEntryRef(pattern)!.identity;
  };

  const runtimeVersionOf = async (runtime: Runtime): Promise<string> => {
    const version = await runtime.patternManager.compileCacheRuntimeVersion({
      patternCoverage: false,
    });
    expect(version).toBeDefined();
    return version!;
  };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    for (const runtime of runtimes.splice(0).reverse()) {
      await runtime.idle();
      await runtime.dispose();
    }
    await storageManager.close();
  });

  describe("compiled documents", () => {
    it("store each code module's import list as the identity scan reads it from the module's source", async () => {
      const runtime = newRuntime();
      const entry = await compileIntoSpace(runtime);

      const tx = runtime.edit();
      try {
        const compiled = await loadCompiledClosure(
          runtime,
          space,
          entry,
          { runtimeVersion: await runtimeVersionOf(runtime) },
          tx,
        );
        const source = await loadVerifiedSourceClosure(
          runtime,
          space,
          entry,
          tx,
        );
        expect(source?.has(entry)).toBe(true);
        for (const [identity, doc] of source!) {
          expect(compiled.get(identity)?.sourceImports).toEqual(
            scannedImports(doc),
          );
        }
        expect(compiled.get(entry)?.sourceImports).toEqual([
          "commonfabric",
          "./label.ts",
          "./shape.ts",
        ]);
      } finally {
        tx.abort();
      }
    });

    it("register their lists in the space they were read from, and in no other", async () => {
      const writer = newRuntime();
      const entry = await compileIntoSpace(writer);
      const reader = newRuntime();
      expect(reader.attestedSourceImports(space, entry)).toBeUndefined();

      const tx = reader.edit();
      try {
        await loadCompiledClosure(
          reader,
          space,
          entry,
          { runtimeVersion: await runtimeVersionOf(reader) },
          tx,
        );
      } finally {
        tx.abort();
      }

      expect(reader.attestedSourceImports(space, entry)).toEqual([
        "commonfabric",
        "./label.ts",
        "./shape.ts",
      ]);
      expect(reader.attestedSourceImports(otherSpace, entry)).toBeUndefined();
    });
    it("register nothing from a compiled document without the compiler's stamp", async () => {
      const runtime = newRuntime();
      const version = await runtimeVersionOf(runtime);
      const identity = "unstamped-module";
      expect(
        (await runtime.editWithRetry((tx) => {
          runtime.getCell(
            space,
            compiledDocKey(version, identity),
            undefined,
            tx,
          )
            .set({
              kind: "compiled",
              identity,
              code: "export const x = 1;",
              filename: "/unstamped.ts",
              sourceImports: ["./forged.ts"],
              imports: [],
            });
        })).error,
      ).toBeUndefined();

      const tx = runtime.edit();
      try {
        const closure = await loadCompiledClosure(
          runtime,
          space,
          identity,
          { runtimeVersion: version },
          tx,
        );
        expect(closure.size).toBe(0);
      } finally {
        tx.abort();
      }

      expect(runtime.attestedSourceImports(space, identity)).toBeUndefined();
    });
  });

  describe("verifySourceDocs()", () => {
    const leaf = { name: "/leaf.ts", contents: "export const leaf = 1;\n" };

    /**
     * A two-module closure keyed as though the entry's source named no
     * import at all, while its text imports `./leaf.ts`: only a verifier that
     * takes `[]` as the entry's list, rather than parsing the text, computes
     * the key it is stored under.
     */
    const closureKeyedByList = (): {
      entry: string;
      docs: Map<string, SourceDoc>;
    } => {
      const main = {
        name: "/main.ts",
        contents: "import { leaf } from './leaf.ts';\nexport { leaf };\n",
      };
      const hashes = computeModuleHashes(
        { main: main.name, files: [main, leaf] },
        { declarations: new Map([[main.name, { imports: [] }]]) },
      );
      const entry = hashes.get(main.name)!;
      return {
        entry,
        docs: new Map<string, SourceDoc>([
          [entry, {
            kind: "source",
            code: main.contents,
            filename: main.name,
            imports: [],
          }],
          [hashes.get(leaf.name)!, {
            kind: "source",
            code: leaf.contents,
            filename: leaf.name,
            imports: [],
          }],
        ]),
      };
    };

    it("takes an attested import list in place of parsing the module's source", () => {
      const { entry, docs } = closureKeyedByList();

      expect(verifySourceDocs(entry, docs).ok).toBe(false);
      expect(
        verifySourceDocs(
          entry,
          docs,
          "",
          (identity) => identity === entry ? [] : undefined,
        ).ok,
      ).toBe(true);
    });

    it("returns a mismatch for a source whose bytes differ from the ones its attested list was scanned from", () => {
      const doc: SourceDoc = {
        kind: "source",
        code: leaf.contents,
        filename: leaf.name,
        imports: [],
      };
      const identity = computeModuleHashes({
        main: leaf.name,
        files: [leaf],
      }).get(leaf.name)!;
      const attested = (id: string) => id === identity ? [] : undefined;
      expect(
        verifySourceDocs(identity, new Map([[identity, doc]]), "", attested)
          .ok,
      ).toBe(true);

      const forged = new Map([[identity, {
        ...doc,
        code: "export const leaf = 2;\n",
      }]]);
      const verdict = verifySourceDocs(identity, forged, "", attested);

      expect(verdict.ok).toBe(false);
      expect(verdict.mismatches).toEqual([identity]);
    });
  });

  describe("PatternManager.prepareSourceClosureVerification()", () => {
    it("asks for no compiler when the compiled closure attests every module's import list", async () => {
      const entry = await compileIntoSpace(newRuntime());
      const fresh = newRuntime();

      const demands = await compilerDemandsOf(() =>
        fresh.patternManager.prepareSourceClosureVerification(space, [entry])
      );

      expect(demands).toBe(0);
      const tx = fresh.edit();
      try {
        expect(readVerifiedSourceClosure(fresh, space, entry, tx)?.has(entry))
          .toBe(true);
      } finally {
        tx.abort();
      }
    });

    it("asks for the compiler for an attested closure when this runtime reads no compiled closures", async () => {
      // The attested lists live in the compiled documents, which a runtime
      // with no compile-cache version does not read.
      const entry = await compileIntoSpace(newRuntime());
      const fresh = newRuntime();

      const restore = setCompileCacheRuntimeVersionForTesting(undefined);
      try {
        const demands = await compilerDemandsOf(() =>
          fresh.patternManager.prepareSourceClosureVerification(space, [entry])
        );
        expect(demands).toBeGreaterThan(0);
      } finally {
        restore();
      }
    });

    /** Writes a module whose compiled document carries no attested list,
     * as one written before the field existed, and returns its identity. */
    const writeUnattestedModule = async (runtime: Runtime): Promise<string> => {
      const source = "export const revision = 'legacy';\n";
      const module: CacheableModule = {
        identity: computeModuleHashes({
          main: "/legacy.ts",
          files: [{ name: "/legacy.ts", contents: source }],
        }).get("/legacy.ts")!,
        filename: "/legacy.ts",
        source,
        js: "export const revision = 'legacy';",
        imports: [],
      };
      const version = await runtimeVersionOf(runtime);
      expect(
        (await runtime.editWithRetry((tx) => {
          writeSourceDocs(runtime, space, [module], module.identity, tx);
          writeCompiledDocs(runtime, space, [module], module.identity, {
            runtimeVersion: version,
          }, tx);
        })).error,
      ).toBeUndefined();
      return module.identity;
    };

    it("asks for the compiler when a module's compiled document carries no attested list", async () => {
      const legacy = await writeUnattestedModule(newRuntime());
      const fresh = newRuntime();

      const demands = await compilerDemandsOf(() =>
        fresh.patternManager.prepareSourceClosureVerification(space, [legacy])
      );

      expect(demands).toBeGreaterThan(0);
    });

    it("synchronizes every closure it is given, also those after one that needs the parser", async () => {
      // A runtime of its own session, so that only what the preparation
      // synchronizes reaches its replica.
      const server = newSharedServer();
      const writerStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const freshStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const writer = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: writerStorage,
      });
      const fresh = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: freshStorage,
      });
      try {
        const legacy = await writeUnattestedModule(writer);
        const pattern = await writer.patternManager.compilePattern(program, {
          space,
        });
        await writer.patternManager.flushCompileCacheWrites();
        await writer.idle();
        const entry = writer.patternManager.getArtifactEntryRef(pattern)!
          .identity;

        await fresh.patternManager.prepareSourceClosureVerification(space, [
          legacy,
          entry,
        ]);

        const tx = fresh.edit();
        try {
          expect(
            readVerifiedSourceClosure(fresh, space, entry, tx)?.has(entry),
          ).toBe(true);
        } finally {
          tx.abort();
        }
      } finally {
        await fresh.dispose();
        await writer.dispose();
        await freshStorage.close();
        await writerStorage.close();
        await server.close();
      }
    });
  });

  describe("a handler creating a child piece under a `system:` origin", () => {
    const APP_DIR = "/api/patterns/system/default-app";
    const files = new Map([
      [
        `${APP_DIR}/default-app.tsx`,
        [
          "import { handler, navigateTo, pattern, type Stream } from " +
          "'commonfabric';",
          "import Child from './child.tsx';",
          "const create = handler<void, Record<string, never>>(() =>",
          "  navigateTo(Child({ label: 'child' }))",
          ");",
          "export default pattern<Record<string, never>, " +
          "{ create: Stream<void> }>(() => ({ create: create({}) }));",
        ].join("\n"),
      ],
      [
        `${APP_DIR}/child.tsx`,
        [
          "import { pattern } from 'commonfabric';",
          "export default pattern<{ label: string }, { label: string }>(",
          "  ({ label }) => ({ label }),",
          ");",
        ].join("\n"),
      ],
    ]);
    const fetchStub: RuntimeFetch = (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.href
          : input.url,
      );
      const body = files.get(url.pathname);
      return Promise.resolve(
        body === undefined
          ? new Response("not found", { status: 404 })
          : new Response(body),
      );
    };

    it("records the child's creation revision in a runtime that never compiled, without asking for the compiler", async () => {
      const activating = newRuntime({ fetch: fetchStub });
      await ensureSpaceRootPattern(activating, space, { isHomeSpace: false });
      await activating.patternManager.flushCompileCacheWrites();
      await activating.idle();

      const navigated: Cell<unknown>[] = [];
      const serving = newRuntime({
        fetch: fetchStub,
        navigateCallback: (target) => navigated.push(target),
      });
      const demands = await compilerDemandsOf(async () => {
        const root = await resolveSpaceRootPattern(serving, space);
        expect(await serving.start(root!)).toBe(true);
        await serving.idle();
        root!.asSchema({
          type: "object",
          properties: { create: { asCell: ["stream"] } },
        }).key("create").send({});
        await serving.settled();
      });

      expect(navigated).toHaveLength(1);
      const child = navigated[0].resolveAsCell();
      await child.sync();
      expect(getPieceSourceRevisions(child).map((r) => r.operation)).toEqual([
        "create",
      ]);
      expect(demands).toBe(0);
    });
  });
});
