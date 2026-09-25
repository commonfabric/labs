/**
 * What a test process learns about its own tests at registration time: the
 * test file each `Deno.test` belongs to, and whether this invocation was
 * asked not to run it.
 *
 * Both come from wrapping `Deno.test` in a `--preload` module, which runs
 * before every test module and so needs nothing from the test files
 * themselves. The file is the one the process was started on, whichever
 * module made the call, and it is written into the run's spool beside the
 * record fragments, where ingestion joins it onto the identities a JUnit
 * report names. The skip list is a file the environment points at,
 * holding the identities this invocation is not to run; a listed test is
 * registered as ignored rather than dropped, so it appears in the report
 * as skipped instead of vanishing.
 */

import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import {
  type Environment,
  readEnv,
  recordsDir,
  repositoryRoot,
} from "./paths.ts";

/** What a name-map file's name starts with, inside the spool. */
export const NAME_MAP_PREFIX = "names-";

/** What it ends with; the whole name is `names-<uuid>.json`. */
export const NAME_MAP_SUFFIX = ".json";

/** Variable naming the file holding this invocation's skip list. */
export const SKIP_LIST_VARIABLE = "CF_TEST_SKIP_LIST";

/**
 * The tails of the paths of modules that register a test on another
 * file's behalf. Deno names a JUnit case's class after the module that
 * registered the test, so a case registered through one of these names
 * that module rather than the test file: `registration.ts` is the
 * `Deno.test` wrapper the preload installs, `bdd.ts` the `describe` and
 * `it` this repository's import map resolves to, `fixture-runner.ts`
 * builds a suite over a directory of fixtures, `clock-preload.ts`
 * replaces `Deno.test` to give each test a clock, and the runner's
 * `silent-backstop-guard.ts` replaces it again to fail a test a
 * production backstop carried. Ingestion rejects a classname ending in
 * one of these rather than reading it as a test file, and the preload's
 * name map supplies the file instead.
 */
export const MACHINERY_MODULE_SUFFIXES: readonly string[] = [
  "src/records/registration.ts",
  "src/records/bdd.ts",
  "src/fixture-runner.ts",
  "test/clock-preload.ts",
  "test/support/silent-backstop-guard.ts",
];

/**
 * The separator a bdd runner joins a describe chain with, and so the
 * separator between a registered test's name and the leaf names beneath
 * it.
 */
export const NAME_SEPARATOR = " > ";

/**
 * A name map as it travels: where the test process ran, and a registered
 * name against the repository-relative file it came from. The names are
 * what `Deno.test` was called with, and, for a file written with
 * `describe` and `it`, the whole chain of each leaf as well — a title two
 * files share says nothing about either, where a leaf's whole chain
 * usually does.
 */
export interface NameMap {
  /**
   * The repository-relative directory the process ran in, which for a
   * workspace member's test task is the member's own directory and for a
   * process running at the repository root is the empty string. Absent
   * where no repository encloses it, and the reader then has only the
   * files to go on.
   */
  dir?: string;

  /** Each registered name against the file it came from. */
  names: Record<string, string>;
}

/** A name map as it comes back off disk, its values still unread. */
interface ParsedNameMap {
  dir?: string;
  names: Record<string, unknown>;
}

/** One map off disk, or undefined for anything that is not one. */
function asNameMap(parsed: unknown): ParsedNameMap | undefined {
  if (!isObjectNotArray(parsed)) {
    return undefined;
  }
  const { dir, names } = parsed as { dir?: unknown; names?: unknown };
  // An array is an object, and its entries are index keys against the
  // values, so names written as one would register a test named "0".
  if (!isObjectNotArray(names)) {
    return undefined;
  }
  return {
    ...(typeof dir === "string" ? { dir } : {}),
    names: names as Record<string, unknown>,
  };
}

/**
 * The repository-relative directory this process is running in, which is
 * the empty string at the repository root. Undefined outside any
 * repository, and undefined when the climb is not permitted to read the
 * filesystem.
 */
export function runDirectory(): string | undefined {
  const cwd = Deno.cwd();
  const root = repositoryRoot(cwd);
  return root === undefined ? undefined : relative(root, cwd)
    .replaceAll("\\", "/");
}

/**
 * A skip list: the names this invocation is not to run, under the
 * repository-relative file that registers them. Keyed by file as well as
 * name because the same test name occurs in more than one file.
 */
export type SkipList = Record<string, string[]>;

/**
 * The repository root enclosing a file, found by climbing to the
 * directory holding `.git`. Undefined outside any repository, and
 * undefined when the climb is not permitted to read the filesystem.
 */
