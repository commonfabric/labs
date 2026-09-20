#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
import { join } from "@std/path";

const PERMISSIONS = [
  "--allow-ffi",
  "--allow-read",
  "--allow-write",
  "--allow-run",
  "--allow-env",
  "--allow-net=127.0.0.1",
];

// Type checking of the CLI package (including test/ and support/) is done by
// `deno task check` (tasks/check.sh), so the test run skips it.
const BASE_FLAGS = ["--no-check"];

// Optional sharding for CI fan-out. CLI_TEST_SHARD uses the same one-based
// "i/n" syntax as PATTERN_INTEGRATION_SHARD. Ordinary files advance through
// the shards in sorted order, starting with the second shard and wrapping after
// the last. An unset variable runs every test file for local development.
function parseCliTestShard(): { index: number; count: number } {
  const raw = Deno.env.get("CLI_TEST_SHARD");
  if (!raw) return { index: 0, count: 1 };
  const match = raw.match(/^(\d+)\/(\d+)$/);
  if (!match) {
    throw new Error(
      `Invalid CLI_TEST_SHARD "${raw}"; expected "i/n" (1-based).`,
    );
  }
  const index = Number(match[1]) - 1;
  const count = Number(match[2]);
  if (count < 1 || index < 0 || index >= count) {
    throw new Error(`CLI_TEST_SHARD "${raw}" out of range.`);
  }
  return { index, count };
}

// Test files that cannot run beside another file. `deno test --parallel` runs
// each file on its own thread of one process, so a file belongs here when it
// changes state the whole process shares: a test that reads an environment
// variable in the test process itself is the common case, since another file
// setting the same name decides what it reads. A test that only configures a
// CLI it spawns does not belong here; `cf` in test/utils.ts gives the spawned
// command its environment directly.
const SERIAL_TESTS = [
  "test/agent-command.test.ts",
  "test/agent-connections.test.ts",
  "test/completion-output.test.ts",
  "test/completion-providers.test.ts",
  "test/fuse.test.ts",
  "test/inspect-remote.test.ts",
  "test/json-command.test.ts",
  "test/log-level.test.ts",
  "test/main-command.test.ts",
  "test/piece-warm.test.ts",
  "test/runtime-creation.test.ts",
  "test/shuttle-command.test.ts",
  "test/shuttle-editor.test.ts",
  "test/shuttle-run.test.ts",
  "test/shuttle-terminal.test.ts",
  "test/shuttle-verbs.test.ts",
  "test/test-runner-compile-byte-cache.test.ts",
  "test/test-runner-pattern-coverage.test.ts",
  "test/test-runner-records.test.ts",
  "test/view-commitmsg-01.test.ts",
  "test/view-commitmsg-02.test.ts",
  "test/view-commitmsg-03.test.ts",
  "test/view-commitmsg-04.test.ts",
  "test/view-commitmsg-05.test.ts",
  "test/view-commitmsg-06.test.ts",
  "test/view-commitmsg-07.test.ts",
  "test/view-commitmsg-08.test.ts",
  "test/view-commitmsg-09.test.ts",
  "test/view-commitmsg-10.test.ts",
  "test/view-mod-gate.test.ts",
  "test/view-pager-pty.test.ts",
  "test/wish-command.test.ts",
];

// These tests exercise Linux procfs paths, which Deno exposes only to an
// all-access process.
const ALL_ACCESS_TESTS = [
  "test/view-procfs.test.ts",
];

// Tests that need a live toolshed named by API_URL. This runner excludes
// them: its --allow-net=127.0.0.1 grant cannot reach an arbitrary API_URL.
// The CI cli-integration-test job runs them against its toolshed; each
// file's header documents the direct local invocation.
const INTEGRATION_TESTS = [
  "test/piece-integration.test.ts",
];

function slashPath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function collectTests(dir: string): Promise<string[]> {
  const tests: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = slashPath(join(dir, entry.name));
    if (entry.isDirectory) {
      tests.push(...await collectTests(path));
    } else if (entry.isFile && path.endsWith(".test.ts")) {
      tests.push(path);
    }
  }
  return tests;
}

async function run(
  label: string,
  options: string[],
  files: string[],
  permissions = PERMISSIONS,
): Promise<void> {
  if (files.length === 0) {
    console.log(`Skipping ${label} (0 files)`);
    return;
  }

  console.log(`Running ${label} (${files.length} files)`);
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["test", ...permissions, ...BASE_FLAGS, ...options, ...files],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!result.success) {
    Deno.exit(result.code);
  }
}

const allTests = (await Promise.all(["test", "support"].map(collectTests)))
  .flat()
  .sort();
const serial = new Set(SERIAL_TESTS);
const missingSerialTests = SERIAL_TESTS.filter((test) =>
  !allTests.includes(test)
);
if (missingSerialTests.length > 0) {
  console.error(
    `Serial CLI test file(s) not found: ${missingSerialTests.join(", ")}`,
  );
  Deno.exit(1);
}

const allAccess = new Set(ALL_ACCESS_TESTS);
const missingAllAccessTests = ALL_ACCESS_TESTS.filter((test) =>
  !allTests.includes(test)
);
if (missingAllAccessTests.length > 0) {
  console.error(
    `All-access CLI test file(s) not found: ${
      missingAllAccessTests.join(", ")
    }`,
  );
  Deno.exit(1);
}

const integration = new Set(INTEGRATION_TESTS);
const missingIntegrationTests = INTEGRATION_TESTS.filter((test) =>
  !allTests.includes(test)
);
if (missingIntegrationTests.length > 0) {
  console.error(
    `Integration CLI test file(s) not found: ${
      missingIntegrationTests.join(", ")
    }`,
  );
  Deno.exit(1);
}
const unitTests = allTests.filter((test) => !integration.has(test));

const shard = parseCliTestShard();
const tests = unitTests.filter((_, index) =>
  (index + 1) % shard.count === shard.index
);

const parallelTests = tests.filter((test) =>
  !serial.has(test) && !allAccess.has(test)
);
const allAccessTests = tests.filter((test) => allAccess.has(test));
const serialTests = tests.filter((test) => serial.has(test));
const denoTestArgs = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;

await run("parallel CLI tests", ["--parallel", ...denoTestArgs], parallelTests);
await run(
  "all-access CLI tests",
  ["--parallel", ...denoTestArgs],
  allAccessTests,
  ["--allow-all"],
);
await run("serial CLI tests", denoTestArgs, serialTests);
