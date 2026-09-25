/**
 * The registration preload, exercised the way a test job exercises it: a
 * real `deno test` run over fixture files, with the preload loaded and a
 * skip list in place. What this proves cannot be proven in-process,
 * because installing the capture replaces `Deno.test` for good.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  dropContainerCases,
  ingestJUnit,
  parseJUnit,
  preloadModulePath,
  readNameMaps,
  RECORDS_DIR_VARIABLE,
  serializeSkipList,
  SKIP_LIST_VARIABLE,
  type SkipList,
} from "../../src/records/mod.ts";

/**
 * The imports a fixture tree needs to resolve the preload's own modules.
 * `@std/testing/bdd` points at this repository's re-export exactly as the
 * root import map does, so a fixture exercises the wrapper a real test
 * file goes through rather than the module underneath it.
 */
const FIXTURE_CONFIG = {
  imports: {
    "@std/path": "jsr:@std/path@^1.1.6",
    "@std/testing": "jsr:@std/testing@^1.0.19",
    "@std/testing/bdd": new URL("../../src/records/bdd.ts", import.meta.url)
      .href,
    "@std/testing/bdd/real": "jsr:@std/testing@^1.0.19/bdd",
    "@std/ulid": "jsr:@std/ulid@^1.0.0",
  },
};

interface Fixture {
  dir: string;

  /**
   * The directory the run happens in, which is the fixture root unless
   * one was named. A workspace member's test task runs in the member's
   * own directory, and the file names a run reports are relative to it.
   */
  runIn: string;

  spool: string;
  junit: string;
}

/**
 * A tree that looks like a repository to the preload: the `.git` marker is
 * what it climbs to, so a fixture needs one and needs nothing else.
 */
async function makeFixture(
  files: Record<string, string>,
  runIn = ".",
): Promise<Fixture> {
  const dir = await Deno.makeTempDir({ prefix: "preload-fixture-" });
  await Deno.mkdir(join(dir, ".git"));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(FIXTURE_CONFIG),
  );
  for (const [name, source] of Object.entries(files)) {
    const path = join(dir, name);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, source);
  }
  const spool = join(dir, "spool");
  await Deno.mkdir(spool);
  const runDir = join(dir, runIn);
  await Deno.mkdir(runDir, { recursive: true });
  return { dir, runIn: runDir, spool, junit: join(dir, "report.xml") };
}

/** What a fixture run carries beyond the files it is given. */
interface RunOptions {
  /**
   * The skip list the run carries, either as a list or as the text of a
   * file that is meant not to parse as one. Without it the run carries
   * no skip list at all.
   */
  skips?: SkipList | string;

  /**
   * Modules preloaded ahead of the records preload, which is how a
   * module reaches the process before that preload does.
   */
  before?: readonly string[];

  /**
   * Whether the run may write, and so whether the preload has a spool it
   * can leave a name map in. True unless a test says otherwise.
   */
  write?: boolean;
}

/**
 * Runs a fixture tree. It is the only place in this file that starts a
 * process, so that every fixture is given the same environment.
 *
 * A process inherits the environment of the process that started it, and
 * a lane runs this file with a skip list of its own. A skip list is one
 * of the two things that make the preload wrap `Deno.test`, so a fixture
 * is given both variables the preload reads, and an empty value — which
 * both read as unset — for whichever of them its test wants none of.
 *
 * The run carries no `--quiet`, so that what the preload writes reaches
 * `output()`, which two of the cases below read their assertion out of.
 */
async function runFixture(
  fixture: Fixture,
  files: readonly string[],
  options: RunOptions = {},
): Promise<Deno.CommandOutput> {
  const { before = [], skips, write = true } = options;
  const env: Record<string, string> = {
    [RECORDS_DIR_VARIABLE]: fixture.spool,
    [SKIP_LIST_VARIABLE]: "",
  };
  if (skips !== undefined) {
    const path = join(fixture.dir, "skips.json");
    await Deno.writeTextFile(
      path,
      typeof skips === "string" ? skips : serializeSkipList(skips),
    );
    env[SKIP_LIST_VARIABLE] = path;
  }
  return await new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--allow-read",
      ...(write ? ["--allow-write"] : []),
      "--allow-env",
      ...before.map((module) => `--preload=${module}`),
      `--preload=${preloadModulePath()}`,
      `--junit-path=${fixture.junit}`,
      ...files,
    ],
    cwd: fixture.runIn,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
}

/** Returns everything a run wrote, in the order a reader would see it. */
function output(run: Deno.CommandOutput): string {
  const decoder = new TextDecoder();
  return decoder.decode(run.stdout) + decoder.decode(run.stderr);
}

