/**
 * How every test file in this repository registers its tests: `describe`,
 * `it` and the hooks for tests grouped into suites, and `test` for a test
 * on its own.
 *
 * Each top-level `describe`, `it` or `test` is one suite, registered as one
 * `Deno.test`. The tests a `describe` holds, and the `describe`s nested in
 * it, are steps of that suite, run in the order they were declared. A
 * test's name is the names of the `describe`s enclosing it and its own,
 * joined with `" > "`, which is its identity in the run-record store; a
 * step a test runs through its context is named the same way, inside the
 * test.
 *
 * The module does three things a test runner left to itself does not:
 *
 * - It skips the tests the run's skip list names (`CF_TEST_SKIP_LIST`,
 *   `./records/skip-list.ts`). A skipped test is still registered, as
 *   ignored, so it shows in the output. A `describe` none of whose tests
 *   will run does not run its `beforeAll` or `afterAll`, and a suite none
 *   of whose tests will run is ignored as a whole. A step runs whenever
 *   its test does, since the steps before it may have set up what it
 *   reads; one the list names is reported as listed.
 * - It reports what each test file registered, and how each test went, to
 *   the run's spool (`CF_TEST_RECORDS_DIR`, `./records/results.ts`), a line
 *   as each test finishes.
 * - It runs whatever a test package installs with `wrapSuites()` around
 *   each suite, which is how a package gives its tests a fake clock.
 *
 * Deno gives each test file a realm of its own, so the state below is one
 * file's.
 *
 * A file that runs in a browser as well, through `deno-web-test`, uses
 * `test` alone: there `Deno` is the page's harness, which offers nothing but
 * `Deno.test`, and `test` hands its test to that unchanged.
 */

import { fromFileUrl, isAbsolute, relative } from "@std/path";
import { readEnv, recordsDir } from "./records/paths.ts";
import { ResultsWriter } from "./records/results.ts";
import { NAME_SEPARATOR } from "./records/schema.ts";
import { parseSkipList, SKIP_LIST_VARIABLE } from "./records/skip-list.ts";

/** What a test does, given the context it runs steps through. */
export type TestBody = (t: Deno.TestContext) => void | Promise<void>;

/** What a hook does. */
export type Hook = () => void | Promise<void>;

/** What a `describe` or an `it` may say about how it runs. */
export interface StepOptions {
  /** Registers it, and everything it holds, without running it. */
  ignore?: boolean;
  sanitizeOps?: boolean;
  sanitizeResources?: boolean;
  sanitizeExit?: boolean;
}

/** What a `test` may say about how it runs. */
export interface TestOptions extends StepOptions {
  /** The permissions the test runs with, as `Deno.test` takes them. */
  permissions?: Deno.PermissionOptions;
}

/**
 * Something a test package runs around each suite: the suite's hooks and
 * tests run inside `run`.
 */
export type SuiteWrapper = (run: () => Promise<void>) => Promise<void>;

/** A `describe`, and what it holds. */
interface Group {
  readonly kind: "group";
  readonly name: readonly string[];
  readonly options: StepOptions;
  readonly beforeAll: Hook[];
  readonly afterAll: Hook[];
  readonly beforeEach: Hook[];
  readonly afterEach: Hook[];
  readonly children: Node[];
}

/** An `it` or a `test`. */
interface Leaf {
  readonly kind: "leaf";
  readonly name: readonly string[];
  readonly options: TestOptions;
  readonly body: TestBody;
}

type Node = Group | Leaf;

/** A group's hook lists start empty. */
function group(name: readonly string[], options: StepOptions): Group {
  return {
    kind: "group",
    name,
    options,
    beforeAll: [],
    afterAll: [],
    beforeEach: [],
    afterEach: [],
    children: [],
  };
}

/**
 * Read before any test runs, and so before any fake clock a package installs
 * replaces it.
 */
const now = performance.now.bind(performance);

/**
 * Whether this realm is a Deno test run, rather than a browser page that
 * `deno-web-test` drives, whose `Deno` offers only `Deno.test`.
 */
const inDeno = typeof Deno.mainModule === "string";

/**
 * The repository-relative test file this realm runs. Undefined where the
 * file is outside the repository this module belongs to, such as a fixture
 * a test wrote to a temporary directory, which is no test of the repository
 * and records nothing.
 */
