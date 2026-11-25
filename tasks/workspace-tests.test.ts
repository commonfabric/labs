import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  acceptsAppendedFlags,
  assertMemberTestTasksDefined,
  assertTaskTestsIncluded,
  initializeDb,
  leafFlags,
  leafTask,
  main,
  memberRecordingArguments,
  memberTestTask,
  readMemberRecords,
  readWorkspaceMembers,
  recordingSpool,
  type RootTestHost,
  runRootTestTask,
  runTests,
  testConcurrency,
  testPackage,
} from "./workspace-tests.ts";
import { expect } from "@std/expect";
import * as path from "@std/path";
import {
  FragmentWriter,
  RECORD_SCHEMA_VERSION,
  RECORDS_DIR_VARIABLE,
  type ResultLine,
} from "@commonfabric/test-support/records";
import type { RunRecording } from "./test-records.ts";

// Write a minimal workspace under `dir`: a root deno.jsonc listing the
// members, and one directory per package whose `test` task records that it
// ran by writing a marker file into the package directory.
async function makeWorkspace(
  dir: string,
  packageNames: string[],
  rootTasks: Record<string, string> = {},
): Promise<void> {
  await Deno.writeTextFile(
    `${dir}/deno.jsonc`,
    JSON.stringify({
      workspace: packageNames.map((name) => `./runtime/${name}`),
      tasks: rootTasks,
    }),
  );
  for (const name of packageNames) {
    await Deno.mkdir(`${dir}/runtime/${name}`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/runtime/${name}/deno.jsonc`,
      JSON.stringify({ tasks: { test: "echo ok > ran.txt" } }),
    );
  }
}

async function ranPackages(
  dir: string,
  packageNames: string[],
): Promise<string[]> {
  const ran: string[] = [];
  for (const name of packageNames) {
    try {
      await Deno.stat(`${dir}/runtime/${name}/ran.txt`);
      ran.push(name);
    } catch {
      // no marker: the package's test task did not run
    }
  }
  return ran;
}

Deno.test("readWorkspaceMembers reads the workspace list from a JSONC manifest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-members-" });
  try {
    const configPath = `${dir}/deno.jsonc`;
    // Comments must not break parsing — that is the whole point of the JSONC
    // parser here.
    await Deno.writeTextFile(
      configPath,
      `{
  // workspace packages
  "workspace": ["./runtime/a", "./runtime/b"]
}
`,
    );
    assertEquals(await readWorkspaceMembers(configPath), [
      "./runtime/a",
      "./runtime/b",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readWorkspaceMembers rejects a manifest declaring no workspace", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-members-" });
  try {
    // A workspace member's own manifest, which is the file a caller handed a
    // package directory or the wrong root reads instead of the root's.
    const configPath = `${dir}/deno.jsonc`;
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({ tasks: { test: "deno test" } }),
    );
    const error = await assertRejects(
      () => readWorkspaceMembers(configPath),
      Error,
      "declares no workspace",
    );
    assertStringIncludes(error.message, configPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertTaskTestsIncluded requires tasks in the root workspace", () => {
  assertTaskTestsIncluded(["./base/api", "./tasks"]);
  assertThrows(
    () => assertTaskTestsIncluded(["./base/api"]),
    Error,
    "workspace must include tasks",
  );
});

// Run `fn` with each variable in `values` set, or cleared where its value is
// `undefined`, then restore the caller's values. This keeps each test
// independent of the ambient environment, a coverage run's included.
async function withEnv<T>(
  values: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = Object.keys(values).map((name) =>
    [name, Deno.env.get(name)] as const
  );
  const apply = (name: string, value: string | undefined) => {
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  };
  for (const [name, value] of Object.entries(values)) apply(name, value);
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) apply(name, value);
  }
}

// Run `fn` with the console's lines captured rather than printed, and
// return them alongside `fn`'s result.
async function capturingOutput<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = { log: console.log, error: console.error };
  console.log = console.error = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, original);
  }
}

Deno.test("testConcurrency parses the override and defaults to half the cores", async () => {
  assertEquals(testConcurrency("3"), 3);
  await withEnv({ TEST_CONCURRENCY: undefined }, () => {
    assertEquals(
      testConcurrency(),
      Math.max(2, Math.floor(navigator.hardwareConcurrency / 2)),
    );
  });
  let threw = false;
  try {
    testConcurrency("zero");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("runTests drains every package with a concurrency limit of one", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-serialpool-" });
  try {
    await makeWorkspace(dir, ["a", "b", "c"]);
    await withEnv({ TEST_CONCURRENCY: "1" }, async () => {
      const passed = await runTests(dir);
      assertEquals(passed, true);
    });
    assertEquals(await ranPackages(dir, ["a", "b", "c"]), ["a", "b", "c"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Run `runTests` over a one-member workspace whose member writes down the
// spool it was handed, with recording pointed at a spool of the test's own,
// and return what the member saw and what the run left in that spool.
async function recordingSeenBy(
  options: { recordResults?: boolean },
): Promise<{ spool: string; seen: string; left: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: "ws-records-" });
  try {
    await makeWorkspace(dir, ["a"]);
    await Deno.writeTextFile(
      `${dir}/runtime/a/deno.jsonc`,
      JSON.stringify({
        tasks: { test: 'echo "[$CF_TEST_RECORDS_DIR]" > seen.txt' },
      }),
    );
    const spool = path.join(dir, "spool");
    await Deno.mkdir(spool);
    await withEnv({ CF_TEST_RECORDS_DIR: spool }, async () => {
      assertEquals(await runTests(dir, options), true);
    });
    return {
      spool,
      seen: (await Deno.readTextFile(`${dir}/runtime/a/seen.txt`)).trim(),
      left: [...Deno.readDirSync(spool)].map((entry) => entry.name),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("runTests records nothing into the spool it inherited for a caller that did not ask", async () => {
  // The members of a workspace a test builds are that test's fixtures, so
  // neither the run nor any member writes into the spool the test inherited.
  // Each member is still handed a spool of its own beside its log, which is
  // what the summary is read from.
  const { spool, seen, left } = await recordingSeenBy({});
  expect(seen).toMatch(/^\[.*\/deno-task-test-[^/]+\/a\.records\]$/);
  expect(seen).not.toContain(spool);
  assertEquals(left, []);
});

Deno.test("runTests records into the spool for a caller that asked, handing each member a spool of its own", async () => {
  const { spool, seen, left } = await recordingSeenBy({ recordResults: true });
  expect(seen).toMatch(/^\[.*\/deno-task-test-[^/]+\/a\.records\]$/);
  expect(seen).not.toContain(spool);
  // The member's tests write no results, so the one fragment is empty: what
  // this pins is that the run opened its fragment in the spool it was handed.
  assertEquals(left.length, 1);
});

Deno.test("runTests moves what a member's tests wrote into the spool, under the member's scope", async () => {
  // The member stands in for a test process: it writes one results line
  // into the spool it was handed, which the run reads back as a record.
  const dir = await Deno.makeTempDir({ prefix: "ws-records-" });
  try {
    await makeWorkspace(dir, ["a"]);
    const line: ResultLine = {
      line: "result",
      file: "runtime/a/test/a.test.ts",
      name: ["works"],
      outcome: "pass",
      durationMs: 1,
    };
    await Deno.writeTextFile(
      `${dir}/runtime/a/write-results.ts`,
      `const spool = Deno.env.get("CF_TEST_RECORDS_DIR")!;
       Deno.mkdirSync(spool, { recursive: true });
       Deno.writeTextFileSync(
         \`\${spool}/results-a.ndjson\`,
         ${JSON.stringify(JSON.stringify(line) + "\n")},
       );`,
    );
    await Deno.writeTextFile(
      `${dir}/runtime/a/deno.jsonc`,
      JSON.stringify({ tasks: { test: "deno run -A write-results.ts" } }),
    );
    const spool = path.join(dir, "spool");
    await Deno.mkdir(spool);
    await capturingOutput(() =>
      withEnv({ CF_TEST_RECORDS_DIR: spool }, async () => {
        assertEquals(await runTests(dir, { recordResults: true }), true);
      })
    );
    const written = [...Deno.readDirSync(spool)]
      .map((entry) => Deno.readTextFileSync(path.join(spool, entry.name)))
      .join("");
    expect(written).toContain(
      '"test":{"k":"unit","s":"a","n":"works"},"outcome":"pass"',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// A workspace of `a`, `b` and `c` whose first package fails.
async function makeFailingWorkspace(dir: string): Promise<void> {
  await makeWorkspace(dir, ["a", "b", "c"]);
  await Deno.writeTextFile(
    `${dir}/runtime/a/deno.jsonc`,
    JSON.stringify({
      tasks: {
        test:
          "echo started > ran.txt && echo upstream package download failed >&2 && exit 1",
      },
    }),
  );
}

// The lines of the block a run ended with.
function summaryOf(lines: readonly string[]): string[] {
  return lines.slice(lines.findIndex((line) => line.includes("test summary")));
}

// The directory of logs a failing run's summary names.
function logsOf(summary: readonly string[]): string {
  return summary.find((line) => line.startsWith("Logs: "))!.slice(6);
}

Deno.test("runTests without a coverage directory reports a failure and stops scheduling packages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-fail-fast-" });
  try {
    await makeFailingWorkspace(dir);
    const { result: passed, lines } = await capturingOutput(() =>
      withEnv(
        { TEST_CONCURRENCY: "1", DENO_COVERAGE_DIR: undefined },
        () => runTests(dir),
      )
    );

    assertEquals(passed, false);
    assertEquals(await ranPackages(dir, ["a", "b", "c"]), ["a"]);
    // The output of the failed package is in its log and quoted in the
    // summary, rather than printed whole.
    const summary = summaryOf(lines);
    assertEquals(summary[1]!.startsWith("FAILED: 0 failed, 0 passed"), true);
    assertEquals(summary.includes("FAIL a: failed with no failing test"), true);
    assertEquals(
      summary.includes("  | upstream package download failed"),
      true,
    );
    const logs = logsOf(summary);
    assertStringIncludes(
      await Deno.readTextFile(path.join(logs, "a.log")),
      "upstream package download failed",
    );
    await Deno.remove(logs, { recursive: true });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests without a coverage directory names the packages it never started", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-unstarted-" });
  try {
    await makeFailingWorkspace(dir);
    const { lines } = await capturingOutput(() =>
      withEnv(
        { TEST_CONCURRENCY: "1", DENO_COVERAGE_DIR: undefined },
        () => runTests(dir),
      )
    );

    // `a` is the only package that started, so `b` and `c` are the ones the
    // run has nothing to say about.
    assertEquals(await ranPackages(dir, ["a", "b", "c"]), ["a"]);
    const summary = summaryOf(lines);
    assertEquals(
      summary.includes(
        "Not started, because a package failed: ./runtime/b, ./runtime/c",
      ),
      true,
    );
    await Deno.remove(logsOf(summary), { recursive: true });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests with a coverage directory runs every package after a failure and still fails", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-coverage-" });
  try {
    await makeFailingWorkspace(dir);
    const { result: passed, lines } = await capturingOutput(() =>
      withEnv(
        { TEST_CONCURRENCY: "1", DENO_COVERAGE_DIR: `${dir}/coverage` },
        () => runTests(dir),
      )
    );

    assertEquals(passed, false);
    assertEquals(await ranPackages(dir, ["a", "b", "c"]), ["a", "b", "c"]);
    const summary = summaryOf(lines);
    assertEquals(summary.includes("FAIL a: failed with no failing test"), true);
    assertEquals(
      summary.some((line) => line.startsWith("Not started")),
      false,
    );
    await Deno.remove(logsOf(summary), { recursive: true });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// A workspace whose one member `a` stands in for a test process over a file
// holding a passing test, an ignored one, and a test whose step fails with
// `failure`, or passes where there is none. It writes their results into
// the spool it is handed, prints its own report, and exits as `deno test`
// does.
async function makeTestingWorkspace(
  dir: string,
  failure?: string,
): Promise<void> {
  await makeWorkspace(dir, ["a"]);
  await Deno.writeTextFile(
    `${dir}/runtime/a/deno.jsonc`,
    JSON.stringify({ tasks: { test: "deno run -A write-results.ts" } }),
  );
  const result = (
    name: string[],
    fields: Partial<ResultLine> = {},
  ): ResultLine => ({
    line: "result",
    file: "runtime/a/a.test.ts",
    name,
    outcome: "pass",
    durationMs: 1,
    ...fields,
  });
  const lines = [
    result(["fine"]),
    result(["ignored"], { outcome: "skip" }),
    result(
      ["outer", "inner"],
      failure === undefined ? {} : { outcome: "fail", failure },
    ),
    result(["outer"], { container: true }),
  ];
  await Deno.writeTextFile(
    `${dir}/runtime/a/write-results.ts`,
    `const spool = Deno.env.get("CF_TEST_RECORDS_DIR")!;
     Deno.mkdirSync(spool, { recursive: true });
     Deno.writeTextFileSync(
       \`\${spool}/results-a.ndjson\`,
       ${
      JSON.stringify(lines.map((line) => JSON.stringify(line) + "\n").join(""))
    },
     );
     ${failure === undefined ? "" : 'console.log("FAILURES"); Deno.exit(1);'}`,
  );
}

Deno.test("runTests names each failing test, its error, and how to run it again", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-failing-test-" });
  try {
    await makeTestingWorkspace(dir, "Error: broken\nsecond");
    const { result: passed, lines } = await capturingOutput(() =>
      runTests(dir)
    );

    assertEquals(passed, false);
    const summary = summaryOf(lines);
    const logs = logsOf(summary);
    assertEquals(summary.slice(1, -1), [
      summary[1]!,
      "",
      "FAIL unit/a: outer > inner",
      "  file:  runtime/a/a.test.ts",
      "  rerun: cd runtime/a && deno task test --filter outer",
      "  | Error: broken",
      "  | second",
      "",
    ]);
    assertEquals(
      summary[1]!.startsWith("FAILED: 1 failed, 1 passed, 1 skipped ("),
      true,
    );
    // The package's own output is in its log rather than in the run's.
    assertEquals(lines.some((line) => line.includes("FAILURES")), false);
    assertStringIncludes(
      await Deno.readTextFile(path.join(logs, "a.log")),
      "FAILURES",
    );
    await Deno.remove(logs, { recursive: true });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests ends a passing run with one line and keeps no logs", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-passing-test-" });
  try {
    await makeTestingWorkspace(dir);
    const { result: passed, lines } = await capturingOutput(() =>
      runTests(dir)
    );

    assertEquals(passed, true);
    const summary = summaryOf(lines);
    assertEquals(summary.length, 2);
    assertEquals(
      summary[1]!.startsWith("PASSED: 0 failed, 2 passed, 1 skipped ("),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("testPackage reports a failure when the package directory cannot be spawned in", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-nodir-" });
  try {
    const log = path.join(dir, "missing.log");
    const outcome = await testPackage(
      "./runtime/missing",
      "missing",
      `${dir}/runtime/missing`,
      undefined,
      log,
    );
    assertEquals(outcome.success, false);
    assertEquals(outcome.packageName, "missing");
    assertStringIncludes(await Deno.readTextFile(log), "NotFound");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("initializeDb runs the initialize-db task in the given directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-initdb-" });
  try {
    await makeWorkspace(dir, [], {
      "initialize-db": "echo ok > initialized.txt",
    });
    assertEquals(await initializeDb(dir), true);
    await Deno.stat(`${dir}/initialized.txt`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("initializeDb returns false when the task fails", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-initdb-fail-" });
  try {
    await makeWorkspace(dir, [], {
      "initialize-db": "exit 3",
    });
    assertEquals(await initializeDb(dir), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests reports a failure for a workspace with no members", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-empty-" });
  try {
    await makeWorkspace(dir, []);
    const { result: passed, lines } = await capturingOutput(() =>
      runTests(dir)
    );
    // A run that tested nothing is a misconfiguration, not a pass.
    assertEquals(passed, false);
    assertEquals(lines, ["No workspace packages to test."]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

//
// The runner reads each member's manifest to decide whether appended flags
// reach its `deno test` whole, so an ordinary new package is covered without
// being named anywhere.
//

Deno.test("acceptsAppendedFlags reads an ordinary test task", () => {
  assertEquals(acceptsAppendedFlags("deno test"), true);
  assertEquals(
    acceptsAppendedFlags("ENV=test deno test --no-check -A"),
    true,
  );
  assertEquals(acceptsAppendedFlags(undefined), false);
  assertEquals(
    acceptsAppendedFlags("echo 'No tests defined.'"),
    false,
  );
});

Deno.test("acceptsAppendedFlags refuses a task whose flag would land elsewhere", () => {
  // An appended flag reaches only the last command of a chain, which would
  // hand a flag meant for the tests to whatever runs after them.
  assertEquals(
    acceptsAppendedFlags("deno test test/ && deno run -A perf.ts"),
    false,
  );
  assertEquals(
    acceptsAppendedFlags("deno test a/ ; deno test b/"),
    false,
  );
  assertEquals(
    acceptsAppendedFlags("deno test > results.txt"),
    false,
  );
});

Deno.test("acceptsAppendedFlags takes a runner only when it is known to forward", () => {
  // The batch runner hands appended flags to each of its `deno test` runs;
  // a script of a package's own shows nothing of what it does with them.
  // Which member runs the task does not enter into it.
  assertEquals(
    acceptsAppendedFlags(
      "deno run -A ../../tasks/run-test-batches.ts . -- -A",
    ),
    true,
  );
  assertEquals(
    acceptsAppendedFlags("deno run -A ./run-test-batches.ts . -- -A"),
    true,
  );
  assertEquals(acceptsAppendedFlags("deno run -A test/runner.ts"), false);
  // Chained with another command, the runner is not the one the appended
  // flag reaches.
  assertEquals(
    acceptsAppendedFlags(
      "deno run -A ./run-test-batches.ts . -- -A && echo done",
    ),
    false,
  );
});

Deno.test("memberTestTask accepts a directory path as well as a URL", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-manifest-root-" });
  try {
    await Deno.mkdir(`${dir}/runtime/probe`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/runtime/probe/deno.jsonc`,
      JSON.stringify({ tasks: { test: "deno test" } }),
    );
    // A plain path is the natural thing to pass, and reading through it
    // must find the manifest rather than quietly reporting none.
    assertEquals(await memberTestTask("./runtime/probe", dir), "deno test");
    assertEquals(
      await memberTestTask("./runtime/probe", path.toFileUrl(`${dir}/`)),
      "deno test",
    );
    // Without the trailing slash a member resolves beside the directory
    // rather than inside it, which reads as a member with no manifest.
    assertEquals(
      await memberTestTask("./runtime/probe", path.toFileUrl(dir)),
      "deno test",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("memberTestTask reads deno.json ahead of deno.jsonc", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-manifest-order-" });
  try {
    await Deno.mkdir(`${dir}/runtime/probe`, { recursive: true });
    // Deno resolves deno.json first, so that is the task that governs.
    await Deno.writeTextFile(
      `${dir}/runtime/probe/deno.json`,
      JSON.stringify({ tasks: { test: "deno test" } }),
    );
    await Deno.writeTextFile(
      `${dir}/runtime/probe/deno.jsonc`,
      JSON.stringify({ tasks: { test: "echo 'No tests defined.'" } }),
    );
    assertEquals(await memberTestTask("./runtime/probe", dir), "deno test");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the workspace's capable members are read from their manifests", async () => {
  const rootUrl = new URL("../", import.meta.url);
  const members = await readWorkspaceMembers(new URL("deno.jsonc", rootUrl));
  const capable = new Set<string>();
  for (const member of members) {
    if (acceptsAppendedFlags(await leafTask(member, rootUrl))) {
      capable.add(member);
    }
  }

  // Members whose `deno-test` is one `deno test`, reached through
  // `run-member-tests.ts`, and flag-forwarding runners behind it, one of
  // them running its files as several `deno test` commands.
  for (
    const member of [
      "./runtime/navigation",
      "./tasks",
      "./runtime/cli",
      "./runtime/runner",
      "./base/api",
      "./base/identity",
      "./runtime/memory",
      "./dashboard",
      "./patterns",
    ]
  ) {
    assertEquals(capable.has(member), true, `${member} should take flags`);
  }
});

Deno.test("the flag reaches the `deno-test` of a member running the wrapper", async () => {
  // `deno task` appends to the `test` task's own line, which for such a
  // member runs the wrapper. What decides whether the flag can be used
  // at all is the command the wrapper hands it to, so that is what is
  // read.
  const root = await Deno.makeTempDir({ prefix: "leaf-task-" });
  try {
    const write = async (member: string, tasks: Record<string, string>) => {
      await Deno.mkdir(path.join(root, member), { recursive: true });
      await Deno.writeTextFile(
        path.join(root, member, "deno.jsonc"),
        JSON.stringify({ tasks }),
      );
    };
    await write("wrapped", {
      test: "deno run --allow-read ../tasks/run-member-tests.ts deno-test",
      "deno-test": "deno test --allow-read",
    });
    await write("direct", {
      test: "deno test --allow-net",
      "deno-test": "deno test --allow-read",
    });
    await Deno.mkdir(path.join(root, "chained"));
    await Deno.writeTextFile(
      path.join(root, "chained", "deno.jsonc"),
      JSON.stringify({ tasks: { test: { dependencies: ["a", "b"] } } }),
    );
    const rootUrl = path.toFileUrl(`${root}/`);
    assertEquals(
      await leafTask("./wrapped", rootUrl),
      "deno test --allow-read",
    );
    // A `test` task running no wrapper is its own leaf, whatever else the
    // member defines.
    assertEquals(await leafTask("./direct", rootUrl), "deno test --allow-net");
    // A `test` task of dependencies alone runs no command of its own for
    // a flag to reach.
    assertEquals(await leafTask("./chained", rootUrl), undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("every member whose leaf takes appended flags lets its tests read their variables", async () => {
  // The test module reads the spool and the skip list from the environment,
  // and a refused read is swallowed, so a leaf that cannot read them records
  // nothing and skips nothing it is told to skip, silently.
  const rootUrl = new URL("../", import.meta.url);
  const members = await readWorkspaceMembers(new URL("deno.jsonc", rootUrl));
  const unreadable: string[] = [];
  for (const member of members) {
    const task = await leafTask(member, rootUrl);
    if (!acceptsAppendedFlags(task)) continue;
    const reads = leafFlags(task ?? "").some((flag) =>
      flag === "-A" || flag === "--allow-all" || flag === "--allow-env" ||
      (flag.startsWith("--allow-env=") &&
        flag.includes("CF_TEST_RECORDS_DIR") &&
        flag.includes("CF_TEST_SKIP_LIST"))
    );
    if (!reads) unreadable.push(member);
  }
  assertEquals(unreadable, []);
});

Deno.test("the spool a run records into is resolved once", () => {
  // Each leaf runs with its own package as the working directory, so a
  // relative spool would name a different place in each of them.
  assertEquals(
    recordingSpool("spool/records", "/work"),
    "/work/spool/records",
  );
  assertEquals(recordingSpool("/var/records", "/work"), "/var/records");
  assertEquals(recordingSpool(undefined, "/work"), undefined);
});

Deno.test("a spool Deno cannot be told about is not recorded into", () => {
  // A comma separates one path from the next inside `--allow-write=`, so
  // such a spool is granted as two paths that are not it. The run turns
  // recording off rather than failing the members that would take it.
  const said: string[] = [];
  assertEquals(
    recordingSpool("/var/a,b/records", "/work", (m) => said.push(m)),
    undefined,
  );
  assertEquals(said.length, 1);
  assertStringIncludes(said[0]!, "/var/a,b/records");
});

Deno.test("a forwarding runner is read by the flags it hands its leaf", () => {
  // The runner process and the leaf `deno test` carry separate flag
  // lists, and the leaf's is the one its tests run under. Reading the
  // whole line would answer from the runner's.
  assertEquals(
    leafFlags(
      "deno run --allow-read run-test-batches.ts . -- --no-check -A",
    ),
    ["--no-check", "-A"],
  );
  // A member running its leaf directly has one list, and it is the whole
  // of the line, as it is for a script that forwards nothing.
  assertEquals(
    leafFlags("deno run --allow-read runner.ts x . -- --no-check -A"),
    [
      "deno",
      "run",
      "--allow-read",
      "runner.ts",
      "x",
      ".",
      "--",
      "--no-check",
      "-A",
    ],
  );
  assertEquals(
    leafFlags("deno test --allow-read a.test.ts"),
    ["deno", "test", "--allow-read", "a.test.ts"],
  );
});

Deno.test("a recording leaf is given the permissions it needs", async () => {
  const rootUrl = new URL("../", import.meta.url);
  const granted = (member: string) =>
    memberRecordingArguments(member, "/spool", rootUrl);
  // A member whose task names a write list of its own, and one naming no
  // write at all, are each granted the spool on top of what they have, so
  // that their tests have somewhere to write their results. A member that
  // reads nothing of its own needs no read to do it.
  for (const member of ["./runtime/runner", "./runtime/html", "./base/text"]) {
    assertEquals(await granted(member), ["--allow-write=/spool"]);
  }
  // A member already permitted to write anywhere is granted nothing.
  // This one runs under `-A`, which Deno refuses to take beside an
  // `--allow-write` path list at all, ending the run before it starts.
  assertEquals(await granted("./runtime/toolshed"), []);
  // A member behind the batch runner is read by the flags its leaf takes,
  // which here grant a write anywhere.
  assertEquals(await granted("./runtime/cli"), []);
  assertEquals(await granted("./dashboard"), []);
});

Deno.test("a leaf that cannot read is granted the skip list the run names", async () => {
  const rootUrl = new URL("../", import.meta.url);
  const granted = (member: string) =>
    memberRecordingArguments(member, "/spool", rootUrl, "/lists/skip.json");
  // A member reading nothing of its own is granted the list, and one
  // already reading everything is granted no list.
  assertEquals(await granted("./base/text"), [
    "--allow-read=/lists/skip.json",
    "--allow-write=/spool",
  ]);
  assertEquals(await granted("./runtime/runner"), ["--allow-write=/spool"]);
});

Deno.test("a leaf that cannot take appended flags is granted nothing", async () => {
  // Its tests record only where its own flags already let them, since
  // whatever is appended lands on a command other than its `deno test`.
  const root = await Deno.makeTempDir({ prefix: "leaf-grant-" });
  try {
    const write = async (member: string, test: string) => {
      await Deno.mkdir(path.join(root, member), { recursive: true });
      await Deno.writeTextFile(
        path.join(root, member, "deno.jsonc"),
        JSON.stringify({ tasks: { test } }),
      );
    };
    await write("chained", "deno test --allow-read a/ && deno test b/");
    await write("single", "deno test --allow-read a/");
    const rootUrl = path.toFileUrl(`${root}/`);
    assertEquals(
      await memberRecordingArguments("./chained", "/spool", rootUrl),
      [],
    );
    assertEquals(
      await memberRecordingArguments("./single", "/spool", rootUrl),
      ["--allow-write=/spool"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

//
// Every member's own `test` task
//
// The runner refuses to start a run when a member defines none: `deno task
// test` in that member's directory resolves against the root workspace
// instead, and the suite re-enters itself once per such member.
//

Deno.test("assertMemberTestTasksDefined names every member defining no test task", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-missing-test-task-" });
  try {
    await makeWorkspace(dir, ["a", "b", "c"]);
    // Two shapes, one report: a manifest whose tasks are all something
    // else, which is what falls through to the root workspace, and a member
    // with no manifest, which never gets that far — Deno refuses to load a
    // workspace at all when one of its members has no config file.
    await Deno.writeTextFile(
      `${dir}/runtime/b/deno.jsonc`,
      JSON.stringify({ tasks: { bench: "deno bench" } }),
    );
    await Deno.remove(`${dir}/runtime/c/deno.jsonc`);

    const members = await readWorkspaceMembers(`${dir}/deno.jsonc`);
    const error = await assertRejects(
      () => assertMemberTestTasksDefined(members, dir),
      Error,
      "Missing from: `./runtime/b/deno.jsonc`, `./runtime/c/deno.jsonc`",
    );
    // Whoever meets this has just added a package and does not know the
    // rule, so the message carries the entry to add and where to copy it
    // from.
    assertStringIncludes(error.message, "echo 'No tests defined.'");
    assertStringIncludes(error.message, "base/text/deno.jsonc");
    // Creating the other manifest is the way out that costs the member its
    // `imports`, so the message has to warn against it where it is met.
    assertStringIncludes(error.message, "ignores the other whole");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertMemberTestTasksDefined accepts a test task defined by dependencies alone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-dependency-test-task-" });
  try {
    await makeWorkspace(dir, ["a"]);
    await Deno.writeTextFile(
      `${dir}/runtime/a/deno.jsonc`,
      JSON.stringify({
        tasks: {
          check: "deno check .",
          "just-test": "deno test",
          test: { dependencies: ["check", "just-test"] },
        },
      }),
    );

    // Such a task resolves in the member's own directory, so the suite
    // cannot re-enter itself through it. Whether it carries a command line
    // is a different question, and the one `memberTestTask()` asks.
    const members = await readWorkspaceMembers(`${dir}/deno.jsonc`);
    await assertMemberTestTasksDefined(members, dir);
    assertEquals(await memberTestTask("./runtime/a", dir), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertMemberTestTasksDefined reads the manifest Deno resolves", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-manifest-precedence-" });
  try {
    await makeWorkspace(dir, ["a"]);
    // `makeWorkspace` gave the member a `deno.jsonc` with a `test` task.
    // Deno takes the `deno.json` where a member carries both and ignores the
    // other file whole, so the task in it is not one `deno task test` can
    // find, and the member falls through to the root workspace all the same.
    await Deno.writeTextFile(
      `${dir}/runtime/a/deno.json`,
      JSON.stringify({ tasks: { bench: "deno bench" } }),
    );

    const members = await readWorkspaceMembers(`${dir}/deno.jsonc`);
    // The manifest named is the one Deno reads, not the one the author put
    // the task in — which is the whole of what the member got wrong.
    await assertRejects(
      () => assertMemberTestTasksDefined(members, dir),
      Error,
      "Missing from: `./runtime/a/deno.json`",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests refuses a workspace whose member defines no test task", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-guarded-run-" });
  try {
    await makeWorkspace(dir, ["a", "b"]);
    await Deno.writeTextFile(
      `${dir}/runtime/b/deno.jsonc`,
      JSON.stringify({ tasks: { bench: "deno bench" } }),
    );

    await assertRejects(
      () => runTests(dir),
      Error,
      "Missing from: `./runtime/b/deno.jsonc`",
    );
    // Each package's test task writes a marker when it runs, so an empty
    // list is what says the refusal came ahead of the spawn loop rather than
    // part way through it.
    assertEquals(await ranPackages(dir, ["a", "b"]), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("every workspace member defines a test task of its own", async () => {
  // The same assertion the runner makes ahead of its spawn loop, made here
  // so that a member missing one is named by a failing test as well.
  const rootUrl = new URL("../", import.meta.url);
  const members = await readWorkspaceMembers(new URL("deno.jsonc", rootUrl));
  await assertMemberTestTasksDefined(members, rootUrl);
});

/** A recording this process owns, with its spool at `dir`. */
function ownedRecording(dir: string): RunRecording {
  return {
    mode: "own",
    spool: { dir, close() {} },
    context: {
      schema: RECORD_SCHEMA_VERSION,
      line: "context",
      reportId: "01J00000000000000000000000",
      repo: "commonfabric/labs",
      commit: "0".repeat(40),
      dirty: false,
      env: "local",
      os: "darwin",
      arch: "aarch64",
      denoVersion: "2.0.0",
      startedAt: "2026-11-13T00:00:00.000Z",
    },
    key: {
      client_email: "runner@example.com",
      private_key: "",
      token_uri: "https://oauth2.googleapis.com/token",
      cf_username: "runner",
    },
    spoolRoot: dir,
  };
}

/**
 * A host for `runRootTestTask()` whose recording starts as `recording` and
 * whose suite passes or fails as `passes` says, and the order in which the
 * task used it.
 */
function rootTestHost(
  recording: RunRecording,
  passes: boolean | Error,
): { host: RootTestHost; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    host: {
      env: { set: (name, value) => calls.push(`set ${name}=${value}`) },
      pinShuffleSeed: () => calls.push("pin"),
      startRecording: () => {
        calls.push("start");
        return Promise.resolve(recording);
      },
      finishRecording: (finished) => {
        calls.push(`finish ${finished.mode}`);
        return Promise.resolve();
      },
      run: () => {
        calls.push("run");
        return passes instanceof Error
          ? Promise.reject(passes)
          : Promise.resolve(passes);
      },
    },
  };
}

Deno.test("runRootTestTask refuses arguments, rather than running the whole suite", async () => {
  const { host, calls } = rootTestHost({ mode: "off" }, true);
  const { result, lines } = await capturingOutput(() =>
    runRootTestTask(["--filter", "a name"], host)
  );
  expect(result).toBe(2);
  expect(lines.join("\n")).toContain(
    "The root `test` task takes no arguments",
  );
  expect(calls).toEqual([]);
});

Deno.test("runRootTestTask returns 0 for a passing run and 1 for a failing one", async () => {
  const passing = rootTestHost({ mode: "off" }, true);
  expect(await runRootTestTask([], passing.host)).toBe(0);
  expect(passing.calls).toEqual(["pin", "start", "run", "finish off"]);

  const failing = rootTestHost({ mode: "off" }, false);
  expect(await runRootTestTask([], failing.host)).toBe(1);
  expect(failing.calls).toEqual(["pin", "start", "run", "finish off"]);
});

Deno.test("runRootTestTask points the members at the spool of a run it owns", async () => {
  const { host, calls } = rootTestHost(ownedRecording("/spool"), true);
  expect(await runRootTestTask([], host)).toBe(0);
  expect(calls).toEqual([
    "pin",
    "start",
    `set ${RECORDS_DIR_VARIABLE}=/spool`,
    "run",
    "finish own",
  ]);
});

Deno.test("runRootTestTask leaves the environment alone for a run it joined", async () => {
  const { host, calls } = rootTestHost({ mode: "join", dir: "/ci" }, true);
  expect(await runRootTestTask([], host)).toBe(0);
  expect(calls).toEqual(["pin", "start", "run", "finish join"]);
});

Deno.test("runRootTestTask finishes the recording of a run that throws", async () => {
  const { host, calls } = rootTestHost({ mode: "off" }, new Error("boom"));
  await expect(runRootTestTask([], host)).rejects.toThrow("boom");
  expect(calls).toEqual(["pin", "start", "run", "finish off"]);
});

Deno.test("main refuses a workspace without tasks before initializing anything", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-main-" });
  try {
    await makeWorkspace(dir, ["a"]);
    let initialized = false;
    await expect(main(dir, () => {
      initialized = true;
      return Promise.resolve(true);
    })).rejects.toThrow("workspace must include tasks");
    expect(initialized).toBe(false);
    expect(await ranPackages(dir, ["a"])).toEqual([]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// A workspace whose members are `tasks` and `runtime/a`, each of whose test
// tasks writes a marker when it runs.
async function makeWorkspaceWithTasks(dir: string): Promise<void> {
  await makeWorkspace(dir, ["a"]);
  await Deno.writeTextFile(
    `${dir}/deno.jsonc`,
    JSON.stringify({ workspace: ["./tasks", "./runtime/a"] }),
  );
  await Deno.mkdir(`${dir}/tasks`);
  await Deno.writeTextFile(
    `${dir}/tasks/deno.jsonc`,
    JSON.stringify({ tasks: { test: "echo ok > ran.txt" } }),
  );
}

Deno.test("main runs no member when initializing the database fails", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-main-" });
  try {
    await makeWorkspaceWithTasks(dir);
    const initializedIn: string[] = [];
    const passed = await main(dir, (cwd) => {
      initializedIn.push(cwd);
      return Promise.resolve(false);
    });
    expect(passed).toBe(false);
    expect(initializedIn).toEqual([dir]);
    expect(await ranPackages(dir, ["a"])).toEqual([]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("main runs every member once the database is initialized", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-main-" });
  try {
    await makeWorkspaceWithTasks(dir);
    const { result } = await capturingOutput(() =>
      withEnv(
        { CF_TEST_RECORDS_DIR: undefined, TEST_CONCURRENCY: "1" },
        () => main(dir, () => Promise.resolve(true)),
      )
    );
    expect(result).toBe(true);
    expect(await ranPackages(dir, ["a"])).toEqual(["a"]);
    await Deno.stat(`${dir}/tasks/ran.txt`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** One results line for `name` in member `a`'s test file. */
function resultOf(
  name: string,
  fields: Partial<ResultLine> = {},
): ResultLine {
  return {
    line: "result",
    file: "runtime/a/test/x.test.ts",
    name: [name],
    outcome: "pass",
    durationMs: 1,
    ...fields,
  };
}

Deno.test("readMemberRecords reads the results a member's tests wrote as unit records under its scope", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-records-" });
  try {
    await Deno.writeTextFile(
      path.join(dir, "results-a.ndjson"),
      [
        resultOf("works"),
        resultOf("breaks", { outcome: "fail", failure: "Error: broke" }),
      ].map((line) => JSON.stringify(line) + "\n").join(""),
    );
    const { records, failures } = await readMemberRecords(dir, "a");
    expect(records).toEqual([
      {
        line: "record",
        test: { k: "unit", s: "a", n: "works" },
        outcome: "pass",
        durationMs: 1,
        file: "runtime/a/test/x.test.ts",
      },
      {
        line: "record",
        test: { k: "unit", s: "a", n: "breaks" },
        outcome: "fail",
        durationMs: 1,
        file: "runtime/a/test/x.test.ts",
      },
    ]);
    expect([...failures]).toEqual([[records[1], "Error: broke"]]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readMemberRecords returns what another producer spooled beside the results, as it was written", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-records-" });
  try {
    const writer = FragmentWriter.open(dir);
    writer?.append({
      line: "record",
      test: { k: "pattern", s: "patterns", n: "a.test.tsx" },
      outcome: "pass",
      durationMs: 2,
    });
    writer?.close();
    await Deno.writeTextFile(
      path.join(dir, "results-a.ndjson"),
      JSON.stringify(resultOf("works")) + "\n",
    );
    const { records, failures } = await readMemberRecords(dir, "a");
    expect(records.map((record) => [record.test.k, record.test.n])).toEqual([
      ["unit", "works"],
      ["pattern", "a.test.tsx"],
    ]);
    expect(failures.size).toBe(0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readMemberRecords returns nothing, and says nothing, for a member that wrote nothing", async () => {
  // A member whose task never started a test has no spool at all.
  const dir = await Deno.makeTempDir({ prefix: "ws-records-" });
  try {
    const { result, lines } = await capturingWarnings(() =>
      readMemberRecords(path.join(dir, "absent"), "a")
    );
    expect(result.records).toEqual([]);
    expect(result.failures.size).toBe(0);
    expect(lines).toEqual([]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readMemberRecords warns of a results line it cannot read, and returns the rest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-records-" });
  try {
    await Deno.writeTextFile(
      path.join(dir, "results-a.ndjson"),
      "not a line\n" + JSON.stringify(resultOf("works")) + "\n",
    );
    const { result, lines } = await capturingWarnings(() =>
      readMemberRecords(dir, "a")
    );
    expect(result.records.map((record) => record.test.n)).toEqual(["works"]);
    expect(lines).toEqual([
      "test records: dropped a line no reader accepts in results-a.ndjson",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Run `fn` with `console.warn` captured rather than printed, and return the
// lines alongside `fn`'s result.
async function capturingWarnings<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.warn = original;
  }
}

Deno.test("testPackage appends the recording arguments to the member's task", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-testpackage-" });
  try {
    await Deno.writeTextFile(
      `${dir}/deno.jsonc`,
      JSON.stringify({ tasks: { test: "echo" } }),
    );
    const log = path.join(dir, "a.log");
    const { result } = await capturingOutput(() =>
      testPackage(
        "./runtime/a",
        "a",
        dir,
        undefined,
        log,
        {},
        ["--allow-write=/spool", "--allow-env"],
      )
    );
    expect(result.success).toBe(true);
    expect(await Deno.readTextFile(log)).toContain(
      "\n--allow-write=/spool --allow-env\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
