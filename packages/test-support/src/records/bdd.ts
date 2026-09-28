/**
 * `describe` and `it`, wrapped so that an invocation can be asked not to
 * run one of them.
 *
 * A test's identity is the name its runner reports, which for a file
 * written this way is the describe chain joined with `" > "`, opening
 * with the root suite the runner invents for a file whose hooks sit
 * outside every `describe`.
 * Registration does not follow that shape: `describe` registers one
 * `Deno.test` and every `it` inside it is a step within that one test, so
 * the preload's wrapper around `Deno.test` sees the container and never
 * the leaves. Reaching a leaf therefore needs a second interception, and
 * this is it.
 *
 * No test file changes. The root import map points `@std/testing/bdd` at
 * this module and the real one at a second specifier, so every file keeps
 * its own `import { describe, it } from "@std/testing/bdd"` and what that
 * specifier means changes once, centrally.
 *
 * A listed test is registered through `it.ignore` rather than dropped, so
 * it appears in the run's output and in its JUnit report as skipped and
 * the store learns it was deliberately not run instead of watching the
 * identity disappear.
 *
 * An invocation with no capture installed gets the real functions back
 * whole; see `capturing`.
 */

import {
  after as realAfter,
  afterAll as realAfterAll,
  afterEach as realAfterEach,
  before as realBefore,
  beforeAll as realBeforeAll,
  beforeEach as realBeforeEach,
  describe as realDescribe,
  it as realIt,
} from "@std/testing/bdd/real";
import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  activeCapture,
  NAME_SEPARATOR,
  type RegistrationCapture,
  runningFile,
} from "./registration.ts";

/**
 * The describe chain enclosing whatever is being registered right now.
 * `describe` runs its body while it registers, so setting the chain
 * around that call is what makes it available to the `it`s inside. A
 * hook declared outside every `describe` opens the chain with the root
 * suite the runner invents for it, and nothing takes that one off again:
 * the suite holds the rest of the file.
 */
let chain: string[] = [];

/**
 * For each suite `describe` has handed back, the chain that suite stands
 * for. A call can name the suite it belongs to outright instead of
 * sitting inside it, and the runner reports such a leaf under the named
 * suite's chain rather than under whatever encloses the call. A value is
 * a handle this module handed out exactly when it is a key here.
 */
const chains = new WeakMap<object, readonly string[]>();

/**
 * The name the bdd runner gives the root suite it invents. A hook
 * declared outside every `describe` has no suite to hold it, so the
 * runner makes one under this name and the suites the file goes on to
 * run sit inside it.
 */
const ROOT_SUITE_NAME = "global";

/**
 * The name a bdd call was given, whichever way it was called: a name
 * argument, a definition's own `name`, or the name of the body, which is
 * what the runner falls back to. A name the call carries stands even
 * where it is empty, so such a call names an empty element of the chain
 * rather than nothing. A call carrying neither a name nor a body is what
 * this has no name for.
 */
export function nameOf(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg === "string") return arg;
    if (isObjectOrArray(arg)) {
      const named = (arg as { name?: unknown }).name;
      if (typeof named === "string") return named;
      const fn = (arg as { fn?: unknown }).fn;
      if (typeof fn === "function") return fn.name;
    }
    if (typeof arg === "function") return arg.name;
  }
  return undefined;
}

// deno-lint-ignore no-explicit-any
type AnyFunction = (...args: any[]) => any;

/** Where the body sits in a call, and what it is. */
export function bodyOf(
  args: readonly unknown[],
): { index: number; body: AnyFunction } | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg === "function") {
      return { index, body: arg as AnyFunction };
    }
    if (isObjectOrArray(arg)) {
      const fn = (arg as { fn?: unknown }).fn;
      if (typeof fn === "function") {
        return { index: -1, body: fn as AnyFunction };
      }
    }
  }
  return undefined;
}

/** The shape every one of the bdd hooks shares. */
type Hook = <T>(fn: (this: T) => void | Promise<void>) => void;

