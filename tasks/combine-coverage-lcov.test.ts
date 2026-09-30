import { assertEquals, assertRejects } from "@std/assert";
import * as path from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  combineCoverageLcov,
  main,
  mergeLcovReports,
  normalizeSourcePath,
  parseArgs,
} from "./combine-coverage-lcov.ts";

const ROOT = path.join(import.meta.dirname!, "..");

Deno.test("normalizeSourcePath strips a GitHub-hosted workspace root", () => {
  assertEquals(
    normalizeSourcePath(
      "/home/runner/work/labs/labs/packages/runner/src/mod.ts",
      "labs",
    ),
    "packages/runner/src/mod.ts",
  );
});

Deno.test("normalizeSourcePath handles a dotted repository name", () => {
  assertEquals(
    normalizeSourcePath(
      "/home/runner/work/commonfabric.labs/commonfabric.labs/tasks/x.ts",
      "commonfabric.labs",
    ),
    "tasks/x.ts",
  );
});

Deno.test("normalizeSourcePath anchors on the checkout, not an earlier repeat", () => {
  // A self-hosted runner whose work directory itself repeats the repo name must
  // still anchor on the deepest doubled segment (the checkout root).

  assertEquals(
    normalizeSourcePath(
      "/srv/labs/labs/_work/labs/labs/scripts/build.ts",
      "labs",
    ),
    "scripts/build.ts",
  );
});

Deno.test("normalizeSourcePath converts Windows separators to POSIX", () => {
  assertEquals(
    normalizeSourcePath(
      "C:\\actions\\_work\\labs\\labs\\scripts\\build.ts",
      "labs",
    ),
    "scripts/build.ts",
  );
});

Deno.test("normalizeSourcePath leaves synthetic pattern paths unchanged", () => {
  assertEquals(
    normalizeSourcePath("cf-mount/fid1abc/main.tsx", "labs"),
    "cf-mount/fid1abc/main.tsx",
  );
});

Deno.test("mergeLcovReports sums line coverage for a file seen in two jobs", () => {
  // The two jobs reach the file under different runner checkout roots and
  // include the function/branch records deno emits, which the merge drops.

  const jobA = [
    "SF:/home/runner/work/labs/labs/packages/a/mod.ts",
    "FN:1,add",
    "FNDA:1,add",
    "FNF:1",
    "FNH:1",
    "BRDA:2,0,0,1",
    "BRF:1",
    "BRH:1",
    "DA:1,1",
    "DA:2,0",
    "LH:1",
    "LF:2",
    "end_of_record",
  ].join("\n");
  const jobB = [
    "SF:/data/_work/labs/labs/packages/a/mod.ts",
    "DA:1,0",
    "DA:2,5",
    "LH:1",
    "LF:2",
    "end_of_record",
  ].join("\n");

  const { lcov, fileCount, rewritten, unchanged } = mergeLcovReports(
    [jobA, jobB],
    "labs",
  );

  assertEquals(fileCount, 1);
  assertEquals(rewritten, 1);
  assertEquals(unchanged, 0);
  assertEquals(
    lcov,
    [
      "SF:packages/a/mod.ts",
      // line 1: 1 + 0 = 1 (hit); line 2: 0 + 5 = 5 (now hit thanks to job B).
      "DA:1,1",
      "DA:2,5",
      "LF:2",
      "LH:2",
      "end_of_record",
      "",
    ].join("\n"),
  );
});

Deno.test("mergeLcovReports keeps a line uncovered in every job", () => {
  const report = [
    "SF:/home/runner/work/labs/labs/packages/a/mod.ts",
    "DA:5,0",
    "LH:0",
    "LF:1",
    "end_of_record",
  ].join("\n");

  const { lcov } = mergeLcovReports([report, report], "labs");

  assertEquals(
    lcov,
    [
      "SF:packages/a/mod.ts",
      "DA:5,0",
      "LF:1",
      "LH:0",
      "end_of_record",
      "",
    ].join("\n"),
  );
});

Deno.test("combineCoverageLcov tolerates a missing input directory", async () => {
  const { lcov, fileCount } = await combineCoverageLcov(
    "/tmp/combine-lcov-does-not-exist-abc123",
    "labs",
  );
  assertEquals(lcov, "");
  assertEquals(fileCount, 0);
});

