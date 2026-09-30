import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/in-space");

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
    });
  },
);
