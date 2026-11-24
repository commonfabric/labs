/**
 * The pattern test files `cf test` runs for a glob and for a file named
 * directly.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { resolve } from "@std/path";
import { test as testCommand } from "../commands/test-command.ts";

const FIXTURES = resolve(
  import.meta.dirname!,
  "fixtures/test-runner-edge-cases",
);

/**
 * Parses `args` with the `test` command, returning what it logged and warned,
 * and the code it exited with, or `null` where it did not exit.
 */
async function parse(args: string[]): Promise<{
  logged: string[];
  warned: string[];
  exitCode: number | null;
}> {
  const logged: string[] = [];
  const warned: string[] = [];
  let exitCode: number | null = null;
  using _log = stub(console, "log", (...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  });
  using _warn = stub(console, "warn", (...parts: unknown[]) => {
    warned.push(parts.map(String).join(" "));
  });
  using _exit = stub(Deno, "exit", (code?: number): never => {
    exitCode = code ?? 0;
    throw new Error(`exited with ${exitCode}`);
  });
  await testCommand.parse(args).catch((error) => {
    if (exitCode === null) throw error;
  });
  return { logged, warned, exitCode };
}

describe(
  "test-command",
  () => {
    it("runs each pattern test a glob matches", async () => {
      // `cf test` expands an argument only when it holds a `*`. Here the `*`
      // follows the two fixtures' whole names, so no other fixture matches.
      const { logged, warned, exitCode } = await parse([
        `${FIXTURES}/{assertion,settle}-only.test.tsx*`,
      ]);
      expect(exitCode).toBeNull();
      expect(logged).toContain("Found 2 test file(s)");
      expect(logged).toContain("\nassertion-only.test.tsx");
      expect(logged).toContain("\nsettle-only.test.tsx");
      expect(logged).toContain("  ✓ assertion_1");
      expect(logged.some((line) => line.startsWith("\n1 passed, 0 failed (")))
        .toBe(true);
      expect(warned.some((line) => line.includes("does not end with")))
        .toBe(false);
    });

    it("runs a file named directly whose name does not end in `.test.tsx`, warning that it does not", async () => {
      const file = resolve(FIXTURES, "not-named-as-test.tsx");
      const { logged, warned, exitCode } = await parse([file]);
      expect(exitCode).toBeNull();
      expect(warned).toContain(`Warning: ${file} does not end with .test.tsx`);
      expect(logged).toContain("  ✓ assertion_1");
    });
  },
);
