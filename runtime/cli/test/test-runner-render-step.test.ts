/**
 * Contract tests for explicit, per-step VDOM materialization in `cf test`.
 */

import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { expect } from "@std/expect";
import { join, resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";
import { argv, cf, checkStderr } from "./utils.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/render-step");
const SUBJECT = join(FIXTURES, "subject.tsx").replaceAll("\\", "/");
const SUBJECT_SOURCE = await Deno.readTextFile(SUBJECT);

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

async function withCoverage(
  name: string,
  options: { continuousUI?: boolean; verbose?: boolean } = {},
): Promise<{
  lateHitCount: number;
  afterRenderHitCount: number;
  stepResultCount: number;
  passed: number;
}> {
  const coverageDir = await Deno.makeTempDir();
  try {
    const result = await runTests(fixture(name), {
      root: FIXTURES,
      patternCoverageDir: coverageDir,
      continuousUI: options.continuousUI,
      verbose: options.verbose,
    });
    const files: string[] = [];
    for await (const entry of Deno.readDir(coverageDir)) {
      if (entry.isFile && entry.name.endsWith(".pattern-coverage.lcov")) {
        files.push(await Deno.readTextFile(join(coverageDir, entry.name)));
      }
    }
    expect(files.length).toBe(1);
    const hitCount = (sourceText: string): number => {
      const sourceLine = SUBJECT_SOURCE.split("\n").findIndex((line) =>
        line.includes(sourceText)
      ) + 1;
      expect(sourceLine).toBeGreaterThan(0);

      let inSubject = false;
      let count = -1;
      for (const line of files[0]!.split("\n")) {
        if (line.startsWith("SF:")) {
          inSubject = line === `SF:${SUBJECT}`;
        }
        if (line === "end_of_record") {
          inSubject = false;
        }
        if (inSubject && line.startsWith(`DA:${sourceLine},`)) {
          count = Number(line.split(",")[1]);
        }
      }
      expect(count).toBeGreaterThanOrEqual(0);
      return count;
    };
    return {
      lateHitCount: hitCount('return "late VDOM branch"'),
      afterRenderHitCount: hitCount('return "post-render VDOM branch"'),
      stepResultCount: result.results.flatMap((entry) =>
        entry.results
      ).length,
      passed: result.passed,
    };
  } finally {
    await Deno.remove(coverageDir, { recursive: true });
  }
}

