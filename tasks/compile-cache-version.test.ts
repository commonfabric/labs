import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  compileCorpus,
  compiledOutputOf,
  CORPUS_DIR,
  CORPUS_ENTRIES,
  mintCompilerVersion,
  outputFingerprintOf,
  staleness,
} from "./compile-cache-version.ts";
import {
  COMMITTED_COMPILER_VERSION,
  FINGERPRINT_LENGTH,
  VERSION_NAMESPACE,
} from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";
import type { CacheableModule } from "../packages/runner/src/harness/types.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

// A corpus small enough to compile in a test, with one entry importing a
// second module, so the fingerprint covers more than the entry's own body.
const TINY_CORPUS: Record<string, string> = {
  "main.tsx": [
    "import { pattern } from 'commonfabric';",
    "import { double } from './double.ts';",
    "export default pattern<{ value: number }>(({ value }) => {",
    "  return { result: double(value) };",
    "});",
  ].join("\n"),
  "double.ts": [
    "import { lift } from 'commonfabric';",
    "export const double = lift<number>((x) => x * 2);",
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
    const entries = [{
      entry: "b.tsx",
      modules: [
        { filename: "/b.tsx", js: "b", artifact: "" },
        { filename: "/a.ts", js: "a", artifact: "" },
      ],
    }, {
      entry: "a.tsx",
      modules: [{ filename: "/a.tsx", js: "a", artifact: "x" }],
    }];

    it("returns a fingerprint of the key's length", () => {
      expect(outputFingerprintOf(entries)).toHaveLength(FINGERPRINT_LENGTH);
    });

    it("ignores the order entries and modules arrive in", () => {
      const reordered = [...entries].reverse().map((entry) => ({
        ...entry,
        modules: [...entry.modules].reverse(),
      }));
      expect(outputFingerprintOf(reordered)).toBe(outputFingerprintOf(entries));
    });

    it("changes with an emitted body, a stored artifact field, or the epoch", () => {
      const base = outputFingerprintOf(entries);
      const body = structuredClone(entries);
      body[0].modules[1] = { ...body[0].modules[1], js: "a2" };
      expect(outputFingerprintOf(body)).not.toBe(base);
      const artifact = structuredClone(entries);
      artifact[1].modules[0] = { ...artifact[1].modules[0], artifact: "y" };
      expect(outputFingerprintOf(artifact)).not.toBe(base);
      expect(outputFingerprintOf(entries, 2)).not.toBe(base);
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
      const first = await compileCorpus(corpus, ["main.tsx"]);
      const second = await compileCorpus(corpus, ["main.tsx"]);

      expect(first).toHaveLength(1);
      // The closure, plus whatever module the compiler injects beside it.
      expect(first[0].modules.map((module) => module.filename)).toEqual(
        expect.arrayContaining(["/double.ts", "/main.tsx"]),
      );
      expect(outputFingerprintOf(second)).toBe(outputFingerprintOf(first));
    });

    it("moves the fingerprint when a corpus file's source changes", async () => {
      const before = outputFingerprintOf(
        await compileCorpus(corpus, ["main.tsx"]),
      );
      const edited = await writeCorpus({
        ...TINY_CORPUS,
        "double.ts": TINY_CORPUS["double.ts"].replace("x * 2", "x * 3"),
      });
      try {
        const after = outputFingerprintOf(
          await compileCorpus(edited, ["main.tsx"]),
        );
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

    it("mints the committed version for the committed inputs", async () => {
      // The gate itself, run as a test: the version module says what this
      // compiler emits for this corpus, and what inputs it was measured on.
      const minted = await mintCompilerVersion(REPO_ROOT);
      expect(staleness(COMMITTED_COMPILER_VERSION, minted)).toBeUndefined();
    });
  });
});
