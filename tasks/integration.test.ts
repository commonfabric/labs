import { assertEquals, assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import ports from "@commonfabric/ports" with { type: "json" };
import { exists } from "@std/fs";
import {
  readSpool,
  RECORD_SCHEMA_VERSION,
  type ResultLine,
} from "@commonfabric/test-support/records";
import { shuffledPaths } from "@commonfabric/test-support/shuffle";
import { test } from "@commonfabric/test-support/test";
import {
  ALL_PACKAGES,
  chooseGeneratedPortOffset,
  filteredTestCommand,
  findIntegrationTestFiles,
  GENERATED_PORT_OFFSET_RANGE,
  type IntegrationHost,
  integrationRerun,
  integrationTestDir,
  offsetPorts,
  type PackageOutcome,
  precompilePatternTests,
  readPatternTestList,
  runCommand,
  runFilteredIntegration,
  runIntegration,
  runPackageIntegration,
  selectIntegrationTestFiles,
  selectPatternTestFiles,
  startServers,
} from "./integration.ts";
import { PATTERN_TREES } from "./pattern-files.ts";
import type { RunRecording } from "./test-records.ts";

test("selectPatternTestFiles returns the files slash-separated and sorted", () => {
  assertEquals(
    selectPatternTestFiles([
      "patterns\\system\\notes\\note.test.tsx",
      "patterns/showcase/dice/dice.test.tsx",
    ]),
    [
      "patterns/showcase/dice/dice.test.tsx",
      "patterns/system/notes/note.test.tsx",
    ],
  );
});

test("readPatternTestList reads the path on each line that has one", () => {
  assertEquals(
    readPatternTestList(
      "patterns/showcase/dice/dice.test.tsx\n\n  patterns/chat.test.tsx\n",
    ),
    ["patterns/showcase/dice/dice.test.tsx", "patterns/chat.test.tsx"],
  );
});

test("selectIntegrationTestFiles keeps .test.ts files matching the filter", () => {
  const files = [
    "home-profile.test.ts",
    "counter.test.ts",
    "home-dashboard.test.ts",
    "README.md",
  ];
  assertEquals(selectIntegrationTestFiles(files, "home"), [
    "home-dashboard.test.ts",
    "home-profile.test.ts",
  ]);
});

test("selectIntegrationTestFiles matches a single file by name", () => {
  const files = ["home-profile.test.ts", "counter.test.ts"];
  assertEquals(selectIntegrationTestFiles(files, "home-profile"), [
    "home-profile.test.ts",
  ]);
});

test("selectIntegrationTestFiles prefers an exact filename match", () => {
  const files = ["counter.test.ts", "nested-counter.test.ts"];
  assertEquals(selectIntegrationTestFiles(files, "counter"), [
    "counter.test.ts",
  ]);
  assertEquals(selectIntegrationTestFiles(files, "counter.test.ts"), [
    "counter.test.ts",
  ]);
});

test("selectIntegrationTestFiles returns empty when nothing matches", () => {
  assertEquals(
    selectIntegrationTestFiles(["counter.test.ts"], "nonexistent"),
    [],
  );
});

test("selectIntegrationTestFiles ignores non-test files containing the filter", () => {
  assertEquals(
    selectIntegrationTestFiles(
      ["home.ts", "home.test.ts", "home.test.tsx", "home.txt"],
      "home",
    ),
    ["home.test.ts"],
  );
});

test("selectIntegrationTestFiles sorts the results", () => {
  assertEquals(
    selectIntegrationTestFiles(["b.test.ts", "a.test.ts"], ".test.ts"),
    ["a.test.ts", "b.test.ts"],
  );
});

test("integrationTestDir points generated-patterns at its patterns subdir", () => {
  assertEquals(
    integrationTestDir("generated-patterns"),
    "integration/patterns",
  );
});

test("integrationTestDir defaults to the integration directory", () => {
  assertEquals(integrationTestDir("patterns"), "integration");
  assertEquals(integrationTestDir("runner"), "integration");
  assertEquals(integrationTestDir("shell"), "integration");
});

test("findIntegrationTestFiles reads one level deep and filters by name", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/home-profile.test.ts`, "");
    await Deno.writeTextFile(`${dir}/counter.test.ts`, "");
    await Deno.writeTextFile(`${dir}/notes.txt`, "");
    // A nested directory and the test file inside it are not descended into.
    await Deno.mkdir(`${dir}/reload`);
    await Deno.writeTextFile(`${dir}/reload/home-reload.test.ts`, "");

    assertEquals(await findIntegrationTestFiles(dir, "home"), [
      "home-profile.test.ts",
    ]);
    assertEquals(await findIntegrationTestFiles(dir, ""), [
      "counter.test.ts",
      "home-profile.test.ts",
    ]);
    assertEquals(await findIntegrationTestFiles(dir, "nope"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("findIntegrationTestFiles returns empty for a missing directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await findIntegrationTestFiles(`${dir}/missing`, "home"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("findIntegrationTestFiles rethrows errors other than a missing directory", async () => {
  const file = await Deno.makeTempFile();
  try {
    // Reading a file as a directory raises NotADirectory, not NotFound.
    await assertRejects(() => findIntegrationTestFiles(file, "home"));
  } finally {
    await Deno.remove(file);
  }
});

test("filteredTestCommand passes files as explicit paths under relDir", () => {
  assertEquals(
    filteredTestCommand(
      "runner",
      "integration",
      ["a.test.ts", "b.test.ts"],
      20260922,
    ),
    [
      "deno",
      "test",
      "--no-check",
      "-A",
      "--shuffle=20260922",
      "./integration/a.test.ts",
      "./integration/b.test.ts",
    ],
  );
});

test("filteredTestCommand adds patterns memory and leak flags", () => {
  assertEquals(
    filteredTestCommand(
      "patterns",
      "integration",
      ["home-profile.test.ts"],
      20260922,
    ),
    [
      "deno",
      "test",
      "--no-check",
      "-A",
      "--shuffle=20260922",
      "--v8-flags=--max-old-space-size=4096",
      "--trace-leaks",
      "./integration/home-profile.test.ts",
    ],
  );
});

test("filteredTestCommand uses the generated-patterns subdir and flags", () => {
  assertEquals(
    filteredTestCommand(
      "generated-patterns",
      "integration/patterns",
      ["simple-counter.test.ts"],
      20260922,
    ),
    [
      "deno",
      "test",
      "--no-check",
      "-A",
      "--shuffle=20260922",
      "--trace-leaks",
      "--parallel",
      "./integration/patterns/simple-counter.test.ts",
    ],
  );
});

test("runFilteredIntegration fails without running when no file matches", async () => {
  const pkgDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${pkgDir}/integration`);
    await Deno.writeTextFile(`${pkgDir}/integration/counter.test.ts`, "");
    let ran = false;
    const result = await runFilteredIntegration(
      "runner",
      pkgDir,
      {},
      "no-such-test",
      0,
      () => {
        ran = true;
        return Promise.resolve({ success: true, code: 0 });
      },
    );
    assertEquals(result, { success: false, code: 1 });
    assertEquals(ran, false);
  } finally {
    await Deno.remove(pkgDir, { recursive: true });
  }
});

