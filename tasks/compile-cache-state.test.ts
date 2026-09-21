import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  changedPathsOf,
  classifyCacheKeyState,
  classifyRunAgainstPredecessor,
  fillMissingFamiliesFromFingerprint,
  inferCurrentRunFallbackState,
  matcherForGlob,
  pathTouchesCompileCacheKey,
} from "./compile-cache-state.ts";
import {
  COMPILE_CACHE_FAMILIES,
  type CompileCacheStates,
} from "./ci-check-lib.ts";
import { COMPILE_FINGERPRINT_INPUTS } from "../packages/runner/src/compilation-cache/compiler-fingerprint.deno.ts";

async function captureLogs(fn: () => void | Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs;
}

Deno.test("pathTouchesCompileCacheKey matches directory-tree globs", () => {
  assert(
    pathTouchesCompileCacheKey(
      "packages/ts-transformers/src/policy/capability-analysis.ts",
    ),
  );
  assert(pathTouchesCompileCacheKey("packages/api/index.ts"));
  assert(!pathTouchesCompileCacheKey("packages/runner/src/runner.ts"));
  assert(!pathTouchesCompileCacheKey("packages/patterns/counter/main.tsx"));
});

Deno.test("pathTouchesCompileCacheKey matches exact-file entries exactly", () => {
  assert(pathTouchesCompileCacheKey("deno.lock"));
  assert(pathTouchesCompileCacheKey("deno.jsonc"));
  assert(
    pathTouchesCompileCacheKey("packages/runner/src/pattern-coverage.ts"),
  );
  // The fingerprint resolves `deno.lock` against the repository root, so an
  // exact-file entry must not swallow a same-named file elsewhere.
  assert(!pathTouchesCompileCacheKey("packages/toolshed/deno.lock"));
  assert(
    !pathTouchesCompileCacheKey("packages/runner/src/pattern-coverage.test.ts"),
  );
});

Deno.test("classifyCacheKeyState is cold iff a changed file touches the key set", () => {
  assertEquals(
    classifyCacheKeyState(["packages/runner/src/cell.ts", "docs/notes.md"]),
    "warm",
  );
  assertEquals(
    classifyCacheKeyState([
      "packages/runner/src/cell.ts",
      "packages/schema-generator/src/mod.ts",
    ]),
    "cold",
  );
  assertEquals(classifyCacheKeyState([]), "warm");
});

Deno.test("classifyRunAgainstPredecessor classifies via changed files", async () => {
  assertEquals(
    await classifyRunAgainstPredecessor("headsha", "basesha", (base, head) => {
      assertEquals(base, "basesha");
      assertEquals(head, "headsha");
      return Promise.resolve(["deno.lock"]);
    }),
    "cold",
  );
  assertEquals(
    await classifyRunAgainstPredecessor(
      "headsha",
      "basesha",
      () => Promise.resolve(["docs/readme.md"]),
    ),
    "warm",
  );
});

Deno.test("classifyRunAgainstPredecessor fails open to unknown", async () => {
  const mustNotFetch = () => {
    throw new Error("should not fetch without a predecessor");
  };
  assertEquals(
    await classifyRunAgainstPredecessor("headsha", undefined, mustNotFetch),
    "unknown",
  );
  assertEquals(
    await classifyRunAgainstPredecessor("samesha", "samesha", mustNotFetch),
    "unknown",
  );
  assertEquals(
    await classifyRunAgainstPredecessor(
      "headsha",
      "basesha",
      () => Promise.reject(new Error("rate limited")),
    ),
    "unknown",
  );
});

