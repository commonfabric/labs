/**
 * Pins which paths `isTestFile()` takes for a test, by file name and by the
 * directories between the root and the file.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isTestFile } from "./test-files.ts";

const ROOT = "/repo";

describe("isTestFile()", () => {
  it("returns true for a `.test.ts` file beside its source", () => {
    expect(isTestFile(ROOT, "/repo/runtime/fuse/tree.test.ts")).toBe(true);
  });

  it("returns true for a `.test.tsx` and a `.bench.ts` file", () => {
    expect(isTestFile(ROOT, "/repo/runtime/p/src/view.test.tsx")).toBe(true);
    expect(isTestFile(ROOT, "/repo/runtime/p/src/stack.bench.ts")).toBe(true);
  });

  it("returns true for a helper under `test/`, `integration/`, or `bench/`", () => {
    expect(isTestFile(ROOT, "/repo/runtime/p/test/helper.ts")).toBe(true);
    expect(isTestFile(ROOT, "/repo/runtime/p/integration/harness.ts")).toBe(
      true,
    );
    expect(isTestFile(ROOT, "/repo/runtime/p/bench/fixtures/far.ts")).toBe(
      true,
    );
  });

  it("returns true for a `test` directory at any depth under the root", () => {
    expect(isTestFile(ROOT, "/repo/runtime/a/b/test/c/d.ts")).toBe(true);
  });

  it("returns false for a source file", () => {
    expect(isTestFile(ROOT, "/repo/runtime/p/src/stack.ts")).toBe(false);
  });

  it("returns false for a directory whose name only contains `test`", () => {
    expect(isTestFile(ROOT, "/repo/base/test-support/src/records.ts"))
      .toBe(false);
    expect(isTestFile(ROOT, "/repo/runtime/p/tests/x.ts")).toBe(false);
  });

  it("returns false for a file whose name only contains `test`", () => {
    expect(isTestFile(ROOT, "/repo/runtime/p/src/test-runner.ts")).toBe(false);
    expect(isTestFile(ROOT, "/repo/runtime/p/src/contest.ts")).toBe(false);
  });

  it("counts only the directories between the root and the file", () => {
    expect(isTestFile("/home/test/repo", "/home/test/repo/src/x.ts")).toBe(
      false,
    );
    expect(isTestFile("/repo/pkg/test", "/repo/pkg/test/x.ts")).toBe(false);
  });
});