test("runFilteredIntegration runs deno test with the matching explicit paths", async () => {
  const pkgDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${pkgDir}/integration`);
    await Deno.writeTextFile(`${pkgDir}/integration/home-profile.test.ts`, "");
    await Deno.writeTextFile(`${pkgDir}/integration/counter.test.ts`, "");
    let captured: { cmd: string[]; cwd?: string } | undefined;
    const result = await runFilteredIntegration(
      "patterns",
      pkgDir,
      { LOG_LEVEL: "warn" },
      "home-profile",
      20260922,
      (cmd, options) => {
        captured = { cmd, cwd: options?.cwd };
        return Promise.resolve({ success: true, code: 0 });
      },
    );
    assertEquals(result, { success: true, code: 0 });
    assertEquals(captured?.cwd, pkgDir);
    assertEquals(captured?.cmd, [
      "deno",
      "test",
      "--no-check",
      "-A",
      "--shuffle=20260922",
      "--v8-flags=--max-old-space-size=4096",
      "--trace-leaks",
      "./integration/home-profile.test.ts",
    ]);
  } finally {
    await Deno.remove(pkgDir, { recursive: true });
  }
});

test("runFilteredIntegration uses the generated-patterns subdir", async () => {
  const pkgDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${pkgDir}/integration/patterns`, { recursive: true });
    await Deno.writeTextFile(
      `${pkgDir}/integration/patterns/simple-counter.test.ts`,
      "",
    );
    let captured: string[] | undefined;
    await runFilteredIntegration(
      "generated-patterns",
      pkgDir,
      {},
      "simple-counter",
      42,
      (cmd) => {
        captured = cmd;
        return Promise.resolve({ success: true, code: 0 });
      },
    );
    assertEquals(captured, [
      "deno",
      "test",
      "--no-check",
      "-A",
      "--shuffle=42",
      "--trace-leaks",
      "--parallel",
      "./integration/patterns/simple-counter.test.ts",
    ]);
  } finally {
    await Deno.remove(pkgDir, { recursive: true });
  }
});

type CommandResult = Awaited<ReturnType<typeof runCommand>>;
type CommandOptions = NonNullable<Parameters<typeof runCommand>[1]>;

/** A command a stand-in host was asked to run. */
interface Ran {
  cmd: string[];
  options: CommandOptions;
}

/** A stand-in for the process a run happens in, and what the run did to it. */
interface FakeHost {
  host: IntegrationHost;
  ran: Ran[];

  /** The process environment, as the run left it. */
  env: Map<string, string>;

  /** The recordings the run finished. */
  finished: RunRecording[];

  /** Settles with the status the run asked the process to exit with. */
  exited: Promise<number>;

  /** The handlers registered for each signal and not yet removed. */
  listeners: Map<Deno.Signal, Set<() => void>>;
}

/**
 * A host whose working directory is `cwd`, whose environment holds `env`,
 * and whose commands answer as `run` says, succeeding where it says nothing.
 * Its shuffle seed is 7.
 */
function fakeHost(options: {
  cwd?: string;
  env?: Record<string, string>;
  run?: (
    cmd: string[],
    options: CommandOptions,
  ) => CommandResult | undefined | Promise<CommandResult | undefined>;
  random?: () => number;
  recording?: RunRecording;
} = {}): FakeHost {
  const ran: Ran[] = [];
  const env = new Map(Object.entries(options.env ?? {}));
  const finished: RunRecording[] = [];
  const listeners = new Map<Deno.Signal, Set<() => void>>();
  const { promise: exited, resolve: exit } = Promise.withResolvers<number>();
  const host: IntegrationHost = {
    cwd: () => options.cwd ?? "/repo",
    env: {
      get: (name) => env.get(name),
      set: (name, value) => {
        env.set(name, value);
      },
    },
    run: async (cmd, runOptions = {}) => {
      ran.push({ cmd, options: runOptions });
      return await options.run?.(cmd, runOptions) ?? { success: true, code: 0 };
    },
    random: options.random ?? (() => 0),
    pinShuffleSeed: () => 7,
    startRecording: () => Promise.resolve(options.recording ?? { mode: "off" }),
    finishRecording: (recording) => {
      finished.push(recording);
      return Promise.resolve();
    },
    addSignalListener: (signal, handler) => {
      const handlers = listeners.get(signal) ?? new Set();
      handlers.add(handler);
      listeners.set(signal, handlers);
    },
    removeSignalListener: (signal, handler) => {
      listeners.get(signal)?.delete(handler);
    },
    exit,
  };
  return { host, ran, env, finished, exited, listeners };
}

/** Runs `fn` with the console's lines captured rather than printed. */
async function capturing<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

/**
 * A temporary repository root holding an empty directory for each package
 * named, where `packageDirNamed()` looks for it, every pattern tree, and
 * `scratch`, the directory a run of its own makes.
 */
async function makeRoot(packages: readonly string[]): Promise<string> {
  const rootDir = await Deno.makeTempDir();
  await Deno.mkdir(`${rootDir}/scratch`);
  for (const pkg of packages) {
    const dir = pkg === "patterns" ? pkg : `runtime/${pkg}`;
    await Deno.mkdir(`${rootDir}/${dir}`, { recursive: true });
  }
  for (const tree of PATTERN_TREES) {
    await Deno.mkdir(`${rootDir}/${tree.directory}`, { recursive: true });
  }
  return rootDir;
}

/** The spool a package's command was handed to write its results into. */
function spoolOf({ options }: Ran): string {
  const spool = options.env?.CF_TEST_RECORDS_DIR;
  if (spool === undefined) throw new Error("the command names no spool");
  return spool;
}