Deno.test("COMPILE_CACHE_KEY_GLOBS covers every compiler fingerprint input", async () => {
  // The globs decide which changed file makes a run cold, and the fingerprint
  // in the cache key decides which change rolls the key. They answer the same
  // question, so the globs are rendered from the fingerprint's own input list
  // rather than written out again. What is left to check is that the rendering
  // covers what the fingerprint hashes, which is every file under a directory
  // input and the file itself for a file input. Which of the two an input is
  // comes from the filesystem, so that a rendering reading the shape off the
  // path some other way is still held to the same coverage.

  for (const input of COMPILE_FINGERPRINT_INPUTS) {
    const info = await Deno.stat(new URL(`../${input}`, import.meta.url));
    const changed = info.isDirectory ? `${input}/nested/file.ts` : input;
    assert(
      pathTouchesCompileCacheKey(changed),
      `the fingerprint hashes ${changed}, which no compile-cache glob matches`,
    );
  }
  assert(!pathTouchesCompileCacheKey("docs/development/CI_PERFORMANCE.md"));
  assert(!pathTouchesCompileCacheKey("packages/runner/src/cell.ts"));
});

Deno.test("pattern integration cache follows sources and shard selector", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/deno.yml", import.meta.url),
  );
  const start = workflow.indexOf("  pattern-integration-test:\n");
  const end = workflow.indexOf("\n  pattern-reload-integration-test:", start);
  assert(start >= 0 && end > start, "pattern integration job not found");

  const job = workflow.slice(start, end);
  assert(
    job.includes(
      "hashFiles('packages/patterns/**/*.ts', 'packages/patterns/**/*.tsx', 'tasks/select-pattern-integration-files.ts', 'tasks/weighted-shards.ts')",
    ),
    "pattern integration cache must rotate when source or file assignment changes",
  );
});

Deno.test("pattern unit cache follows sources and shard selector", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/deno.yml", import.meta.url),
  );
  const start = workflow.indexOf("  pattern-unit-test:\n");
  const end = workflow.indexOf("\n  # ---", start);
  assert(start >= 0 && end > start, "pattern unit job not found");

  const job = workflow.slice(start, end);
  assert(
    job.includes(
      "hashFiles('packages/patterns/**/*.ts', 'packages/patterns/**/*.tsx', 'packages/connectors/agents/debug-view/**/*.ts', 'packages/connectors/agents/debug-view/**/*.tsx', 'packages/connectors/github/activity-view/**/*.ts', 'packages/connectors/github/activity-view/**/*.tsx', 'packages/connectors/pattern-sources.ts', 'tasks/integration.ts', 'tasks/pattern-files.ts')",
    ),
    "pattern unit cache must rotate when source or file assignment changes",
  );
});

Deno.test("changedPathsOf surfaces both sides of a rename", () => {
  const paths = changedPathsOf([
    {
      filename: "packages/runner/src/moved.ts",
      previous_filename: "packages/api/moved.ts",
    },
    { filename: "docs/notes.md" },
  ]);
  assertEquals(paths, [
    "packages/runner/src/moved.ts",
    "packages/api/moved.ts",
    "docs/notes.md",
  ]);
  // A rename OUT of the key set still rotated the fingerprint: the file
  // left a hashed directory even though its new path matches nothing.
  assertEquals(classifyCacheKeyState(paths), "cold");
});

Deno.test("matcherForGlob interprets tree and exact-file globs and refuses others", () => {
  const tree = matcherForGlob("packages/api/**");
  assert(tree("packages/api/index.ts"));
  assert(!tree("packages/runner/index.ts"));

  const exact = matcherForGlob("deno.lock");
  assert(exact("deno.lock"));
  assert(!exact("packages/toolshed/deno.lock"));

  // A shape that is neither a directory tree nor an exact file is refused
  // rather than silently mis-matched: a new glob shape in the workflow has to
  // extend matcherForGlob (and the drift guard) deliberately.
  assertThrows(
    () => matcherForGlob("packages/*/deno.lock"),
    Error,
    "Unsupported compile-cache key glob shape",
  );
});

