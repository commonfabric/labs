import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { emitRuntimeCode } from "./verify-runtime-bytes.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** Run the verifier's command interface against the supplied source files. */
async function runVerifier(files: string[]): Promise<Deno.CommandOutput> {
  return await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lockPath) => [
      "run",
      "--frozen",
      "--lock",
      lockPath,
      "-A",
      join(REPO_ROOT, "tasks/verify-runtime-bytes.ts"),
      ...files,
    ],
  });
}

describe("verify-runtime-bytes", () => {
  it("rejects invalid syntax before producing comparison evidence", () => {
    expect(() => emitRuntimeCode("export const broken = ;", "broken.ts"))
      .toThrow("Expression expected");
  });

  it("ignores comments and types while retaining runtime changes", () => {
    const before = emitRuntimeCode("export const value: number = 3;", "a.ts");
    const comments = emitRuntimeCode(
      "/** A value. */\nexport const value = 3;",
      "b.ts",
    );
    const changed = emitRuntimeCode("export const value = 4;", "c.ts");
    expect(comments).toBe(before);
    expect(changed).not.toBe(before);
  });

  it("emits one comparison record per file in argument order", async () => {
    const directory = await Deno.makeTempDir();
    try {
      const first = join(directory, "first source.ts");
      const second = join(directory, "second é.ts");
      await Deno.writeTextFile(
        first,
        "/** First. */\nexport const first: number = 1;",
      );
      await Deno.writeTextFile(second, "export const second: number = 2;");

      const output = await runVerifier([second, first]);
      expect(output.code).toBe(0);
      const records = new TextDecoder().decode(output.stdout).trim()
        .split("\n").map((line) => JSON.parse(line));
      expect(records).toEqual([
        { file: second, emitted: "export const second = 2;\n" },
        { file: first, emitted: "export const first = 1;\n" },
      ]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("fails on invalid source before emitting a comparison record", async () => {
    const directory = await Deno.makeTempDir();
    try {
      const invalid = join(directory, "invalid.ts");
      const later = join(directory, "later.ts");
      await Deno.writeTextFile(invalid, "export const broken = ;");
      await Deno.writeTextFile(later, "export const later = 1;");

      const output = await runVerifier([invalid, later]);
      expect(output.code).toBe(1);
      expect(new TextDecoder().decode(output.stdout)).toBe("");
      expect(new TextDecoder().decode(output.stderr)).toContain(
        "Expression expected",
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});