/**
 * The chain the suite a bdd call names stands for, and undefined where
 * the call names none. A call names a suite by passing its handle ahead
 * of everything else, or by carrying that handle in the `suite` field of
 * a definition, and those two places are where the real functions look
 * for it.
 */
function namedChain(args: readonly unknown[]): readonly string[] | undefined {
  for (const arg of args) {
    if (!isObjectOrArray(arg)) continue;
    const own = chains.get(arg);
    if (own !== undefined) return own;
    const suite = (arg as { suite?: unknown }).suite;
    if (!isObjectOrArray(suite)) continue;
    const named = chains.get(suite);
    if (named !== undefined) return named;
  }
  return undefined;
}

/**
 * The chain a call's own name hangs off: the chain of the suite it
 * names, and otherwise the chain lexically open around it.
 */
function enclosing(args: readonly unknown[]): readonly string[] {
  return namedChain(args) ?? chain;
}

/**
 * A body wrapped so that it runs with `own` as the open chain. Where a
 * call gives no name of its own, `describe` names the suite after its
 * body, so the replacement carries the body's own name.
 */
function inChain(own: string[], body: AnyFunction): AnyFunction {
  const wrapped = function (this: unknown, ...rest: unknown[]): unknown {
    const outer = chain;
    chain = own;
    try {
      return body.apply(this, rest);
    } finally {
      chain = outer;
    }
  };
  Object.defineProperty(wrapped, "name", { value: body.name });
  return wrapped;
}

/** One call's arguments with its body replaced, wherever the body sits. */
function withBody(
  args: readonly unknown[],
  index: number,
  body: AnyFunction,
): unknown[] {
  if (index >= 0) {
    const next = [...args];
    next[index] = body;
    return next;
  }
  return args.map((arg) =>
    isObjectOrArray(arg) &&
      typeof (arg as { fn?: unknown }).fn === "function"
      ? { ...arg, fn: body }
      : arg
  );
}

/**
 * Wraps one `describe` entry point so the chain is set around the body it
 * registers, and so the suite it hands back is remembered under the chain
 * that suite stands for. A leaf naming that handle is then named the way
 * the runner names it, wherever the call sits. A call carrying no title
 * of its own is named after its body, so the wrapper answers to the
 * body's own name and the suite is reported under it. A shape this does
 * not model reaches the real function untouched, so an unfamiliar
 * overload still runs and still reports its own error.
 *
 * Takes no capture: a wrapper is built only where one is installed, and
 * tracking the chain is the whole of what this does with it.
 */
export function wrapDescribe(through: AnyFunction): AnyFunction {
  return (...args: unknown[]): unknown => {
    const found = bodyOf(args);
    const name = nameOf(args);
    if (name === undefined) return through(...args);
    const own = [...enclosing(args), name];
    const result = found === undefined
      ? through(...args)
      : through(...withBody(args, found.index, inChain(own, found.body)));
    if (isObjectOrArray(result)) {
      chains.set(result, own);
    }
    return result;
  };
}

/**
 * Wraps one `it` entry point so that a listed leaf is registered as
 * ignored, and so that the leaf's own file reaches the name map. The
 * leaf's identity is the chain enclosing it and its own name joined,
 * which is what the store speaks in, and the file is the test file the
 * process runs, as the preload takes it — the two together, because the
 * same test name occurs in more than one file.
 *
 * The body reaches the real function unchanged, so the runner names the
 * leaf from the same function `nameOf` read it from.
 *
 * The preload's wrapper around `Deno.test` sees only the container the
 * describe chain registers, so without this the map holds one entry per
 * top-level suite title. Two files opening with the same title are then
 * one ambiguous entry, and every leaf under either of them loses its
 * file. Recording each leaf against its own file narrows that to two
 * files holding the same whole identity, which is a name clash rather
 * than a shared title.
 */