/** The names of the entries `dir` holds, sorted. */
async function entriesOf(dir: string): Promise<string[]> {
  return (await Array.fromAsync(Deno.readDir(dir)))
    .map((entry) => entry.name)
    .sort();
}

/** Runs `pkg`'s integration tests from `rootDir` on `fake`. */
function runPackage(
  pkg: string,
  rootDir: string,
  fake: FakeHost,
  extra: { filter?: string; only?: readonly string[]; records?: boolean } = {},
): Promise<PackageOutcome> {
  return runPackageIntegration(pkg, {
    apiUrl: "http://localhost:8000",
    rootDir,
    scratch: `${rootDir}/scratch`,
    seed: 7,
    host: fake.host,
    ...extra,
  });
}

test("runPackageIntegration returns false when a filtered run matches nothing", async () => {
  const rootDir = await makeRoot(["runner"]);
  try {
    await Deno.mkdir(`${rootDir}/runtime/runner/integration`);
    await Deno.writeTextFile(
      `${rootDir}/runtime/runner/integration/counter.test.ts`,
      "",
    );
    const fake = fakeHost();
    const { result } = await capturing(() =>
      runPackage("runner", rootDir, fake, { filter: "no-such-test" })
    );
    expect(result).toEqual({ success: false, code: 1, tests: [] });
    expect(fake.ran).toEqual([]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runPackageIntegration runs a matching filtered test with the run's seed", async () => {
  const rootDir = await makeRoot(["runner"]);
  try {
    await Deno.mkdir(`${rootDir}/runtime/runner/integration`);
    await Deno.writeTextFile(
      `${rootDir}/runtime/runner/integration/counter.test.ts`,
      "",
    );
    const fake = fakeHost();
    await capturing(() =>
      runPackage("runner", rootDir, fake, { filter: "counter" })
    );
    expect(fake.ran.map(({ cmd }) => cmd)).toEqual([[
      "deno",
      "test",
      "--no-check",
      "-A",
      "--shuffle=7",
      "./integration/counter.test.ts",
    ]]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

/**
 * A host whose package command writes `lines` into the spool it is handed,
 * as one test file's results, or writes nothing for no `lines`, and fails.
 */
function reportingHost(
  lines?: readonly ResultLine[],
  env: Record<string, string> = {},
): FakeHost {
  return fakeHost({
    env,
    run: async (cmd, options) => {
      if (lines !== undefined) {
        await Deno.writeTextFile(
          `${spoolOf({ cmd, options })}/results-counter.ndjson`,
          lines.map((line) => JSON.stringify(line) + "\n").join(""),
        );
      }
      return { success: false, code: 1 };
    },
  });
}

/** One results line for `name` in the runner's counter test file. */
function counterResult(
  name: string,
  fields: Partial<ResultLine> = {},
): ResultLine {
  return {
    line: "result",
    file: "runtime/runner/integration/counter.test.ts",
    name: [name],
    outcome: "pass",
    durationMs: 1,
    ...fields,
  };
}

/** A counter test that passes and one that fails. */
const COUNTER_RESULTS = [
  counterResult("counts"),
  counterResult("resets", { outcome: "fail", failure: "Error: still 3" }),
];

test("runPackageIntegration reads each test, and how to rerun a failing one, from the results its tests wrote", async () => {
  const rootDir = await makeRoot(["runner"]);
  const spool = await Deno.makeTempDir();
  try {
    const fake = reportingHost(COUNTER_RESULTS, { CF_TEST_RECORDS_DIR: spool });
    const { result: outcome, lines } = await capturing(() =>
      runPackage("runner", rootDir, fake)
    );
    expect(fake.ran.map(({ cmd, options }) => [cmd, options.cwd])).toEqual([
      [["deno", "task", "integration"], `${rootDir}/runtime/runner`],
    ]);
    expect(lines).toContain(
      "❌ runner integration tests failed (exit code: 1)",
    );
    expect(outcome.success).toBe(false);
    expect(
      outcome.tests.map(({ record, message, rerun }) => ({
        name: record.test.n,
        outcome: record.outcome,
        file: record.file,
        message,
        rerun,
      })),
    ).toEqual([{
      name: "counts",
      outcome: "pass",
      file: "runtime/runner/integration/counter.test.ts",
      message: undefined,
      rerun: undefined,
    }, {
      name: "resets",
      outcome: "fail",
      file: "runtime/runner/integration/counter.test.ts",
      message: "Error: still 3",
      rerun: "deno task integration runner counter",
    }]);
    expect(lines.filter((line) => line.startsWith("test records:")))
      .toEqual([]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
    await Deno.remove(spool, { recursive: true });
  }
});

test("runPackageIntegration warns of the results it could not read and keeps the rest", async () => {
  const rootDir = await makeRoot(["runner"]);
  const spool = await Deno.makeTempDir();
  try {
    const fake = reportingHost(
      [...COUNTER_RESULTS, counterResult("counts", { outcome: "fail" })],
      { CF_TEST_RECORDS_DIR: spool },
    );
    const { result: outcome, lines } = await capturing(() =>
      runPackage("runner", rootDir, fake)
    );
    expect(lines.filter((line) => line.startsWith("test records:")))
      .toEqual([
        "test records: dropped a second result for counts in results-counter.ndjson",
      ]);
    expect(
      outcome.tests.map(({ record }) => [record.test.n, record.outcome]),
    ).toEqual([["counts", "pass"], ["resets", "fail"]]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
    await Deno.remove(spool, { recursive: true });
  }
});

test("runPackageIntegration has the package's tests write into the run's spool", async () => {
  const rootDir = await makeRoot(["runner"]);
  const spool = await Deno.makeTempDir();
  try {
    const fake = reportingHost(COUNTER_RESULTS, { CF_TEST_RECORDS_DIR: spool });
    await capturing(() => runPackage("runner", rootDir, fake));
    expect(spoolOf(fake.ran[0]!)).toBe(spool);
    expect(await entriesOf(spool)).toEqual(["results-counter.ndjson"]);
    expect(await Deno.readTextFile(`${spool}/results-counter.ndjson`))
      .toContain('"name":["resets"]');
    expect(await entriesOf(`${rootDir}/scratch`)).toEqual([]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
    await Deno.remove(spool, { recursive: true });
  }
});

test("runPackageIntegration has the package's tests write into its scratch directory where the run has no spool", async () => {
  const rootDir = await makeRoot(["runner"]);
  try {
    const fake = reportingHost(COUNTER_RESULTS);
    const { result: outcome } = await capturing(() =>
      runPackage("runner", rootDir, fake)
    );
    expect(outcome.tests.map(({ record }) => record.test.n)).toEqual([
      "counts",
      "resets",
    ]);
    expect(spoolOf(fake.ran[0]!)).toBe(`${rootDir}/scratch`);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runPackageIntegration does not read results an earlier package left in the run's spool", async () => {
  const rootDir = await makeRoot(["runner"]);
  const spool = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${spool}/results-stale.ndjson`,
      JSON.stringify(counterResult("stale")) + "\n",
    );
    const { result: outcome } = await capturing(() =>
      runPackage(
        "runner",
        rootDir,
        reportingHost(undefined, { CF_TEST_RECORDS_DIR: spool }),
      )
    );
    expect(outcome).toEqual({ success: false, code: 1, tests: [] });
    expect(await entriesOf(spool)).toEqual(["results-stale.ndjson"]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
    await Deno.remove(spool, { recursive: true });
  }
});

test("runPackageIntegration runs the CLI suite's script against the server", async () => {
  const rootDir = await makeRoot(["cli"]);
  try {
    const fake = fakeHost();
    const { result: outcome, lines } = await capturing(() =>
      runPackage("cli", rootDir, fake)
    );
    expect(outcome).toEqual({ success: true, code: 0, tests: [] });
    expect(lines).toContain("✅ cli integration tests passed");
    expect(fake.ran.map(({ cmd, options }) => [cmd, options.cwd])).toEqual([
      [["bash", "./integration/integration.sh"], `${rootDir}/runtime/cli`],
    ]);
    expect(fake.ran[0].options.env).toEqual({
      LOG_LEVEL: "warn",
      CF_TEST_RECORDS_DIR: spoolOf(fake.ran[0]!),
      API_URL: "http://localhost:8000",
      CF_CLI_INTEGRATION_USE_LOCAL: "1",
    });
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runPackageIntegration runs the FUSE suite from the CLI package, probing deep entities only when asked", async () => {
  const rootDir = await makeRoot(["cli"]);
  try {
    const probes: (string | undefined)[] = [];
    const envs: Record<string, string>[] = [{}, {
      FUSE_DEEP_ENTITY_PROBE: "1",
    }];
    for (const env of envs) {
      const fake = fakeHost({ env });
      await capturing(() => runPackage("cli-fuse", rootDir, fake));
      expect(fake.ran.map(({ cmd, options }) => [cmd, options.cwd])).toEqual([
        [["bash", "./integration/fuse-exec.sh"], `${rootDir}/runtime/cli`],
      ]);
      expect(fake.ran[0].options.env?.CF_CLI_INTEGRATION_USE_LOCAL).toBe("1");
      probes.push(fake.ran[0].options.env?.FUSE_DEEP_ENTITY_PROBE);
    }
    expect(probes).toEqual(["0", "1"]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runPackageIntegration runs the reload suite headless from the patterns package unless told otherwise", async () => {
  const rootDir = await makeRoot(["patterns"]);
  try {
    const seen: Record<string, string | undefined>[] = [];
    for (
      const env of [{}, { HEADLESS: "0", PIPE_CONSOLE: "1" }] as Record<
        string,
        string
      >[]
    ) {
      const fake = fakeHost({ env });
      await capturing(() => runPackage("patterns-reload", rootDir, fake));
      expect(fake.ran.map(({ cmd, options }) => [cmd, options.cwd])).toEqual([
        [["deno", "task", "integration:reload"], `${rootDir}/patterns`],
      ]);
      const { HEADLESS, PIPE_CONSOLE } = fake.ran[0].options.env ?? {};
      seen.push({ HEADLESS, PIPE_CONSOLE });
    }
    expect(seen).toEqual([
      { HEADLESS: "1", PIPE_CONSOLE: undefined },
      { HEADLESS: "0", PIPE_CONSOLE: "1" },
    ]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runPackageIntegration runs a package without a server with server execution off and no API URL", async () => {
  const rootDir = await makeRoot(["generated-patterns"]);
  try {
    const fake = fakeHost();
    await capturing(() => runPackage("generated-patterns", rootDir, fake));
    const env = fake.ran[0].options.env ?? {};
    expect(env.EXPERIMENTAL_SERVER_EXECUTION).toBe("false");
    expect(env.API_URL).toBeUndefined();
    expect(env.HEADLESS).toBeUndefined();
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

/** Pattern test files a run from a temporary root finds. */
const PASSING_PATTERN = "patterns/apps/alpha/alpha.test.tsx";
const FAILING_PATTERN = "patterns/apps/beta/beta.test.tsx";
const OTHER_PATTERN = "patterns/examples/gamma/gamma.test.tsx";

/** A root holding the three pattern test files above. */
async function makePatternRoot(): Promise<string> {
  const rootDir = await makeRoot([]);
  for (const file of [PASSING_PATTERN, FAILING_PATTERN, OTHER_PATTERN]) {
    await Deno.mkdir(`${rootDir}/${file.slice(0, file.lastIndexOf("/"))}`, {
      recursive: true,
    });
    await Deno.writeTextFile(`${rootDir}/${file}`, "");
  }
  return rootDir;
}

/** A host on which `FAILING_PATTERN` fails, printing to both streams. */
function patternHost(env: Record<string, string> = {}): FakeHost {
  return fakeHost({
    env,
    run: (cmd) =>
      cmd.at(-1) === FAILING_PATTERN
        ? { success: false, code: 1, stdout: "step 2 failed", stderr: "boom" }
        : undefined,
  });
}

test("runPackageIntegration runs each pattern test the filter matches, and reports a failing one's output", async () => {
  const rootDir = await makePatternRoot();
  const spool = await Deno.makeTempDir();
  try {
    const fake = patternHost({ CF_TEST_RECORDS_DIR: spool });
    const { result: outcome, lines } = await capturing(() =>
      runPackage("pattern-tests", rootDir, fake, { filter: "apps/" })
    );
    expect(fake.ran.map(({ cmd }) => cmd.at(-1)).sort()).toEqual([
      PASSING_PATTERN,
      FAILING_PATTERN,
    ].sort());
    expect(fake.ran[0].cmd.slice(0, 2)).toEqual(["deno", "run"]);
    expect(fake.ran[0].cmd.slice(-4, -1)).toEqual([
      "test",
      "--root",
      `${rootDir}/patterns`,
    ]);
    expect(lines.some((line) => line.startsWith(`❌ ${FAILING_PATTERN} (`)))
      .toBe(true);
    expect(lines).toContain("   step 2 failed");
    expect(lines).toContain("   boom");
    expect(outcome.success).toBe(false);
    expect(
      outcome.tests.map(({ record, message, rerun }) => [
        record.test.n,
        record.outcome,
        message,
        rerun,
      ]).sort(),
    ).toEqual([
      [PASSING_PATTERN, "pass", undefined, undefined],
      [
        FAILING_PATTERN,
        "fail",
        "step 2 failed\nboom",
        `deno task integration pattern-tests ${FAILING_PATTERN}`,
      ],
    ]);
    // The orchestrator records one line per file into the run's spool.
    let recorded = "";
    for (const entry of Deno.readDirSync(spool)) {
      recorded += await Deno.readTextFile(`${spool}/${entry.name}`);
    }
    expect(recorded).toContain(`"n":"${FAILING_PATTERN}"`);
    expect(recorded).toContain(`"n":"${PASSING_PATTERN}"`);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
    await Deno.remove(spool, { recursive: true });
  }
});

test("runPackageIntegration runs the pattern tests a list names through the cf binary named", async () => {
  const rootDir = await makePatternRoot();
  try {
    const fake = patternHost({ CF_BINARY: "/bin/cf" });
    const { result: outcome } = await capturing(() =>
      runPackage("pattern-tests", rootDir, fake, {
        only: readPatternTestList(OTHER_PATTERN),
      })
    );
    expect(outcome.success).toBe(true);
    expect(fake.ran.map(({ cmd }) => cmd)).toEqual([[
      "/bin/cf",
      "test",
      "--root",
      `${rootDir}/patterns`,
      OTHER_PATTERN,
    ]]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runPackageIntegration precompiles the pattern tests where there is a cache file to fill", async () => {
  const rootDir = await makePatternRoot();
  try {
    const fake = patternHost({
      CF_BINARY: "/bin/cf",
      CF_COMPILE_CACHE_FILE: "/cache",
    });
    await capturing(() =>
      runPackage("pattern-tests", rootDir, fake, {
        only: readPatternTestList(OTHER_PATTERN),
      })
    );
    expect(fake.ran.map(({ cmd }) => cmd.slice(0, 3))).toEqual([
      ["/bin/cf", "test", "--compile-only"],
      ["/bin/cf", "test", "--root"],
    ]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runPackageIntegration runs pattern test files one at a time, in the seed's order", async () => {
  const rootDir = await makeRoot([]);
  const files = Array.from(
    { length: 6 },
    (_, at) => `patterns/showcase/f${at}.test.tsx`,
  );
  try {
    let running = 0;
    let most = 0;
    const fake = fakeHost({
      run: async () => {
        most = Math.max(most, ++running);
        await Promise.resolve();
        running--;
        return undefined;
      },
    });
    const { result: outcome } = await capturing(() =>
      runPackage("pattern-tests", rootDir, fake, { only: files })
    );
    const order = shuffledPaths(files, 7);
    expect(outcome.success).toBe(true);
    expect(most).toBe(1);
    expect(fake.ran.map(({ cmd }) => cmd.at(-1))).toEqual(order);
    expect(outcome.tests.map(({ record }) => [record.test.n, record.outcome]))
      .toEqual(order.map((file) => [file, "pass"]));
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runPackageIntegration counts a pattern test whose run cannot spawn as failed", async () => {
  const rootDir = await makePatternRoot();
  try {
    const fake = fakeHost({
      run: () => Promise.reject(new Error("no such binary")),
    });
    const { result: outcome, lines } = await capturing(() =>
      runPackage("pattern-tests", rootDir, fake, {
        only: readPatternTestList(OTHER_PATTERN),
      })
    );
    expect(outcome.success).toBe(false);
    expect(outcome.tests.map(({ message }) => message)).toEqual([
      "Error: no such binary",
    ]);
    expect(lines).toContain("   Error: no such binary");
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("integrationRerun names the test file where it is known", () => {
  assertEquals(
    integrationRerun(
      "patterns",
      "patterns/integration/cf-render.test.ts",
    ),
    "deno task integration patterns cf-render",
  );
  assertEquals(integrationRerun("cli"), "deno task integration cli");
  // These run a script of their own, which a name would not reach.
  assertEquals(
    integrationRerun(
      "patterns-reload",
      "patterns/integration/x.test.ts",
    ),
    "deno task integration patterns-reload",
  );
  assertEquals(
    integrationRerun("pattern-tests", "patterns/a b/c.test.tsx"),
    "deno task integration pattern-tests 'patterns/a b/c.test.tsx'",
  );
});

test("startServers returns when the startup script completes", async () => {
  using time = new FakeTime();
  let ran = false;
  let settled = false;
  const completion = startServers(
    17,
    "/repo",
    () => {
      ran = true;
      return Promise.resolve({ success: true, code: 0 });
    },
  ).then((code) => {
    settled = true;
    return code;
  });

  await time.tickAsync(0);

  assertEquals(ran, true);
  assertEquals(settled, true);
  assertEquals(await completion, 0);
});

test("startServers returns the startup script failure", async () => {
  const failureCode = 42;
  const code = await startServers(
    17,
    "/repo",
    () => Promise.resolve({ success: false, code: failureCode }),
  );

  assertEquals(code, failureCode);
});

// Every offset the choice can return, collected by sweeping its random input
// finely enough that nothing it can produce is missed.
function generatedPortOffsets(): number[] {
  const steps = 100_000;
  const offsets = new Set<number>();
  for (let step = 0; step < steps; step++) {
    offsets.add(chooseGeneratedPortOffset(() => step / steps));
  }
  return [...offsets].sort((a, b) => a - b);
}

//
// Port offsets, and the ports they must not land on
//
// A port offset shifts every dev server together, and the servers bind whatever
// port arithmetic lands on. Browsers and Deno's `fetch` both refuse to open a
// connection to a port on the WHATWG bad-port list, so an offset that lands a
// server on one produces a server that starts, passes a curl health check, and
// that nothing in a test can reach: every browser navigation gets an error page
// and every server-to-server proxy hop fails.
//

test("no generated port offset lands a server on a blocked port", () => {
  const blocked = new Set(ports.blockedPorts);
  const offenders: string[] = [];
  for (const offset of generatedPortOffsets()) {
    for (const port of offsetPorts(offset)) {
      if (blocked.has(port)) {
        offenders.push(`offset ${offset} uses port ${port}`);
      }
    }
  }
  assertEquals(offenders, []);
});

test("generated port offsets span the documented range", () => {
  const offsets = generatedPortOffsets();
  assertEquals(offsets[0], GENERATED_PORT_OFFSET_RANGE.first);
  assertEquals(offsets[offsets.length - 1], GENERATED_PORT_OFFSET_RANGE.last);
});

test("every recorded blocked port is one fetch refuses", async () => {
  // Keeps the recorded list honest against the runtime that enforces it. A
  // blocked port is rejected before any connection is opened, so pointing these
  // probes at a host that cannot resolve reaches no network service: the
  // blocked answer arrives first, and any other port would fail on the name
  // instead.

  const stillBlocked: number[] = [];
  for (const port of ports.blockedPorts) {
    try {
      await fetch(`http://blocked-port-probe.invalid:${port}/`);
    } catch (error) {
      if (String(error).includes("are blocked")) stillBlocked.push(port);
    }
  }
  assertEquals(stillBlocked, ports.blockedPorts);
});

// The precompile pass, driven with a stand-in for the command runner: what it
// asks to run, and how a group that fails or cannot spawn is reported.

const PRECOMPILE_ROOT = "/repo";
const PATTERN_FILES = "abcdefghijkl".split("").map((name) =>
  `patterns/${name}/main.test.tsx`
);
const CONNECTOR_FILE = `${PATTERN_TREES[1].directory}/main.test.tsx`;

async function precompileCapturing(
  run: (argv: string[]) => Promise<CommandResult>,
): Promise<{ argvs: string[][]; logged: string[] }> {
  const argvs: string[][] = [];
  const logged: string[] = [];
  const previousLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    await precompilePatternTests(
      ["cf"],
      PRECOMPILE_ROOT,
      [...PATTERN_FILES, CONNECTOR_FILE],
      5,
      (argv) => {
        argvs.push(argv);
        return run(argv);
      },
    );
  } finally {
    console.log = previousLog;
  }
  return { argvs, logged };
}

test("precompilePatternTests cuts the shard into runs of neighbors that share a root", async () => {
  const { argvs } = await precompileCapturing(() =>
    Promise.resolve({ success: true, code: 0 })
  );
  const groups = argvs.map((argv) => {
    const root = argv[argv.indexOf("--root") + 1];
    return { root, files: argv.slice(argv.indexOf("--root") + 2) };
  });
  // Thirteen files, five at a time: runs of three, and the lone file of the
  // other root in a run of its own, never beside the others.
  assertEquals(
    groups.map((group) => group.files.length),
    [3, 3, 3, 3, 1],
  );
  assertEquals(
    groups.map((group) => group.root),
    [
      ...Array(4).fill(`${PRECOMPILE_ROOT}/patterns`),
      PRECOMPILE_ROOT,
    ],
  );
  assertEquals(groups.flatMap((group) => group.files), [
    ...PATTERN_FILES,
    CONNECTOR_FILE,
  ]);
  for (const argv of argvs) {
    assertEquals(argv.slice(0, 3), ["cf", "test", "--compile-only"]);
  }
});

test("precompilePatternTests prints a failed group's output and goes on to the rest", async () => {
  let calls = 0;
  const { argvs, logged } = await precompileCapturing(() => {
    calls++;
    return Promise.resolve(
      calls === 1
        ? { success: false, code: 3, stdout: "first\nsecond", stderr: "third" }
        : { success: true, code: 0 },
    );
  });
  assertEquals(argvs.length, 5);
  assertEquals(
    logged.some((line) => line.endsWith("exited 3:")),
    true,
  );
  for (const line of ["   first", "   second", "   third"]) {
    assertEquals(logged.includes(line), true, line);
  }
  assertEquals(
    logged.some((line) => line.includes("1 group(s) had a failure")),
    true,
  );
});

test("precompilePatternTests treats a run that cannot spawn as that group's failure", async () => {
  let calls = 0;
  const { argvs, logged } = await precompileCapturing(() => {
    calls++;
    return calls === 1
      ? Promise.reject(new Error("no such binary"))
      : Promise.resolve({ success: true, code: 0 });
  });
  assertEquals(argvs.length, 5);
  assertEquals(
    logged.some((line) => line.endsWith("exited 127:")),
    true,
  );
  assertEquals(logged.includes("   Error: no such binary"), true);
});

test("runCommand captures what a command prints, with the environment it is given", async () => {
  const result = await runCommand([
    Deno.execPath(),
    "eval",
    `console.log(Deno.env.get("INTEGRATION_PROBE")); console.error("err"); Deno.exit(3);`,
  ], { env: { INTEGRATION_PROBE: "seen" } });
  expect(result).toEqual({
    success: false,
    code: 3,
    stdout: "seen\n",
    stderr: "err\n",
  });
});

test("runCommand captures nothing from a command that prints to this process's output", async () => {
  const result = await runCommand([Deno.execPath(), "eval", ""], {
    inheritStdio: true,
  });
  expect(result).toEqual({
    success: true,
    code: 0,
    stdout: undefined,
    stderr: undefined,
  });
});

/** The lines of the block a run ended with; throws where it printed none. */
function summaryOf(lines: readonly string[]): string[] {
  const start = lines.findIndex((line) => line.includes("test summary"));
  if (start === -1) throw new Error("the run printed no test summary");
  return lines.slice(start);
}

/** The dev-server scripts `ran` holds runs of, each with its first argument. */
function serverScripts(ran: readonly Ran[]): string[] {
  return ran.filter(({ cmd }) => cmd[0] === "bash").map(({ cmd }) =>
    `${cmd[1]} ${cmd[2]}`
  );
}

test("runIntegration prints its usage for --help and runs nothing", async () => {
  const fake = fakeHost();
  const { result, lines } = await capturing(() =>
    runIntegration(["--help"], fake.host)
  );
  expect(result).toBe(0);
  expect(lines.join("\n")).toContain(
    "  deno task integration [options] [package] [filter]",
  );
  expect(lines.join("\n")).toContain(`Available: ${ALL_PACKAGES.join(", ")}`);
  expect(fake.ran).toEqual([]);
  expect(fake.finished).toEqual([]);
});

test("runIntegration refuses a port offset that is not a non-negative integer", async () => {
  for (
    const [args, env, error] of [
      [["--port-offset=x"], {}, `Invalid port offset from --port-offset: "x"`],
      [[], { PORT_OFFSET: "-4" }, `Invalid port offset from PORT_OFFSET: "-4"`],
    ] as const
  ) {
    const fake = fakeHost({ env });
    const { result, lines } = await capturing(() =>
      runIntegration(["cli", ...args], fake.host)
    );
    expect(result).toBe(1);
    expect(lines).toEqual([error]);
    expect(fake.ran).toEqual([]);
    expect(fake.finished).toEqual([{ mode: "off" }]);
  }
});

test("runIntegration refuses an unknown package and names the known ones", async () => {
  const fake = fakeHost();
  const { result, lines } = await capturing(() =>
    runIntegration(["no-such-package"], fake.host)
  );
  expect(result).toBe(1);
  expect(lines).toEqual([
    "Unknown package: no-such-package",
    `Available packages: ${ALL_PACKAGES.join(", ")}`,
  ]);
  expect(fake.ran).toEqual([]);
  expect(fake.finished).toEqual([{ mode: "off" }]);
});

test("runIntegration reuses an explicit port offset and leaves its servers running", async () => {
  const rootDir = await makeRoot(["runner"]);
  try {
    const fake = fakeHost({ cwd: rootDir, env: { PORT_OFFSET: " " } });
    const { result, lines } = await capturing(() =>
      runIntegration(["--port-offset=40", "runner"], fake.host)
    );
    expect(result).toBe(0);
    expect(serverScripts(fake.ran)).toEqual([
      "scripts/stop-local-dev.sh --port-offset=40",
      "scripts/start-local-dev.sh --port-offset=40",
    ]);
    const apiUrl = `http://localhost:${ports.toolshed + 40}`;
    expect(lines).toContain("PORT_OFFSET: 40 (from --port-offset)");
    expect(lines).toContain(`API_URL: ${apiUrl}`);
    expect(fake.ran.at(-1)?.options.env?.API_URL).toBe(apiUrl);
    expect(lines).toContain("\nLeaving servers running (PORT_OFFSET was set).");
    // The runner wrote no report, so it is counted as reporting nothing.
    expect(summaryOf(lines)[1]).toMatch(/^PASSED: /);
    expect(summaryOf(lines)).toContain(
      "Not counted, because they report no tests: runner",
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runIntegration runs no test when the servers on an offset from the environment do not start", async () => {
  const rootDir = await makeRoot(["runner"]);
  try {
    const fake = fakeHost({
      cwd: rootDir,
      env: { PORT_OFFSET: "40" },
      run: (cmd) =>
        cmd[1] === "scripts/start-local-dev.sh"
          ? { success: false, code: 1 }
          : undefined,
    });
    const { result, lines } = await capturing(() =>
      runIntegration(["runner"], fake.host)
    );
    expect(result).toBe(1);
    expect(lines).toContain("PORT_OFFSET: 40 (from env)");
    expect(fake.ran.every(({ cmd }) => cmd[0] === "bash")).toBe(true);
    expect(summaryOf(lines)).toContain(
      "The servers did not start, so no test ran.",
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runIntegration moves a generated offset on after a port collision, and stops its servers after a failing package", async () => {
  const rootDir = await makeRoot(["runner"]);
  try {
    const draws = [0, 0.5];
    const [first, second] = draws.map((draw) =>
      chooseGeneratedPortOffset(() => draw)
    );
    let starts = 0;
    const fake = fakeHost({
      cwd: rootDir,
      random: () => {
        const draw = draws.shift();
        if (draw === undefined) throw new Error("drew more offsets than given");
        return draw;
      },
      run: (cmd) =>
        cmd[0] === "deno"
          ? { success: false, code: 5 }
          : cmd[1] === "scripts/start-local-dev.sh" && starts++ === 0
          ? { success: false, code: 3 }
          : undefined,
    });
    const { result, lines } = await capturing(() =>
      runIntegration(["runner"], fake.host)
    );
    expect(result).toBe(1);
    expect(summaryOf(lines)).toContain(
      "FAIL runner (exit code 5): failed with no failing test",
    );
    expect(lines).toContain(
      `Offset ${first} hit a port collision; retrying...`,
    );
    expect(lines).toContain(`PORT_OFFSET: ${second} (generated)`);
    expect(serverScripts(fake.ran)).toEqual([
      `scripts/start-local-dev.sh --port-offset=${first}`,
      `scripts/start-local-dev.sh --port-offset=${second}`,
      `scripts/stop-local-dev.sh --port-offset=${second}`,
    ]);
    expect(summaryOf(lines)).toContain(
      "Logs: the output above, runtime/toolshed/local-dev-toolshed.log, " +
        "and runtime/shell/local-dev-shell.log",
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runIntegration stops at a startup failure other than a port collision", async () => {
  const rootDir = await makeRoot(["runner"]);
  try {
    const offset = chooseGeneratedPortOffset(() => 0);
    const fake = fakeHost({
      cwd: rootDir,
      run: (cmd) =>
        cmd[1] === "scripts/start-local-dev.sh"
          ? { success: false, code: 1 }
          : undefined,
    });
    const { result, lines } = await capturing(() =>
      runIntegration(["runner"], fake.host)
    );
    expect(result).toBe(1);
    expect(serverScripts(fake.ran)).toEqual([
      `scripts/start-local-dev.sh --port-offset=${offset}`,
      `scripts/stop-local-dev.sh --port-offset=${offset}`,
    ]);
    expect(summaryOf(lines)).toContain(
      "The servers did not start, so no test ran.",
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runIntegration stops its servers from an interrupt that arrives mid-run", async () => {
  const rootDir = await makeRoot(["runner"]);
  try {
    const offset = chooseGeneratedPortOffset(() => 0);
    const fake = fakeHost({
      cwd: rootDir,
      run: (cmd) => {
        if (cmd[0] === "deno") {
          for (const handler of fake.listeners.get("SIGTERM") ?? []) handler();
        }
        return undefined;
      },
    });
    const { lines } = await capturing(async () => {
      await runIntegration(["runner"], fake.host);
      expect(await fake.exited).toBe(130);
    });
    expect(lines).toContain("\nInterrupted, cleaning up...");
    expect(lines).toContain("\nCleaning up servers...");
    expect(serverScripts(fake.ran).filter((s) => s.includes("stop"))).toEqual([
      `scripts/stop-local-dev.sh --port-offset=${offset}`,
    ]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runIntegration fails a run whose selection names no pattern test, and says so last", async () => {
  const rootDir = await makeRoot([]);
  try {
    const fake = fakeHost({ cwd: rootDir });
    const { result, lines } = await capturing(() =>
      runIntegration(["pattern-tests", "no-such-pattern-test"], fake.host)
    );
    expect(result).toBe(1);
    expect(lines).toContain("Package filter: pattern-tests");
    expect(lines).toContain("Name filter: no-such-pattern-test");
    expect(lines).toContain("No pattern test files found.");
    const summary = summaryOf(lines);
    expect(summary[1]).toMatch(/^FAILED: 0 failed, 0 passed, 0 skipped, /);
    expect(summary[3]).toBe(
      "FAIL pattern-tests (exit code 1): failed with no failing test",
    );
    expect(fake.ran).toEqual([]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runIntegration runs the pattern tests a --files list names", async () => {
  const rootDir = await makePatternRoot();
  try {
    await Deno.writeTextFile(`${rootDir}/list`, `${OTHER_PATTERN}\n`);
    const fake = fakeHost({ cwd: rootDir });
    const { result } = await capturing(() =>
      runIntegration(["pattern-tests", `--files=${rootDir}/list`], fake.host)
    );
    expect(result).toBe(0);
    expect(fake.ran.map(({ cmd }) => cmd.at(-1))).toEqual([OTHER_PATTERN]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runIntegration reports a run that stops on an error, and still finishes recording", async () => {
  // No package directory is named `generated-patterns` in an empty root.
  const rootDir = await makeRoot([]);
  try {
    const fake = fakeHost({ cwd: rootDir });
    const { result, lines } = await capturing(() =>
      runIntegration(["generated-patterns"], fake.host)
    );
    expect(result).toBe(1);
    expect(lines).toContain(
      "Integration run failed: Error: no package is named generated-patterns",
    );
    expect(summaryOf(lines)).toContain(
      "The run stopped: Error: no package is named generated-patterns",
    );
    expect(fake.finished).toEqual([{ mode: "off" }]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runIntegration summarizes a package from the results its tests wrote, and removes the scratch directory it gave them", async () => {
  const rootDir = await makeRoot(["generated-patterns"]);
  try {
    const spools: string[] = [];
    const fake = fakeHost({
      cwd: rootDir,
      run: async (cmd, options) => {
        const spool = spoolOf({ cmd, options });
        spools.push(spool);
        await Deno.writeTextFile(
          `${spool}/results-renders.ndjson`,
          JSON.stringify({
            line: "result",
            file: "runtime/generated-patterns/integration/patterns/a.test.ts",
            name: ["renders"],
            outcome: "pass",
            durationMs: 1,
          }) + "\n",
        );
        return undefined;
      },
    });
    const { result, lines } = await capturing(() =>
      runIntegration(["generated-patterns"], fake.host)
    );
    expect(result).toBe(0);
    expect(summaryOf(lines)[1]).toMatch(/^PASSED: 0 failed, 1 passed, /);
    expect(spools).toHaveLength(1);
    expect(await exists(spools[0]!)).toBe(false);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

test("runIntegration fails, saying why, when the --files list cannot be read", async () => {
  const fake = fakeHost();
  const { result, lines } = await capturing(() =>
    runIntegration(["--files=/no/such/list"], fake.host)
  );
  expect(result).toBe(1);
  expect(lines[0]).toMatch(/^Integration run failed: NotFound: /);
  expect(fake.finished).toEqual([{ mode: "off" }]);
});

test("runIntegration reads a relative --files list in its working directory", async () => {
  const rootDir = await makePatternRoot();
  try {
    await Deno.writeTextFile(`${rootDir}/list`, `${OTHER_PATTERN}\n`);
    const fake = fakeHost({ cwd: rootDir });
    const { result } = await capturing(() =>
      runIntegration(["pattern-tests", "--files=list"], fake.host)
    );
    expect(result).toBe(0);
    expect(fake.ran.map(({ cmd }) => cmd.at(-1))).toEqual([OTHER_PATTERN]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
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

test("runIntegration points its children at the spool of a recording it owns", async () => {
  const rootDir = await makeRoot(["generated-patterns"]);
  const spool = await Deno.makeTempDir();
  try {
    const recording = ownedRecording(spool);
    const fake = fakeHost({ cwd: rootDir, recording });
    await capturing(() => runIntegration(["generated-patterns"], fake.host));
    expect(fake.env.get("CF_TEST_RECORDS_DIR")).toBe(spool);
    expect(fake.finished).toEqual([recording]);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
    await Deno.remove(spool, { recursive: true });
  }
});

test("runIntegration leaves the spool of an enclosing run in place", async () => {
  const rootDir = await makeRoot(["generated-patterns"]);
  const spool = await Deno.makeTempDir();
  try {
    const fake = fakeHost({
      cwd: rootDir,
      env: { CF_TEST_RECORDS_DIR: spool },
      recording: ownedRecording("/elsewhere"),
    });
    await capturing(() => runIntegration(["generated-patterns"], fake.host));
    expect(fake.env.get("CF_TEST_RECORDS_DIR")).toBe(spool);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
    await Deno.remove(spool, { recursive: true });
  }
});

test("runPackageIntegration records what the package's tests wrote where the run owns its spool", async () => {
  // A run that owns its spool ships it, and a spool ships only records, so the
  // results become records there under the package's scope. A run that joined
  // another's spool leaves them for that run.

  const rootDir = await makeRoot(["runner"]);
  const spool = await Deno.makeTempDir();
  try {
    await capturing(() =>
      runPackage(
        "runner",
        rootDir,
        reportingHost(COUNTER_RESULTS, { CF_TEST_RECORDS_DIR: spool }),
        { records: true },
      )
    );
    const owned = (await readSpool(spool)).records;
    expect(owned.map((record) => [record.test, record.outcome])).toEqual([
      [{ k: "integration", s: "runner", n: "counts" }, "pass"],
      [{ k: "integration", s: "runner", n: "resets" }, "fail"],
    ]);

    const joined = await Deno.makeTempDir();
    try {
      await capturing(() =>
        runPackage(
          "runner",
          rootDir,
          reportingHost(COUNTER_RESULTS, { CF_TEST_RECORDS_DIR: joined }),
        )
      );
      expect((await readSpool(joined)).records).toEqual([]);
    } finally {
      await Deno.remove(joined, { recursive: true });
    }
  } finally {
    await Deno.remove(rootDir, { recursive: true });
    await Deno.remove(spool, { recursive: true });
  }
});
