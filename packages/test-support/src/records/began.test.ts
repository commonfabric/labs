import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  BEGAN_PREFIX,
  BEGAN_SUFFIX,
  markUnitsBegan,
  unitsBegan,
} from "./began.ts";
import { RECORDS_DIR_VARIABLE } from "./paths.ts";

/** An environment naming `spool` as the run's spool, and nothing else. */
function spoolAt(spool: string): (name: string) => string | undefined {
  return (name) => name === RECORDS_DIR_VARIABLE ? spool : undefined;
}

/** Every entry a directory holds, by name. */
async function entriesOf(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names;
}

describe("began", () => {
  describe("markUnitsBegan()", () => {
    it("leaves a mark that `unitsBegan()` reads back", async () => {
      const spool = await Deno.makeTempDir();
      try {
        markUnitsBegan(spoolAt(spool), 1_700_000_000_123);
        expect(await unitsBegan(spool)).toBe(1_700_000_000_123);
      } finally {
        await Deno.remove(spool, { recursive: true });
      }
    });

    it("leaves one mark per call, so every worker of a process leaves its own", async () => {
      const spool = await Deno.makeTempDir();
      try {
        markUnitsBegan(spoolAt(spool), 2_000);
        markUnitsBegan(spoolAt(spool), 1_000);
        const names = await entriesOf(spool);
        expect(names.length).toBe(2);
        for (const name of names) {
          expect(name.startsWith(BEGAN_PREFIX)).toBe(true);
          expect(name.endsWith(BEGAN_SUFFIX)).toBe(true);
        }
      } finally {
        await Deno.remove(spool, { recursive: true });
      }
    });

    it("warns rather than throwing where the mark cannot be written", async () => {
      // A file where the spool should be. A missing mark costs a
      // measurement, and must not fail the tests the process was running.
      const parent = await Deno.makeTempDir();
      const spool = join(parent, "in-the-way");
      await Deno.writeTextFile(spool, "");
      const said: string[] = [];
      const warn = console.warn;
      console.warn = (...parts: unknown[]) => said.push(parts.join(" "));
      try {
        markUnitsBegan(spoolAt(spool), 1_000);
      } finally {
        console.warn = warn;
        await Deno.remove(parent, { recursive: true });
      }
      expect(said.join("\n")).toContain("cannot mark when units began");
    });

    it("writes nothing where no spool is named", async () => {
      const dir = await Deno.makeTempDir();
      try {
        markUnitsBegan(() => undefined, 1_000);
        markUnitsBegan((name) => name === RECORDS_DIR_VARIABLE ? "" : dir);
        expect(await entriesOf(dir)).toEqual([]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("unitsBegan()", () => {
    it("returns the earliest of the marks a spool holds", async () => {
      const spool = await Deno.makeTempDir();
      try {
        for (const at of [3_000, 1_000, 2_000]) {
          markUnitsBegan(spoolAt(spool), at);
        }
        expect(await unitsBegan(spool)).toBe(1_000);
      } finally {
        await Deno.remove(spool, { recursive: true });
      }
    });

    it("passes over a mark that does not read as a time, and anything else in the spool", async () => {
      const spool = await Deno.makeTempDir();
      try {
        markUnitsBegan(spoolAt(spool), 5_000);
        await Deno.writeTextFile(
          join(spool, `${BEGAN_PREFIX}text${BEGAN_SUFFIX}`),
          JSON.stringify("1000"),
        );
        await Deno.writeTextFile(join(spool, "fragment-1.jsonl"), "1000\n");
        await Deno.writeTextFile(
          join(spool, `${BEGAN_PREFIX}broken${BEGAN_SUFFIX}`),
          "{",
        );
        expect(await unitsBegan(spool)).toBe(5_000);
      } finally {
        await Deno.remove(spool, { recursive: true });
      }
    });

    it("throws where the spool cannot be read, rather than reading no mark", async () => {
      // A file where the spool should be is one way reading it fails.
      const dir = await Deno.makeTempDir();
      try {
        const file = join(dir, "not-a-directory");
        await Deno.writeTextFile(file, "");
        await expect(unitsBegan(file)).rejects.toThrow();
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns `undefined` for a spool holding no mark, and for one that does not exist", async () => {
      const spool = await Deno.makeTempDir();
      try {
        expect(await unitsBegan(spool)).toBeUndefined();
        expect(await unitsBegan(join(spool, "missing"))).toBeUndefined();
      } finally {
        await Deno.remove(spool, { recursive: true });
      }
    });
  });
});
