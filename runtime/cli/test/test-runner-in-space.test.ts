import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/in-space");

/** Runs `fn` with a temporary directory, which is removed afterwards. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

describe(
  "test-runner",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    describe("a pattern instantiated with `inSpace()`", () => {
      it("runs from a handler without a replication error", async () => {
        // A replication that finds no closure logs an error, which fails the
        // file on top of its assertions.
        const { passed, failed } = await runTests(
          resolve(FIXTURES, "create-in-handler.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(2);
      });

      it("runs from a multi-user participant's handler without a replication error", async () => {
        const { passed, failed } = await runTests(
          resolve(FIXTURES, "create-in-participant-handler.test.tsx"),
          { root: FIXTURES },
        );
        expect(failed).toBe(0);
        expect(passed).toBe(1);
      });

      describe("while collecting pattern coverage", () => {
        // Coverage compiles an instrumented variant of the closure, which the
        // space holds apart from the ordinary one. The replication has to read
        // the variant that was written.

        it("runs from a handler without a replication error", async () => {
          await withTempDir(async (patternCoverageDir) => {
            const { passed, failed } = await runTests(
              resolve(FIXTURES, "create-in-handler.test.tsx"),
              { root: FIXTURES, patternCoverageDir },
            );
            expect(failed).toBe(0);
            expect(passed).toBe(2);
          });
        });

        it("runs from a multi-user participant's handler without a replication error", async () => {
          await withTempDir(async (patternCoverageDir) => {
            const { passed, failed } = await runTests(
              resolve(FIXTURES, "create-in-participant-handler.test.tsx"),
              { root: FIXTURES, patternCoverageDir },
            );
            expect(failed).toBe(0);
            expect(passed).toBe(1);
          });
        });
      });
    });
  },
);