const file: string | undefined = (() => {
  if (!inDeno || !Deno.mainModule.startsWith("file:")) return undefined;
  const root = fromFileUrl(new URL("../../../", import.meta.url));
  const main = fromFileUrl(Deno.mainModule);
  const inside = (from: string, to: string) => {
    const path = relative(from, to).replaceAll("\\", "/");
    return isAbsolute(path) || path === ".." || path.startsWith("../")
      ? undefined
      : path;
  };
  // The two can reach the checkout by different paths, one through a
  // symbolic link, where only resolving both says whether one holds the
  // other.
  return inside(root, main) ?? inside(...canonical(root, main));
})();

/**
 * Both paths with every symbolic link resolved, or both as given where this
 * process may not resolve them and has no records to write or skip list to
 * apply, so that which file it runs makes no difference.
 */
function canonical(...paths: [string, string]): [string, string] {
  try {
    return [Deno.realPathSync(paths[0]), Deno.realPathSync(paths[1])];
  } catch (error) {
    if (
      !(error instanceof Deno.errors.NotCapable) ||
      recordsDir() !== undefined || (readEnv(SKIP_LIST_VARIABLE) ?? "") !== ""
    ) throw error;
    return paths;
  }
}

/**
 * The names this file is not to run, joined. A skip list that names a file
 * but cannot be read is refused, since running everything is not what was
 * asked.
 */
const skips: ReadonlySet<string> = (() => {
  if (file === undefined) return new Set();
  const path = readEnv(SKIP_LIST_VARIABLE);
  if (path === undefined || path.length === 0) return new Set();
  const list = parseSkipList(Deno.readTextFileSync(path));
  if (list === undefined) {
    throw new Error(`the skip list ${path} is not one`);
  }
  return new Set(list[file] ?? []);
})();

/** Whether the skip list names a test or anything enclosing it. */
function listed(name: readonly string[]): boolean {
  for (let length = 1; length <= name.length; length++) {
    if (skips.has(name.slice(0, length).join(NAME_SEPARATOR))) return true;
  }
  return false;
}

/** Whether a test will run: neither listed nor ignored. */
function runs(leaf: Leaf, ignored: boolean): boolean {
  return !ignored && leaf.options.ignore !== true && !listed(leaf.name);
}

/** Whether any test a node holds will run. */
function anyRuns(node: Node, ignored = false): boolean {
  if (node.kind === "leaf") return runs(node, ignored);
  const inside = ignored || node.options.ignore === true;
  return node.children.some((child) => anyRuns(child, inside));
}

/** Where results go, opened before any test runs. */
let writer: ResultsWriter | undefined;

/** Reports how a test or a group went. */
function report(
  name: readonly string[],
  outcome: "pass" | "fail" | "skip",
  durationMs: number,
  details: { container?: true; failure?: Thrown; listed?: true } = {},
): void {
  if (file === undefined) return;
  writer?.write({
    line: "result",
    file,
    name: [...name],
    outcome,
    durationMs,
    ...(details.container === undefined ? {} : { container: true }),
    ...(details.listed === undefined ? {} : { listed: true }),
    ...(details.failure === undefined
      ? {}
      : { failure: describeFailure(details.failure.thrown) }),
  });
}

/** What a test or group threw, or what failed it from outside. */
interface Thrown {
  readonly thrown: unknown;
}

/** A test or group that has started. */
interface Entry {
  readonly name: readonly string[];
  readonly startedAt: number;
  readonly container: () => boolean;

  /** What failed it, once anything has: its body, or an uncaught error. */
  failure: Thrown | undefined;

  /** When its body settled, once it has. */
  finishedAt?: number;

  /** Whether it has been reported, which happens once. */
  reported?: true;

  /** Whether the skip list named it, which only a step that runs can be. */
  readonly listed: boolean;
}

/** What has started and not finished, in the order it started. */
const running = new Set<Entry>();

/**
 * The tests and groups that have just finished and are yielding a turn of
 * the event loop before they are reported, in the order they finished. An
 * error a test leaves uncaught, such as a promise it rejects without
 * awaiting, reaches the file in that turn.
 */
const finishing = new Set<Entry>();