/** The leaf cases a run reported, by name, with their outcomes. */
async function outcomes(
  fixture: Fixture,
): Promise<Map<string, "pass" | "fail" | "skip">> {
  const xml = await Deno.readTextFile(fixture.junit);
  const leaves = dropContainerCases(parseJUnit(xml));
  return new Map(leaves.map((leaf) => [leaf.name, leaf.outcome]));
}

const BDD_FILE = `import { describe, it } from "@std/testing/bdd";
describe("outer", () => {
  it("kept", () => {});
  it("dropped", () => {});
});
`;

const NESTED_BDD_FILE = `import { describe, it } from "@std/testing/bdd";
describe("outer", () => {
  describe("inner", () => {
    it("kept", () => {});
    it("dropped", () => {});
  });
});
`;

const ADDED_LEAF_FILE = `import { describe, it } from "@std/testing/bdd";
describe("outer", () => {
  it("kept", () => {});
  it("dropped", () => {});
  it("added later", () => {});
});
`;

const OTHER_BDD_FILE = `import { describe, it } from "@std/testing/bdd";
describe("elsewhere", () => {
  it("dropped", () => {});
});
`;

// A file naming each suite by the handle `describe` hands back rather
// than by nesting inside it. The runner reports a leaf under the suite
// its call names, so that is the identity the name map has to hold and
// the identity a skip list has to be keyed by.
const HANDLE_BDD_FILE = `import { describe, it } from "@std/testing/bdd";
const outer = describe("outer");
it(outer, "kept", () => {});
const inner = describe(outer, "inner");
it(inner, "dropped", () => {});
describe(inner, "bodied", () => {
  it("nested", () => {});
});
`;

// A file that both declares a hook outside every `describe` and names
// its suites by handle. The root suite the runner invents holds the
// handle-named ones, so the chain each leaf is named by opens with the
// root suite's name and goes on through the suite the call named.
const HOOKED_HANDLE_FILE =
  `import { beforeEach, describe, it } from "@std/testing/bdd";
let ran = 0;
beforeEach(() => {
  ran++;
});
const outer = describe("outer");
it(outer, "kept", () => {
  if (ran === 0) throw new Error("the hook did not run");
});
it(outer, "dropped", () => {});
`;
// A second file opening with the same suite title as BDD_FILE. Nothing
// stops two files sharing one, and several packages have a title every
// one of their files opens with.
const SHARED_TITLE_FILE = `import { describe, it } from "@std/testing/bdd";
describe("outer", () => {
  it("elsewhere", () => {});
});
`;

// A file declaring a hook outside every `describe`. The bdd runner has
// no suite to hold it, so it makes one of its own named `global` and
// every suite the file registers after that is a step inside it, which
// puts that name at the head of each leaf's chain.
const HOOKED_FILE =
  `import { beforeEach, describe, it } from "@std/testing/bdd";
let ran = 0;
beforeEach(() => {
  ran++;
});
describe("hooked", () => {
  it("kept", () => {
    if (ran === 0) throw new Error("the hook did not run");
  });
  it("dropped", () => {});
});
`;

// A second file doing the same, so the run holds two root suites under
// the one name. That name says nothing about either file, and what
// carries a file is the whole chain of each leaf beneath it.
const SECOND_HOOKED_FILE =
  `import { afterEach, describe, it } from "@std/testing/bdd";
afterEach(() => {});
describe("second", () => {
  it("kept", () => {});
});
`;

// A file declaring all six hooks the re-export hands out, inside a
// `describe` rather than outside every one. Each hook writes its own
// name as it fires, so what the file leaves behind is the order the
// runner ran them in, and its leaves are named without a root suite.
const EVERY_HOOK_FILE = `import {
  after,
  afterAll,
  afterEach,
  before,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "@std/testing/bdd";

function note(what: string) {
  Deno.writeTextFileSync("hooks.log", what + " ", {
    append: true,
    create: true,
  });
}

describe("hooks", () => {
  beforeAll(() => note("beforeAll"));
  before(() => note("before"));
  beforeEach(() => note("beforeEach"));
  afterEach(() => note("afterEach"));
  afterAll(() => note("afterAll"));
  after(() => note("after"));
  it("first", () => {});
  it("second", () => {});
});
`;

// A file whose outermost `describe` carries no title of its own. The
// runner names such a suite after the body it was given.
const TITLELESS_FILE = `import { describe, it } from "@std/testing/bdd";
describe(function first() {
  it("kept", () => {});
});
`;

