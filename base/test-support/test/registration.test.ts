import { expect } from "@std/expect";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import {
  readRegistered,
  readResults,
  serializeSkipList,
  type SkipList,
  type TestRecord,
} from "@commonfabric/test-support/records";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";

const ROOT = fromFileUrl(new URL("../../../", import.meta.url));
const FIXTURES = "base/test-support/test/fixtures";

/** What one run of a fixture test file came to. */
interface Run {
  code: number;
  output: string;

  /** What the fixture logged, in order, each `LOG ` line without the prefix. */
  logged: string[];
  records: TestRecord[];

  /** The skips the skip list asked for, which are no records of the tests. */
  listed: TestRecord[];
  hooks: TestRecord[];
  failures: Map<TestRecord, string>;
  registered: Map<string, Set<string>>;
}

const temporary: string[] = [];

/**
 * Runs `file`, repository-relative, as `deno test` would in a lane, with the
 * skip list `skips` where one is given, and reads what it recorded.
 */
async function run(
  file: string,
  { skips, known, flags = [], env = {} }: {
    skips?: SkipList | string;
    known?: (name: string) => boolean;
    flags?: readonly string[];
    env?: Record<string, string>;
  } = {},
): Promise<Run> {
  const dir = await Deno.makeTempDir({ prefix: "registration-test-" });
  temporary.push(dir);
  const spool = join(dir, "spool");
  let skipList = "";
  if (skips !== undefined) {
    skipList = join(dir, "skip.json");
    await Deno.writeTextFile(
      skipList,
      typeof skips === "string" ? skips : serializeSkipList(skips),
    );
  }
  const result = await runDenoCommandWithTemporaryLock({
    root: ROOT,
    args: (lock) => [
      "test",
      "--no-check",
      "-A",
      `--lock=${lock}`,
      "--frozen",
      ...flags,
      file,
    ],
    env: {
      CF_TEST_RECORDS_DIR: spool,
      CF_TEST_SKIP_LIST: skipList,
      NO_COLOR: "1",
      ...env,
    },
  });
  const output = new TextDecoder().decode(result.stdout) +
    new TextDecoder().decode(result.stderr);
  const results = await readResults(spool, {
    kind: "unit",
    scope: "bakery",
    ...(known === undefined ? {} : { known: (test) => known(test.n) }),
  });
  return {
    code: result.code,
    output,
    logged: output.split("\n").filter((line) => line.startsWith("LOG "))
      .map((line) => line.slice("LOG ".length)),
    records: results.records,
    listed: results.listed,
    hooks: results.hooks,
    failures: results.failures,
    registered: await readRegistered(spool),
  };
}

/** The outcome of each record, by name. */
function outcomes(records: readonly TestRecord[]): Record<string, string> {
  return Object.fromEntries(
    records.map((record) => [record.test.n, record.outcome]),
  );
}