/** An error that reached the file uncaught, and the test it is charged to. */
interface Arrival {
  readonly event: Event;
  readonly thrown: unknown;
  readonly culprit: Entry | undefined;
}

/**
 * What has reached the file uncaught since it was last looked at. The file's
 * own listeners may still handle an error after this module hears of it, so
 * whether one was handled is read once the event has been dispatched.
 */
let arrivals: Arrival[] = [];

/** Hears of an error that reached the file uncaught. */
function arrive(event: Event, thrown: unknown): void {
  if (unloaded) return;
  arrivals.push({
    event,
    thrown,
    culprit: [...finishing].at(-1) ?? [...running].at(-1),
  });
}

/** Whether the name `outer` is a group's that `inner` lies inside. */
function encloses(
  outer: readonly string[],
  inner: readonly string[],
): boolean {
  return inner.length > outer.length &&
    outer.every((name, index) => inner[index] === name);
}

/**
 * The file's own group, named for the file. Its time is what the file's own
 * hooks took, which is no test's, and its failure is theirs, or that of an
 * error reaching the file uncaught while no test runs, such as one its hooks
 * leave. It is reported as the file unloads, and only where it has something
 * to say.
 */
const fileGroup: {
  ran: boolean;
  spent: number;
  failure: Thrown | undefined;
  /** When the file's hooks now running started, while they run. */
  since: number | undefined;
} = { ran: false, spent: 0, failure: undefined, since: undefined };

/**
 * Adds the file's hooks now running to its group, as having failed with
 * `failure` where one is given, and as no longer running.
 */
function settleFileHooks(failure: Thrown | undefined): void {
  if (fileGroup.since === undefined) return;
  fileGroup.ran = true;
  fileGroup.spent += now() - fileGroup.since;
  fileGroup.since = undefined;
  fileGroup.failure ??= failure;
}

/**
 * Whether the file has unloaded, and no test has started since. Nothing
 * reports after that, so an error reaching the file then is written at once,
 * as a failure of the file's group, by listeners added as it unloads, which
 * hear it after the file's own. A test's `Deno.exit()` unloads the file, and
 * Deno then goes on with the next test, which hears what reaches the file as
 * any test does.
 */
let unloaded = false;

/**
 * Writes `thrown` as the file group's failure, unless the file handled it, or
 * a test has started since the file unloaded and so will hear of it.
 */
function lateArrival(event: Event, thrown: unknown): void {
  if (!unloaded || event.defaultPrevented) return;
  fileGroup.failure ??= { thrown };
  reportFileGroup();
}

/**
 * The listeners for what reaches the file once it has unloaded. Each is one
 * function, so the second unload a test's `Deno.exit()` brings adds neither
 * again.
 */
function lateError(event: ErrorEvent): void {
  lateArrival(event, event.error ?? event.message);
}
function lateRejection(event: PromiseRejectionEvent): void {
  lateArrival(event, event.reason);
}

/** Charges each arrival nobody handled to its test, or to the file. */
function settleArrivals(): void {
  for (const { event, thrown, culprit } of arrivals) {
    if (event.defaultPrevented) continue;
    (culprit ?? fileGroup).failure ??= { thrown };
  }
  arrivals = [];
}

/** Reports the file's own group, where it ran or failed. */
function reportFileGroup(provisional?: Thrown): void {
  const { ran, spent } = fileGroup;
  const failure = fileGroup.failure ?? provisional;
  if (!ran && failure === undefined) return;
  report([file ?? ""], failure === undefined ? "pass" : "fail", spent, {
    container: true,
    ...(failure === undefined ? {} : { failure }),
  });
}

/**
 * Resolves after one turn of the event loop. An immediate is the cheapest
 * turn there is that dispatches no event, which a test may have replaced the
 * classes of. It is read as the module loads, before any fake clock a package
 * installs replaces it.
 */
const immediate = globalThis.setImmediate;
function turn(): Promise<void> {
  return new Promise((resolve) => immediate(resolve));
}

/**
 * Runs `body` as the test or group `name`, and reports how it went: as a
 * failure where `body` throws, or where an error reaches the file uncaught
 * while it runs or in the turn after it finishes, and as a group where
 * `container` says so once `body` has settled.
 */
