import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  acceptsJUnitPath,
  acceptsPreload,
  assertMemberTestTasksDefined,
  assertTaskTestsIncluded,
  initializeDb,
  junitCapableMembers,
  leafFlags,
  leafTask,
  memberRecordingArguments,
  memberTestTask,
  readWorkspaceMembers,
  recordingSpool,
  runTests,
  testConcurrency,
  testPackage,
} from "./workspace-tests.ts";
import * as path from "@std/path";
import { preloadArgument } from "@commonfabric/test-support/records";

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
      workspace: packageNames.map((name) => `./packages/${name}`),
      tasks: rootTasks,
    }),
  );
  for (const name of packageNames) {
    await Deno.mkdir(`${dir}/packages/${name}`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/packages/${name}/deno.jsonc`,
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
      await Deno.stat(`${dir}/packages/${name}/ran.txt`);
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
  "workspace": ["./packages/a", "./packages/b"]
}
`,
    );
    assertEquals(await readWorkspaceMembers(configPath), [
      "./packages/a",
      "./packages/b",
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
  assertTaskTestsIncluded(["./packages/api", "./tasks"]);
  assertThrows(
    () => assertTaskTestsIncluded(["./packages/api"]),
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

// Run `fn` with the console's errors captured rather than printed, and
// return them alongside `fn`'s result.
async function capturingErrors<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  };
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = originalError;
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

// A workspace of `a`, `b` and `c` whose first package fails.
async function makeFailingWorkspace(dir: string): Promise<void> {
  await makeWorkspace(dir, ["a", "b", "c"]);
  await Deno.writeTextFile(
    `${dir}/packages/a/deno.jsonc`,
    JSON.stringify({
      tasks: {
        test:
          "echo started > ran.txt && echo upstream package download failed >&2 && exit 1",
      },
    }),
  );
}

Deno.test("runTests without a coverage directory reports a failure and stops scheduling packages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-fail-fast-" });
  try {
    await makeFailingWorkspace(dir);
    const { result: passed, errors } = await capturingErrors(() =>
      withEnv(
        { TEST_CONCURRENCY: "1", DENO_COVERAGE_DIR: undefined },
        () => runTests(dir),
      )
    );

    assertEquals(passed, false);
    assertEquals(await ranPackages(dir, ["a", "b", "c"]), ["a"]);
    const downloadErrorIndex = errors.findIndex((message) =>
      message.includes("upstream package download failed")
    );
    const summaryIndex = errors.indexOf("One or more tests failed.");
    assertEquals(downloadErrorIndex >= 0, true);
    assertEquals(summaryIndex >= 0, true);
    assertEquals(downloadErrorIndex < summaryIndex, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests without a coverage directory names the packages it never started", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-unstarted-" });
  try {
    await makeFailingWorkspace(dir);
    const { errors } = await capturingErrors(() =>
      withEnv(
        { TEST_CONCURRENCY: "1", DENO_COVERAGE_DIR: undefined },
        () => runTests(dir),
      )
    );

    // `a` is the only package that started, so `b` and `c` are the ones the
    // run has nothing to say about.
    assertEquals(await ranPackages(dir, ["a", "b", "c"]), ["a"]);
    const listed = errors.indexOf("Packages this run never started:");
    assertEquals(listed >= 0, true);
    assertEquals(errors.slice(listed + 1), [
      "- ./packages/b",
      "- ./packages/c",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runTests with a coverage directory runs every package after a failure and still fails", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-coverage-" });
  try {
    await makeFailingWorkspace(dir);
    const { result: passed, errors } = await capturingErrors(() =>
      withEnv(
        { TEST_CONCURRENCY: "1", DENO_COVERAGE_DIR: `${dir}/coverage` },
        () => runTests(dir),
      )
    );

    assertEquals(passed, false);
    assertEquals(await ranPackages(dir, ["a", "b", "c"]), ["a", "b", "c"]);
    assertEquals(errors.includes("One or more tests failed."), true);
    assertEquals(errors.includes("Packages this run never started:"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("testPackage reports a failure when the package directory cannot be spawned in", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-nodir-" });
  try {
    const outcome = await testPackage(
      "./packages/missing",
      "missing",
      `${dir}/packages/missing`,
      undefined,
    );
    assertEquals(outcome.result.success, false);
    assertEquals(outcome.packageName, "missing");
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
    const { result: passed, errors } = await capturingErrors(() =>
      runTests(dir)
    );
    // A run that tested nothing is a misconfiguration, not a pass.
    assertEquals(passed, false);
    assertEquals(errors, ["No workspace packages to test."]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

//
// The runner reads each member's manifest to decide whether an appended
// --junit-path reaches its `deno test` whole, so an ordinary new package is
// covered without being named anywhere.
//

Deno.test("acceptsJUnitPath reads an ordinary test task", () => {
  assertEquals(acceptsJUnitPath("deno test"), true);
  assertEquals(
    acceptsJUnitPath("ENV=test deno test --no-check -A"),
    true,
  );
  assertEquals(acceptsJUnitPath(undefined), false);
  assertEquals(
    acceptsJUnitPath("echo 'No tests defined.'"),
    false,
  );
});

Deno.test("acceptsPreload refuses a task naming its own import map", () => {
  // That map governs every module of the invocation, the preload
  // included, so a specifier the preload needs and the map does not carry
  // fails the whole run rather than the preload alone.
  assertEquals(acceptsPreload("deno test"), true);
  assertEquals(
    acceptsPreload("deno test -A --import-map ./m.json ."),
    false,
  );
  assertEquals(
    acceptsPreload("deno test -A --import-map=./m.json ."),
    false,
  );
  // A member that cannot take the JUnit path cannot take the preload
  // either: neither reaches the leaf.
  assertEquals(
    acceptsPreload("deno test a/ && deno test b/"),
    false,
  );
  assertEquals(acceptsPreload(undefined), false);
});

Deno.test("acceptsJUnitPath refuses a task whose flag would land elsewhere", () => {
  // The appended flag reaches only the last command of a chain, which is
  // how a benchmark once received a --junit-path meant for the tests.
  assertEquals(
    acceptsJUnitPath("deno test test/ && deno run -A perf.ts"),
    false,
  );
  assertEquals(
    acceptsJUnitPath("deno test a/ ; deno test b/"),
    false,
  );
  assertEquals(
    acceptsJUnitPath("deno test > results.txt"),
    false,
  );
});

Deno.test("acceptsJUnitPath takes a runner only when it is known to forward", () => {
  // The batch runner hands appended flags to its `deno test` runs and
  // leaves one report; a script of a package's own shows nothing of what
  // it does with them. Which member runs the task does not enter into it.
  assertEquals(
    acceptsJUnitPath(
      "deno run -A ../../tasks/run-test-batches.ts . -- -A",
    ),
    true,
  );
  assertEquals(
    acceptsJUnitPath("deno run -A ./run-test-batches.ts . -- -A"),
    true,
  );
  assertEquals(acceptsJUnitPath("deno run -A test/runner.ts"), false);
  // Chained with another command, the runner is not the one the appended
  // flag reaches.
  assertEquals(
    acceptsJUnitPath(
      "deno run -A ./run-test-batches.ts . -- -A && echo done",
    ),
    false,
  );
});

Deno.test("memberTestTask accepts a directory path as well as a URL", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-manifest-root-" });
  try {
    await Deno.mkdir(`${dir}/packages/probe`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/packages/probe/deno.jsonc`,
      JSON.stringify({ tasks: { test: "deno test" } }),
    );
    // A plain path is the natural thing to pass, and reading through it
    // must find the manifest rather than quietly reporting none.
    assertEquals(await memberTestTask("./packages/probe", dir), "deno test");
    assertEquals(
      await memberTestTask("./packages/probe", new URL(`file://${dir}/`)),
      "deno test",
    );
    // Without the trailing slash a member resolves beside the directory
    // rather than inside it, which reads as a member with no manifest.
    assertEquals(
      await memberTestTask("./packages/probe", new URL(`file://${dir}`)),
      "deno test",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("memberTestTask reads deno.json ahead of deno.jsonc", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-manifest-order-" });
  try {
    await Deno.mkdir(`${dir}/packages/probe`, { recursive: true });
    // Deno resolves deno.json first, so that is the task that governs.
    await Deno.writeTextFile(
      `${dir}/packages/probe/deno.json`,
      JSON.stringify({ tasks: { test: "deno test" } }),
    );
    await Deno.writeTextFile(
      `${dir}/packages/probe/deno.jsonc`,
      JSON.stringify({ tasks: { test: "echo 'No tests defined.'" } }),
    );
    assertEquals(await memberTestTask("./packages/probe", dir), "deno test");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the workspace's capable members are read from their manifests", async () => {
  const rootUrl = new URL("../", import.meta.url);
  const members = await readWorkspaceMembers(new URL("deno.jsonc", rootUrl));
  const capable = await junitCapableMembers(members, rootUrl);

  // Members whose `deno-test` is one `deno test`, reached through
  // `run-member-tests.ts`, and flag-forwarding runners behind it, one of
  // them running its files as several `deno test` commands.
  for (
    const member of [
      "./packages/navigation",
      "./tasks",
      "./packages/cli",
      "./packages/runner",
      "./packages/api",
      "./packages/memory",
      "./packages/dashboard",
      "./packages/patterns",
    ]
  ) {
    assertEquals(capable.has(member), true, `${member} should take the flag`);
  }
  // A browser harness, which does not.
  assertEquals(
    capable.has("./packages/identity"),
    false,
    "./packages/identity should not",
  );
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

Deno.test("every member whose leaf takes the preload lets it read its variables", async () => {
  // The preload reads the spool and the skip list from the environment,
  // and a refused read is swallowed, so a leaf that cannot read them
  // records no file map and skips nothing it is told to skip, silently.
  const rootUrl = new URL("../", import.meta.url);
  const members = await readWorkspaceMembers(new URL("deno.jsonc", rootUrl));
  const recording = await memberRecordingArguments(members, "/spool", rootUrl);
  const unreadable: string[] = [];
  for (const [member, args] of recording) {
    if (args.length === 0) continue;
    const flags = leafFlags((await leafTask(member, rootUrl)) ?? "");
    const reads = flags.some((flag) =>
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
  // lists, and the leaf's is the one that loads the preload. Reading the
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

Deno.test("a recording leaf is given the preload and a write it needs", async () => {
  const rootUrl = new URL("../", import.meta.url);
  const members = await readWorkspaceMembers(new URL("deno.jsonc", rootUrl));
  const recording = await memberRecordingArguments(members, "/spool", rootUrl);

  const preload = preloadArgument();
  // A member whose task names a write list of its own, and one naming no
  // write at all, are each granted the spool on top of what they have,
  // so the preload has somewhere to leave the name map its class names
  // were traded for.
  for (const member of ["./packages/runner", "./packages/html"]) {
    assertEquals(recording.get(member), [preload, "--allow-write=/spool"]);
  }
  // A member already permitted to write anywhere is granted nothing.
  // This one runs under `-A`, which Deno refuses to take beside an
  // `--allow-write` path list at all, ending the run before it starts.
  assertEquals(recording.get("./packages/toolshed"), [preload]);
  // A member that cannot read the tree is granted nothing either: the
  // write is what makes the preload take the class names, and the read
  // is what finds the files that replace them.
  assertEquals(recording.get("./packages/utils"), [preload]);
  // A member behind the batch runner is read by the flags its leaf takes,
  // which here grant a write anywhere.
  assertEquals(recording.get("./packages/cli"), [preload]);
  assertEquals(recording.get("./packages/dashboard"), [preload]);
  // A member whose task cannot take the preload takes nothing at all.
  assertEquals(recording.get("./packages/identity"), []);
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
      `${dir}/packages/b/deno.jsonc`,
      JSON.stringify({ tasks: { bench: "deno bench" } }),
    );
    await Deno.remove(`${dir}/packages/c/deno.jsonc`);

    const members = await readWorkspaceMembers(`${dir}/deno.jsonc`);
    const error = await assertRejects(
      () => assertMemberTestTasksDefined(members, dir),
      Error,
      "Missing from: `./packages/b/deno.jsonc`, `./packages/c/deno.jsonc`",
    );
    // Whoever meets this has just added a package and does not know the
    // rule, so the message carries the entry to add and where to copy it
    // from.
    assertStringIncludes(error.message, "echo 'No tests defined.'");
    assertStringIncludes(error.message, "packages/utils/deno.jsonc");
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
      `${dir}/packages/a/deno.jsonc`,
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
    assertEquals(await memberTestTask("./packages/a", dir), undefined);
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
      `${dir}/packages/a/deno.json`,
      JSON.stringify({ tasks: { bench: "deno bench" } }),
    );

    const members = await readWorkspaceMembers(`${dir}/deno.jsonc`);
    // The manifest named is the one Deno reads, not the one the author put
    // the task in — which is the whole of what the member got wrong.
    await assertRejects(
      () => assertMemberTestTasksDefined(members, dir),
      Error,
      "Missing from: `./packages/a/deno.json`",
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
      `${dir}/packages/b/deno.jsonc`,
      JSON.stringify({ tasks: { bench: "deno bench" } }),
    );

    await assertRejects(
      () => runTests(dir),
      Error,
      "Missing from: `./packages/b/deno.jsonc`",
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