describe("@commonfabric/test-support/test", () => {
  afterAll(async () => {
    for (const dir of temporary) await Deno.remove(dir, { recursive: true });
  });

  describe("a file run whole", () => {
    const file = `${FIXTURES}/suites.fixture.ts`;
    let whole: Run;

    beforeAll(async () => {
      whole = await run(file, { known: (name) => name === "bakery > glaze" });
    });

    it("fails the run where a test fails", () => {
      expect(whole.code).not.toBe(0);
    });

    it("records each test under the names enclosing it", () => {
      expect(outcomes(whole.records)).toMatchObject({
        "bakery > bakes bread": "pass",
        "bakery > burns toast": "fail",
        "bakery > glaze > sets": "pass",
        "bakery > glaze > runs": "pass",
        "bakery > pantry > stocks flour": "pass",
        "closed shop > opens": "pass",
        "invoice": "pass",
      });
      for (const record of whole.records) expect(record.file).toBe(file);
    });

    it("records a step as a test inside the test running it", () => {
      expect(outcomes(whole.records)).toMatchObject({
        "delivery > loads the van": "pass",
        "delivery > drives": "pass",
      });
    });

    it("records an ignored test as skipped and never runs it", () => {
      expect(outcomes(whole.records)).toMatchObject({
        "bakery > sells cake": "skip",
        "bakery > weighs dough": "skip",
      });
      expect(whole.logged).not.toContain("sells cake");
      expect(whole.logged).not.toContain("weighs dough");
    });

    it("records a group only where it failed on its own or is known", () => {
      const names = whole.records.map((record) => record.test.n);
      expect(names).not.toContain("bakery");
      expect(names).not.toContain("delivery");
      expect(outcomes(whole.records)).toMatchObject({
        "cellar": "fail",
        "bakery > glaze": "pass",
      });
    });

    it("keeps the message each failure threw", () => {
      const messages = [...whole.failures].map(([record, message]) =>
        [record.test.n, message] as const
      );
      expect(messages).toContainEqual([
        "bakery > burns toast",
        expect.stringContaining("the toast is burnt"),
      ]);
      expect(messages).toContainEqual([
        "cellar",
        expect.stringContaining("the cellar flooded"),
      ]);
      expect(messages.map(([name]) => name)).not.toContain(
        "bakery > bakes bread",
      );
    });

    it("measures what each outermost group's hooks took", () => {
      expect(whole.hooks.map((record) => record.test.n).toSorted()).toEqual([
        "bakery",
        "cellar",
        "closed shop",
        "delivery",
      ]);
    });

    it("registers every test and group, and no step", () => {
      const names = whole.registered.get(file);
      expect(names).toBeDefined();
      for (
        const name of [
          "bakery",
          "bakery > glaze",
          "bakery > glaze > sets",
          "bakery > sells cake",
          "delivery",
          "invoice",
        ]
      ) {
        expect(names!.has(name)).toBe(true);
      }
      expect(names!.has("delivery > drives")).toBe(false);
    });

    it("runs each hook around the tests of the group declaring it", () => {
      const at = whole.logged.indexOf("sets");
      expect(whole.logged.slice(at - 3, at + 4)).toEqual([
        "file beforeEach",
        "bakery beforeEach",
        "glaze beforeEach",
        "sets",
        "glaze afterEach",
        "bakery afterEach",
        "file afterEach",
      ]);
      expect(whole.logged.filter((line) => line === "glaze beforeAll"))
        .toHaveLength(1);
      expect(whole.logged.indexOf("bakery beforeAll")).toBeLessThan(
        whole.logged.indexOf("bakes bread"),
      );
      expect(whole.logged.indexOf("bakery afterAll")).toBeGreaterThan(
        whole.logged.indexOf("stocks flour"),
      );
    });

    it("runs a file's own hooks around a test of its own", () => {
      const at = whole.logged.indexOf("invoice");
      expect(whole.logged.slice(at - 1, at + 2)).toEqual([
        "file beforeEach",
        "invoice",
        "file afterEach",
      ]);
    });
  });

  describe("a file run with a skip list", () => {
    const file = `${FIXTURES}/suites.fixture.ts`;
    let skipped: Run;

    beforeAll(async () => {
      skipped = await run(file, {
        skips: {
          [file]: [
            "bakery > pantry",
            "bakery > glaze > runs",
            "closed shop",
            "delivery > drives",
          ],
          [`${FIXTURES}/other.fixture.ts`]: ["bakery"],
        },
      });
    });

    it("reports each listed test as listed, records nothing of it, and never runs it", () => {
      expect(outcomes(skipped.listed)).toMatchObject({
        "bakery > glaze > runs": "skip",
      });
      const recorded = skipped.records.map((record) => record.test.n);
      expect(recorded).not.toContain("bakery > glaze > runs");
      expect(skipped.logged).not.toContain("runs");
    });

    it("runs a listed step with its test, and reports it as listed rather than recording it", () => {
      // A step is part of its test's body, and may read what the steps
      // before it set up, so it runs whenever its test does.

      expect(outcomes(skipped.listed)).toMatchObject({
        "delivery > drives": "pass",
      });
      expect(skipped.records.map((record) => record.test.n)).not.toContain(
        "delivery > drives",
      );
      expect(skipped.logged).toContain("drives");
    });

    it("skips every test a listed group holds", () => {
      expect(outcomes(skipped.listed)).toMatchObject({
        "bakery > pantry > stocks flour": "skip",
        "closed shop > opens": "skip",
      });
    });

    it("records a test's own skip inside a listed group", () => {
      expect(outcomes(skipped.records)).toMatchObject({
        "bakery > pantry > orders yeast": "skip",
      });
      expect(skipped.listed.map((record) => record.test.n)).not.toContain(
        "bakery > pantry > orders yeast",
      );
    });

    it("runs no hook of a group none of whose tests run", () => {
      expect(skipped.logged).not.toContain("pantry beforeAll");
      expect(skipped.logged).not.toContain("pantry afterAll");
      expect(skipped.logged).not.toContain("closed shop beforeAll");
      expect(skipped.output).toMatch(/closed shop \.\.\. ignored/);
    });

    it("runs the hooks of a group some of whose tests run", () => {
      expect(skipped.logged).toContain("glaze beforeAll");
      expect(skipped.logged).toContain("sets");
    });

    it("runs every test it does not list, whatever it lists for other files", () => {
      expect(outcomes(skipped.records)).toMatchObject({
        "bakery > bakes bread": "pass",
        "delivery > loads the van": "pass",
      });
      expect(skipped.logged).toContain("bakes bread");
    });
  });

  it("refuses a skip list that is not one", async () => {
    const refused = await run(`${FIXTURES}/refused-skip-list.fixture.ts`, {
      skips: "[]",
    });
    expect(refused.logged).toEqual([
      expect.stringMatching(/^refused: the skip list .* is not one$/),
    ]);
  });

  it("runs each installed wrapper around each suite, the first outermost", async () => {
    const wrapped = await run(`${FIXTURES}/wrappers.fixture.ts`);
    expect(wrapped.code).toBe(0);
    expect(wrapped.logged).toEqual([
      "outer wrapper enters",
      "inner wrapper enters",
      "first",
      "second",
      "inner wrapper leaves",
      "outer wrapper leaves",
      "outer wrapper enters",
      "inner wrapper enters",
      "alone",
      "inner wrapper leaves",
      "outer wrapper leaves",
    ]);
  });

  it("refuses a registration made while tests run", async () => {
    const late = await run(`${FIXTURES}/late-registration.fixture.ts`);
    expect(outcomes(late.records)).toMatchObject({
      "late > registers another test while running": "fail",
      "late > declares a suite inside a describe": "pass",
      "nests": "fail",
    });
    const messages = [...late.failures.values()].join("\n");
    expect(messages).toContain("it() was called while tests were running");
    expect(messages).toContain(
      "describe() was called while tests were running",
    );
  });

  it("refuses a describe body that returns a promise", async () => {
    const refused = await run(`${FIXTURES}/async-describe.fixture.ts`);
    expect(refused.logged).toEqual([
      expect.stringContaining("returned a value"),
    ]);
    const names = [...refused.registered.values()].flatMap((set) => [...set]);
    expect(names.filter((name) => name.startsWith("waits"))).toEqual([]);
  });

  it("refuses test() inside a describe", async () => {
    const refused = await run(`${FIXTURES}/test-in-describe.fixture.ts`);
    expect(refused.logged).toEqual([
      expect.stringContaining("test() declares a suite of its own"),
    ]);
  });

  it("records a failure a wrapper throws as the suite's", async () => {
    const ran = await run(`${FIXTURES}/failing-wrapper.fixture.ts`);
    expect(ran.code).not.toBe(0);
    expect(outcomes(ran.records)).toMatchObject({
      "wrapped": "fail",
      "wrapped > passes inside": "pass",
      "alone": "fail",
    });
    expect([...ran.failures.values()].join("\n")).toContain(
      "the wrapper found something wrong",
    );
  });

  it("fails a suite whose wrapper hides what it threw", async () => {
    const ran = await run(`${FIXTURES}/failing-wrapper.fixture.ts`, {
      env: { FIXTURE_CASE: "swallows" },
    });
    expect(ran.code).not.toBe(0);
    expect(outcomes(ran.records)).toMatchObject({ "throws": "fail" });
  });

  it("fails a suite whose wrapper never runs it", async () => {
    const ran = await run(`${FIXTURES}/failing-wrapper.fixture.ts`, {
      env: { FIXTURE_CASE: "skips" },
    });
    expect(ran.code).not.toBe(0);
    expect(outcomes(ran.records)).toEqual({
      "wrapped": "fail",
      "alone": "fail",
    });
    expect([...ran.failures.values()].join("\n")).toContain(
      "ran its suite 0 times",
    );
  });

  it("records a failure the file's own setup throws once, under the file's name", async () => {
    // The suites never run, so they record nothing; Deno fails each of them.

    const file = `${FIXTURES}/failing-setup.fixture.ts`;
    const ran = await run(file);
    expect(ran.code).not.toBe(0);
    expect(outcomes(ran.records)).toEqual({ [file]: "fail" });
    expect([...ran.failures.values()]).toEqual([
      expect.stringContaining("the file's setup failed"),
    ]);
    expect(ran.logged).toEqual(["file afterAll"]);
  });

  it("fails the run whose file's setup throws, though a filter leaves it no test", async () => {
    const file = `${FIXTURES}/failing-setup.fixture.ts`;
    const ran = await run(file, { flags: ["--filter", "nothing matches"] });
    expect(ran.code).not.toBe(0);
    expect(outcomes(ran.records)).toEqual({ [file]: "fail" });
  });

  it("runs none of a file's own hooks where the skip list leaves it no test", async () => {
    const file = `${FIXTURES}/failing-setup.fixture.ts`;
    const ran = await run(file, { skips: { [file]: ["suite", "alone"] } });
    expect(ran.logged).toEqual([]);
    expect(ran.records).toEqual([]);
  });

  it("runs the file's own setup with the file's permissions, whichever test runs first", async () => {
    const ran = await run(`${FIXTURES}/permissions.fixture.ts`);
    expect(ran.code).toBe(0);
    expect(outcomes(ran.records)).toEqual({
      "narrows its permissions": "pass",
      "keeps its permissions": "pass",
    });
  });

  it("records a failure the file's own teardown throws under the file's name", async () => {
    const file = `${FIXTURES}/failing-teardown.fixture.ts`;
    const ran = await run(file);
    expect(ran.code).not.toBe(0);
    // The file's setup passed, and the group holding it and the teardown
    // is recorded once.
    expect(ran.records.map((record) => record.test.n).sort()).toEqual(
      [file, "one"].sort(),
    );
    expect(outcomes(ran.records)).toEqual({ "one": "pass", [file]: "fail" });
    expect([...ran.failures.values()]).toEqual([
      expect.stringContaining("the file's teardown failed"),
    ]);
  });

  describe("an error a test leaves uncaught", () => {
    const file = `${FIXTURES}/uncaught.fixture.ts`;
    const scenario = (name: string) =>
      run(file, { env: { FIXTURE_CASE: name } });

    it("fails the test that left it, after it returns", async () => {
      const ran = await scenario("test");
      expect(ran.code).not.toBe(0);
      expect(outcomes(ran.records)).toEqual({
        "rejects without awaiting": "fail",
      });
      expect([...ran.failures.values()].join("\n")).toContain(
        "nobody awaited this",
      );
    });

    it("fails the test that left it inside a describe, and not the next", async () => {
      const ran = await scenario("step");
      expect(outcomes(ran.records)).toMatchObject({
        "group > rejects without awaiting": "fail",
      });
      expect(outcomes(ran.records)["group > after"]).not.toBe("fail");
      expect(ran.records.map((record) => record.test.n)).not.toContain(
        "group",
      );
    });

    it("fails the test that left it after another test hung", async () => {
      const ran = await scenario("after-hang");
      expect(outcomes(ran.records)).toEqual({
        "waits forever": "fail",
        "rejects without awaiting": "fail",
      });
    });

    it("charges nothing that arrives later to a test Deno gave up on", async () => {
      const ran = await scenario("abandoned");
      expect(outcomes(ran.records)).toEqual({
        "waits forever": "fail",
        "leaves a promise to reject later": "pass",
        [file]: "fail",
      });
      const failures = [...ran.failures.entries()];
      expect(
        failures.find(([record]) => record.test.n === file)?.[1],
      ).toContain("rejected while no test ran");
      expect(
        failures.find(([record]) => record.test.n === "waits forever")?.[1],
      ).not.toContain("rejected while no test ran");
    });

    it("fails the file's own group where the file's setup left it", async () => {
      // Whether Deno ends the file over the error before its test runs is
      // Deno's to decide; the test is not charged with it either way.
      const ran = await scenario("setup");
      expect(outcomes(ran.records)[file]).toBe("fail");
      expect(outcomes(ran.records)["one"]).not.toBe("fail");
      expect([...ran.failures.values()].join("\n")).toContain(
        "the setup left this",
      );
    });

    it("fails the file's own group where it arrives while no test runs", async () => {
      const ran = await scenario("between");
      expect(ran.code).not.toBe(0);
      expect(outcomes(ran.records)).toEqual({
        "leaves a promise to reject later": "pass",
        [file]: "fail",
      });
      expect([...ran.failures.values()].join("\n")).toContain(
        "rejected while no test ran",
      );
    });

    it("fails the file's own group where it arrives as the file ends", async () => {
      const ran = await scenario("late");
      expect(ran.records.map((record) => record.test.n).sort()).toEqual(
        [file, "one"].sort(),
      );
      expect(outcomes(ran.records)).toEqual({ "one": "pass", [file]: "fail" });
      expect(ran.hooks.length).toBe(1);
      expect([...ran.failures.values()].join("\n")).toContain(
        "thrown as the file ended",
      );
    });

    it("fails the file's own group where its setup never settles", async () => {
      const ran = await scenario("setup-hangs");
      expect(ran.code).not.toBe(0);
      expect(outcomes(ran.records)).toEqual({ [file]: "fail" });
    });

    it("fails the file's own group where its teardown never settles", async () => {
      const ran = await scenario("teardown-hangs");
      expect(ran.code).not.toBe(0);
      expect(outcomes(ran.records)).toEqual({ "one": "pass", [file]: "fail" });
    });

    it("fails the group whose setup left it, not the group's first test", async () => {
      const ran = await scenario("group-setup");
      expect(outcomes(ran.records)["group"]).toBe("fail");
      expect(outcomes(ran.records)["group > is innocent"]).not.toBe("fail");
    });

    it("leaves the file's own group passed where the file is killed after its setup", async () => {
      const ran = await scenario("killed");
      expect(ran.code).not.toBe(0);
      expect(ran.records).toEqual([]);
      expect(ran.hooks.map((record) => record.outcome)).toEqual(["pass"]);
    });

    it("fails nothing where the file handles what arrives as it ends", async () => {
      const ran = await scenario("late-handled");
      expect(outcomes(ran.records)[file]).not.toBe("fail");
      expect([...ran.failures.values()].join("\n")).not.toContain(
        "handled as the file ended",
      );
    });

    it("fails only the test that hung, not the groups around it", async () => {
      const ran = await scenario("nested-hang");
      expect(outcomes(ran.records)).toEqual({
        "outer > inner > waits forever": "fail",
      });
    });

    it("fails a group whose hook never settles", async () => {
      const ran = await scenario("group-hangs");
      expect(outcomes(ran.records)).toEqual({
        "group > passes": "pass",
        "group": "fail",
      });
    });

    it("fails nothing where the file handles it", async () => {
      const ran = await scenario("handled");
      expect(ran.code).toBe(0);
      expect(outcomes(ran.records)).toEqual({
        "handles its own rejection": "pass",
        "after": "pass",
      });
    });
  });

  it("fails a step still running when its test throws", async () => {
    const ran = await run(`${FIXTURES}/steps.fixture.ts`, {
      env: { FIXTURE_CASE: "throws" },
    });
    expect(outcomes(ran.records)).toMatchObject({
      "throws with a step running": "fail",
      "throws with a step running > never awaited": "fail",
    });
    expect([...ran.failures.values()].join("\n")).toContain("the test threw");
  });

  it("records a test whose every step it skipped as a test that passed", async () => {
    const ran = await run(`${FIXTURES}/steps.fixture.ts`, {
      env: { FIXTURE_CASE: "skipped" },
    });
    expect(outcomes(ran.records)).toEqual({
      "skips every step": "pass",
      "skips every step > skipped": "skip",
    });
  });

  it("fails a step Deno fails without running it", async () => {
    const ran = await run(`${FIXTURES}/steps.fixture.ts`, {
      env: { FIXTURE_CASE: "together" },
    });
    expect(outcomes(ran.records)).toMatchObject({
      "runs two steps at once > fast": "fail",
    });
    expect([...ran.failures.values()].join("\n")).toContain(
      "without running it",
    );
  });

  it("charges nothing to a step its test left behind", async () => {
    const ran = await run(`${FIXTURES}/steps.fixture.ts`, {
      env: { FIXTURE_CASE: "orphan" },
    });
    const failures = [...ran.failures.entries()];
    expect(
      failures.find(([record]) => record.test.n === "rejects while it settles")
        ?.[1],
    ).toContain("this test left this");
    expect(
      failures.find(([record]) =>
        record.test.n === "leaves a step behind > slow"
      )?.[1],
    ).toContain("returned first");
  });

  it("registers nothing for a file an error stopped as it loaded", async () => {
    const file = `${FIXTURES}/loading.fixture.ts`;
    // Whether Deno runs the tests the file registered before it stopped is
    // Deno's to decide; either way the file names nothing it holds.
    const ran = await run(file);
    expect(ran.code).not.toBe(0);
    expect(ran.registered.size).toBe(0);
    expect(outcomes(ran.records)[file]).not.toBe("pass");
  });

  it("names a test by its options, and fails a step given no body", async () => {
    const ran = await run(`${FIXTURES}/steps.fixture.ts`, {
      env: { FIXTURE_CASE: "forms" },
    });
    expect(outcomes(ran.records)).toMatchObject({
      "named by its options": "fail",
    });
    expect([...ran.failures.values()].join("\n")).toContain(
      'step("bodiless") was given no body',
    );
  });

  it("fails a test that returns with a step still running", async () => {
    const ran = await run(`${FIXTURES}/steps.fixture.ts`);
    expect(ran.code).not.toBe(0);
    expect(outcomes(ran.records)).toMatchObject({
      "leaves a step running": "fail",
    });
    expect([...ran.failures.values()].join("\n")).toContain(
      "had not finished when it returned",
    );
    expect(outcomes(ran.records)).toMatchObject({
      "leaves a step running > never awaited": "fail",
    });
  });

  it("refuses a test that turns on a sanitizer", async () => {
    const ran = await run(`${FIXTURES}/sanitizer.fixture.ts`);
    expect(ran.code).not.toBe(0);
    expect(ran.output).toContain("turns on a sanitizer");
    expect(ran.registered.size).toBe(0);
  });

  it("fails a test whose step turns on a sanitizer", async () => {
    const ran = await run(`${FIXTURES}/sanitizer.fixture.ts`, {
      env: { FIXTURE_CASE: "step" },
    });
    expect(outcomes(ran.records)).toEqual({ "runs a step": "fail" });
    expect([...ran.failures.values()].join("\n")).toContain(
      "turns on a sanitizer",
    );
  });

  it("refuses two tests of one name in one group", async () => {
    const ran = await run(`${FIXTURES}/duplicates.fixture.ts`);
    expect(ran.logged).toEqual([
      'refused: two tests or groups are named "group > again"',
    ]);
    expect(outcomes(ran.records)).toEqual({ "group > again": "pass" });
  });

  it("refuses two groups of one name", async () => {
    const ran = await run(`${FIXTURES}/duplicates.fixture.ts`, {
      env: { FIXTURE_CASE: "groups" },
    });
    expect(ran.logged).toEqual([
      'refused: two tests or groups are named "group"',
    ]);
    expect(outcomes(ran.records)).toEqual({ "group > first": "pass" });
  });

  it("refuses a name holding the separator", async () => {
    const ran = await run(`${FIXTURES}/duplicates.fixture.ts`, {
      env: { FIXTURE_CASE: "separator" },
    });
    expect(ran.logged).toEqual([
      expect.stringContaining('refused: "a > b" holds " > "'),
    ]);
    expect(ran.records).toEqual([]);
  });

  it("fails a test that runs two steps of one name", async () => {
    const ran = await run(`${FIXTURES}/duplicates.fixture.ts`, {
      env: { FIXTURE_CASE: "step" },
    });
    expect(outcomes(ran.records)).toEqual({
      "runs steps": "fail",
      "runs steps > again": "pass",
    });
    expect([...ran.failures.values()].join("\n")).toContain(
      'two tests or groups are named "runs steps > again"',
    );
  });

  describe("a test file outside the repository, read with no permission to resolve it", () => {
    // Whether the file is in the repository by another path takes resolving
    // symbolic links, which needs read permission.
    const outside = async (env: Record<string, string>) => {
      const dir = await Deno.makeTempDir({ prefix: "registration-outside-" });
      temporary.push(dir);
      const file = join(dir, "outside.test.ts");
      const module = toFileUrl(join(ROOT, "base/test-support/src/testing.ts"));
      await Deno.writeTextFile(
        file,
        // The module is loaded where a refusal can be caught and logged, so
        // that the file ends as any other does.
        `try {\n  const { test } = await import("${module}");\n` +
          `  test("runs", () => {});\n` +
          `} catch (error) {\n  console.log("LOG refused: " + error.name);\n}\n`,
      );
      const result = await runDenoCommandWithTemporaryLock({
        root: ROOT,
        args: (lock) => [
          "test",
          "--no-check",
          "--allow-env",
          `--lock=${lock}`,
          "--frozen",
          file,
        ],
        env: { NO_COLOR: "1", ...env },
      });
      return {
        code: result.code,
        output: new TextDecoder().decode(result.stdout) +
          new TextDecoder().decode(result.stderr),
      };
    };

    it("runs where nothing is to be recorded", async () => {
      const ran = await outside({});
      expect(ran.output).toContain("runs ... ok");
      expect(ran.code).toBe(0);
    });

    it("refuses to load where its results are to be recorded", async () => {
      const ran = await outside({ CF_TEST_RECORDS_DIR: "/nonexistent" });
      expect(ran.output).toContain("LOG refused: NotCapable");
      expect(ran.output).not.toContain("runs ... ok");
    });
  });

  it("records nothing for a test a filter leaves out that would have run", async () => {
    const file = `${FIXTURES}/suites.fixture.ts`;
    const ran = await run(file, { flags: ["--filter", "invoice"] });
    expect(outcomes(ran.records)).toEqual({ "invoice": "pass" });
  });

  it("records a test Deno gave up on as failed", async () => {
    const ran = await run(`${FIXTURES}/unfinished.fixture.ts`);
    expect(ran.code).not.toBe(0);
    expect(outcomes(ran.records)).toEqual({
      "stuck > waits forever": "fail",
      "after": "pass",
    });
    expect(
      ran.failures.get(
        ran.records.find((record) =>
          record.test.n === "stuck > waits forever"
        )!,
      ),
    ).toBe("Deno moved on before this finished");
  });

  it("records each test of a file once, though a test's Deno.exit() unloads it twice", async () => {
    const file = `${FIXTURES}/exit.fixture.ts`;
    const ran = await run(file);
    expect(ran.code).not.toBe(0);
    expect(outcomes(ran.records)).toEqual({
      "exits": "fail",
      "passes": "pass",
    });
    expect(ran.hooks.map((record) => [record.test.n, record.outcome])).toEqual(
      [[file, "pass"]],
    );
  });

  it("fails the test that left an error after a test's Deno.exit(), and not the file", async () => {
    const file = `${FIXTURES}/exit.fixture.ts`;
    const ran = await run(file, { env: { FIXTURE_CASE: "rejects" } });
    expect(ran.code).not.toBe(0);
    expect(outcomes(ran.records)).toEqual({
      "exits": "fail",
      "rejects without awaiting": "fail",
    });
    expect(
      ran.failures.get(
        ran.records.find((record) =>
          record.test.n === "rejects without awaiting"
        )!,
      ),
    ).toContain("nobody awaited this");
    expect(ran.hooks.map((record) => [record.test.n, record.outcome])).toEqual(
      [[file, "pass"]],
    );
  });

  it("hands a browser page's Deno.test each test as given, and refuses suites there", async () => {
    const ran = await run(`${FIXTURES}/browser.fixture.ts`);
    expect(ran.code).toBe(0);
    const refusal = "runs only under deno test; in a browser, use test() alone";
    expect(ran.logged).toEqual([
      `refused: describe() ${refusal}`,
      `refused: it() ${refusal}`,
      `refused: beforeAll() ${refusal}`,
      "registered runs as given",
      "registered is ignored (ignored)",
      "ran runs as given",
    ]);
    // A page has no run records, so nothing of its tests is recorded.
    expect(ran.records).toEqual([]);
    expect(ran.registered.size).toBe(0);
  });

  it("names the file of a test run through a symbolic link to the repository", async () => {
    const dir = await Deno.makeTempDir({ prefix: "registration-link-" });
    temporary.push(dir);
    const link = join(dir, "labs");
    await Deno.symlink(ROOT, link);
    const file = `${FIXTURES}/mapped.fixture.ts`;
    const ran = await run(join(link, file));
    expect(ran.code).toBe(0);
    expect(ran.records).toEqual([
      expect.objectContaining({
        test: expect.objectContaining({ n: "found" }),
        file,
      }),
    ]);
  });

  it("records nothing for a test file outside the repository", async () => {
    const dir = await Deno.makeTempDir({ prefix: "registration-outside-" });
    temporary.push(dir);
    const module =
      toFileUrl(join(ROOT, "base/test-support/src/testing.ts")).href;
    const source = (await Deno.readTextFile(
      join(ROOT, FIXTURES, "wrappers.fixture.ts"),
    )).replace('"../../src/testing.ts"', JSON.stringify(module));
    const outside = join(dir, "outside.test.ts");
    await Deno.writeTextFile(outside, source);
    const ran = await run(outside);
    expect(ran.code).toBe(0);
    expect(ran.logged).toContain("alone");
    expect(ran.records).toEqual([]);
    expect(ran.registered.size).toBe(0);
  });
});