async function reported(
  name: readonly string[],
  container: () => boolean,
  body: () => Promise<void>,
  listed = false,
): Promise<void> {
  const entry: Entry = {
    name,
    startedAt: now(),
    container,
    failure: undefined,
    listed,
  };
  running.add(entry);
  try {
    await body();
  } catch (thrown) {
    entry.failure = { thrown };
  }
  entry.finishedAt = now();
  running.delete(entry);
  // A test reported as abandoned has had its say, and an error arriving now
  // belongs to whatever runs now.
  if (!entry.reported) {
    finishing.add(entry);
    await turn();
    finishing.delete(entry);
    settleArrivals();
    reportEntry(entry);
  }
  if (entry.failure !== undefined) throw entry.failure.thrown;
}

/**
 * Reports a test or group that has started: as a failure where something
 * failed it, and over the time it ran, or has run so far.
 */
function reportEntry(entry: Entry): void {
  if (entry.reported) return;
  entry.reported = true;
  const { failure } = entry;
  report(
    entry.name,
    failure === undefined ? "pass" : "fail",
    (entry.finishedAt ?? now()) - entry.startedAt,
    {
      ...(entry.container() ? { container: true as const } : {}),
      ...(entry.listed ? { listed: true as const } : {}),
      ...(failure === undefined ? {} : { failure }),
    },
  );
}

/**
 * Runs `body`, then each of `after` whatever happened, and throws the first
 * thing any of them threw.
 */
async function withCleanup(
  body: () => Promise<void>,
  after: readonly Hook[],
): Promise<void> {
  let failure: Thrown | undefined;
  try {
    await body();
  } catch (thrown) {
    failure = { thrown };
  }
  for (const hook of after) {
    try {
      await hook();
    } catch (thrown) {
      failure ??= { thrown };
    }
  }
  if (failure !== undefined) throw failure.thrown;
}

/** What a thrown value says about itself. */
function describeFailure(thrown: unknown): string {
  return thrown instanceof Error
    ? thrown.stack ?? String(thrown)
    : String(thrown);
}

/** Every name a node and what it holds carry. */
function namesOf(node: Node): string[][] {
  return node.kind === "leaf"
    ? [[...node.name]]
    : [[...node.name], ...node.children.flatMap(namesOf)];
}

/**
 * Reports every test a node holds that will not run as skipped, saying which
 * of them the skip list named rather than the test itself.
 */
function reportSkipped(node: Node, ignored = false): void {
  if (node.kind === "leaf") {
    if (runs(node, ignored)) return;
    const own = ignored || node.options.ignore === true;
    report(node.name, "skip", 0, own ? {} : { listed: true });
    return;
  }
  const inside = ignored || node.options.ignore === true;
  for (const child of node.children) reportSkipped(child, inside);
}

/** The file's own scope: hooks declared outside every `describe`. */
const root = group([], {});

/** The group whose body is registering right now. */
let open: Group = root;

/** The suites this file registered, in order. */
const suites: Node[] = [];

/** Whether the file's tests have started, after which nothing registers. */
let started = false;

/** What `wrapSuites()` installed, outermost first. */
const wrappers: SuiteWrapper[] = [];

/**
 * Runs `wrapper` around every suite of the file, and around the file's own
 * `beforeAll` and `afterAll` hooks, inside any installed before it. A test
 * package's `--preload` module calls this.
 */
export function wrapSuites(wrapper: SuiteWrapper): void {
  wrappers.push(wrapper);
}

/**
 * Refuses a registration in a browser page, which runs flat tests alone, and
 * once the file's tests have started.
 */
function registering(what: string): void {
  if (!inDeno) {
    throw new Error(
      `${what} runs only under deno test; in a browser, use test() alone`,
    );
  }
  if (started) {
    throw new Error(
      `${what} was called while tests were running; register every test ` +
        "while the test file loads",
    );
  }
}

/**
 * `run`, inside every installed wrapper. A wrapper that does not run what it
 * wraps exactly once fails, rather than passing tests that never ran, and
 * what it wraps fails whatever the wrapper made of that.
 */
function wrapped(run: () => Promise<void>): () => Promise<void> {
  return wrappers.reduceRight<() => Promise<void>>(
    (next, wrapper) => async () => {
      const ran: Promise<void>[] = [];
      await wrapper(() => {
        const running = next();
        ran.push(running);
        return running;
      });
      if (ran.length !== 1) {
        throw new Error(
          `a suite wrapper ran its suite ${ran.length} times rather than once`,
        );
      }
      await ran[0];
    },
    run,
  );
}

