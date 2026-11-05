import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import {
  compileCorpus,
  compileCorpusVariants,
  type CompiledOutput,
  compiledOutputOf,
  type CompiledVariant,
  CORPUS_ENTRIES,
  outputFingerprintOf,
} from "../src/compilation-cache/compile-cache-output-version.deno.ts";
import { CORPUS_DIR } from "../src/compilation-cache/compile-cache-output-memo.deno.ts";
import { FINGERPRINT_LENGTH } from "../src/compilation-cache/compiler-fingerprint.deno.ts";
import {
  cacheVariantName,
  PERSISTED_CACHE_VARIANTS,
} from "../src/compilation-cache/cache-variants.ts";
import type { CacheableModule } from "../src/harness/types.ts";

const REPO_ROOT = fromFileUrl(new URL("../../../", import.meta.url));

const PLAIN = { patternCoverage: false, instanceNames: false };
const COVERAGE = { patternCoverage: true, instanceNames: false };
const NAMED = { patternCoverage: false, instanceNames: true };

// A corpus small enough to compile in a test, with one entry importing a
// second module and a `const`-bound sub-pattern instance, so every variant
// has something to transform: the coverage mode instruments the branches,
// and the naming mode names `inner`.
const TINY_CORPUS: Record<string, string> = {
  "main.tsx": [
    "import { pattern } from 'commonfabric';",
    "import { Double } from './double.tsx';",
    "export default pattern<{ value: number }>(({ value }) => {",
    "  const inner = Double({ value });",
    "  return { result: inner.result };",
    "});",
  ].join("\n"),
  "double.tsx": [
    "import { lift, pattern } from 'commonfabric';",
    "const double = lift<number>((x) => x > 0 ? x * 2 : 0);",
    "export const Double = pattern<{ value: number }>(({ value }) => {",
    "  return { result: double(value) };",
    "});",
  ].join("\n"),
};

async function writeCorpus(
  files: Record<string, string>,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "compile-cache-corpus-" });
  for (const [name, contents] of Object.entries(files)) {
    await Deno.writeTextFile(join(root, name), contents);
  }
  return root;
}

function cacheable(overrides: Partial<CacheableModule>): CacheableModule {
  return {
    identity: "id",
    filename: "/main.tsx",
    source: "export default 1;",
    js: "module.exports = 1;",
    imports: [],
    ...overrides,
  };
}

/** `variants` with one module of one variant's first entry patched. */
function withModule(
  variants: readonly CompiledVariant[],
  at: { variant: number; module: number },
  patch: Partial<CompiledOutput>,
): CompiledVariant[] {
  return variants.map((variant, v) =>
    v !== at.variant ? variant : {
      ...variant,
      entries: variant.entries.map((entry, e) =>
        e !== 0 ? entry : {
          ...entry,
          modules: entry.modules.map((module, m) =>
            m !== at.module ? module : { ...module, ...patch }
          ),
        }
      ),
    }
  );
}

/** The entry module as one compiled variant reduced it. */
function entryModule(variant: CompiledVariant): CompiledOutput {
  return variant.entries[0].modules
    .find((module) => module.filename === "/main.tsx")!;
}

/** The entry module's emitted body under one compiled variant. */
function entryBody(variant: CompiledVariant): string {
  return entryModule(variant).js;
}

