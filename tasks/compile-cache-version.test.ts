import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type CompileCacheVersionCommands,
  main,
} from "./compile-cache-version.ts";
import { OUTPUT_VERSION_MEMO_PATH } from "../runtime/runner/src/compilation-cache/compile-cache-output-memo.deno.ts";
import type { CorpusEntryCompiled } from "../runtime/runner/src/compilation-cache/compile-cache-output-version.deno.ts";

const VERSION = "cf/esm-compile/OutputVersion001";

/** Two entries finishing, as a corpus compile reports them. */
const COMPILED: readonly CorpusEntryCompiled[] = [
  {
    entry: "dice.tsx",
    variantNumber: 1,
    variantCount: 4,
    entryNumber: 5,
    entryCount: 26,
  },
  {
    entry: "system/home.tsx",
    variantNumber: 2,
    variantCount: 4,
    entryNumber: 18,
    entryCount: 26,
  },
];

const COMPILED_LINES = [
  "compiled dice.tsx (variant 1 of 4, entry 5 of 26)",
  "compiled system/home.tsx (variant 2 of 4, entry 18 of 26)",
];

describe("compile-cache-version", () => {
  describe("main()", () => {
    let stdout: string[];
    let stderr: string[];
    let originalLog: typeof console.log;
    let originalError: typeof console.error;

    beforeEach(() => {
      stdout = [];
      stderr = [];
      originalLog = console.log;
      originalError = console.error;
      console.log = (line: string) => stdout.push(line);
      console.error = (line: string) => stderr.push(line);
    });

    afterEach(() => {
      console.log = originalLog;
      console.error = originalError;
    });

    /**
     * Commands that record which ran. `recorded` is what memoize reports. A
     * memoize that records nothing reports no compiled entries, as
     * `memoizeOutputVersion` compiles nothing for a tree whose memo matches.
     */
    function commandsThat(
      ran: string[],
      recorded = true,
    ): CompileCacheVersionCommands {
      return {
        print: (onCompiled) => {
          ran.push("print");
          COMPILED.forEach(onCompiled);
          return Promise.resolve(VERSION);
        },
        memoize: (onCompiled) => {
          ran.push("memoize");
          if (recorded) COMPILED.forEach(onCompiled);
          return Promise.resolve({ version: VERSION, recorded });
        },
      };
    }

    it("prints the version and records no memo when given no argument", async () => {
      // Standard output holds the version alone, so the compiled entries go
      // to standard error.

      const ran: string[] = [];

      expect(await main([], commandsThat(ran))).toBe(0);
      expect(ran).toEqual(["print"]);
      expect(stdout).toEqual([VERSION]);
      expect(stderr).toEqual(COMPILED_LINES);
    });

    it("records the memo with --memo and says whether it recorded one", async () => {
      // Each compiled entry is a line on standard output ahead of the verdict,
      // and with no compiled entries the verdict is the only line.

      const ran: string[] = [];

      expect(await main(["--memo"], commandsThat(ran))).toBe(0);
      expect(await main(["--memo"], commandsThat(ran, false))).toBe(0);
      expect(ran).toEqual(["memoize", "memoize"]);
      expect(stdout).toEqual([
        ...COMPILED_LINES,
        `${OUTPUT_VERSION_MEMO_PATH}: recorded ${VERSION}.`,
        `${OUTPUT_VERSION_MEMO_PATH}: already records ${VERSION} for this tree.`,
      ]);
      expect(stderr).toEqual([]);
    });

    it("returns 2 and runs nothing for an argument it does not take", async () => {
      const ran: string[] = [];

      expect(await main(["--bake"], commandsThat(ran))).toBe(2);
      expect(ran).toEqual([]);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        expect.stringContaining('Unknown argument "--bake"'),
      ]);
    });

    it("rejects with the command's failure, after reporting the entries that compiled", async () => {
      // Neither form prints a result. The rejection leaves the process through
      // its top-level `await`, which exits with status 1.

      const failure = new Error("the tree changed while it compiled");
      const failing: CompileCacheVersionCommands = {
        print: (onCompiled) => {
          COMPILED.forEach(onCompiled);
          return Promise.reject(failure);
        },
        memoize: (onCompiled) => {
          COMPILED.forEach(onCompiled);
          return Promise.reject(failure);
        },
      };

      await expect(main([], failing)).rejects.toBe(failure);
      await expect(main(["--memo"], failing)).rejects.toBe(failure);
      expect(stdout).toEqual(COMPILED_LINES);
      expect(stderr).toEqual(COMPILED_LINES);
    });
  });
});