// A second file doing the same, so the run holds two such suites. Each
// is named after its own body, and the two names are different.
const SECOND_TITLELESS_FILE = `import { describe, it } from "@std/testing/bdd";
describe(function second() {
  it("kept", () => {});
});
`;

// A file whose `describe` carries neither a title nor a body with a
// name in it. The suite's name is empty, and the runner is what says
// so.
const NAMELESS_FILE = `import { describe, it } from "@std/testing/bdd";
describe(() => {
  it("kept", () => {});
});
`;

// A file whose leaves carry no name of their own, so each is named
// after its body. One body has a name and the other has none, and the
// runner reports the second under a chain whose last element is empty.
const BODY_NAMED_LEAF_FILE = `import { describe, it } from "@std/testing/bdd";
describe("outer", () => {
  it(function kept() {});
  it(() => {});
});
`;

// A file whose leaf is given an empty name of its own. That name stands
// in place of the body's, so the runner reports the leaf with an empty
// last element and the body's name reaches nothing.
const EMPTY_NAME_LEAF_FILE = `import { describe, it } from "@std/testing/bdd";
describe("emptied", () => {
  it({ name: "", fn: function unused() {} });
});
`;

// A module that registers tests for whichever file calls it, the way a
// shared suite does: leaves inside the caller's own describe, and a
// top-level test named by the caller.
const REGISTRAR = `import { it } from "@std/testing/bdd";
export function leaves(): void {
  it("kept", () => {});
  it("dropped", () => {});
}
export function test(name: string): void {
  Deno.test(name, () => {});
}
`;

/** A test file registering all of its tests through `REGISTRAR`. */
function registeredThrough(title: string): string {
  return `import { describe } from "@std/testing/bdd";
import { leaves, test } from "./registrar.ts";
describe("${title}", () => {
  leaves();
});
test("${title} bare");
`;
}

const BARE_FILE = `Deno.test("bare kept", () => {});
Deno.test("bare dropped", () => {});
`;

// Every way `Deno.test` can be called. The options forms carry the
// sanitizer settings a test needs, and they put the body in the second or
// third argument, so a wrapper that reads only the first two registers a
// definition with no body and Deno refuses the whole module.
const OVERLOAD_FILE = `Deno.test("name and body", () => {});
Deno.test("name, options and body", { sanitizeOps: false }, () => {});
Deno.test({ name: "whole definition", fn: () => {} });
Deno.test({ name: "options and body", sanitizeResources: false }, () => {});
Deno.test({ sanitizeOps: false }, function namedByItsFunction() {});
Deno.test(function bodyAlone() {});
`;