/**
 * Runs the file's own hooks of one kind inside the installed wrappers, as
 * part of the file's own group. Returns what they threw, where they threw.
 */
async function runFileHooks(
  hooks: readonly Hook[],
): Promise<Thrown | undefined> {
  if (hooks.length === 0) return undefined;
  // Hooks that never settle end the file with no event to report them from,
  // so the file's group is written as failed first, and written again as it
  // unloads; a reader takes the last.
  reportFileGroup({ thrown: "the file's own hooks never finished" });
  fileGroup.since = now();
  let failure: Thrown | undefined;
  try {
    await wrapped(async () => {
      for (const hook of hooks) await hook();
    })();
  } catch (thrown) {
    failure = { thrown };
  }
  settleFileHooks(failure);
  // An error the hooks left uncaught reaches the file in the turn after
  // them, while no test runs, and so fails the file's own group, which is
  // then written as it stands in place of the provisional failure.
  await turn();
  settleArrivals();
  reportFileGroup();
  return failure;
}

/**
 * Whether the file's own `beforeAll` hooks ran, which they do once before any
 * test, and only where the skip list leaves the file a test to run. Where
 * they fail, Deno runs no test of the file, and runs its teardown.
 */
let setUp = false;

/**
 * Arranges, once per file, for its registrations to be reported, its own
 * `afterAll` hooks to run, uncaught errors to be heard, and what is still
 * running when it stops to be reported. Deno runs a file's `beforeAll` once
 * the module has loaded, before any test, and whether or not any test runs,
 * and its `afterAll` once every test has run.
 *
 * An error that reaches the file uncaught fails the test that has just
 * finished, where it arrives in the turn after it, the test running when it
 * arrives, or else the file's own group. A test or group still running when
 * the file stops, such as one whose promise never settles or one an uncaught
 * error ends, is reported as a failure as the file unloads, and a group around
 * it on its own account. A test that calls `Deno.exit()` makes the file unload
 * as well, and Deno fails that test and goes on with the next, so a file can
 * unload twice; each time reports what still runs then, and the file's own
 * group as it then stands.
 */
let arranged = false;
function arrange(): void {
  if (arranged) return;
  arranged = true;
  // The file's own group is named for the file.
  if (file !== undefined) claim([file]);
  // deno-lint-ignore cf-test/registration
  Deno.test.beforeAll(async () => {
    started = true;
    if (file !== undefined) {
      writer = ResultsWriter.openForRun();
      // An error that reached the file as it loaded may have stopped it part
      // way, and then what it registered is not what it holds.
      settleArrivals();
      if (fileGroup.failure === undefined) {
        writer?.write({
          line: "registered",
          file,
          names: suites.flatMap(namesOf),
        });
      }
    }
    // A suite Deno ignores never runs its body, which is where a suite that
    // runs reports what it skips.
    for (const suite of suites) {
      if (!anyRuns(suite)) reportSkipped(suite);
    }
    // Here, rather than in the first suite to run, the file's setup has the
    // file's own permissions rather than those that suite narrows to.
    if (suites.some((suite) => anyRuns(suite))) {
      setUp = true;
      const failure = await runFileHooks(root.beforeAll);
      if (failure !== undefined) throw failure.thrown;
    }
  });
  // deno-lint-ignore cf-test/registration
  Deno.test.afterAll(async () => {
    abandon("Deno moved on before this finished");
    if (!setUp) return;
    const failure = await runFileHooks(root.afterAll);
    if (failure !== undefined) throw failure.thrown;
  });
  globalThis.addEventListener(
    "error",
    (event) => arrive(event, event.error ?? event.message),
  );
  globalThis.addEventListener(
    "unhandledrejection",
    (event) => arrive(event, event.reason),
  );
  globalThis.addEventListener("unload", () => {
    unloaded = true;
    globalThis.addEventListener("error", lateError);
    globalThis.addEventListener("unhandledrejection", lateRejection);
    settleArrivals();
    for (const entry of finishing) reportEntry(entry);
    abandon("the test file stopped before this finished");
    reportFileGroup();
  });
}

