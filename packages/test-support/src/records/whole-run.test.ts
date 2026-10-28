import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { markWholeRun, readWholeRuns, type WholeRun } from "./whole-run.ts";
import { RECORDS_DIR_VARIABLE } from "./paths.ts";

/** An environment naming `spool` as the run's spool, and nothing else. */
function spoolAt(spool: string): (name: string) => string | undefined {
  return (name) => name === RECORDS_DIR_VARIABLE ? spool : undefined;
}

const RUN: WholeRun = {
  kind: "browser",
  scope: "ui",
  tests: { "packages/ui/a.test.ts": ["renders", "clicks"] },
};

describe("whole-run", () => {
  describe("markWholeRun()", () => {
    it("leaves a mark that `readWholeRuns()` reads back", async () => {
      const spool = await Deno.makeTempDir();
      try {
        markWholeRun(RUN, spoolAt(spool));
        expect(await readWholeRuns(spool)).toEqual([RUN]);
      } finally {
        await Deno.remove(spool, { recursive: true });
      }
    });

    it("does nothing, and says nothing, where no spool is named", () => {
      const said: string[] = [];
      const warn = console.warn;
      console.warn = (message: string) => said.push(message);
      try {
        markWholeRun(RUN, () => undefined);
      } finally {
        console.warn = warn;
      }
      expect(said).toEqual([]);
    });

    it("warns rather than throwing where the mark cannot be written", async () => {
      const parent = await Deno.makeTempDir();
      const spool = join(parent, "in-the-way");
      await Deno.writeTextFile(spool, "");
      const said: string[] = [];
      const warn = console.warn;
      console.warn = (message: string) => said.push(message);
      try {
        markWholeRun(RUN, spoolAt(spool));
      } finally {
        console.warn = warn;
        await Deno.remove(parent, { recursive: true });
      }
      expect(said.length).toBe(1);
      expect(said[0]).toContain("cannot mark a whole run");
    });
  });

  describe("readWholeRuns()", () => {
    it("returns nothing for a mark that does not read as one", async () => {
      const spool = await Deno.makeTempDir();
      try {
        const mark = (body: string) =>
          Deno.writeTextFile(
            join(spool, `whole-run-${crypto.randomUUID()}.json`),
            body,
          );
        await mark("not json");
        await mark(JSON.stringify([RUN]));
        await mark(JSON.stringify({ ...RUN, scope: undefined }));
        await mark(JSON.stringify({ ...RUN, tests: ["renders"] }));
        await mark(JSON.stringify({ ...RUN, tests: { "a.test.ts": "x" } }));
        await mark(JSON.stringify({ ...RUN, tests: { "a.test.ts": [1] } }));
        // A record fragment beside the marks is not one of them.
        await Deno.writeTextFile(
          join(spool, "fragment.ndjson"),
          JSON.stringify(RUN),
        );
        expect(await readWholeRuns(spool)).toEqual([]);
      } finally {
        await Deno.remove(spool, { recursive: true });
      }
    });

    it("throws where the spool cannot be read", async () => {
      // A spool that is there and cannot be listed is not one that holds
      // no marks, and reading it as that would vouch for nothing silently.
      const parent = await Deno.makeTempDir();
      try {
        const spool = join(parent, "a-file");
        await Deno.writeTextFile(spool, "");
        await expect(readWholeRuns(spool)).rejects.toThrow();
      } finally {
        await Deno.remove(parent, { recursive: true });
      }
    });

    it("returns nothing for a spool that does not exist", async () => {
      const parent = await Deno.makeTempDir();
      try {
        expect(await readWholeRuns(join(parent, "absent"))).toEqual([]);
      } finally {
        await Deno.remove(parent, { recursive: true });
      }
    });
  });
});