describe("preload", () => {
  it("records the file each test was registered from", async () => {
    const fixture = await makeFixture({
      "bdd.test.ts": BDD_FILE,
      "bare.test.ts": BARE_FILE,
    });
    try {
      const run = await runFixture(fixture, ["bdd.test.ts", "bare.test.ts"]);
      assert(run.success, output(run));
      const names = await readNameMaps(fixture.spool);
      expect(names.get("outer")).toEqual("bdd.test.ts");
      expect(names.get("bare kept")).toEqual("bare.test.ts");
      expect(names.get("bare dropped")).toEqual("bare.test.ts");

      // The join ingestion performs: a leaf named as its describe chain
      // takes the file its top-level registration came from.
      const records = ingestJUnit(await Deno.readTextFile(fixture.junit), {
        kind: "unit",
        scope: "fixture",
        fileByName: names,
      });
      const byName = new Map(records.map((r) => [r.test.n, r.file]));
      expect(byName.get("outer > kept")).toEqual("bdd.test.ts");
      expect(byName.get("bare kept")).toEqual("bare.test.ts");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("places a file above the directory the run happened in", async () => {
    // A workspace member's test task runs in the member's directory and
    // may name a file anywhere in the tree: `packages/test-support` runs
    // the repository tools' own regression tests, two directories above
    // itself. The map says which directory the run happened in, and a
    // read scoped to that directory takes it whole.

    const fixture = await makeFixture({
      "member/own.test.ts": BDD_FILE,
      "tools/away.test.ts": OTHER_BDD_FILE,
    }, "member");
    try {
      const run = await runFixture(fixture, [
        "own.test.ts",
        "../tools/away.test.ts",
      ]);
      assert(run.success, output(run));
      const names = await readNameMaps(fixture.spool, { ranIn: "member" });
      expect(names.get("outer > kept")).toEqual("member/own.test.ts");
      expect(names.get("elsewhere > dropped")).toEqual("tools/away.test.ts");
      // The directory the file sits in is not the directory the run
      // happened in, and a read scoped to it is offered nothing.
      expect((await readNameMaps(fixture.spool, { ranIn: "tools" })).size)
        .toEqual(0);

      // The join ingestion performs, with the prefix the workspace runner
      // passes. Every class name in the report names the wrapper, so the
      // map is the only thing that can place either file.
      const records = ingestJUnit(await Deno.readTextFile(fixture.junit), {
        kind: "unit",
        scope: "fixture",
        filePrefix: "member",
        fileByName: names,
      });
      const byName = new Map(records.map((r) => [r.test.n, r.file]));
      expect(byName.get("outer > kept")).toEqual("member/own.test.ts");
      expect(byName.get("elsewhere > dropped")).toEqual("tools/away.test.ts");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("keeps each leaf's own file where two files share a suite title", async () => {
    const fixture = await makeFixture({
      "bdd.test.ts": BDD_FILE,
      "shared.test.ts": SHARED_TITLE_FILE,
    });
    try {
      const run = await runFixture(fixture, ["bdd.test.ts", "shared.test.ts"]);
      assert(run.success, output(run));
      const names = await readNameMaps(fixture.spool);
      // The title both files register under says nothing about either,
      // so it carries no file; each leaf carries its own.
      expect(names.get("outer")).toBeUndefined();
      expect(names.get("outer > kept")).toEqual("bdd.test.ts");
      expect(names.get("outer > elsewhere")).toEqual("shared.test.ts");

      const records = ingestJUnit(await Deno.readTextFile(fixture.junit), {
        kind: "unit",
        scope: "fixture",
        fileByName: names,
      });
      const byName = new Map(records.map((r) => [r.test.n, r.file]));
      expect(byName.get("outer > kept")).toEqual("bdd.test.ts");
      expect(byName.get("outer > elsewhere")).toEqual("shared.test.ts");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("names a leaf inside the root suite a file-scope hook brings about", async () => {
    const fixture = await makeFixture({
      "hooked.test.ts": HOOKED_FILE,
      "second.test.ts": SECOND_HOOKED_FILE,
      "bdd.test.ts": BDD_FILE,
    });
    try {
      const run = await runFixture(fixture, [
        "hooked.test.ts",
        "second.test.ts",
        "bdd.test.ts",
      ]);
      assert(run.success, output(run));
      const names = await readNameMaps(fixture.spool);
      // Both hooked files register a root suite under the one name, so
      // that name carries no file and each leaf carries its own.
      expect(names.get("global")).toBeUndefined();
      expect(names.get("global > hooked > kept")).toEqual("hooked.test.ts");
      expect(names.get("global > second > kept")).toEqual("second.test.ts");
      // The third file declares no hook, so the runner invents nothing
      // for it and its leaves are named by their own chain.
      expect(names.get("outer > kept")).toEqual("bdd.test.ts");
      expect(names.get("global > outer > kept")).toBeUndefined();

      // The names the report gives those leaves, so the map is joined
      // onto them rather than sitting beside them.
      const records = ingestJUnit(await Deno.readTextFile(fixture.junit), {
        kind: "unit",
        scope: "fixture",
        fileByName: names,
      });
      const byName = new Map(records.map((r) => [r.test.n, r.file]));
      expect(byName.get("global > hooked > kept")).toEqual("hooked.test.ts");
      expect(byName.get("global > second > kept")).toEqual("second.test.ts");
      expect(byName.get("outer > kept")).toEqual("bdd.test.ts");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("hands out each hook, and one inside a describe invents no suite", async () => {
    const fixture = await makeFixture({ "hooks.test.ts": EVERY_HOOK_FILE });
    try {
      const run = await runFixture(fixture, ["hooks.test.ts"]);
      assert(run.success, output(run));

      // The order the runner ran them in. A binding reaching a function
      // other than the one it names moves or drops a line here, which
      // nothing else in this suite would notice.
      const fired = await Deno.readTextFile(join(fixture.dir, "hooks.log"));
      expect(fired.trim().split(" ")).toEqual([
        "beforeAll",
        "before",
        "beforeEach",
        "afterEach",
        "beforeEach",
        "afterEach",
        "afterAll",
        "after",
      ]);

      // The hooks sit inside a `describe`, so the runner has a suite to
      // hold them and invents none of its own.
      const names = await readNameMaps(fixture.spool);
      expect(names.get("hooks > first")).toEqual("hooks.test.ts");
      expect(names.get("global > hooks > first")).toBeUndefined();
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("names a suite whose call carries no title after its body", async () => {
    const fixture = await makeFixture({
      "first.test.ts": TITLELESS_FILE,
      "second.test.ts": SECOND_TITLELESS_FILE,
    });
    try {
      const run = await runFixture(fixture, [
        "first.test.ts",
        "second.test.ts",
      ]);
      assert(run.success, output(run));
      const names = await readNameMaps(fixture.spool);
      expect(names.get("first > kept")).toEqual("first.test.ts");
      expect(names.get("second > kept")).toEqual("second.test.ts");

      // The name the report gives each leaf, which is the body's name and
      // not the wrapper's. A wrapper name would be one name two files
      // share, and neither leaf would carry a file.
      const records = ingestJUnit(await Deno.readTextFile(fixture.junit), {
        kind: "unit",
        scope: "fixture",
        fileByName: names,
      });
      const byName = new Map(records.map((r) => [r.test.n, r.file]));
      expect(byName.get("first > kept")).toEqual("first.test.ts");
      expect(byName.get("second > kept")).toEqual("second.test.ts");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("leaves a suite with no name at all to the runner to refuse", async () => {
    const fixture = await makeFixture({ "nameless.test.ts": NAMELESS_FILE });
    try {
      const run = await runFixture(fixture, ["nameless.test.ts"]);
      expect(run.success).toBe(false);
      // The runner's own report of the call it refused, which is what
      // reaches a reader of the run rather than the wrapper's name.
      const reported = new TextDecoder().decode(run.stdout);
      expect(reported).toContain("The test name can't be empty");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("names a leaf whose call carries no name after its body", async () => {
    const fixture = await makeFixture({
      "leaf.test.ts": BODY_NAMED_LEAF_FILE,
      "empty.test.ts": EMPTY_NAME_LEAF_FILE,
    });
    try {
      const run = await runFixture(fixture, ["leaf.test.ts", "empty.test.ts"]);
      assert(run.success, output(run));
      const names = await readNameMaps(fixture.spool);
      expect(names.get("outer > kept")).toEqual("leaf.test.ts");
      // A body with no name of its own leaves the last element of the
      // chain empty, and so does an empty name the call carries.
      expect(names.get("outer > ")).toEqual("leaf.test.ts");
      expect(names.get("emptied > ")).toEqual("empty.test.ts");
      expect(names.get("emptied > unused")).toBeUndefined();

      // The names the runner reports, which the map has to agree with
      // for a skip list to reach any of these leaves.
      const reported = await outcomes(fixture);
      expect([...reported.keys()].sort()).toEqual([
        "emptied > ",
        "outer > ",
        "outer > kept",
      ]);
      for (const outcome of reported.values()) expect(outcome).toEqual("pass");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("says so when the bdd re-export loaded before it", async () => {
    // Loading the re-export first is what makes it hand back the real
    // `describe` and `it`, and every leaf then reaches the report
    // without reaching the name map. A preload that pulls the re-export
    // in ahead of this one is the way that happens.
    const fixture = await makeFixture({
      "bdd.test.ts": BDD_FILE,
      "early.ts": `import "@std/testing/bdd";\n`,
    });
    try {
      const run = await runFixture(fixture, ["bdd.test.ts"], {
        before: ["./early.ts"],
      });
      assert(run.success, output(run));
      expect(output(run)).toContain(
        "the bdd re-export loaded before this preload",
      );
      // What the warning names: the wrapper around `Deno.test` still
      // sees the suite the describe chain registers, and nothing sees
      // the leaves inside it.
      const names = await readNameMaps(fixture.spool);
      expect(names.get("outer")).toEqual("bdd.test.ts");
      expect(names.get("outer > kept")).toBeUndefined();
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("attributes a test a helper module registered to the file the run was given", async () => {
    const fixture = await makeFixture({
      "registrar.ts": REGISTRAR,
      "one.test.ts": registeredThrough("one"),
      "two.test.ts": registeredThrough("two"),
    });
    try {
      const run = await runFixture(fixture, ["one.test.ts", "two.test.ts"]);
      assert(run.success, output(run));
      const names = await readNameMaps(fixture.spool);
      expect(names.get("one > kept")).toEqual("one.test.ts");
      expect(names.get("one bare")).toEqual("one.test.ts");
      expect(names.get("two > kept")).toEqual("two.test.ts");
      expect(names.get("two bare")).toEqual("two.test.ts");
      expect([...names.values()]).not.toContain("registrar.ts");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("skips a test a helper module registered by the file the run was given", async () => {
    const fixture = await makeFixture({
      "registrar.ts": REGISTRAR,
      "one.test.ts": registeredThrough("one"),
      "two.test.ts": registeredThrough("two"),
    });
    try {
      const run = await runFixture(fixture, ["one.test.ts", "two.test.ts"], {
        skips: { "one.test.ts": ["one > dropped", "one bare"] },
      });
      assert(run.success, output(run));
      const reported = await outcomes(fixture);
      expect(reported.get("one > kept")).toEqual("pass");
      expect(reported.get("one > dropped")).toEqual("skip");
      expect(reported.get("one bare")).toEqual("skip");
      // The other file registered the same leaves through the same
      // module, and the list names nothing of it.
      expect(reported.get("two > dropped")).toEqual("pass");
      expect(reported.get("two bare")).toEqual("pass");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("stops a run that loaded the re-export early and holds a skip list", async () => {
    const fixture = await makeFixture({
      "bdd.test.ts": BDD_FILE,
      "early.ts": `import "@std/testing/bdd";\n`,
    });
    try {
      const run = await runFixture(fixture, ["bdd.test.ts"], {
        before: ["./early.ts"],
        skips: { "bdd.test.ts": ["outer > dropped"] },
      });
      // A skip list says what this invocation is not to run, and nothing
      // reaches inside a describe chain to apply it, so the run ends
      // rather than running the leaf it was told to leave alone.
      expect(run.success).toBe(false);
      expect(output(run)).toContain(
        "the bdd re-export loaded before this preload",
      );
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("registers every way `Deno.test` can be called", async () => {
    const fixture = await makeFixture({ "overloads.test.ts": OVERLOAD_FILE });
    try {
      const run = await runFixture(fixture, ["overloads.test.ts"]);
      assert(run.success, output(run));
      const reported = await outcomes(fixture);
      expect([...reported.keys()].sort()).toEqual([
        "bodyAlone",
        "name and body",
        "name, options and body",
        "namedByItsFunction",
        "options and body",
        "whole definition",
      ].sort());
      for (const outcome of reported.values()) expect(outcome).toEqual("pass");
      // That each form registers and runs. That the options it carried
      // reach the definition is asserted directly against `asDefinition`
      // in registration.test.ts: Deno's sanitizers do not fire on a leak
      // these bodies could stage, so no outcome here would differ.
      const names = await readNameMaps(fixture.spool);
      expect(names.get("name, options and body")).toEqual("overloads.test.ts");
      expect(names.get("options and body")).toEqual("overloads.test.ts");
      expect(names.get("namedByItsFunction")).toEqual("overloads.test.ts");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("skips a listed test whichever way it was registered", async () => {
    const fixture = await makeFixture({ "overloads.test.ts": OVERLOAD_FILE });
    try {
      const run = await runFixture(fixture, ["overloads.test.ts"], {
        skips: {
          "overloads.test.ts": ["name, options and body", "options and body"],
        },
      });
      assert(run.success, output(run));
      const reported = await outcomes(fixture);
      expect(reported.get("name, options and body")).toEqual("skip");
      expect(reported.get("options and body")).toEqual("skip");
      expect(reported.get("whole definition")).toEqual("pass");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("reports a listed test as skipped rather than missing", async () => {
    const fixture = await makeFixture({ "bare.test.ts": BARE_FILE });
    try {
      const run = await runFixture(fixture, ["bare.test.ts"], {
        skips: { "bare.test.ts": ["bare dropped"] },
      });
      assert(run.success, output(run));
      const reported = await outcomes(fixture);
      expect(reported.get("bare kept")).toEqual("pass");
      expect(reported.get("bare dropped")).toEqual("skip");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("runs an unlisted test whatever the list says of its neighbours", async () => {
    const fixture = await makeFixture({
      "bare.test.ts": BARE_FILE + `Deno.test("added later", () => {});\n`,
    });
    try {
      const run = await runFixture(fixture, ["bare.test.ts"], {
        skips: { "bare.test.ts": ["bare kept", "bare dropped"] },
      });
      assert(run.success, output(run));
      const reported = await outcomes(fixture);
      expect(reported.get("added later")).toEqual("pass");
      expect(reported.get("bare kept")).toEqual("skip");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("skips one leaf of a file by its whole describe chain", async () => {
    const fixture = await makeFixture({ "bdd.test.ts": BDD_FILE });
    try {
      const run = await runFixture(fixture, ["bdd.test.ts"], {
        skips: { "bdd.test.ts": ["outer > dropped"] },
      });
      assert(run.success, output(run));
      const reported = await outcomes(fixture);
      expect(reported.get("outer > kept")).toEqual("pass");
      expect(reported.get("outer > dropped")).toEqual("skip");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("skips a leaf whose name is the empty one its body gave it", async () => {
    const fixture = await makeFixture({ "leaf.test.ts": BODY_NAMED_LEAF_FILE });
    try {
      const run = await runFixture(fixture, ["leaf.test.ts"], {
        skips: { "leaf.test.ts": ["outer > "] },
      });
      assert(run.success, output(run));
      const reported = await outcomes(fixture);
      expect(reported.get("outer > ")).toEqual("skip");
      expect(reported.get("outer > kept")).toEqual("pass");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("skips a leaf under the root suite by the name it is reported as", async () => {
    const fixture = await makeFixture({ "hooked.test.ts": HOOKED_FILE });
    try {
      const run = await runFixture(fixture, ["hooked.test.ts"], {
        skips: { "hooked.test.ts": ["global > hooked > dropped"] },
      });
      assert(run.success, output(run));
      const reported = await outcomes(fixture);
      expect(reported.get("global > hooked > kept")).toEqual("pass");
      expect(reported.get("global > hooked > dropped")).toEqual("skip");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("names a nested leaf by the whole chain that encloses it", async () => {
    const fixture = await makeFixture({ "nested.test.ts": NESTED_BDD_FILE });
    try {
      const run = await runFixture(fixture, ["nested.test.ts"], {
        skips: { "nested.test.ts": ["outer > inner > dropped"] },
      });
      assert(run.success, output(run));
      const reported = await outcomes(fixture);
      expect(reported.get("outer > inner > kept")).toEqual("pass");
      expect(reported.get("outer > inner > dropped")).toEqual("skip");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("names a leaf by the suite its call names rather than encloses it", async () => {
    const fixture = await makeFixture({ "handle.test.ts": HANDLE_BDD_FILE });
    try {
      const run = await runFixture(fixture, ["handle.test.ts"], {
        skips: { "handle.test.ts": ["outer > inner > dropped"] },
      });
      assert(run.success, output(run));
      // A skip list keyed by the name the report gives leaves the leaf
      // out, which it can only do if the two are the same identity.
      const reported = await outcomes(fixture);
      expect(reported.get("outer > kept")).toEqual("pass");
      expect(reported.get("outer > inner > dropped")).toEqual("skip");
      expect(reported.get("outer > inner > bodied > nested")).toEqual("pass");
      const names = await readNameMaps(fixture.spool);
      expect(names.get("outer > kept")).toEqual("handle.test.ts");
      expect(names.get("outer > inner > dropped")).toEqual("handle.test.ts");
      expect(names.get("outer > inner > bodied > nested"))
        .toEqual("handle.test.ts");

      // The map's name and the report's name meeting is what carries the
      // file through: a leaf recorded under a name no runner reports
      // reaches ingestion with none.
      const records = ingestJUnit(await Deno.readTextFile(fixture.junit), {
        kind: "unit",
        scope: "fixture",
        fileByName: names,
      });
      const byName = new Map(records.map((r) => [r.test.n, r.file]));
      expect(byName.get("outer > kept")).toEqual("handle.test.ts");
      expect(byName.get("outer > inner > dropped")).toEqual("handle.test.ts");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("names a handle's leaf inside the root suite a hook brings about", async () => {
    const fixture = await makeFixture({ "both.test.ts": HOOKED_HANDLE_FILE });
    try {
      const run = await runFixture(fixture, ["both.test.ts"], {
        skips: { "both.test.ts": ["global > outer > dropped"] },
      });
      assert(run.success, output(run));
      const reported = await outcomes(fixture);
      expect(reported.get("global > outer > kept")).toEqual("pass");
      expect(reported.get("global > outer > dropped")).toEqual("skip");
      const names = await readNameMaps(fixture.spool);
      expect(names.get("global > outer > kept")).toEqual("both.test.ts");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });
  it("skips independently in two files holding the same leaf name", async () => {
    const fixture = await makeFixture({
      "bdd.test.ts": BDD_FILE,
      "other.test.ts": OTHER_BDD_FILE,
    });
    try {
      const run = await runFixture(fixture, ["bdd.test.ts", "other.test.ts"], {
        skips: { "bdd.test.ts": ["outer > dropped"] },
      });
      assert(run.success, output(run));
      const reported = await outcomes(fixture);
      expect(reported.get("outer > dropped")).toEqual("skip");
      expect(reported.get("elsewhere > dropped")).toEqual("pass");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("runs an unlisted leaf a pull request just added", async () => {
    const fixture = await makeFixture({
      "bdd.test.ts": ADDED_LEAF_FILE,
    });
    try {
      const run = await runFixture(fixture, ["bdd.test.ts"], {
        skips: { "bdd.test.ts": ["outer > kept", "outer > dropped"] },
      });
      assert(run.success, output(run));
      const reported = await outcomes(fixture);
      expect(reported.get("outer > added later")).toEqual("pass");
      expect(reported.get("outer > kept")).toEqual("skip");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("runs a renamed test, since the new name is not the old", async () => {
    const fixture = await makeFixture({
      "bare.test.ts": `Deno.test("the new name", () => {});\n`,
    });
    try {
      const run = await runFixture(fixture, ["bare.test.ts"], {
        skips: { "bare.test.ts": ["the old name"] },
      });
      assert(run.success, output(run));
      expect((await outcomes(fixture)).get("the new name")).toEqual("pass");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("skips one file's copy of a shared test name and not the other", async () => {
    const shared = `Deno.test("shared name", () => {});\n`;
    const fixture = await makeFixture({
      "one.test.ts": shared,
      "two.test.ts": shared,
    });
    try {
      const run = await runFixture(fixture, ["one.test.ts", "two.test.ts"], {
        skips: { "one.test.ts": ["shared name"] },
      });
      assert(run.success, output(run));
      // The report names both by the same identity, so the pair is one
      // passed case and one skipped one under that name.
      const xml = await Deno.readTextFile(fixture.junit);
      const leaves = dropContainerCases(parseJUnit(xml))
        .filter((leaf) => leaf.name === "shared name")
        .map((leaf) => leaf.outcome)
        .sort();
      expect(leaves).toEqual(["pass", "skip"]);
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("leaves the report alone when it has nothing to do", async () => {
    const fixture = await makeFixture({
      "bdd.test.ts": BDD_FILE,
      "bare.test.ts": BARE_FILE,
    });
    try {
      // No write permission and no skip list, so `Deno.test` is left
      // alone and the report keeps its own class names. The bdd
      // re-export hands back the real `describe` and `it` where there is
      // no capture, so a bdd file's class name is the file too, and both
      // kinds of leaf carry one without a name map to join onto.
      const run = await runFixture(fixture, ["bdd.test.ts", "bare.test.ts"], {
        write: false,
      });
      assert(run.success, output(run));
      expect((await readNameMaps(fixture.spool)).size).toEqual(0);
      const records = ingestJUnit(await Deno.readTextFile(fixture.junit), {
        kind: "unit",
        scope: "fixture",
        filePrefix: "",
      });
      const byName = new Map(records.map((r) => [r.test.n, r.file]));
      expect(byName.get("outer > kept")).toEqual("bdd.test.ts");
      expect(byName.get("bare kept")).toEqual("bare.test.ts");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("runs everything when the skip list is malformed", async () => {
    const fixture = await makeFixture({ "bare.test.ts": BARE_FILE });
    try {
      const run = await runFixture(fixture, ["bare.test.ts"], {
        skips: "not a skip list",
      });
      assert(run.success, output(run));
      // The warning is what tells a reader that the file was read and
      // refused, rather than never reaching the preload at all.
      expect(output(run)).toContain("is malformed");
      const reported = await outcomes(fixture);
      expect(reported.get("bare kept")).toEqual("pass");
      expect(reported.get("bare dropped")).toEqual("pass");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("runs a test the skip list of the run that started it names", async () => {
    // A process inherits the environment of the process that started it,
    // and a lane runs this file with a skip list of its own. What an
    // invocation is not to run is what its own environment names, so the
    // list a fixture inherits reaches none of its tests.

    const fixture = await makeFixture({ "bare.test.ts": BARE_FILE });
    const outside = Deno.env.get(SKIP_LIST_VARIABLE);
    try {
      const path = join(fixture.dir, "outside.json");
      await Deno.writeTextFile(
        path,
        serializeSkipList({ "bare.test.ts": ["bare kept"] }),
      );
      Deno.env.set(SKIP_LIST_VARIABLE, path);
      const run = await runFixture(fixture, ["bare.test.ts"]);
      assert(run.success, output(run));
      const reported = await outcomes(fixture);
      expect(reported.get("bare kept")).toEqual("pass");
      expect(reported.get("bare dropped")).toEqual("pass");
      // What the fixture is given is an empty value, which the preload
      // reads as no skip list rather than as a file at the empty path.
      expect(output(run)).not.toContain("cannot read the skip list");
    } finally {
      if (outside === undefined) Deno.env.delete(SKIP_LIST_VARIABLE);
      else Deno.env.set(SKIP_LIST_VARIABLE, outside);
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });
});