/**
 * Reports what still runs, which Deno has given up on, such as a test whose
 * promise never settled or a step its test outlived, and forgets it, so that
 * neither what arrives later nor the time that passes is charged to it: all
 * of it, the file's own hooks included, or what lies inside the test or group
 * named `within`. Each fails
 * with `reason`, unless something inside it that still runs, or has just
 * finished, carries that failure for it.
 */
function abandon(reason: string, within: readonly string[] = []): void {
  settleArrivals();
  if (within.length === 0) settleFileHooks({ thrown: reason });
  const stale = [...running].filter((entry) => encloses(within, entry.name));
  for (const entry of stale.toReversed()) {
    entry.failure ??= [...stale, ...finishing].some((other) =>
        encloses(entry.name, other.name)
      )
      ? undefined
      : { thrown: reason };
    reportEntry(entry);
  }
  for (const entry of stale) running.delete(entry);
}

/** Registers one suite as a `Deno.test`. */
function registerSuite(node: Node): void {
  arrange();
  suites.push(node);
  // deno-lint-ignore cf-test/registration
  Deno.test({
    ...withoutIgnore(node.options),
    name: node.name[0] ?? "",
    ignore: !anyRuns(node),
    fn: async (t) => {
      let body: () => Promise<void>;
      let container: () => boolean;
      if (node.kind === "group") {
        body = () => runGroup(node, t, [root, node]);
        container = () => true;
      } else {
        const test = recording(t, node.name);
        body = () => runLeaf(node, test, [root]);
        container = test.ranSteps;
      }
      abandon("Deno moved on before this finished");
      unloaded = false;
      reportSkipped(node);
      await reported(node.name, container, () => wrapped(body)());
    },
  });
}

/** The parts of a call to `describe`, `it` or `test`. */
interface Call<Body> {
  name: string;
  options: TestOptions;
  body: Body;
}

/** The forms each of those takes. */
type CallArguments<Options, Body> =
  | [name: string, body: Body]
  | [name: string, options: Options, body: Body]
  | [options: Options & { name: string }, body: Body]
  | [definition: Options & { name: string; fn: Body }];

/** One call's parts, whichever form it took. */
function callOf<Body>(args: CallArguments<TestOptions, Body>): Call<Body> {
  const call = partsOf(args);
  refuseSanitizers(call.name, call.options);
  return call;
}

/**
 * Refuses a test or step that turns on a sanitizer. Deno decides what a
 * sanitizer finds only once a test has returned, out of this module's sight,
 * so a test whose sanitizer failed would be recorded as a pass.
 */
function refuseSanitizers(
  name: string,
  options: Deno.TestStepDefinition | TestOptions,
): void {
  if (options.sanitizeOps === true || options.sanitizeResources === true) {
    throw new TypeError(
      `"${name}" turns on a sanitizer, whose verdict this module cannot ` +
        "record; check what the test leaves behind in its own body",
    );
  }
}

/** One call's parts, as it gave them. */
function partsOf<Body>(args: CallArguments<TestOptions, Body>): Call<Body> {
  if (args.length === 1) {
    const { name, fn, ...options } = args[0];
    return { name, options, body: fn };
  }
  if (args.length === 3) {
    return { name: args[0], options: args[1], body: args[2] };
  }
  const [first, body] = args;
  if (typeof first === "string") return { name: first, options: {}, body };
  const { name, ...options } = first;
  return { name, options, body };
}

/**
 * Declares a group of tests. Its body runs as the file loads and registers
 * what the group holds; it may not return a promise.
 */
export function describe(
  ...args: CallArguments<StepOptions, () => void>
): void {
  registering("describe()");
  const { name, options, body } = callOf(args);
  const parent = open;
  const node = group([...parent.name, name], options);
  claim(node.name);
  open = node;
  try {
    const returned: unknown = body();
    if (returned !== undefined) {
      throw new TypeError(
        `describe("${name}") was given a body that returned a value; a ` +
          "describe body registers tests and returns nothing",
      );
    }
  } finally {
    open = parent;
  }
  adopt(parent, node);
}

/** Declares a test, alone or inside the `describe` registering it. */
function declare(call: Call<TestBody>): void {
  const node: Leaf = {
    kind: "leaf",
    name: [...open.name, call.name],
    options: call.options,
    body: call.body,
  };
  claim(node.name);
  adopt(open, node);
}

