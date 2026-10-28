/**
 * Test-identity aliases: the parsing, validation, and resolution shared by
 * the alias gate and every reader of the record store. The alias directory —
 * tasks/test-identity-aliases at the repository root — is append-only
 * history, held as one JSON-lines file per test file: an alias line goes in
 * the file named after the test file holding the renamed test, so that two
 * changes renaming tests in different test files append to different files.
 * The division is for the sake of merges alone; every reader takes the
 * directory as one set of aliases. Each line maps an old identity, or a whole
 * scope for package renames, or the repository path of a moved directory or
 * file, to
 * its replacement, with the date of the rename.
 * A reader resolves aliases transitively and applies one only to records from
 * days strictly before its date, so the pre-rename history of a test joins
 * its post-rename history under today's name.
 */

import { join } from "@std/path";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { TestIdentity } from "./schema.ts";
import { repositoryRoot } from "./paths.ts";

/** Repository-root-relative path of the alias directory. */
export const ALIAS_DIRECTORY = "tasks/test-identity-aliases";

/** Suffix of every alias file in the alias directory. */
export const ALIAS_FILE_SUFFIX = ".jsonl";

/** An end of a full-identity mapping, or of a whole-scope one without `n`. */
export interface AliasIdentity {
  k: string;
  s: string;
  n?: string;
}

/**
 * An end of a moved-path mapping: the repository-relative path of a directory
 * or a file.
 */
export interface AliasPath {
  p: string;
}

/**
 * One alias line: a full-identity mapping, a whole-scope mapping, or a
 * moved-path mapping. A moved path renames every identity whose name holds
 * that path, in any kind and scope. Both ends of a line are the same
 * shape.
 */
export interface AliasLine {
  /** ISO date of the rename; readers apply the alias to older records. */
  date: string;

  from: AliasIdentity | AliasPath;
  to: AliasIdentity | AliasPath;
}

/**
 * Whether a value is the end of a moved-path mapping: an object holding a
 * relative path of one or more segments and nothing else.
 */
function isPathPart(value: unknown): value is AliasPath {
  if (!isObjectOrArray(value)) return false;
  if (Object.keys(value).join(",") !== "p" || typeof value.p !== "string") {
    return false;
  }
  return value.p.split("/").every((segment) =>
    segment !== "" && segment !== "." && segment !== ".."
  );
}

function isIdentityPart(value: unknown, wholeScope: boolean): boolean {
  if (!isObjectOrArray(value)) return false;
  const part = value as Record<string, unknown>;
  const expectedKeys = wholeScope ? ["k", "s"] : ["k", "n", "s"];
  if (Object.keys(part).sort().join(",") !== expectedKeys.join(",")) {
    return false;
  }
  if (typeof part.k !== "string" || part.k.length === 0) return false;
  if (typeof part.s !== "string" || part.s.length === 0) return false;
  if (wholeScope) return part.n === undefined;
  return typeof part.n === "string" && part.n.length > 0;
}

function isCalendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const stamp = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(stamp.getTime()) &&
    stamp.toISOString().slice(0, 10) === date;
}

/** Parses one line; returns an error message instead of a value when bad. */
export function parseAliasLine(line: string): AliasLine | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "is not JSON";
  }
  if (typeof value !== "object" || value === null) return "is not an object";
  const alias = value as Record<string, unknown>;
  if (
    typeof alias.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(alias.date)
  ) {
    return "has no ISO date";
  }
  if (!isCalendarDate(alias.date)) {
    return "has an impossible calendar date";
  }
  if (isObjectOrArray(alias.from) && "p" in alias.from) {
    if (!isPathPart(alias.from)) return "has a malformed `from`";
    if (!isPathPart(alias.to)) return "maps a path to something other than one";
    return value as AliasLine;
  }
  const wholeScope = (alias.from as Record<string, unknown> | null)?.n ===
    undefined;
  if (!isIdentityPart(alias.from, wholeScope)) {
    return "has a malformed `from`";
  }
  if (!isIdentityPart(alias.to, wholeScope)) {
    return wholeScope
      ? "maps a whole scope to a single identity"
      : "has a malformed `to`";
  }
  return value as AliasLine;
}

/**
 * The lookup key of an alias endpoint; null marks a whole-scope entry, and a
 * one-element array a moved path.
 */
