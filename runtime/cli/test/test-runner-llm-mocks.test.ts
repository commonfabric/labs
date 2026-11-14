import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { resolve } from "@std/path";

import { runTests } from "../lib/test-runner.ts";

const root = resolve(import.meta.dirname!, "fixtures/llm-mocks");

describe("test-runner llm mocks", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  it("answers a pattern's language-model requests from the test's `llmMocks` export", async () => {
    const result = await runTests(resolve(root, "answers.test.tsx"), { root });
    expect(result.results.map((r) => r.error)).toEqual([undefined]);
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(2);
  });

  it("fails only the answered assertion when the test exports no `llmMocks`", async () => {
    const result = await runTests(resolve(root, "subject.tsx"), { root });
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("refuses `llmMocks` in a multi-user test", async () => {
    const result = await runTests(resolve(root, "multi-user.test.tsx"), {
      root,
    });
    expect(result.results[0].error).toContain(
      "`llmMocks` is not supported in multi-user tests",
    );
  });
});