export function repositoryRootOf(path: string): string | undefined {
  return repositoryRoot(dirname(resolve(path)));
}

/**
 * The repository-relative path of the file a `file:` URL names. Undefined
 * for a URL naming no file, for a file inside no repository, and where
 * finding the repository is not permitted to read the filesystem.
 */
export function repositoryPathOf(url: string): string | undefined {
  let path: string;
  try {
    path = fromFileUrl(url);
  } catch {
    return undefined;
  }
  const root = repositoryRootOf(path);
  return root === undefined
    ? undefined
    : relative(root, path).replaceAll("\\", "/");
}

/** The test file this process runs, resolved once. */
let runFile: string | undefined;
let runFileResolved = false;

/**
 * The repository-relative path of the test file this process runs, which
 * is the file every test it registers belongs to. Deno runs each test
 * file in a realm of its own, with that file as the main module, so the
 * path is the one the command named: the one a skip list is keyed by and
 * a suite knows as its unit. A test registered from a helper module the
 * file imports belongs to the file all the same.
 *
 * Undefined where the main module is no file inside a repository, and
 * where finding the repository is not permitted to read the filesystem.
 */
export function runningFile(): string | undefined {
  if (!runFileResolved) {
    runFileResolved = true;
    runFile = repositoryPathOf(Deno.mainModule);
  }
  return runFile;
}

/**
 * The file a leaf identity's name belongs to, given a name map. A leaf is
 * named as its describe chain, so the registered name is either the whole
 * of it or a prefix of it up to a separator; the longest such prefix wins,
 * because nested describes make several of them.
 */
export function fileForName(
  name: string,
  names: ReadonlyMap<string, string>,
): string | undefined {
  const exact = names.get(name);
  if (exact !== undefined) return exact;
  let best: string | undefined;
  let bestLength = -1;
  for (const [registered, file] of names) {
    if (registered.length <= bestLength) continue;
    if (!name.startsWith(registered + NAME_SEPARATOR)) continue;
    best = file;
    bestLength = registered.length;
  }
  return best;
}

/** Whether an entry of a map is one a read scoped to `ranIn` takes. */
function inScope(
  dir: string | undefined,
  file: string,
  ranIn: string | undefined,
): boolean {
  if (ranIn === undefined) return true;
  if (dir !== undefined) return dir === ranIn;
  return ranIn.length === 0 || file.startsWith(`${ranIn}/`);
}

/**
 * Merges the name maps a spool holds into one lookup. A name two files
 * both registered is dropped rather than attributed to either: the two
 * are one identity, and which file it came from is not a question the
 * spool can answer. Reading is best-effort, since a name map is metadata
 * and its absence costs only the file field.
 *
 * Every package of a workspace run writes into one spool, so a caller
 * ingesting one package's report passes `ranIn`: the directory that
 * package's test process ran in. A map naming the directory it was
 * written in belongs to that directory and to no other, whatever files
 * it names. A map naming none is judged by its files, and contributes
 * only those under `ranIn`. Either way the scope is applied before the
 * ambiguity is judged rather than after, or a name two packages happen
 * to share would cost both of them a file each had unambiguously.
 */
export async function readNameMaps(
  spool: string,
  options: { ranIn?: string } = {},
): Promise<Map<string, string>> {
  const ranIn = options.ranIn?.replace(/\/$/, "");
  const names = new Map<string, string>();
  const ambiguous = new Set<string>();
  let entries: string[] = [];
  try {
    for await (const entry of Deno.readDir(spool)) {
      if (
        entry.isFile && entry.name.startsWith(NAME_MAP_PREFIX) &&
        entry.name.endsWith(NAME_MAP_SUFFIX)
      ) {
        entries.push(entry.name);
      }
    }
  } catch {
    entries = [];
  }
  entries.sort();
  for (const entry of entries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Deno.readTextFile(join(spool, entry)));
    } catch {
      continue;
    }
    const map = asNameMap(parsed);
    if (map === undefined) continue;
    for (const [name, file] of Object.entries(map.names)) {
      if (typeof file !== "string" || file.length === 0) continue;
      if (!inScope(map.dir, file, ranIn)) continue;
      const known = names.get(name);
      if (known === undefined) {
        names.set(name, file);
        continue;
      }
      if (known !== file) ambiguous.add(name);
    }
  }
  for (const name of ambiguous) names.delete(name);
  return names;
}

