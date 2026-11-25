import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { runMemberBatches, runTestBatches } from "./run-test-batches.ts";

/**
 * A directory holding the files a case describes, by name and source. Its
 * path is the real one, since a test run from inside it is named by that
 * path, and a permission granted under another spelling does not reach it.
 */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "batches-fixture-" }),
  );
  for (const [name, source] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/${name}`, source);
  }
  return dir;
}

/**
 * A test file whose one test, `name`, leaves a file `<name>.ran` beside it,
 * which is what tells a case that the test ran.
 */
function marking(name: string): string {
  return `Deno.test(${JSON.stringify(name)}, () => {\n` +
    `  Deno.writeTextFileSync(new URL(${
      JSON.stringify(`${name}.ran`)
    }, import.meta.url), "");\n` +
    "});\n";
}

/** The tests in `dir` that left their mark, by name. */
async function ran(dir: string): Promise<string[]> {
  return (await Array.fromAsync(Deno.readDir(dir)))
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".ran"))
    .map((name) => name.slice(0, -".ran".length))
    .sort();
}

describe("run-test-batches", () => {
  describe("runTestBatches()", () => {
    it("runs every batch's tests", async () => {
      const dir = await fixture({
        "a.test.ts": marking("rises"),
        "b.test.ts": marking("sets"),
      });
      try {
        const flags = ["--no-config", "--no-check", `--allow-write=${dir}`];
        const code = await runTestBatches([
          { flags, files: [`${dir}/a.test.ts`] },
          { flags, files: [`${dir}/b.test.ts`] },
        ]);
        expect(code).toBe(0);
        expect(await ran(dir)).toEqual(["rises", "sets"]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("runs every batch past a failing one, and returns its code", async () => {
      const dir = await fixture({
        "a.test.ts": 'Deno.test("fails on purpose", () => {\n' +
          '  throw new Error("a fixture of runTestBatches() failing");\n' +
          "});\n",
        "b.test.ts": marking("sets"),
      });
      try {
        const flags = ["--no-config", "--no-check", `--allow-write=${dir}`];
        const code = await runTestBatches([
          { flags, files: [`${dir}/a.test.ts`] },
          { flags, files: [`${dir}/b.test.ts`] },
        ]);
        expect(code).not.toBe(0);
        expect(await ran(dir)).toEqual(["sets"]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("runs only the files each batch names", async () => {
      const dir = await fixture({
        "a.test.ts": marking("rises"),
        "b.test.ts": marking("sets"),
      });
      try {
        const code = await runTestBatches([{
          flags: ["--no-config", "--no-check", `--allow-write=${dir}`],
          files: [`${dir}/a.test.ts`],
        }]);
        expect(code).toBe(0);
        expect(await ran(dir)).toEqual(["rises"]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("runMemberBatches()", () => {
    const FILES = {
      "rise.test.ts": marking("rises"),
      "proof.serial.test.ts": marking("proofs"),
    };

    it("runs every file in its group", async () => {
      const dir = await fixture(FILES);
      try {
        const code = await runMemberBatches(
          [
            ".",
            "--serial=**/*.serial.test.ts",
            "--",
            "--no-config",
            "--no-check",
            "--parallel",
            `--allow-write=${dir}`,
          ],
          dir,
        );
        expect(code).toBe(0);
        expect(await ran(dir)).toEqual(["proofs", "rises"]);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("throws naming a glob that matches no test file", async () => {
      const dir = await fixture(FILES);
      try {
        await expect(
          runMemberBatches(
            [".", "--all-access=oven.test.ts", "--", "--no-config"],
            dir,
          ),
        ).rejects.toThrow("No test file matches `oven.test.ts`.");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("throws when the member holds no test file to run", async () => {
      const dir = await fixture({ "helper.ts": "export {};\n" });
      try {
        await expect(runMemberBatches([".", "--"], dir)).rejects.toThrow(
          "No test file to run.",
        );
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("throws the usage for arguments it cannot read", async () => {
      await expect(runMemberBatches(["."], ".")).rejects.toThrow(
        "Usage: run-test-batches.ts",
      );
    });
  });
});