Deno.test("combineCoverageLcov merges reports from a directory tree", async () => {
  const dir = await Deno.makeTempDir({ prefix: "combine-lcov-" });
  try {
    await Deno.writeTextFile(
      path.join(dir, "workspace.lcov"),
      [
        "SF:/home/runner/work/labs/labs/packages/a/mod.ts",
        "DA:1,1",
        "LF:1",
        "LH:1",
        "end_of_record",
        "",
      ].join("\n"),
    );
    // A report nested in an artifact subdirectory is still discovered.
    await Deno.mkdir(path.join(dir, "pattern-runtime", "unit-1"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      path.join(dir, "pattern-runtime", "unit-1", "subject.lcov"),
      [
        "TN:pattern-runtime",
        "SF:cf-mount/fid/main.tsx",
        "DA:2,0",
        "LF:1",
        "LH:0",
        "end_of_record",
        "",
      ].join("\n"),
    );
    // An empty report (no coverage produced) is skipped, not concatenated.
    await Deno.writeTextFile(path.join(dir, "empty.lcov"), "");

    const { lcov, fileCount, rewritten, unchanged } = await combineCoverageLcov(
      dir,
      "labs",
    );

    assertEquals(fileCount, 2);
    assertEquals(rewritten, 1);
    assertEquals(unchanged, 1);
    // Output is sorted by source path; the synthetic pattern path keeps its TN.
    assertEquals(
      lcov.split("\n").filter((line) =>
        line.startsWith("SF:") || line.startsWith("TN:")
      ),
      [
        "TN:pattern-runtime",
        "SF:cf-mount/fid/main.tsx",
        "SF:packages/a/mod.ts",
      ],
    );
    assertEquals(lcov.endsWith("\n"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("combineCoverageLcov surfaces a non-NotFound read error", async () => {
  const dir = await Deno.makeTempDir({ prefix: "combine-lcov-" });
  const file = path.join(dir, "not-a-directory");
  await Deno.writeTextFile(file, "");
  try {
    // Walking a path that is a regular file is not a "no coverage" case; the
    // error must propagate rather than be swallowed.
    await assertRejects(() => combineCoverageLcov(file, "labs"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseArgs reads --key=value flags and ignores other tokens", () => {
  const parsed = parseArgs(["--input-dir=a", "--repo-name=x=y", "stray", "-z"]);
  assertEquals(parsed.get("input-dir"), "a");
  // Everything after the first "=" is the value, so embedded "=" is preserved.
  assertEquals(parsed.get("repo-name"), "x=y");
  assertEquals(parsed.has("stray"), false);
  assertEquals(parsed.size, 2);
});

Deno.test("main combines reports and writes the output file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "combine-lcov-main-" });
  try {
    const inputDir = path.join(dir, "in");
    await Deno.mkdir(inputDir);
    await Deno.writeTextFile(
      path.join(inputDir, "workspace.lcov"),
      [
        "SF:/home/runner/work/labs/labs/packages/a/mod.ts",
        "DA:1,1",
        "LF:1",
        "LH:1",
        "end_of_record",
        "",
      ].join("\n"),
    );
    const outputPath = path.join(dir, "nested", "labs-sha.lcov");

    const code = await main([
      `--input-dir=${inputDir}`,
      `--output=${outputPath}`,
      "--repo-name=labs",
    ]);

    assertEquals(code, 0);
    assertEquals(
      await Deno.readTextFile(outputPath),
      [
        "SF:packages/a/mod.ts",
        "DA:1,1",
        "LF:1",
        "LH:1",
        "end_of_record",
        "",
      ].join("\n"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("main returns exit code 2 when a required flag is missing", async () => {
  assertEquals(await main(["--input-dir=a", "--output=b"]), 2);
});

Deno.test("the CLI entry point runs the task as a process", async () => {
  // Run the task as its own process so the `import.meta.main` entry point is
  // exercised end to end. Lockfile isolation keeps the real deno.lock
  // untouched, and all inputs and outputs live under temporary directories.

  const dir = await Deno.makeTempDir({ prefix: "combine-lcov-cli-" });
  try {
    const inputDir = path.join(dir, "in");
    await Deno.mkdir(inputDir);
    await Deno.writeTextFile(
      path.join(inputDir, "workspace.lcov"),
      [
        "SF:/home/runner/work/labs/labs/packages/a/mod.ts",
        "DA:1,1",
        "LF:1",
        "LH:1",
        "end_of_record",
        "",
      ].join("\n"),
    );
    const outputPath = path.join(dir, "labs-sha.lcov");

    const output = await runDenoCommandWithTemporaryLock({
      root: ROOT,
      args: (lockPath) => [
        "run",
        "--config",
        path.join(ROOT, "deno.jsonc"),
        "--lock",
        lockPath,
        "--allow-read",
        "--allow-write",
        path.join(ROOT, "tasks/combine-coverage-lcov.ts"),
        `--input-dir=${inputDir}`,
        `--output=${outputPath}`,
        "--repo-name=labs",
      ],
    });

    assertEquals(output.code, 0);
    assertEquals(
      await Deno.readTextFile(outputPath),
      [
        "SF:packages/a/mod.ts",
        "DA:1,1",
        "LF:1",
        "LH:1",
        "end_of_record",
        "",
      ].join("\n"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
