import { ConsoleEvent } from "@astral/astral";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { basename, join } from "@std/path";

import {
  FRAGMENT_PREFIX,
  parseRecordLine,
  RECORDS_DIR_VARIABLE,
} from "@commonfabric/test-support/records";
import { removeDirectory } from "@commonfabric/test-support/remove-directory";

import { applyDefaults } from "../config.ts";
import { Manifest } from "../manifest.ts";
import { packageScope, Runner } from "../runner.ts";
import { HarnessRun, runDenoWebTest } from "./utils.ts";

type ConsoleMethod = "log" | "info" | "debug" | "warn" | "error";

// What the runner prints for the browser console messages of type `types`,
// with `pipeConsole` as given, by the console method each went to.
function printedFor(
  pipeConsole: boolean,
  types: ConsoleEvent["detail"]["type"][],
): [ConsoleMethod, string][] {
  const runner = new Runner(
    new Manifest("/nowhere", [], "/nowhere", applyDefaults({ pipeConsole })),
    0,
  );
  const printed: [ConsoleMethod, string][] = [];
  const methods: ConsoleMethod[] = ["log", "info", "debug", "warn", "error"];
  const stubs = methods.map((method) =>
    stub(console, method, (text: string) => {
      printed.push([method, text]);
    })
  );
  try {
    for (const type of types) {
      runner.browser.dispatchEvent(
        new ConsoleEvent({ type, text: `a ${type}` }),
      );
    }
  } finally {
    for (const restore of stubs) restore.restore();
  }
  return printed;
}

// Runs the success project with a spool of this test's own rather than the
// empty one a fixture run is usually given, and returns the run and every
// line of every record fragment it left in that spool.
async function spooledBy(
  inRepository: boolean,
): Promise<{ run: HarnessRun; lines: string[] }> {
  const spool = await Deno.makeTempDir({ prefix: "deno-web-test-spool-" });
  try {
    const run = await runDenoWebTest(
      "success-project",
      { [RECORDS_DIR_VARIABLE]: spool },
      { inRepository },
    );
    const lines: string[] = [];
    for await (const entry of Deno.readDir(spool)) {
      if (!entry.isFile || !entry.name.startsWith(FRAGMENT_PREFIX)) continue;
      const text = await Deno.readTextFile(join(spool, entry.name));
      for (const line of text.split("\n")) {
        if (line.length > 0) lines.push(line);
      }
    }
    run.assert(run.success, "the run passed");
    run.assert(
      /ok \| 2 passed/.test(run.stdoutText),
      "the run ran the project's tests",
    );
    return { run, lines };
  } finally {
    await removeDirectory(spool);
  }
}

describe("runner", () => {
  describe("packageScope()", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "deno-web-test-scope-" });
    });

    afterEach(async () => {
      await removeDirectory(dir);
    });

    it("returns the last segment of the name deno.json gives", async () => {
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        '{ "name": "@example/oven" }',
      );
      await Deno.writeTextFile(
        join(dir, "deno.jsonc"),
        '{ "name": "@example/stove" }',
      );
      expect(await packageScope(dir)).toBe("oven");
    });

    it("returns the name deno.jsonc gives when deno.json names nothing", async () => {
      await Deno.writeTextFile(join(dir, "deno.json"), '{ "name": "" }');
      await Deno.writeTextFile(
        join(dir, "deno.jsonc"),
        '// The package.\n{ "name": "stove" }',
      );
      expect(await packageScope(dir)).toBe("stove");
    });

    it("returns the directory's own name when no manifest names it", async () => {
      await Deno.writeTextFile(join(dir, "deno.jsonc"), "not json");
      expect(await packageScope(dir)).toBe(basename(dir));
    });
  });

  describe("Runner", () => {
    describe("instance members", () => {
      describe("onConsole()", () => {
        it("prints each browser message through the matching console method", () => {
          expect(
            printedFor(true, ["log", "info", "debug", "warning", "error"]),
          ).toEqual([
            ["log", "browser: a log"],
            ["info", "browser: a info"],
            ["debug", "browser: a debug"],
            ["warn", "browser: a warning"],
            ["error", "browser: a error"],
          ]);
        });

        it("prints nothing for a message of another type", () => {
          expect(printedFor(true, ["table", "dir"])).toEqual([]);
        });

        it("prints nothing when the config does not pipe the console", () => {
          expect(printedFor(false, ["log", "warning", "error"])).toEqual([]);
        });
      });
    });
  });

  it("spools a record per test of a project inside a repository", async () => {
    const { run, lines } = await spooledBy(true);
    const records = lines.flatMap((line) => parseRecordLine(line) ?? []);
    run.assert(
      records.length === 2 && lines.length === 2,
      `the spool holds ${lines.length} line(s): ${lines.join("\n")}`,
    );
    run.assert(
      records.every((record) =>
        record.test.k === "browser" &&
        record.file === "success-project/add.test.ts"
      ),
      `the records name the wrong test or file: ${lines.join("\n")}`,
    );
  });

  it("spools no record for a project inside no repository", async () => {
    const { run, lines } = await spooledBy(false);
    run.assert(
      lines.length === 0,
      `the spool holds ${lines.length} line(s): ${lines.join("\n")}`,
    );
  });
});
