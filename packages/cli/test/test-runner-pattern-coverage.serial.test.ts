import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join, resolve } from "@std/path";
import { test as testCommand } from "../commands/test-command.ts";
import { runTests } from "../lib/test-runner.ts";
import { cf, checkStderr, withEnv } from "./utils.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/pattern-coverage");
const SUBJECT = join(FIXTURES, "subject.tsx").replaceAll("\\", "/");
const SUBJECT_SOURCE = await Deno.readTextFile(SUBJECT);

interface CoverageFile {
  name: string;
  text: string;
}

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

async function readCoverageFiles(dir: string): Promise<CoverageFile[]> {
  const out: CoverageFile[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".pattern-coverage.lcov")) {
      out.push({
        name: entry.name,
        text: await Deno.readTextFile(join(dir, entry.name)),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function runTestCommand(args: string[]): Promise<void> {
  const previousLog = console.log;
  console.log = () => {};
  try {
    await testCommand.parse(args);
  } finally {
    console.log = previousLog;
  }
}

function subjectLine(text: string): number {
  const line = SUBJECT_SOURCE.split("\n").findIndex((entry) =>
    entry.includes(text)
  );
  if (line < 0) {
    throw new Error(`Could not find subject line containing ${text}`);
  }
  return line + 1;
}

function lineHitsForSource(
  lcov: string,
  sourcePath: string,
): Map<number, number> {
  const hits = new Map<number, number>();
  let inSource = false;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      inSource = line === `SF:${sourcePath}`;
      continue;
    }
    if (line === "end_of_record") {
      inSource = false;
      continue;
    }
    if (!inSource || !line.startsWith("DA:")) continue;

    const [lineNumber, count] = line.slice(3).split(",").map(Number);
    hits.set(lineNumber, count);
  }
  return hits;
}

function expectLineHit(
  lcov: string,
  sourceLineText: string,
  expected: "hit" | "miss",
): void {
  const hits = lineHitsForSource(lcov, SUBJECT);
  const line = subjectLine(sourceLineText);
  const count = hits.get(line);
  expect(typeof count).toBe("number");
  if (expected === "hit") {
    expect(count!).toBeGreaterThan(0);
  } else {
    expect(count).toBe(0);
  }
}

describe(
  "pattern coverage output",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("writes local LCOV for imported pattern source", async () => {
      await withTempDir(async (coverageDir) => {
        const { passed, failed } = await runTests(
          fixture("single.test.tsx"),
          { root: FIXTURES, patternCoverageDir: coverageDir },
        );

        expect(passed).toBe(1);
        expect(failed).toBe(0);

        const coverageFiles = await readCoverageFiles(coverageDir);
        expect(coverageFiles.length).toBe(1);
        const coverage = coverageFiles[0]!.text;
        expect(coverage).toContain(`SF:${SUBJECT}`);
        expect(coverage).toContain("DA:");
        expect(coverage).toContain("LH:");
        expectLineHit(coverage, "count.set(count.get() + 1);", "hit");
        expectLineHit(coverage, "return count.get() === 1;", "hit");
        expectLineHit(coverage, 'return name.get() === "alice";', "miss");
        expectLineHit(coverage, 'return name.get() === "bob";', "miss");
      });
    });

    it("reports local coverage write failures without failing the test", async () => {
      const coveragePath = await Deno.makeTempFile();
      const errors: string[] = [];
      const previousError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map((arg) => String(arg)).join(" "));
      };

      try {
        const { passed, failed } = await runTests(
          fixture("single.test.tsx"),
          { root: FIXTURES, patternCoverageDir: coveragePath },
        );

        expect(passed).toBe(1);
        expect(failed).toBe(0);
        expect(
          errors.some((line) =>
            line.includes("[cf test] failed to write pattern coverage for")
          ),
        ).toBe(true);
      } finally {
        console.error = previousError;
        await Deno.remove(coveragePath).catch(() => {});
      }
    });

    it("writes one LCOV artifact per multi-user participant", async () => {
      await withTempDir(async (coverageDir) => {
        const { passed, failed } = await runTests(
          fixture("multi-user.test.tsx"),
          { root: FIXTURES, patternCoverageDir: coverageDir },
        );

        expect(passed).toBe(2);
        expect(failed).toBe(0);

        const names: string[] = [];
        for await (const entry of Deno.readDir(coverageDir)) {
          if (entry.isFile) names.push(entry.name);
        }
        names.sort();

        expect(names.length).toBe(2);
        expect(names.some((name) => name.includes("--alice."))).toBe(true);
        expect(names.some((name) => name.includes("--bob."))).toBe(true);

        const coverageFiles = await readCoverageFiles(coverageDir);
        expect(
          coverageFiles.every(({ text }) => text.includes(`SF:${SUBJECT}`)),
        )
          .toBe(true);
        const aliceCoverage = coverageFiles.find(({ name }) =>
          name.includes("--alice.")
        );
        const bobCoverage = coverageFiles.find(({ name }) =>
          name.includes("--bob.")
        );
        expect(aliceCoverage).toBeTruthy();
        expect(bobCoverage).toBeTruthy();
        expectLineHit(
          aliceCoverage!.text,
          'return name.get() === "alice";',
          "hit",
        );
        expectLineHit(
          aliceCoverage!.text,
          'return name.get() === "bob";',
          "miss",
        );
        expectLineHit(
          bobCoverage!.text,
          'return name.get() === "alice";',
          "miss",
        );
        expectLineHit(
          bobCoverage!.text,
          'return name.get() === "bob";',
          "hit",
        );
      });
    });

    it("reports multi-user coverage write failures", async () => {
      const coveragePath = await Deno.makeTempFile();
      const errors: string[] = [];
      const previousError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map((arg) => String(arg)).join(" "));
      };

      try {
        const { passed, failed } = await runTests(
          fixture("multi-user.test.tsx"),
          { root: FIXTURES, patternCoverageDir: coveragePath },
        );

        expect(passed).toBe(2);
        expect(failed).toBe(0);
        expect(
          errors.some((line) =>
            line.includes(
              "[cf test] failed to write pattern coverage for alice:",
            )
          ),
        ).toBe(true);
        expect(
          errors.some((line) =>
            line.includes(
              "[cf test] failed to write pattern coverage for bob:",
            )
          ),
        ).toBe(true);
      } finally {
        console.error = previousError;
        await Deno.remove(coveragePath).catch(() => {});
      }
    });

    it("passes the coverage directory from the cf test option", async () => {
      await withTempDir(async (coverageDir) => {
        const { code, stderr } = await cf(
          `test "${
            fixture("single.test.tsx")
          }" --root "${FIXTURES}" --pattern-coverage-dir "${coverageDir}"`,
        );

        expect(code).toBe(0);
        checkStderr(stderr);
        const coverageFiles = await readCoverageFiles(coverageDir);
        expect(coverageFiles.length).toBe(1);
        expect(coverageFiles[0]!.text).toContain(`SF:${SUBJECT}`);
        expectLineHit(
          coverageFiles[0]!.text,
          "count.set(count.get() + 1);",
          "hit",
        );
      });
    });

    it("passes the coverage directory from CF_PATTERN_COVERAGE_DIR", async () => {
      await withTempDir(async (coverageDir) => {
        const { code, stderr } = await cf(
          `test "${fixture("single.test.tsx")}" --root "${FIXTURES}"`,
          {
            env: {
              CF_PATTERN_COVERAGE_DIR: coverageDir,
              CF_LOG_LEVEL: "error",
            },
          },
        );

        expect(code).toBe(0);
        checkStderr(stderr);

        const coverageFiles = await readCoverageFiles(coverageDir);
        expect(coverageFiles.length).toBe(1);
        expect(coverageFiles[0]!.text).toContain(`SF:${SUBJECT}`);
        expectLineHit(
          coverageFiles[0]!.text,
          "count.set(count.get() + 1);",
          "hit",
        );
      });
    });

    it("runs the command action with an explicit coverage option", async () => {
      await withTempDir(async (coverageDir) => {
        await runTestCommand([
          fixture("single.test.tsx"),
          "--root",
          FIXTURES,
          "--pattern-coverage-dir",
          coverageDir,
        ]);

        const coverageFiles = await readCoverageFiles(coverageDir);
        expect(coverageFiles.length).toBe(1);
        expect(coverageFiles[0]!.text).toContain(`SF:${SUBJECT}`);
        expectLineHit(
          coverageFiles[0]!.text,
          "count.set(count.get() + 1);",
          "hit",
        );
      });
    });

    it("runs the command action with the coverage env fallback", async () => {
      await withTempDir(async (coverageDir) => {
        await withEnv("CF_PATTERN_COVERAGE_DIR", coverageDir, async () => {
          await runTestCommand([
            fixture("single.test.tsx"),
            "--root",
            FIXTURES,
          ]);
        });

        const coverageFiles = await readCoverageFiles(coverageDir);
        expect(coverageFiles.length).toBe(1);
        expect(coverageFiles[0]!.text).toContain(`SF:${SUBJECT}`);
        expectLineHit(
          coverageFiles[0]!.text,
          "count.set(count.get() + 1);",
          "hit",
        );
      });
    });
  },
);