/** The full name of every test, group and step of this file, joined. */
const declared = new Set<string>();

/**
 * Claims `name` for one test, group or step. A name the file has already
 * given another is refused: the two would be one identity, whose outcomes
 * and durations merge.
 */
function claim(name: readonly string[]): void {
  const joined = name.join(NAME_SEPARATOR);
  if (name.at(-1)?.includes(NAME_SEPARATOR)) {
    throw new Error(
      `"${joined}" holds "${NAME_SEPARATOR}", which separates the names ` +
        "enclosing a test from its own",
    );
  }
  if (declared.has(joined)) {
    throw new Error(`two tests or groups are named "${joined}"`);
  }
  declared.add(joined);
}

/** Adds `node`, whose name it has claimed, to what `parent` holds. */
function adopt(parent: Group, node: Node): void {
  if (parent === root) registerSuite(node);
  else parent.children.push(node);
}

/** `it`, and `it.ignore` beside it. */
export interface It {
  (...args: CallArguments<StepOptions, TestBody>): void;

  /** Declares a test that is registered and never run. */
  ignore(...args: CallArguments<StepOptions, TestBody>): void;
}

/** Declares a test inside the `describe` registering it. */
export const it: It = Object.assign(
  (...args: CallArguments<StepOptions, TestBody>): void => {
    registering("it()");
    declare(callOf(args));
  },
  {
    ignore: (...args: CallArguments<StepOptions, TestBody>): void => {
      registering("it.ignore()");
      const call = callOf(args);
      declare({ ...call, options: { ...call.options, ignore: true } });
    },
  },
);

/**
 * Declares a test of its own. Its context runs steps, each named inside the
 * test, and each reported as a test.
 */
export function test(...args: CallArguments<TestOptions, TestBody>): void {
  if (!inDeno) {
    const { name, options, body } = callOf(args);
    // deno-lint-ignore cf-test/registration
    Deno.test({ ...options, name, fn: body });
    return;
  }
  registering("test()");
  if (open !== root) {
    throw new Error(
      "test() declares a suite of its own; use it() inside describe()",
    );
  }
  declare(callOf(args));
}

/** Declares a hook of the `describe` registering it, or of the whole file. */
function hook(
  list: (group: Group) => Hook[],
  what: string,
): (fn: Hook) => void {
  return (fn) => {
    registering(what);
    list(open).push(fn);
  };
}

/** Runs once before the tests of the group that declares it. */
export const beforeAll = hook((g) => g.beforeAll, "beforeAll()");

/** Runs once after the tests of the group that declares it. */
export const afterAll = hook((g) => g.afterAll, "afterAll()");

/** Runs before each test of the group that declares it, outermost first. */
export const beforeEach = hook((g) => g.beforeEach, "beforeEach()");

/** Runs after each test of the group that declares it, innermost first. */
export const afterEach = hook((g) => g.afterEach, "afterEach()");

/**
 * Options as `Deno.test` and `Deno.TestContext.step` take them, without the
 * `ignore` this module decides for itself.
 */
function withoutIgnore<Options extends StepOptions>(
  options: Options,
): Omit<Options, "ignore"> {
  const { ignore: _, ...rest } = options;
  return rest;
}

/**
 * Runs a group's tests as steps of `t`, between its `beforeAll` and its
 * `afterAll`, which run only where a test inside will.
 */
async function runGroup(
  node: Group,
  t: Deno.TestContext,
  lineage: readonly Group[],
): Promise<void> {
  // A group runs only where something in it will.
  await withCleanup(async () => {
    if (node.beforeAll.length > 0) {
      for (const hook of node.beforeAll) await hook();
      // An error the hooks left uncaught reaches the file in the turn after
      // them, while the group runs and none of its tests yet does.
      await turn();
    }
    for (const child of node.children) {
      const name = child.name.at(-1) ?? "";
      await t.step({
        ...withoutIgnore(child.options),
        name,
        ignore: !anyRuns(child),
        fn: child.kind === "group"
          ? (inner) =>
            reported(
              child.name,
              () => true,
              () => runGroup(child, inner, [...lineage, child]),
            )
          : (inner) => {
            const test = recording(inner, child.name);
            return reported(
              child.name,
              test.ranSteps,
              () => runLeaf(child, test, lineage),
            );
          },
      });
    }
  }, node.afterAll);
}

