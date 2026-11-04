import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(
  import.meta.dirname!,
  "fixtures/default-piece-registration",
);

describe(
  "test-runner default piece registration",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("registers valid addPiece events and ignores events without a piece", async () => {
      const { passed, failed } = await runTests(
        resolve(FIXTURES, "registration.test.tsx"),
        { root: FIXTURES },
      );

      expect(passed).toBe(3);
      expect(failed).toBe(0);
    });
  },
);
