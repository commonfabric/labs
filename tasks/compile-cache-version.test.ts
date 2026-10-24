import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  compileCorpus,
  compileCorpusVariants,
  type CompiledOutput,
  compiledOutputOf,
  type CompiledVariant,
  CORPUS_DIR,
  CORPUS_ENTRIES,
  outputFingerprintOf,
  staleness,
} from "./compile-cache-version.ts";
import {
  COMMITTED_COMPILER_VERSION,
  computeCompilerFingerprint,
  FINGERPRINT_LENGTH,
  VERSION_NAMESPACE,
} from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";
import {
  cacheVariantName,
  PERSISTED_CACHE_VARIANTS,
} from "../packages/runner/src/compilation-cache/cache-variants.ts";
import type { CacheableModule } from "../packages/runner/src/harness/types.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

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

/** The entry module's emitted body under one compiled variant. */
function entryBody(variant: CompiledVariant): string {
  return variant.entries[0].modules
    .find((module) => module.filename === "/main.tsx")!.js;
}

describe("compile-cache-version", () => {
  describe("compiledOutputOf()", () => {
    it("keeps the body and the stored artifact fields, not the source map or identity", () => {
      const output = compiledOutputOf(cacheable({
        sourceMap: "{}",
        policyManifests: [{ a: 1 }],
        importSpecs: ["./double.ts"],
      }));

      expect(output).toEqual({
        filename: "/main.tsx",
        js: "module.exports = 1;",
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
          { filename: "/b.tsx", js: "b", artifact: "" },
          { filename: "/a.ts", js: "a", artifact: "" },
        ],
      }],
    }, {
      variant: "",
      entries: [{
        entry: "a.tsx",
        modules: [{ filename: "/a.tsx", js: "a", artifact: "x" }],
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

    it("changes with an emitted body, a stored artifact field, or the epoch", () => {
      const base = outputFingerprintOf(variants);
      const body = withModule(variants, { variant: 0, module: 1 }, {
        js: "a2",
      });
      expect(outputFingerprintOf(body)).not.toBe(base);
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

  describe("staleness()", () => {
    const minted = { version: `${VERSION_NAMESPACE}/out1`, inputs: "in1" };

    it("returns nothing for a record minted on these inputs with this output", () => {
      expect(staleness(minted, minted)).toBeUndefined();
    });

    it("names the inputs when the fingerprint moved, whatever the output did", () => {
      expect(staleness({ ...minted, inputs: "in0" }, minted)).toContain(
        "inputs changed",
      );
    });

    it("names the output when the inputs match and the bytes moved", () => {
      expect(
        staleness({ ...minted, version: `${VERSION_NAMESPACE}/out0` }, minted),
      ).toContain("different bytes");
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

    it("records the inputs fingerprint of this tree", async () => {
      // The cheap half of the gate: the committed version was minted against
      // the compiler this tree holds. Whether that compiler still emits the
      // bytes the version names takes the corpus compile, which is the gate
      // task's own job (`deno task check-compile-cache-version`).
      expect(COMMITTED_COMPILER_VERSION.inputs).toBe(
        await computeCompilerFingerprint(REPO_ROOT),
      );
    });
  });
});
