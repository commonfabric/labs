import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  computeOutputVersionMemoKey,
  computeSourceCompileCacheVersion,
  CORPUS_DIR,
  memoizeOutputVersion,
  OUTPUT_VERSION_INPUTS,
  OUTPUT_VERSION_MEMO_PATH,
  readOutputVersionMemo,
  writeOutputVersionMemo,
} from "../src/compilation-cache/compile-cache-output-memo.deno.ts";
import {
  computeCompilerVersion,
  VERSION_NAMESPACE,
} from "../src/compilation-cache/compiler-fingerprint.deno.ts";

const REPO_ROOT = fromFileUrl(new URL("../../../", import.meta.url));

// A tree small enough to build per test, with one compiler input and the two
// kinds of output-version input: a module and a corpus directory.
const INPUTS = {
  compilerInputs: ["compiler"],
  outputInputs: ["output.ts", "corpus"],
};

const OUTPUT_VERSION = `${VERSION_NAMESPACE}/OutputVersion001`;

async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await Deno.mkdir(dirname(join(root, path)), { recursive: true });
    await Deno.writeTextFile(join(root, path), contents);
  }
}

describe("compile-cache-output-memo", () => {
  let root: string;

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "compile-cache-memo-" });
    await writeFiles(root, {
      "compiler/transform.ts": "export const transform = 1;\n",
      "output.ts": "export const COMPILE_CACHE_EPOCH = 1;\n",
      "corpus/entry.tsx": "export default 1;\n",
    });
    await Deno.mkdir(join(root, dirname(OUTPUT_VERSION_MEMO_PATH)), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  /** Record a memo for the tree as it stands now. */
  async function recordMemo(version = OUTPUT_VERSION): Promise<void> {
    await writeOutputVersionMemo(root, {
      key: await computeOutputVersionMemoKey(root, INPUTS),
      version,
    });
  }

  function inputVersion(): Promise<string> {
    return computeCompilerVersion(root, INPUTS.compilerInputs);
  }

  describe("computeSourceCompileCacheVersion()", () => {
    it("returns the compiler-input version when the tree records no memo", async () => {
      expect(await computeSourceCompileCacheVersion(root, INPUTS)).toBe(
        await inputVersion(),
      );
    });

    it("returns the recorded output version while the memo's key matches the tree", async () => {
      await recordMemo();

      expect(await computeSourceCompileCacheVersion(root, INPUTS)).toBe(
        OUTPUT_VERSION,
      );
    });

    it("returns the compiler-input version once a compiler input changes", async () => {
      await recordMemo();
      await writeFiles(root, {
        "compiler/transform.ts": "export const transform = 2;\n",
      });

      expect(await computeSourceCompileCacheVersion(root, INPUTS)).toBe(
        await inputVersion(),
      );
    });

    it("returns the compiler-input version once the corpus or the output module changes", async () => {
      // Neither is a compiler input, so the compiler-input version stays put
      // while the output version could move; the memo's key covers both.
      await recordMemo();
      await writeFiles(root, { "corpus/entry.tsx": "export default 2;\n" });
      expect(await computeSourceCompileCacheVersion(root, INPUTS)).toBe(
        await inputVersion(),
      );

      await recordMemo();
      await writeFiles(root, {
        "output.ts": "export const COMPILE_CACHE_EPOCH = 2;\n",
      });
      expect(await computeSourceCompileCacheVersion(root, INPUTS)).toBe(
        await inputVersion(),
      );
    });

    it("returns the compiler-input version for a file that does not hold a memo", async () => {
      const key = await computeOutputVersionMemoKey(root, INPUTS);
      const path = join(root, OUTPUT_VERSION_MEMO_PATH);
      for (
        const contents of [
          "not json",
          JSON.stringify({ key }),
          JSON.stringify({ key, version: `${VERSION_NAMESPACE}/source` }),
          JSON.stringify({ key, version: "elsewhere/OutputVersion001" }),
          JSON.stringify([key, OUTPUT_VERSION]),
        ]
      ) {
        await Deno.writeTextFile(path, contents);
        expect(await readOutputVersionMemo(root)).toBe(undefined);
        expect(await computeSourceCompileCacheVersion(root, INPUTS)).toBe(
          await inputVersion(),
        );
      }
    });
  });

  describe("memoizeOutputVersion()", () => {
    it("records the computed version under the tree's key", async () => {
      const result = await memoizeOutputVersion(
        root,
        () => Promise.resolve(OUTPUT_VERSION),
        INPUTS,
      );

      expect(result).toEqual({ version: OUTPUT_VERSION, recorded: true });
      expect(await readOutputVersionMemo(root)).toEqual({
        key: await computeOutputVersionMemoKey(root, INPUTS),
        version: OUTPUT_VERSION,
      });
    });

    it("computes nothing while the tree's memo still matches it, and again once the tree moves", async () => {
      let computed = 0;
      const compute = () => {
        computed += 1;
        return Promise.resolve(OUTPUT_VERSION);
      };

      await memoizeOutputVersion(root, compute, INPUTS);
      expect(await memoizeOutputVersion(root, compute, INPUTS)).toEqual({
        version: OUTPUT_VERSION,
        recorded: false,
      });
      expect(computed).toBe(1);

      await writeFiles(root, { "corpus/entry.tsx": "export default 2;\n" });
      expect(await memoizeOutputVersion(root, compute, INPUTS)).toEqual({
        version: OUTPUT_VERSION,
        recorded: true,
      });
      expect(computed).toBe(2);
    });

    it("records nothing when the tree changes while its version is computed", async () => {
      const compute = async (at: string) => {
        await writeFiles(at, { "corpus/entry.tsx": "export default 2;\n" });
        return OUTPUT_VERSION;
      };

      await expect(memoizeOutputVersion(root, compute, INPUTS)).rejects
        .toThrow("nothing was recorded");
      expect(await readOutputVersionMemo(root)).toBe(undefined);
    });

    it("records nothing for a value that is not a compile-cache version", async () => {
      await expect(
        memoizeOutputVersion(root, () => Promise.resolve("nonsense"), INPUTS),
      ).rejects.toThrow("is not a compile-cache version");
      expect(await readOutputVersionMemo(root)).toBe(undefined);
    });
  });

  describe("the repository's memo", () => {
    it("covers paths the repository holds, the corpus and the output module among them", async () => {
      expect(OUTPUT_VERSION_INPUTS).toContain(CORPUS_DIR);
      expect(OUTPUT_VERSION_INPUTS).toContain(
        "packages/runner/src/compilation-cache/compile-cache-output-version.deno.ts",
      );
      for (const input of OUTPUT_VERSION_INPUTS) {
        await Deno.stat(join(REPO_ROOT, input));
      }
    });

    it("lives at a path git ignores, so no checkout carries it as a change", async () => {
      const { code } = await new Deno.Command("git", {
        args: ["check-ignore", "--quiet", OUTPUT_VERSION_MEMO_PATH],
        cwd: REPO_ROOT,
        stdout: "null",
        stderr: "null",
      }).output();

      expect(code).toBe(0);
    });
  });
});
