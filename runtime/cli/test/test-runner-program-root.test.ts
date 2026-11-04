/**
 * Guard for how a run resolves its import root when no --root is given: the
 * nearest ancestor whose deno.json(c) declares a package name anchors the
 * program, so an import that spans the package resolves bare; without such an
 * ancestor the file's own directory anchors it, and an import that climbs out
 * is refused by name rather than reported as a missing file it never named.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const TEST_PATTERN = `import { assert, pattern, TESTS } from "commonfabric";
import { expected } from "../shared/value.ts";

export default pattern(() => ({
  [TESTS]: [
    { assertion: assert(() => expected === true) },
  ],
}));
`;

describe(
  "test-runner program root",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    let dir: string;

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "test_runner_root_" });
      await Deno.mkdir(join(dir, "pkg/shared"), { recursive: true });
      await Deno.mkdir(join(dir, "pkg/nested"), { recursive: true });
      await Deno.writeTextFile(
        join(dir, "pkg/shared/value.ts"),
        "export const expected = true;\n",
      );
      await Deno.writeTextFile(
        join(dir, "pkg/nested/main.test.tsx"),
        TEST_PATTERN,
      );
    });

    afterEach(async () => {
      await Deno.remove(dir, { recursive: true });
    });

    describe("with a named config above the test file", () => {
      beforeEach(async () => {
        await Deno.writeTextFile(
          join(dir, "pkg/deno.json"),
          `{"name": "@cf-test/root-fixture"}`,
        );
      });

      it("resolves a package-spanning import without --root", async () => {
        const { passed, failed } = await runTests(
          join(dir, "pkg/nested/main.test.tsx"),
          {},
        );
        expect(failed).toBe(0);
        expect(passed).toBe(1);
      });

      it("lets an explicit --root override the inferred one", async () => {
        const { failed, results } = await runTests(
          join(dir, "pkg/nested/main.test.tsx"),
          { root: join(dir, "pkg/nested") },
        );
        expect(failed).toBe(1);
        expect(results[0].error).toContain(
          'Import "../shared/value.ts" in "/main.test.tsx" escapes the program root.',
        );
      });
    });

    describe("with no named config above the test file", () => {
      it("refuses the escaping import by name and hints at --root", async () => {
        const { failed, results } = await runTests(
          join(dir, "pkg/nested/main.test.tsx"),
          {},
        );
        expect(failed).toBe(1);
        expect(results[0].error).toContain(
          'Import "../shared/value.ts" in "/main.test.tsx" escapes the program root.',
        );
        expect(results[0].error).toContain("--root");
      });
    });
  },
);
