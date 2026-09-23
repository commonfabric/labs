/**
 * Contract tests for `cf test --compile-only`, in process: what
 * `compileTestPatterns()` reports for a file that compiles and one that
 * does not, and the exit the command takes on the latter. The cache the pass
 * leaves behind is pinned across processes in
 * `test-runner-compile-byte-cache.serial.test.ts`.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { join, resolve } from "@std/path";
import { createTestCommand } from "../commands/test-command.ts";
import { compileTestPatterns } from "../lib/test-runner.ts";

const GOOD = resolve(
  import.meta.dirname!,
  "fixtures/settle/settle-step.test.tsx",
);

// A pattern whose import climbs out of its own directory, with no package
// config above it to widen the root: the resolve refuses it, so the compile
// fails without the source itself being wrong.
const ESCAPING_PATTERN = `import { assert, pattern, TESTS } from "commonfabric";
import { expected } from "../shared/value.ts";

export default pattern(() => ({
  [TESTS]: [
    { assertion: assert(() => expected === true) },
  ],
}));
`;

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`Deno.exit(${code})`);
  }
}

/**
 * Runs `callback` with `Deno.exit` throwing; returns the code it was given,
 * or `null` when it was never called.
 */
async function exitCodeOf(
  callback: () => Promise<unknown>,
): Promise<number | null> {
  const originalExit = Deno.exit;
  Deno.exit = ((code?: number): never => {
    throw new ExitError(code ?? 0);
  }) as typeof Deno.exit;
  try {
    await callback();
    return null;
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    throw error;
  } finally {
    Deno.exit = originalExit;
  }
}

describe(
  "cf test --compile-only",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    let dir: string;
    let bad: string;
    let logged: string[];
    let restoreLog: { restore(): void };

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "test_runner_compile_only_" });
      await Deno.mkdir(join(dir, "shared"), { recursive: true });
      await Deno.mkdir(join(dir, "nested"), { recursive: true });
      await Deno.writeTextFile(
        join(dir, "shared/value.ts"),
        "export const expected = true;\n",
      );
      bad = join(dir, "nested/main.test.tsx");
      await Deno.writeTextFile(bad, ESCAPING_PATTERN);
      logged = [];
      restoreLog = stub(console, "log", (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    });

    afterEach(async () => {
      restoreLog.restore();
      await Deno.remove(dir, { recursive: true });
    });

    describe("compileTestPatterns()", () => {
      it("compiles the files that compile and returns the ones that do not", async () => {
        const { compiled, failed } = await compileTestPatterns([GOOD, bad]);
        expect(compiled).toBe(1);
        expect(failed).toEqual([bad]);
        expect(logged).toContain("  compiled settle-step.test.tsx");
        expect(
          logged.some((line) =>
            line.startsWith("  ✗ main.test.tsx: ") &&
            line.includes("escapes the program root")
          ),
        ).toBe(true);
        expect(logged.some((line) => line.includes("passed"))).toBe(false);
      });

      it("treats a run that throws as that file's failure", async () => {
        const { compiled, failed } = await compileTestPatterns(
          [GOOD],
          {},
          () => Promise.reject(new Error("wedged")),
        );
        expect(compiled).toBe(0);
        expect(failed).toEqual([GOOD]);
        expect(logged).toContain("  ✗ settle-step.test.tsx: wedged");
      });
    });

    describe("the command", () => {
      it("exits 1 when a file fails to compile, and returns when every file compiles", async () => {
        expect(
          await exitCodeOf(() =>
            createTestCommand().parse([bad, "--compile-only"])
          ),
        ).toBe(1);
        expect(
          await exitCodeOf(() =>
            createTestCommand().parse([GOOD, "--compile-only"])
          ),
        ).toBe(null);
      });
    });
  },
);