describe("compile-cache-output-version", () => {
  describe("compiledOutputOf()", () => {
    it("keeps the body, the import edges and the stored artifact fields, not the source map or identity", () => {
      const output = compiledOutputOf(cacheable({
        sourceMap: "{}",
        policyManifests: [{ a: 1 }],
        importSpecs: ["./double.ts"],
        imports: [
          { specifier: "./z.ts", targetIdentity: "z" },
          { specifier: "./double.ts", targetIdentity: "d" },
        ],
      }));

      expect(output).toEqual({
        filename: "/main.tsx",
        js: "module.exports = 1;",
        imports: [["./double.ts", "d"], ["./z.ts", "z"]],
        artifact: JSON.stringify({
          importSpecs: ["./double.ts"],
          policyManifests: [{ a: 1 }],
        }),
      });
    });

    it("renders no artifact for a module with only a body", () => {
      expect(compiledOutputOf(cacheable({})).artifact).toBe("");
    });
  });

  describe("outputFingerprintOf()", () => {
    const variants: CompiledVariant[] = [{
      variant: "pattern-coverage",
      entries: [{
        entry: "b.tsx",
        modules: [
          {
            filename: "/b.tsx",
            js: "b",
            imports: [["./a.ts", "a"]],
            artifact: "",
          },
          { filename: "/a.ts", js: "a", imports: [], artifact: "" },
        ],
      }],
    }, {
      variant: "",
      entries: [{
        entry: "a.tsx",
        modules: [{ filename: "/a.tsx", js: "a", imports: [], artifact: "x" }],
      }],
    }];

    it("returns a fingerprint of the key's length", () => {
      expect(outputFingerprintOf(variants)).toHaveLength(FINGERPRINT_LENGTH);
    });

    it("ignores the order variants, entries and modules arrive in", () => {
      const reordered = [...variants].reverse().map((variant) => ({
        ...variant,
        entries: variant.entries.map((entry) => ({
          ...entry,
          modules: [...entry.modules].reverse(),
        })),
      }));
      expect(outputFingerprintOf(reordered)).toBe(
        outputFingerprintOf(variants),
      );
    });

    it("changes with an emitted body, an import edge, a stored artifact field, or the epoch", () => {
      const base = outputFingerprintOf(variants);
      const body = withModule(variants, { variant: 0, module: 1 }, {
        js: "a2",
      });
      expect(outputFingerprintOf(body)).not.toBe(base);
      const edge = withModule(variants, { variant: 0, module: 0 }, {
        imports: [["./a.ts", "a-elsewhere"]],
      });
      expect(outputFingerprintOf(edge)).not.toBe(base);
      const artifact = withModule(variants, { variant: 1, module: 0 }, {
        artifact: "y",
      });
      expect(outputFingerprintOf(artifact)).not.toBe(base);
      expect(outputFingerprintOf(variants, 2)).not.toBe(base);
    });

    it("changes when one variant's bytes change and the others' do not", () => {
      // A change confined to one mode's transform shows up only under that
      // mode's variant, and that is enough to move the version.
      const base = outputFingerprintOf(variants);
      const coverageOnly = withModule(variants, { variant: 0, module: 0 }, {
        js: "b-instrumented-differently",
      });
      expect(outputFingerprintOf(coverageOnly)).not.toBe(base);
      expect(outputFingerprintOf(variants.slice(1))).not.toBe(base);
    });
  });

  describe("compileCorpus()", () => {
    let corpus: string;

    beforeAll(async () => {
      corpus = await writeCorpus(TINY_CORPUS);
    });

    afterAll(async () => {
      await Deno.remove(corpus, { recursive: true });
    });

    it("compiles each entry with its closure and reports the same bytes twice", async () => {
      const first = await compileCorpus(corpus, PLAIN, ["main.tsx"]);
      const second = await compileCorpus(corpus, PLAIN, ["main.tsx"]);

      expect(first.variant).toBe("");
      expect(first.entries).toHaveLength(1);
      // The closure, plus whatever module the compiler injects beside it.
      expect(first.entries[0].modules.map((module) => module.filename))
        .toEqual(expect.arrayContaining(["/double.tsx", "/main.tsx"]));
      expect(entryModule(first).imports.map(([specifier]) => specifier))
        .toContain("./double.tsx");
      expect(outputFingerprintOf([second])).toBe(outputFingerprintOf([first]));
    });

    it("emits different bytes under the coverage and instance-naming variants", async () => {
      // Each mode's transform reaches the corpus, so a change to it moves
      // that variant's bytes and, through them, the version.
      const plain = await compileCorpus(corpus, PLAIN, ["main.tsx"]);
      const coverage = await compileCorpus(corpus, COVERAGE, ["main.tsx"]);
      const named = await compileCorpus(corpus, NAMED, ["main.tsx"]);

      expect(coverage.variant).toBe(cacheVariantName(COVERAGE));
      expect(named.variant).toBe(cacheVariantName(NAMED));
      expect(entryBody(coverage)).not.toBe(entryBody(plain));
      expect(entryBody(named)).not.toBe(entryBody(plain));
      expect(entryBody(named)).toContain("nameInstance");
    });

    it("compiles the corpus once per persisted variant", async () => {
      const variants = await compileCorpusVariants(corpus, ["main.tsx"]);
      expect(variants.map((variant) => variant.variant)).toEqual(
        PERSISTED_CACHE_VARIANTS.map(cacheVariantName),
      );
    });

    it("moves the fingerprint when a corpus file's source changes", async () => {
      const before = outputFingerprintOf([
        await compileCorpus(corpus, PLAIN, ["main.tsx"]),
      ]);
      const edited = await writeCorpus({
        ...TINY_CORPUS,
        "double.tsx": TINY_CORPUS["double.tsx"].replace("x * 2", "x * 3"),
      });
      try {
        const after = outputFingerprintOf([
          await compileCorpus(edited, PLAIN, ["main.tsx"]),
        ]);
        expect(after).not.toBe(before);
      } finally {
        await Deno.remove(edited, { recursive: true });
      }
    });
  });

  describe("the committed corpus", () => {
    it("names only entries the corpus holds, each once", async () => {
      expect(new Set(CORPUS_ENTRIES).size).toBe(CORPUS_ENTRIES.length);
      for (const entry of CORPUS_ENTRIES) {
        const info = await Deno.stat(join(REPO_ROOT, CORPUS_DIR, entry));
        expect(info.isFile).toBe(true);
      }
    });

    describe("each entry", () => {
      // A shipped build compiles the corpus to name its compiler, and a lane's
      // binary build takes the input fingerprint instead to fit the lane, so
      // this is where an entry the compiler stops accepting fails a pull
      // request rather than a release: one entry under one persisted variant
      // per test, each a few seconds, well inside the time a test may take.
      //
      // A test's name writes its entry as `./` and the path in the corpus.
      // A pattern key on its own, such as `chatbot.tsx`, is one the moved-path
      // test-identity aliases rename to where that pattern now lives, and the
      // corpus keeps its own copies where they were.

      for (const entry of CORPUS_ENTRIES) {
        for (const variant of PERSISTED_CACHE_VARIANTS) {
          const name = cacheVariantName(variant);
          it(`compiles ./${entry} under the ${name === "" ? "plain" : name} variant`, async () => {
            const compiled = await compileCorpus(
              join(REPO_ROOT, CORPUS_DIR),
              variant,
              [entry],
            );
            expect(compiled.entries[0].entry).toBe(entry);
            expect(compiled.entries[0].modules.length).toBeGreaterThan(0);
          });
        }
      }
    });
  });
});