/** Serializes a skip list for the file the environment points at. */
export function serializeSkipList(skips: SkipList): string {
  return JSON.stringify(skips, null, 2) + "\n";
}

/**
 * Parses a skip list. Returns undefined for anything that is not one: a
 * skip list is an instruction to run less, so a malformed one runs
 * everything rather than an arbitrary subset.
 */
export function parseSkipList(text: string): SkipList | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObjectOrArray(parsed)) return undefined;
  if (Array.isArray(parsed)) return undefined;
  const skips: SkipList = {};
  for (const [file, names] of Object.entries(parsed)) {
    if (!Array.isArray(names)) return undefined;
    for (const name of names) {
      if (typeof name !== "string") return undefined;
    }
    skips[file] = names as string[];
  }
  return skips;
}

/** What one test process captured, and what it was told not to run. */
export interface RegistrationCapture {
  /** The file each registered name came from, repository-relative. */
  names: Map<string, string>;

  /** Whether a name registered from a file is on the skip list. */
  skipped(file: string | undefined, name: string): boolean;

  /** Writes the captured name map into the spool. */
  flush(): void;
}

let installed: RegistrationCapture | undefined;

/** Whether anything has asked for the capture yet. */
let consulted = false;

/**
 * The capture this process installed, for the bdd re-exports to consult.
 * Undefined when no preload ran, which is every invocation that is not
 * recording.
 */
export function activeCapture(): RegistrationCapture | undefined {
  consulted = true;
  return installed;
}

/**
 * Wraps `Deno.test` so that every registration is attributed to its file
 * and checked against the skip list, and arranges for the captured map to
 * reach the spool when the process unloads. Returns undefined when there
 * was nothing to do and `Deno.test` was left alone.
 *
 * Called from a `--preload` module, so it runs before any test module and
 * needs nothing from the test files. Installing twice is a no-op: a
 * process that loads two preloads naming this module captures once.
 */
export function installRegistrationCapture(
  env: Environment = Deno.env.get,
): RegistrationCapture | undefined {
  if (installed !== undefined) return installed;

  const skips = loadSkipList(env);
  const spool = recordsDir(env);
  // Wrapping `Deno.test` costs the report its own file attribution: Deno
  // names each case's class after the module that registered it, so from
  // here on that is this module rather than the test file. Paying that is
  // right when there is a skip list to apply, or a spool this process can
  // write the replacement map into. With neither, the report is the
  // better source and nothing is wrapped.
  if (skips === undefined && !writableSpool(spool)) return undefined;
  // The bdd re-export decides whether to wrap as it is evaluated, by
  // asking for the capture. Finding the capture asked for already means
  // it decided before this ran and handed back the real `describe` and
  // `it`, so nothing of ours sits inside a describe chain any more: no
  // leaf reaches the name map, and no leaf is checked against the skip
  // list. A skip list says what this invocation is not to run, so an
  // invocation that cannot apply one stops rather than running what it
  // was told to leave alone. A name map is metadata, and losing it is
  // said out loud and carried.
  if (consulted) {
    const detail = "the bdd re-export loaded before this preload, so no " +
      "leaf reaches the name map or the skip list";
    if (skips !== undefined) throw new Error(`test records: ${detail}`);
    console.warn(`test records: ${detail}`);
  }

  const dir = runDirectory();
  const built = buildCapture({
    registrar: Deno.test,
    ...(dir === undefined ? {} : { dir }),
    ...(skips === undefined ? {} : { skips }),
    ...(spool === undefined ? {} : { spool }),
  });
  Reflect.set(Deno, "test", built.registrar);
  globalThis.addEventListener("unload", () => built.capture.flush());
  installed = built.capture;
  return built.capture;
}

/** What a capture is built from, and where its map goes. */
export interface CaptureOptions {
  /** The registrar the wrapper hands each definition on to. */
  registrar: (definition: Deno.TestDefinition) => void;

  /** The identities this invocation is not to run. */
  skips?: SkipList;

  /** Where `flush` writes the name map. Nothing is written without one. */
  spool?: string;

  /**
   * The repository-relative directory the map says it was written in, as
   * it stood when the capture was built. `flush` runs at process unload,
   * by which time a test may have changed the working directory.
   */
  dir?: string;
}

/**
 * The wrapper and the capture behind it, built against a registrar the
 * caller supplies. `installRegistrationCapture` supplies `Deno.test`;
 * anything else can supply its own and exercise the whole of this
 * without replacing a global that cannot be put back.
 */
