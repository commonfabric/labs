import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import {
  memberTasks,
  memberTestFiles,
  parseTestTask,
  readBatchRunnerArguments,
  runnerPaths,
  slashSeparated,
  taskEnvironment,
  testBatches,
  unmatchedGlobs,
  unquote,
} from "./deno-task.ts";

/** Every directory a case made, removed when the case is done. */
const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

/** A member directory holding the manifest and files a case describes. */
async function member(
  manifest: Record<string, unknown>,
  files: readonly string[] = [],
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "deno-task-" });
  made.push(dir);
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify(manifest, null, 2),
  );
  for (const file of files) {
    const at = `${dir}/${file}`;
    await Deno.mkdir(at.slice(0, at.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(at, "");
  }
  return dir;
}

describe("reading a member's test task", () => {
  it("takes the flags apart from the paths", () => {
    const parsed = parseTestTask(
      "ENV=test deno test --no-check --allow-read test/*.test.ts",
    );
    expect(parsed?.env).toEqual({ ENV: "test" });
    expect(parsed?.flags).toEqual(["--no-check", "--allow-read"]);
    expect(parsed?.paths).toEqual(["test/*.test.ts"]);
  });

  it("collects every --ignore separately from the flags", () => {
    const parsed = parseTestTask(
      "deno test --allow-read --ignore='a.test.ts,b/**' .",
    );
    expect(parsed?.ignores).toEqual(["a.test.ts", "b/**"]);
    expect(parsed?.flags).toEqual(["--allow-read"]);
  });

  it("resolves the execPath substitution rather than refusing it", () => {
    const parsed = parseTestTask(
      'deno test --allow-run=$(deno eval "console.log(Deno.execPath())")',
      "/usr/bin/deno",
    );
    expect(parsed?.flags).toEqual(["--allow-run=/usr/bin/deno"]);
  });

  it("keeps a quoted execPath substitution one flag when the path has a space", () => {
    const parsed = parseTestTask(
      'deno test --allow-run="$(deno eval "console.log(Deno.execPath())")" a.test.ts',
      "/Users/Some One/bin/deno",
    );
    expect(parsed?.flags).toEqual(["--allow-run=/Users/Some One/bin/deno"]);
    expect(parsed?.paths).toEqual(["a.test.ts"]);
  });

  it("takes the seed substitution out rather than refusing it", () => {
    // A suite builds the run's own `--shuffle` from the seed it settled
    // on, so what the task writes is taken out here rather than carried
    // through; what matters is that its `$(...)` does not cost the
    // member its per-file granularity.
    const parsed = parseTestTask(
      "deno test --shuffle=$(deno task -q test-seed) --no-check test/a.test.ts",
    );
    expect(parsed?.flags).toEqual(["--no-check"]);
    expect(parsed?.paths).toEqual(["test/a.test.ts"]);
  });

  it("takes both substitutions out of one task", () => {
    const parsed = parseTestTask(
      "deno test --shuffle=$(deno task -q test-seed) " +
        '--allow-run=$(deno eval "console.log(Deno.execPath())") .',
      "/usr/bin/deno",
    );
    expect(parsed?.flags).toEqual(["--allow-run=/usr/bin/deno"]);
    expect(parsed?.paths).toEqual(["."]);
  });

  it("strips shell quoting from inside a flag's value", () => {
    // Several members write `--allow-env=API_URL,"TSC_*",NODE_ENV`. The
    // quotes are the shell's; a flag passed through with them names a
    // permission with literal quote characters, which matches nothing.
    const parsed = parseTestTask(
      'deno test --allow-env=API_URL,"TSC_*",NODE_ENV test/a.test.ts',
    );
    expect(parsed?.flags).toEqual(["--allow-env=API_URL,TSC_*,NODE_ENV"]);
    expect(unquote('a,"b",c')).toBe("a,b,c");
  });

  it("refuses a task that is two commands", () => {
    expect(parseTestTask("deno test a.test.ts && deno run b.ts"))
      .toBeUndefined();
  });

  it("refuses a task naming its own import map", () => {
    // That map governs every module of the invocation, the preload
    // included, so a specifier the preload needs and the map does not
    // carry would fail the whole run rather than the preload alone.
    expect(parseTestTask("deno test -A --import-map ./map.json .")).toBe(
      undefined,
    );
  });

  it("refuses a task that is not a deno test at all", () => {
    expect(parseTestTask("deno run test/runner.ts")).toBeUndefined();
    expect(parseTestTask("echo 'No tests defined.'")).toBeUndefined();
  });
});

describe("reading a task that runs the batch runner", () => {
  // The runner walks a directory and runs `deno test` over what it finds with
  // the flags written after the separator. A lane is pointed at files out of
  // that directory, so it needs only the directory and those flags.

  const TASK = "deno run --allow-env --allow-read " +
    '--allow-run="$(deno eval "console.log(Deno.execPath())")" ' +
    "../../tasks/run-test-batches.ts . " +
    "-- --no-check --allow-ffi";

  it("returns the directory the runner walks as the path to enumerate", () => {
    expect(parseTestTask(TASK, "/usr/bin/deno")?.paths).toEqual(["."]);
  });

  it("reads the runner past a Deno path holding a space", () => {
    expect(parseTestTask(TASK, "/Users/Some One/deno")?.paths).toEqual(["."]);
  });

  it("returns the flags after the separator and not the wrapper's own", () => {
    // The permissions before the runner apply to the runner itself. The tests
    // run under the flags after the separator, and those are the flags a lane
    // has to reproduce.
    expect(parseTestTask(TASK, "/usr/bin/deno")?.flags).toEqual([
      "--no-check",
      "--allow-ffi",
    ]);
  });

  it("returns the assignments standing in front of the command", () => {
    expect(parseTestTask(`ENV=test ${TASK}`, "/usr/bin/deno")?.env).toEqual({
      ENV: "test",
    });
  });

  it("refuses a path written among the flags after the separator", () => {
    // The runner appends its files after those words, so a path there
    // would run alongside whatever a lane asked for.
    expect(
      parseTestTask(
        "deno run -A ../../tasks/run-test-batches.ts . " +
          "-- --no-check extra.test.ts",
      ),
    ).toBeUndefined();
  });

  it("refuses a run of the runner with no separator where one belongs", () => {
    expect(
      parseTestTask(
        "deno run -A ../../tasks/run-test-batches.ts .",
      ),
    ).toBeUndefined();
  });

  it("reads the files the runner's options give flags of their own", () => {
    const parsed = parseTestTask(
      "deno run -A ../../tasks/run-test-batches.ts . " +
        "--serial='**/*.serial.test.ts' --all-access=a.test.ts,b.test.ts " +
        "-- --parallel",
    );
    expect(parsed?.serial).toEqual(["**/*.serial.test.ts"]);
    expect(parsed?.allAccess).toEqual(["a.test.ts", "b.test.ts"]);
    expect(parsed?.flags).toEqual(["--parallel"]);
  });

  it("gives a run with no options no files that need flags of their own", () => {
    const parsed = parseTestTask(TASK, "/usr/bin/deno");
    expect(parsed?.serial).toEqual([]);
    expect(parsed?.allAccess).toEqual([]);
  });

  it("takes an `--ignore` after the separator as files to leave out", () => {
    // The runner walks the directory itself and hands `deno test` the files
    // it chose, so what the flag leaves out has to come out of the walk.
    const parsed = parseTestTask(
      "deno run -A ../../tasks/run-test-batches.ts . " +
        "-- --no-check --ignore='**/*.test.tsx',fixtures/",
    );
    expect(parsed?.ignores).toEqual(["**/*.test.tsx", "fixtures/"]);
    expect(parsed?.flags).toEqual(["--no-check"]);
  });

  it("refuses a second separator among the flags", () => {
    // Every word after it, the files the runner appends included, would be
    // an argument to the test modules rather than to `deno test`.
    expect(
      parseTestTask(
        "deno run -A ../../tasks/run-test-batches.ts . " +
          "-- --no-check -- --parallel",
      ),
    ).toBeUndefined();
  });

  it("refuses an option the runner does not take", () => {
    expect(
      parseTestTask(
        "deno run -A ../../tasks/run-test-batches.ts . " +
          "--parallel -- --no-check",
      ),
    ).toBeUndefined();
  });

  it("refuses a deno run naming no script", () => {
    expect(parseTestTask("deno run --allow-read")).toBeUndefined();
  });

  it("refuses a deno run of any other script", () => {
    expect(parseTestTask("deno run -A ./test/runner.ts a b . -- --no-check"))
      .toBeUndefined();
  });
});

describe("reading the batch runner's own arguments", () => {
  it("keeps a flag's value that follows it as a word of its own", () => {
    // What the runner is handed at run time includes whatever a caller
    // appended, and `--filter "a name"` is two words. Only a task line is
    // held to flags alone.
    expect(
      readBatchRunnerArguments(
        [".", "--", "--no-check", "--filter", "a name"],
      )?.flags,
    ).toEqual(["--no-check", "--filter", "a name"]);
  });

  it("names the directory it walks as the one path", () => {
    expect(readBatchRunnerArguments(["test", "--"])?.paths).toEqual(["test"]);
  });

  it("refuses a second separator", () => {
    // Every word after it, the files the runner appends included, would be
    // an argument to the test modules rather than to `deno test`.
    expect(
      readBatchRunnerArguments([".", "--", "-A", "--", "x"]),
    ).toBeUndefined();
  });

  it("refuses arguments with no separator", () => {
    expect(readBatchRunnerArguments([".", "--no-check"])).toBeUndefined();
    expect(readBatchRunnerArguments([])).toBeUndefined();
  });
});

describe("splitting a member's files by the flags they need", () => {
  const TASK = {
    flags: ["--no-check", "--parallel", "--allow-read", "--allow-net=a.b"],
    serial: ["**/*.serial.test.ts"],
    allAccess: ["test/proc.test.ts"],
  };

  it("runs a serial file without `--parallel`, apart from the rest", () => {
    expect(
      testBatches(TASK, ["test/a.test.ts", "test/b.serial.test.ts"]),
    ).toEqual([
      { flags: TASK.flags, files: ["test/a.test.ts"] },
      {
        flags: ["--no-check", "--allow-read", "--allow-net=a.b"],
        files: ["test/b.serial.test.ts"],
      },
    ]);
  });

  it("runs an all-access file under `--allow-all` alone", () => {
    expect(
      testBatches(TASK, ["test/proc.test.ts", "test/a.test.ts"]),
    ).toEqual([
      { flags: TASK.flags, files: ["test/a.test.ts"] },
      {
        flags: ["--no-check", "--parallel", "--allow-all"],
        files: ["test/proc.test.ts"],
      },
    ]);
  });

  it("replaces short permission flags, and keeps flags granting none", () => {
    expect(
      testBatches(
        {
          flags: ["-R", "-N=a.b", "--allow-scripts", "--deny-net=c.d"],
          serial: [],
          allAccess: ["proc.test.ts"],
        },
        ["proc.test.ts"],
      )[0]!.flags,
    ).toEqual(["--allow-scripts", "--deny-net=c.d", "--allow-all"]);
  });

  it("gives a file both options name both changes", () => {
    expect(
      testBatches(
        { ...TASK, allAccess: ["test/proc.serial.test.ts"] },
        ["test/proc.serial.test.ts"],
      ),
    ).toEqual([
      {
        flags: ["--no-check", "--allow-all"],
        files: ["test/proc.serial.test.ts"],
      },
    ]);
  });

  it("keeps files that need the same flags together, in their own order", () => {
    expect(
      testBatches(TASK, [
        "test/c.serial.test.ts",
        "test/b.test.ts",
        "test/a.serial.test.ts",
        "test/a.test.ts",
      ]).map((batch) => batch.files),
    ).toEqual([
      ["test/b.test.ts", "test/a.test.ts"],
      ["test/c.serial.test.ts", "test/a.serial.test.ts"],
    ]);
  });

  it("gives a plain task one batch under its own flags", () => {
    expect(
      testBatches(
        { flags: ["-A", "--parallel"], serial: [], allAccess: [] },
        ["a.test.ts", "b.serial.test.ts"],
      ),
    ).toEqual([
      { flags: ["-A", "--parallel"], files: ["a.test.ts", "b.serial.test.ts"] },
    ]);
  });

  it("gives no files no batches", () => {
    expect(testBatches(TASK, [])).toEqual([]);
  });
});

describe("finding the globs that name no test file", () => {
  it("names each glob no test file matches, and none that one does", async () => {
    const dir = await member({}, [
      "rise.serial.test.ts",
      "oven.test.ts",
      "fixture.test.tsx",
    ]);
    expect(
      await unmatchedGlobs(dir, ["."], [
        "**/*.serial.test.ts",
        "oven.test.ts",
        "**/*.test.tsx",
      ]),
    ).toEqual([]);
    expect(
      await unmatchedGlobs(dir, ["."], [
        "**/*.serial.test.ts",
        "gone.test.ts",
        "moved/",
      ]),
    ).toEqual(["gone.test.ts", "moved/"]);
  });
});

describe("reading the environment a task sets", () => {
  it("takes the assignments standing before the command", async () => {
    const dir = await member({
      tasks: { integration: "LOG_LEVEL=warn TEST_HTTP=1 deno test -A" },
    });
    expect(await taskEnvironment(dir, "integration")).toEqual({
      LOG_LEVEL: "warn",
      TEST_HTTP: "1",
    });
  });

  it("answers for a command the test-task parser declines", async () => {
    // Every `integration` task in the workspace names a shell variable
    // among its flags, and a shell variable is a metacharacter that
    // `parseTestTask` stops at. The environment is readable regardless,
    // and it is the whole of what the suites want from these tasks.

    const command =
      'LOG_LEVEL=warn deno test -A $INTEGRATION_TEST_FLAGS "./integration/*.test.ts"';
    expect(parseTestTask(command)).toBeUndefined();
    const dir = await member({ tasks: { integration: command } });
    expect(await taskEnvironment(dir, "integration")).toEqual({
      LOG_LEVEL: "warn",
    });
  });

  it("stops at the command, so a later argument is not environment", async () => {
    const dir = await member({
      tasks: { integration: "deno test -A --env=LOG_LEVEL=debug" },
    });
    expect(await taskEnvironment(dir, "integration")).toEqual({});
  });

  it("gives nothing for a task the manifest does not define", async () => {
    const dir = await member({ tasks: { test: "deno test" } });
    expect(await taskEnvironment(dir, "integration")).toEqual({});
  });

  it("reads a task written as an object with dependencies", async () => {
    const dir = await member({
      tasks: {
        integration: { command: "LOG_LEVEL=warn deno test", dependencies: [] },
      },
    });
    expect(await taskEnvironment(dir, "integration")).toEqual({
      LOG_LEVEL: "warn",
    });
  });
});

describe("listing a member's test files", () => {
  it("walks a directory the way deno test walks one", async () => {
    const dir = await member({}, [
      "test/one.test.ts",
      "test/nested/two.test.tsx",
      "test/helper.ts",
      "src/three_test.ts",
    ]);
    const files = await memberTestFiles(dir, parseTestTask("deno test .")!);
    expect(files).toEqual([
      "src/three_test.ts",
      "test/nested/two.test.tsx",
      "test/one.test.ts",
    ]);
  });

  it("applies the task's --ignore, which an explicit path would not", async () => {
    const dir = await member({}, [
      "test/one.test.ts",
      "test/browser/two.browser.test.ts",
    ]);
    const files = await memberTestFiles(
      dir,
      parseTestTask("deno test --ignore='test/browser' .")!,
    );
    expect(files).toEqual(["test/one.test.ts"]);
  });

  it("applies the member's own exclude", async () => {
    const dir = await member({ test: { exclude: ["integration"] } }, [
      "test/one.test.ts",
      "integration/two.test.ts",
    ]);
    const files = await memberTestFiles(dir, parseTestTask("deno test .")!);
    expect(files).toEqual(["test/one.test.ts"]);
  });

  it("keeps a file the task names outright, whatever it is called", async () => {
    // The naming rule is how Deno decides what to run when it discovers
    // files for itself. A path somebody wrote down is one the task runs.
    const dir = await member({}, ["test/scenarios.ts", "test/one.test.ts"]);
    const files = await memberTestFiles(
      dir,
      parseTestTask("deno test test/scenarios.ts")!,
    );
    expect(files).toEqual(["test/scenarios.ts"]);
  });

  it("walks a directory that holds no test file and finds none", async () => {
    // The directory has to exist, or the path never reaches the walk:
    // an absent one is not a directory, so it falls through to being
    // expanded as a glob and the case would prove nothing about walking.
    const dir = await member({}, ["test/helper.ts", "test/data/fixture.json"]);
    const files = await memberTestFiles(dir, parseTestTask("deno test test")!);
    expect(files).toEqual([]);
  });

  it("expands a glob the task names", async () => {
    const dir = await member({}, [
      "test/one.test.ts",
      "test/nested/two.test.ts",
    ]);
    const files = await memberTestFiles(
      dir,
      parseTestTask("deno test test/*.test.ts")!,
    );
    expect(files).toEqual(["test/one.test.ts"]);
  });
});

describe("writing a member-relative path with slashes", () => {
  it("returns a Windows path slash-separated, which a manifest's glob matches", () => {
    const file = slashSeparated("test\\slow\\one.test.ts", "\\");
    expect(file).toBe("test/slow/one.test.ts");
    expect(
      testBatches(
        { flags: ["--parallel"], serial: ["test/slow/**"], allAccess: [] },
        [file],
      ),
    ).toEqual([{ flags: [], files: ["test/slow/one.test.ts"] }]);
  });

  it("returns a POSIX path holding a backslash unchanged", () => {
    expect(slashSeparated("test/one\\two.test.ts", "/")).toBe(
      "test/one\\two.test.ts",
    );
  });
});

describe("resolving which task a member's tests run through", () => {
  it("prefers the Deno-only half where a member names one", async () => {
    const dir = await member({
      tasks: {
        test: { dependencies: ["deno-test", "browser-test"] },
        "deno-test": "deno test --allow-read test/*.test.ts",
        "browser-test": "deno run -A ../deno-web-test/cli.ts test/*.test.ts",
      },
    });
    const tasks = await memberTasks(dir);
    expect(tasks.denoTestTask).toBe("deno-test");
    expect(tasks.browserTest).toBe(true);
    expect(tasks.browserPaths).toEqual(["test/*.test.ts"]);
  });

  it("reaches through a task written as a dependency list", async () => {
    const dir = await member({
      tasks: {
        check: "deno check .",
        "just-test": { command: "deno test --allow-read" },
        test: { dependencies: ["check", "just-test"] },
      },
    });
    const tasks = await memberTasks(dir);
    expect(tasks.denoTestTask).toBe("just-test");
    expect(tasks.denoTest?.flags).toEqual(["--allow-read"]);
  });

  it("reports a member whose task cannot be handed a subset", async () => {
    const dir = await member({
      tasks: { test: "deno run --allow-read test/run-tests.ts" },
    });
    const tasks = await memberTasks(dir);
    expect(tasks.present).toBe(true);
    expect(tasks.denoTest).toBeUndefined();
  });

  it("keeps a member whose only tests need a browser", async () => {
    const dir = await member({
      tasks: {
        "browser-test": "deno run -A ../deno-web-test/cli.ts a.test.ts",
      },
    });
    const tasks = await memberTasks(dir);
    expect(tasks.present).toBe(true);
    expect(tasks.browserTest).toBe(true);
  });

  it("reports a member that says it has no tests as no surface", async () => {
    const dir = await member({ tasks: { test: "echo 'No tests defined.'" } });
    expect((await memberTasks(dir)).present).toBe(false);
  });
});

describe("reading the paths a test runner's task names", () => {
  it("takes the words after the script that are not flags", () => {
    expect(
      runnerPaths(
        "deno run --allow-read ../deno-web-test/cli.ts --verbose " +
          "'**/*.browser.test.ts' a.test.ts",
      ),
    ).toEqual(["**/*.browser.test.ts", "a.test.ts"]);
  });

  it("reads past the assignments standing before the command", () => {
    expect(runnerPaths("HEADLESS=1 deno run -A cli.ts a.test.ts"))
      .toEqual(["a.test.ts"]);
  });

  it("names nothing for a runner given no paths", () => {
    expect(runnerPaths("deno run -A ../deno-web-test/cli.ts")).toEqual([]);
  });

  it("names nothing for a task that is not a deno run", () => {
    expect(runnerPaths("deno test -A a.test.ts")).toEqual([]);
    expect(runnerPaths("")).toEqual([]);
  });

  it("names nothing for a deno run naming no script", () => {
    expect(runnerPaths("deno run -A")).toEqual([]);
  });

  it("names nothing for a task that is two commands", () => {
    expect(
      runnerPaths("deno run -A cli.ts a.test.ts && deno run -A cli.ts b"),
    ).toEqual([]);
  });
});

describe("a member whose manifest says less than usual", () => {
  it("excludes nothing where the member has no manifest", async () => {
    const dir = await Deno.makeTempDir({ prefix: "deno-task-" });
    made.push(dir);
    await Deno.mkdir(`${dir}/test`, { recursive: true });
    await Deno.writeTextFile(`${dir}/test/one.test.ts`, "");
    const files = await memberTestFiles(dir, parseTestTask("deno test .")!);
    expect(files).toEqual(["test/one.test.ts"]);
  });

  it("reports no task at all as no test surface", async () => {
    const dir = await member({});
    const tasks = await memberTasks(dir);
    expect(tasks.present).toBe(false);
    expect(tasks.browserTest).toBe(false);
  });

  it("never descends into the directories the walk is told to skip", async () => {
    // These hold test files; what keeps them out is their names. A
    // dependency's own tests are its own business, and a build output
    // holds a copy of tests that already ran from their source.
    const dir = await member({}, [
      "node_modules/dep/a.test.ts",
      "dist/b.test.ts",
      "test/c.test.ts",
    ]);
    const files = await memberTestFiles(dir, parseTestTask("deno test .")!);
    expect(files).toEqual(["test/c.test.ts"]);
  });

  it("excludes a file by a glob as well as by a directory", async () => {
    const dir = await member({}, ["test/a.test.ts", "test/b.browser.test.ts"]);
    const files = await memberTestFiles(
      dir,
      parseTestTask("deno test --ignore='**/*.browser.test.ts' .")!,
    );
    expect(files).toEqual(["test/a.test.ts"]);
  });
});

describe("a member holding a file where a directory would go", () => {
  it("keeps walking past it, and finds the tests beside it", async () => {
    // The walk descends into directories and reads files; a file called
    // `test` is neither a directory to descend into nor a name the test
    // rule matches, so it is passed over rather than being read as
    // either.
    const dir = await Deno.makeTempDir({ prefix: "deno-task-" });
    made.push(dir);
    await Deno.writeTextFile(`${dir}/test`, "not a directory");
    await Deno.mkdir(`${dir}/src`);
    await Deno.writeTextFile(`${dir}/src/a.test.ts`, "");
    const files = await memberTestFiles(dir, parseTestTask("deno test .")!);
    expect(files).toEqual(["src/a.test.ts"]);
  });
});

describe("a task naming a dependency that is not there", () => {
  it("passes over it rather than reading it as a command", async () => {
    const dir = await member({
      tasks: {
        test: { dependencies: ["check", "just-test"] },
        "just-test": "deno test --allow-read",
      },
    });
    // `check` is named and not defined; what matters is that the
    // dependency that is defined is still found.
    const tasks = await memberTasks(dir);
    expect(tasks.denoTestTask).toBe("just-test");
  });
});