Deno.test("inferCurrentRunFallbackState reads a PR's own changed files", async () => {
  const mustNotFetch = () => {
    throw new Error("a PR run must not fetch a baseline sha");
  };
  // Touching the key set is cold; touching nothing in it is warm — both read
  // the PR's file list directly, never the predecessor compare.
  assertEquals(
    await inferCurrentRunFallbackState({
      isPullRequestRun: true,
      prFiles: [{ filename: "packages/schema-generator/src/mod.ts" }],
      headSha: "head",
      fetchLatestBaselineSha: mustNotFetch,
    }),
    "cold",
  );
  assertEquals(
    await inferCurrentRunFallbackState({
      isPullRequestRun: true,
      prFiles: [{ filename: "docs/notes.md" }],
      headSha: "head",
      fetchLatestBaselineSha: mustNotFetch,
    }),
    "warm",
  );
  // A PR whose file list did not load cannot be classified — fail open.
  assertEquals(
    await inferCurrentRunFallbackState({
      isPullRequestRun: true,
      prFiles: [],
      headSha: "head",
      fetchLatestBaselineSha: mustNotFetch,
    }),
    "unknown",
  );
});

Deno.test("inferCurrentRunFallbackState compares a main push against the latest baseline", async () => {
  const base = { isPullRequestRun: false, prFiles: [], headSha: "head" };
  // Cold: the compare against the latest baseline run touches the key set.
  assertEquals(
    await inferCurrentRunFallbackState({
      ...base,
      fetchLatestBaselineSha: () => Promise.resolve("prev"),
      fetchChanged: (b, h) => {
        assertEquals([b, h], ["prev", "head"]);
        return Promise.resolve(["deno.lock"]);
      },
    }),
    "cold",
  );
  // Warm: the compare touches nothing in the key set.
  assertEquals(
    await inferCurrentRunFallbackState({
      ...base,
      fetchLatestBaselineSha: () => Promise.resolve("prev"),
      fetchChanged: () => Promise.resolve(["docs/readme.md"]),
    }),
    "warm",
  );
});

Deno.test("inferCurrentRunFallbackState fails open when the baseline is missing or unfetchable", async () => {
  const base = { isPullRequestRun: false, prFiles: [], headSha: "head" };
  // No prior baseline run (empty history): nothing to compare against.
  assertEquals(
    await inferCurrentRunFallbackState({
      ...base,
      fetchLatestBaselineSha: () => Promise.resolve(undefined),
      fetchChanged: () => {
        throw new Error("must not compare without a predecessor");
      },
    }),
    "unknown",
  );
  // The baseline-sha lookup itself failing (rate limit, outage).
  assertEquals(
    await inferCurrentRunFallbackState({
      ...base,
      fetchLatestBaselineSha: () => Promise.reject(new Error("rate limited")),
    }),
    "unknown",
  );
});

Deno.test("fillMissingFamiliesFromFingerprint fills only unknown families, only when cold", async () => {
  // Recorded states win: an already-recorded family (even warm) is untouched;
  // only families with no recorded state are filled cold.
  const recorded: CompileCacheStates = { "pattern-unit": "warm" };
  let filled = -1;
  const logs = await captureLogs(() => {
    filled = fillMissingFamiliesFromFingerprint(recorded, "cold");
  });

  assertEquals(recorded["pattern-unit"], "warm");
  assertEquals(recorded["pattern-integration"], "cold");
  assertEquals(recorded["generated-patterns"], "cold");

  const allFamilies = [...COMPILE_CACHE_FAMILIES].sort();
  assertEquals(Object.keys(recorded).sort(), allFamilies);
  assertEquals(filled, allFamilies.length - 1);
  // A non-zero fill is announced in the transcript, with the count.
  assertEquals(logs.length, 1);
  assert(logs[0]!.includes(String(filled)));
  assert(logs[0]!.includes("treated as cold"));
});

Deno.test("fillMissingFamiliesFromFingerprint is a no-op (and silent) for warm and unknown verdicts", async () => {
  for (const verdict of ["warm", "unknown"] as const) {
    const recorded: CompileCacheStates = { "pattern-unit": "warm" };
    let filled = -1;
    const logs = await captureLogs(() => {
      filled = fillMissingFamiliesFromFingerprint(recorded, verdict);
    });
    assertEquals(filled, 0);
    assertEquals(recorded, { "pattern-unit": "warm" });
    assertEquals(logs.length, 0);
  }
});