export function buildCapture(
  options: CaptureOptions,
): { capture: RegistrationCapture; registrar: (...args: unknown[]) => void } {
  const { dir, skips, spool } = options;
  const names = new Map<string, string>();

  const capture: RegistrationCapture = {
    names,
    skipped: (file, name) => {
      if (skips === undefined || file === undefined) return false;
      return skips[file]?.includes(name) ?? false;
    },
    flush: () => {
      if (spool === undefined || names.size === 0) return;
      const map: NameMap = {
        ...(dir === undefined ? {} : { dir }),
        names: Object.fromEntries(names),
      };
      try {
        Deno.mkdirSync(spool, { recursive: true });
        // A random name rather than a sortable one: nothing orders these,
        // and `crypto.randomUUID` is built in, where a sortable id would
        // be one more specifier a test task's own import map has to
        // carry for the preload to load at all.
        Deno.writeTextFileSync(
          join(
            spool,
            `${NAME_MAP_PREFIX}${crypto.randomUUID()}${NAME_MAP_SUFFIX}`,
          ),
          JSON.stringify(map),
        );
      } catch (error) {
        console.warn(`test records: cannot write a name map: ${error}`);
      }
    },
  };

  const realTest = options.registrar;
  const register = (
    through: (definition: Deno.TestDefinition) => void,
    extra: Partial<Deno.TestDefinition>,
  ) =>
  (...args: unknown[]): void => {
    const definition = asDefinition(args);
    if (definition === undefined) {
      // A shape this wrapper does not model reaches the real registrar
      // untouched and with its own arguments, so an unfamiliar overload
      // still runs and still reports its own error.
      // deno-lint-ignore no-explicit-any
      (through as any)(...args);
      return;
    }
    const file = runningFile();
    if (file !== undefined) names.set(definition.name, file);
    if (capture.skipped(file, definition.name)) {
      through({ ...definition, ...extra, ignore: true });
      return;
    }
    through({ ...definition, ...extra });
  };
  const capturingTest = register(realTest, {});
  Reflect.set(capturingTest, "ignore", register(realTest, { ignore: true }));
  Reflect.set(capturingTest, "only", register(realTest, { only: true }));
  return { capture, registrar: capturingTest };
}

/**
 * One definition, whichever way `Deno.test` was called. It takes a name
 * and a body, an options object and a body, a name and options and a
 * body, a whole definition, or a named function alone, and the options
 * carry the sanitizer and permission settings a test needs — so reading
 * only the first two arguments drops the body of several of them and
 * builds a definition Deno rejects.
 *
 * Undefined for a shape this does not model, including an anonymous
 * function with no name to take. The caller passes those through
 * untouched, so Deno reports them as it would have.
 */
export function asDefinition(
  args: readonly unknown[],
): Deno.TestDefinition | undefined {
  const [first, second, third] = args;
  const isBody = (value: unknown): value is Deno.TestDefinition["fn"] =>
    typeof value === "function";
  const isOptions = (value: unknown): value is Record<string, unknown> =>
    isObjectOrArray(value);

  if (typeof first === "string") {
    if (isBody(second)) return { name: first, fn: second };
    if (isOptions(second) && isBody(third)) {
      return { ...second, name: first, fn: third } as Deno.TestDefinition;
    }
    return undefined;
  }
  if (isOptions(first)) {
    if (isBody(first.fn) && typeof first.name === "string") {
      return first as unknown as Deno.TestDefinition;
    }
    if (isBody(second)) {
      const name = typeof first.name === "string" ? first.name : second.name;
      if (name.length > 0) {
        return { ...first, name, fn: second } as Deno.TestDefinition;
      }
    }
    return undefined;
  }
  if (isBody(first) && first.name.length > 0) {
    return { name: first.name, fn: first };
  }
  return undefined;
}

/**
 * Whether this process may write into the spool. Querying a permission
 * needs no permission, so this answers before anything is attempted and
 * without a warning for a process that was never going to record.
 */
export function writableSpool(spool: string | undefined): boolean {
  if (spool === undefined) return false;
  try {
    return Deno.permissions.querySync({ name: "write", path: spool }).state ===
      "granted";
  } catch {
    return false;
  }
}

function loadSkipList(env: Environment): SkipList | undefined {
  const path = readEnv(SKIP_LIST_VARIABLE, env);
  if (path === undefined || path.length === 0) return undefined;
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (error) {
    console.warn(`test records: cannot read the skip list ${path}: ${error}`);
    return undefined;
  }
  const skips = parseSkipList(text);
  if (skips === undefined) {
    console.warn(`test records: the skip list ${path} is malformed`);
  }
  return skips;
}