/**
 * Runs a test with the `beforeEach` and `afterEach` hooks of every group
 * enclosing it.
 */
async function runLeaf(
  leaf: Leaf,
  run: Recording,
  lineage: readonly Group[],
): Promise<void> {
  await withCleanup(
    async () => {
      for (const enclosing of lineage) {
        for (const hook of enclosing.beforeEach) await hook();
      }
      let failure: Thrown | undefined;
      try {
        await leaf.body(run.context);
      } catch (thrown) {
        failure = { thrown };
      }
      const unfinished = run.unfinishedSteps();
      if (unfinished > 0) {
        // Deno fails each such step for not finishing before the test did.
        abandon("the test that started this step returned first", leaf.name);
        failure ??= {
          thrown: new Error(
            `${unfinished} step(s) this test started had not finished when ` +
              "it returned; await each t.step()",
          ),
        };
      }
      if (failure !== undefined) throw failure.thrown;
    },
    lineage.toReversed().flatMap((enclosing) => enclosing.afterEach),
  );
}

/** One step's definition, whichever form `step()` was called in. */
function stepDefinition(
  first: Deno.TestStepDefinition | string | TestBody,
  second: TestBody | undefined,
): Deno.TestStepDefinition {
  if (typeof first === "function") return { name: first.name, fn: first };
  if (typeof first !== "string") return first;
  if (second === undefined) {
    throw new TypeError(`step("${first}") was given no body`);
  }
  return { name: first, fn: second };
}

/** A test's context, and what the test did with its steps. */
interface Recording {
  readonly context: Deno.TestContext;

  /** Whether the test ran a step, which makes it a group of them. */
  readonly ranSteps: () => boolean;

  /** How many of the steps it started have not finished. */
  readonly unfinishedSteps: () => number;
}

/**
 * The context a test runs with. Its steps are named inside the test and
 * reported as tests; one the skip list names still runs, and is reported as
 * listed.
 */
function recording(
  raw: Deno.TestContext,
  name: readonly string[],
  parent: Deno.TestContext | undefined = raw.parent,
): Recording {
  let ranSteps = false;
  let unfinished = 0;
  const step = async (
    first: Deno.TestStepDefinition | string | TestBody,
    second?: TestBody,
  ): Promise<boolean> => {
    unfinished++;
    try {
      return await runStep(first, second);
    } finally {
      unfinished--;
    }
  };
  const runStep = async (
    first: Deno.TestStepDefinition | string | TestBody,
    second?: TestBody,
  ): Promise<boolean> => {
    const definition = stepDefinition(first, second);
    refuseSanitizers(definition.name, definition);
    const stepName = [...name, definition.name];
    claim(stepName);
    // A step runs whenever its test does: it is part of its test's body,
    // and the steps before it may have set up what it reads. One the skip
    // list names is written as listed, so that a lane that did not plan it
    // records nothing of it.
    const skipped = definition.ignore === true;
    const asListed = listed(stepName);
    ranSteps ||= !skipped;
    if (skipped) report(stepName, "skip", 0, asListed ? { listed: true } : {});
    let entered = false;
    const passed = await raw.step({
      ...definition,
      ignore: skipped,
      fn: (inner) => {
        entered = true;
        const test = recording(inner, stepName, context);
        return reported(
          stepName,
          test.ranSteps,
          () =>
            runLeaf(
              {
                kind: "leaf",
                name: stepName,
                options: {},
                body: definition.fn,
              },
              test,
              [],
            ),
          asListed,
        );
      },
    });
    // Deno can fail a step without running it, such as one started while
    // another runs.
    if (!passed && !skipped && !entered) {
      report(stepName, "fail", 0, {
        failure: { thrown: "Deno failed this step without running it" },
        ...(asListed ? { listed: true as const } : {}),
      });
    }
    return passed;
  };
  const context: Deno.TestContext = {
    name: raw.name,
    origin: raw.origin,
    ...(parent === undefined ? {} : { parent }),
    step,
    assertSnapshot: raw.assertSnapshot.bind(raw),
  };
  return {
    context,
    ranSteps: () => ranSteps,
    unfinishedSteps: () => unfinished,
  };
}