describe(
  "cf test UI demand",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("materializes late-state VDOM and stays transparent to results", async () => {
      const result = await withCoverage("render-step.test.tsx", {
        verbose: true,
      });
      expect(result.lateHitCount).toBeGreaterThan(0);
      expect(result.stepResultCount).toBe(1);
      expect(result.passed).toBe(1);
    });

    it("demands rendered children without evaluating unrelated VNode metadata", async () => {
      const result = await withCoverage("bounded-root-render.test.tsx");
      expect(result.lateHitCount).toBeGreaterThan(0);
      expect(result.afterRenderHitCount).toBe(0);
      expect(result.passed).toBe(1);
    });

    it("accepts primitive VDOM roots", async () => {
      const { failed, passed } = await runTests(
        fixture("primitive-render.test.tsx"),
        { root: FIXTURES },
      );
      expect(failed).toBe(0);
      expect(passed).toBe(1);
    });

    it("accepts a direct-array VDOM root", async () => {
      const { failed, passed } = await runTests(
        fixture("direct-array-render.test.tsx"),
        { root: FIXTURES },
      );
      expect(failed).toBe(0);
      expect(passed).toBe(1);
    });

    it("preserves the headless default when no render step is present", async () => {
      const result = await withCoverage("no-render.test.tsx");
      expect(result.lateHitCount).toBe(0);
      expect(result.passed).toBe(1);
    });

    it("does not materialize a skipped render step", async () => {
      const result = await withCoverage("skipped-render.test.tsx", {
        verbose: true,
      });
      expect(result.lateHitCount).toBe(0);
      expect(result.passed).toBe(1);
    });

    it("removes renderer demand before the following action", async () => {
      const result = await withCoverage("render-cleanup.test.tsx");
      expect(result.lateHitCount).toBeGreaterThan(0);
      expect(result.afterRenderHitCount).toBe(0);
      expect(result.passed).toBe(1);
    });

    it("reports invalid VDOM content as a harness error", async () => {
      const output: string[] = [];
      using _log = stub(console, "log", (...args: unknown[]) => {
        output.push(args.map(String).join(" "));
      });
      const { failed, results } = await runTests(
        fixture("invalid-render.test.tsx"),
        { root: FIXTURES, verbose: true, statsThreshold: 0 },
      );
      expect(failed).toBe(1);
      expect(results[0]!.error ?? "").toContain(
        "VDOM materialization failed: Invalid VDOM content",
      );
      expect(
        output.some((line) => line.includes("Read cost (render_1):")),
      ).toBe(true);
    });

    it("uses the same primitive in multi-user workers", async () => {
      const result = await withCoverage("multi-user.test.tsx", {
        verbose: true,
      });
      expect(result.lateHitCount).toBeGreaterThan(0);
      expect(result.stepResultCount).toBe(1);
      expect(result.passed).toBe(1);
    });

    it("leaves an exported $UI undemanded without the stress option", async () => {
      const result = await withCoverage("continuous-ui.test.tsx");
      expect(result.lateHitCount).toBe(0);
      expect(result.passed).toBe(1);
    });

    it("continuously demands an exported $UI for the full run", async () => {
      const result = await withCoverage("continuous-ui.test.tsx", {
        continuousUI: true,
        verbose: true,
      });
      expect(result.lateHitCount).toBeGreaterThan(0);
      expect(result.passed).toBe(1);
    });

    it("continuously demands each multi-user participant's $UI", async () => {
      const result = await withCoverage(
        "continuous-multi-user.test.tsx",
        { continuousUI: true },
      );
      expect(result.lateHitCount).toBeGreaterThan(0);
      expect(result.passed).toBe(1);
    });

    it("rejects invalid continuous $UI content", async () => {
      const { failed, results } = await runTests(
        fixture("invalid-continuous-ui.test.tsx"),
        { root: FIXTURES, continuousUI: true },
      );
      expect(failed).toBe(1);
      expect(results[0]!.error ?? "").toContain(
        "VDOM materialization failed: Invalid VDOM content",
      );
    });

    it("enables continuous $UI demand through CF_TEST_CONTINUOUS_UI", async () => {
      const coverageDir = await Deno.makeTempDir();
      try {
        const { code, stderr } = await cf(
          argv`test ${
            fixture("continuous-ui.test.tsx")
          } --root ${FIXTURES} --pattern-coverage-dir ${coverageDir}`,
          {
            env: {
              CF_TEST_CONTINUOUS_UI: "1",
              // Wall-clock performance diagnostics can fire under CI
              // contention; keep this environment-contract test strict about
              // errors instead.
              CF_LOG_LEVEL: "error",
            },
          },
        );
        expect(code).toBe(0);
        checkStderr(stderr);

        const files: string[] = [];
        for await (const entry of Deno.readDir(coverageDir)) {
          if (entry.isFile && entry.name.endsWith(".pattern-coverage.lcov")) {
            files.push(await Deno.readTextFile(join(coverageDir, entry.name)));
          }
        }
        expect(files.length).toBe(1);
        const sourceLine = SUBJECT_SOURCE.split("\n").findIndex((line) =>
          line.includes('return "late VDOM branch"')
        ) + 1;
        expect(files[0]).toContain(`DA:${sourceLine},`);
        const hit = files[0]!.split("\n").find((line) =>
          line.startsWith(`DA:${sourceLine},`)
        );
        expect(Number(hit?.split(",")[1] ?? 0)).toBeGreaterThan(0);
      } finally {
        await Deno.remove(coverageDir, { recursive: true });
      }
    });
  },
);