export function wrapIt(
  through: AnyFunction,
  ignore: AnyFunction,
  active: () => RegistrationCapture,
): AnyFunction {
  return (...args: unknown[]): unknown => {
    const capture = active();
    const name = nameOf(args);
    if (name === undefined) return through(...args);
    const identity = [...enclosing(args), name].join(NAME_SEPARATOR);
    const file = runningFile();
    if (file !== undefined) capture.names.set(identity, file);
    return capture.skipped(file, identity) ? ignore(...args) : through(...args);
  };
}

/** Copies the entry points hanging off a bdd function onto its wrapper. */
function withEntryPoints(
  wrapper: AnyFunction,
  real: AnyFunction,
  wrap: (through: AnyFunction) => AnyFunction,
): AnyFunction {
  for (const key of ["only", "skip", "ignore"] as const) {
    const entry = (real as unknown as Record<string, unknown>)[key];
    if (typeof entry === "function") {
      Reflect.set(wrapper, key, wrap(entry as AnyFunction));
    }
  }
  return wrapper;
}

/**
 * The capture installed before this module was evaluated, read once.
 *
 * Deno names a case's class after the nearest frame of the tree's own
 * code below the runner, so a wrapper here takes that name from the test
 * file whether or not it does anything with the call. With no capture
 * there is nothing for it to do, and the real functions go back whole,
 * so the report's class names name the file and ingestion reads the file
 * from those.
 *
 * Reading it once is what makes that possible: the exported binding is
 * either a wrapper or the real function, and it is fixed before the
 * first `describe` runs. The preload installs the capture before any
 * test module loads, and `installRegistrationCapture` reports an
 * invocation that loaded this module ahead of it. Nothing uninstalls a
 * capture, so a wrapper built here has one for as long as it lives.
 */
const capture = activeCapture();

/** `describe`, tracking the chain its body registers inside. */
export const describe: typeof realDescribe = capture === undefined
  ? realDescribe
  : withEntryPoints(
    wrapDescribe(realDescribe as unknown as AnyFunction),
    realDescribe as unknown as AnyFunction,
    wrapDescribe,
  ) as typeof realDescribe;

const realIgnore = (realIt as unknown as Record<string, AnyFunction>).ignore ??
  (realIt as unknown as AnyFunction);

/** `it`, registering a listed leaf as ignored rather than running it. */
export const it: typeof realIt = capture === undefined
  ? realIt
  : withEntryPoints(
    wrapIt(realIt as unknown as AnyFunction, realIgnore, () => capture),
    realIt as unknown as AnyFunction,
    (through) => wrapIt(through, realIgnore, () => capture),
  ) as typeof realIt;

/** The alias `@std/testing/bdd` gives `it`. */
export const test: typeof realIt = it;

/**
 * Wraps one hook where a capture is installed, and not otherwise.
 *
 * A call outside every `describe` is what makes the runner invent its
 * root suite, so the chain opens with that suite's name from there on
 * and every leaf is named inside it. The name goes on once the call has
 * returned, so a hook the runner refuses — it refuses one declared after
 * a test has started — leaves the naming alone. Deno gives each test
 * file a realm of its own, so the chain is one file's.
 */
function hook(real: Hook): Hook {
  if (capture === undefined) return real;
  return (fn) => {
    real(fn);
    if (chain.length === 0) chain.push(ROOT_SUITE_NAME);
  };
}

/** `beforeEach`, noticing a call that brings the root suite about. */
export const beforeEach: typeof realBeforeEach = hook(realBeforeEach);

/** `afterEach`, noticing the same. */
export const afterEach: typeof realAfterEach = hook(realAfterEach);

/** `beforeAll`, noticing the same. */
export const beforeAll: typeof realBeforeAll = hook(realBeforeAll);

/** `afterAll`, noticing the same. */
export const afterAll: typeof realAfterAll = hook(realAfterAll);

/** The alias `@std/testing/bdd` gives `beforeAll`. */
export const before: typeof realBefore = hook(realBefore);

/** The alias `@std/testing/bdd` gives `afterAll`. */
export const after: typeof realAfter = hook(realAfter);
