import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type CompileCacheVersionCommands,
  main,
} from "./compile-cache-version.ts";
import { OUTPUT_VERSION_MEMO_PATH } from "../packages/runner/src/compilation-cache/compile-cache-output-memo.deno.ts";

const VERSION = "cf/esm-compile/OutputVersion001";

describe("compile-cache-version", () => {
  describe("main()", () => {
    let printed: string[];
    let originalLog: typeof console.log;
    let originalError: typeof console.error;

    beforeEach(() => {
      printed = [];
      originalLog = console.log;
      originalError = console.error;
      console.log = (line: string) => printed.push(line);
      console.error = (line: string) => printed.push(line);
    });

    afterEach(() => {
      console.log = originalLog;
      console.error = originalError;
    });

    /** Commands that record which ran; `recorded` is what memoize reports. */
    function commandsThat(
      ran: string[],
      recorded = true,
    ): CompileCacheVersionCommands {
      return {
        print: () => {
          ran.push("print");
          return Promise.resolve(VERSION);
        },
        memoize: () => {
          ran.push("memoize");
          return Promise.resolve({ version: VERSION, recorded });
        },
      };
    }

    it("prints the version and records no memo when given no argument", async () => {
      const ran: string[] = [];

      expect(await main([], commandsThat(ran))).toBe(0);
      expect(ran).toEqual(["print"]);
      expect(printed).toEqual([VERSION]);
    });

    it("records the memo with --memo and says whether it recorded one", async () => {
      const ran: string[] = [];

      expect(await main(["--memo"], commandsThat(ran))).toBe(0);
      expect(await main(["--memo"], commandsThat(ran, false))).toBe(0);
      expect(ran).toEqual(["memoize", "memoize"]);
      expect(printed).toEqual([
        `${OUTPUT_VERSION_MEMO_PATH}: recorded ${VERSION}.`,
        `${OUTPUT_VERSION_MEMO_PATH}: already records ${VERSION} for this tree.`,
      ]);
    });

    it("returns 2 and runs nothing for an argument it does not take", async () => {
      const ran: string[] = [];

      expect(await main(["--bake"], commandsThat(ran))).toBe(2);
      expect(ran).toEqual([]);
      expect(printed[0]).toContain('Unknown argument "--bake"');
    });
  });
});