export function aliasKeyOf(part: AliasIdentity | AliasPath): string {
  // A JSON array: printable, and unambiguous for names with any content.
  return "p" in part
    ? JSON.stringify([part.p])
    : JSON.stringify([part.k, part.s, part.n ?? null]);
}

/**
 * Where a path occurs in a name as a path of its own: not continuing a longer
 * path segment or a longer path on either side.
 */
function pathOccurrences(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w.-])`, "g");
}

/**
 * Every path that occurs in a name as a path of its own, in the sense of
 * {@link pathOccurrences}: each run of path characters, and each of its
 * leading parts that ends where a segment does.
 */
function pathsIn(name: string): string[] {
  const paths: string[] = [];
  for (const [run] of name.matchAll(/[\w./-]+/g)) {
    let end = run.indexOf("/");
    while (end !== -1) {
      paths.push(run.slice(0, end));
      end = run.indexOf("/", end + 1);
    }
    paths.push(run);
  }
  return paths;
}

/** One file of an alias directory. */
export type AliasFile = {
  /** File name within the directory. */
  name: string;

  /** The file's whole text. */
  text: string;
};

/** What an alias directory holds. */
export type AliasDirectory = {
  /** The alias files directly inside the directory, in order of name. */
  files: AliasFile[];

  /**
   * Names of the directory's other entries, in order. No reader loads
   * these.
   */
  unread: string[];
};

/**
 * Reads an alias directory: every `.jsonl` file directly inside it, and the
 * names of whatever else is there. A missing directory holds nothing.
 */
export async function readAliasDirectory(
  directory: string,
): Promise<AliasDirectory> {
  const names: string[] = [];
  const unread: string[] = [];
  try {
    for await (const entry of Deno.readDir(directory)) {
      const isAliasFile = entry.isFile &&
        entry.name.endsWith(ALIAS_FILE_SUFFIX);
      (isAliasFile ? names : unread).push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { files: [], unread: [] };
    throw error;
  }
  names.sort();
  unread.sort();
  const files = await Promise.all(names.map(async (name) => ({
    name,
    text: await Deno.readTextFile(join(directory, name)),
  })));
  return { files, unread };
}

/**
 * Structural problems across the whole set: a second mapping from one
 * identity, and cycles under transitive resolution.
 */
export function aliasGraphProblems(aliases: readonly AliasLine[]): string[] {
  const problems: string[] = [];
  const byFrom = new Map<string, AliasLine>();
  for (const alias of aliases) {
    const from = aliasKeyOf(alias.from);
    if (byFrom.has(from)) {
      problems.push(
        `two mappings from ${JSON.stringify(alias.from)}; an identity is ` +
          "mapped at most once",
      );
      continue;
    }
    byFrom.set(from, alias);
    if (
      "p" in alias.from && "p" in alias.to &&
      pathsIn(alias.to.p).includes(alias.from.p)
    ) {
      problems.push(
        `${JSON.stringify(alias.from)} moves into a path that holds it; ` +
          "resolving it would never end",
      );
    }
  }
  for (const alias of byFrom.values()) {
    const start = aliasKeyOf(alias.from);
    const seen = new Set<string>([start]);
    let cursor = byFrom.get(aliasKeyOf(alias.to));
    while (cursor !== undefined) {
      const from = aliasKeyOf(cursor.from);
      if (from === start) {
        problems.push(
          `cycle through ${JSON.stringify(alias.from)}; a rename back is a ` +
            "new rename with its own line",
        );
        break;
      }
      if (seen.has(from)) break;
      seen.add(from);
      cursor = byFrom.get(aliasKeyOf(cursor.to));
    }
  }
  return problems;
}

/**
 * Resolves recorded identities to their current names. An alias applies to
 * a record from a day strictly before the alias's date; resolution follows
 * chains transitively, prefers a full-identity mapping over a whole-scope
 * one, and that over a moved path, at each step, and stops at any
 * repetition, so a malformed cycle cannot hang a reader.
 */
export class AliasResolver {
  #byIdentity = new Map<string, { date: string; to: AliasIdentity }>();
  #byScope = new Map<string, { date: string; to: AliasIdentity }>();
  #byPath = new Map<string, { date: string; from: RegExp; to: string }>();

  constructor(aliases: readonly AliasLine[]) {
    for (const { date, from, to } of aliases) {
      const key = aliasKeyOf(from);
      if ("p" in from || "p" in to) {
        if ("p" in from && "p" in to && !this.#byPath.has(from.p)) {
          this.#byPath.set(from.p, {
            date,
            from: pathOccurrences(from.p),
            to: to.p,
          });
        }
        continue;
      }
      const map = from.n === undefined ? this.#byScope : this.#byIdentity;
      if (!map.has(key)) map.set(key, { date, to });
    }
  }

  /** Whether any alias is loaded at all. */
  get empty(): boolean {
    return this.#byIdentity.size === 0 && this.#byScope.size === 0 &&
      this.#byPath.size === 0;
  }

  /**
   * The current identity of a test recorded on `recordDay`, given as
   * "yyyy/mm/dd" or "yyyy-mm-dd".
   */
  resolve(test: TestIdentity, recordDay: string): TestIdentity {
    const day = recordDay.replaceAll("/", "-");
    let current = test;
    const seen = new Set<string>();
    const movedPaths = new Set<string>();
    for (;;) {
      const key = JSON.stringify([current.k, current.s, current.n]);
      if (seen.has(key)) return current;
      seen.add(key);
      const exact = this.#byIdentity.get(aliasKeyOf(current));
      if (exact !== undefined && day < exact.date) {
        current = {
          ...current,
          k: exact.to.k,
          s: exact.to.s,
          n: exact.to.n ?? current.n,
        };
        continue;
      }
      const scope = this.#byScope.get(
        aliasKeyOf({ k: current.k, s: current.s }),
      );
      if (scope !== undefined && day < scope.date) {
        current = {
          ...current,
          k: scope.to.k,
          s: scope.to.s,
        };
        continue;
      }
      const n = this.#moveOnePath(current.n, day, movedPaths);
      if (n === undefined) return current;
      current = { ...current, n };
    }
  }

  /**
   * `text` with every moved path it holds as a path of its own renamed, as
   * the moved-path aliases rename a test name recorded on `recordDay`. A
   * path that is not a test's name, such as the file a test lives in or a
   * workspace member's directory, moves this way.
   */
  resolvePath(text: string, recordDay: string): string {
    const day = recordDay.replaceAll("/", "-");
    const movedPaths = new Set<string>();
    let current = text;
    for (;;) {
      const next = this.#moveOnePath(current, day, movedPaths);
      if (next === undefined) return current;
      current = next;
    }
  }

  /**
   * Helper for {@link resolve} and {@link resolvePath}, which renames the
   * longest moved path `name` holds that is not in `movedPaths`, or returns
   * undefined when there is none. Each moved path applies at most once, so
   * that resolution ends even for a move into a path that contains the moved
   * one.
   */
  #moveOnePath(
    name: string,
    day: string,
    movedPaths: Set<string>,
  ): string | undefined {
    let moved: { path: string; from: RegExp; to: string } | undefined;
    for (const path of pathsIn(name)) {
      const alias = this.#byPath.get(path);
      if (alias === undefined || movedPaths.has(path)) continue;
      if (day >= alias.date) continue;
      if (moved === undefined || path.length > moved.path.length) {
        moved = { path, from: alias.from, to: alias.to };
      }
    }
    if (moved === undefined) return undefined;
    movedPaths.add(moved.path);
    return name.replace(moved.from, moved.to);
  }
}

/**
 * Loads an alias directory into a resolver. With no path given, the
 * directory is found at its fixed place under the enclosing repository's
 * root; a missing directory, or a run outside any repository, resolves every
 * identity to itself. Unparsable lines are skipped — the check-test-aliases
 * gate is where they fail, not every reader.
 */
export async function loadAliasResolver(path?: string): Promise<AliasResolver> {
  const directory = path ??
    (() => {
      const root = repositoryRoot();
      return root === undefined ? undefined : join(root, ALIAS_DIRECTORY);
    })();
  const aliases: AliasLine[] = [];
  const files = directory === undefined
    ? []
    : (await readAliasDirectory(directory)).files;
  for (const { text } of files) {
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const parsed = parseAliasLine(line);
      if (typeof parsed !== "string") aliases.push(parsed);
    }
  }
  return new AliasResolver(aliases);
}
