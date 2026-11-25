/**
 * Contract tests for the language-model answers a pattern test states in its
 * `llmMocks` export: the runner answers each request from them, and fails the
 * test for a request none answers and for an export it cannot read.
 */

import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";
import { describe, it } from "@commonfabric/test-support/test";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/llm-mocks");

function run(name: string) {
  return runTests(resolve(FIXTURES, name), { root: FIXTURES });
}

describe(
  "test-runner llmMocks",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("answers each request with the entry whose conditions it meets", async () => {
      const { passed, failed } = await run("answered.test.tsx");

      expect(failed).toBe(0);
      expect(passed).toBe(2);
    });

    it("fails the test for a request no entry answers", async () => {
      const { failed, results } = await run("unanswered.test.tsx");

      const llmResult = results[0].results.find((r) => r.name === "llmMocks");
      expect(failed).toBe(1);
      expect(results[0].results[0].passed).toBe(true);
      expect(llmResult?.error).toContain(
        "No llmMocks entry answers a text request with 1 message(s)",
      );
      expect(llmResult?.error).toContain(
        'llmMocks[0] does not fit: expected last message to contain "weather"',
      );
    });

    it("fails the run for an entry it cannot read", async () => {
      const { failed, results } = await run("malformed.test.tsx");

      expect(failed).toBe(1);
      expect(results[0].error).toContain('llmMocks[0] has unknown key "txt".');
    });

    it("answers a multi-user test's participants from one list", async () => {
      const { passed, failed } = await run("multi-user.test.tsx");

      expect(failed).toBe(0);
      expect(passed).toBe(2);
    });

    it("answers each entry once across a multi-user test's participants", async () => {
      const { passed, failed, results } = await run(
        "multi-user-shared.test.tsx",
      );

      const errors = results[0].results.flatMap((r) =>
        r.name === "llmMocks" ? [r.error ?? ""] : []
      );
      expect(passed).toBe(2);
      expect(failed).toBe(1);
      expect(errors.length).toBe(1);
      expect(errors[0].match(/No llmMocks entry answers/g)?.length).toBe(1);
      expect(errors[0]).toContain('last message: "hello"');
    });
  },
);
