#!/usr/bin/env -S deno run --allow-read --allow-write
import { fromFileUrl } from "@std/path";
import { SANDBOX_WITHHELD_GLOBALS } from "@commonfabric/utils/sandbox-contract";

/**
 * Removes the declaration of each global a sandbox compartment does not
 * provide, so the pattern compiler stops offering names that throw at runtime.
 *
 * Only the value declaration goes. The matching `interface` stays, so a
 * pattern can still write `let bytes: Float32Array` — it just cannot reach the
 * constructor. `new Float32Array()` becomes "'Float32Array' only refers to a
 * type, but is being used as a value here" at compile time. A name with no
 * same-named interface, such as `Proxy`, gives "Cannot find name" instead.
 *
 * Three declaration shapes appear in TypeScript's libraries, all handled here:
 * the one-line `declare var Atomics: Atomics;` or
 * `declare function setTimeout(...): number;`, the braced
 * `declare var Blob: { ... };`, and `declare namespace Intl { ... }`, which
 * mixes types and values. Removing a namespace whole would take its types with
 * it, so only its value members (`var`, `const`, `function`, ...) are dropped;
 * the interfaces stay, and a pattern can still name an `Intl.NumberFormatOptions`
 * even though it can no longer construct a formatter. A namespace binds its
 * name as a value only while it holds such a member, so removing them all turns
 * `Intl` back into a types-only declaration that binds nothing. The namespace
 * body is walked by indentation rather than brace depth, because its JSDoc
 * comments carry unbalanced braces (`{@link}`, `@throws {TypeError}`) that a
 * depth counter would trip over.
 *
 * Every other byte is preserved, including each line's original ending,
 * because `es2023.d.ts` is CRLF and `dom.d.ts` is LF.
 */

const withheldGlobalSet: ReadonlySet<string> = new Set(
  SANDBOX_WITHHELD_GLOBALS,
);

/** Splits text into lines that each keep their own line ending. */
function splitKeepingLineEndings(source: string): string[] {
  return source.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function countUnbracketed(line: string, bracket: string): number {
  let count = 0;
  for (const character of line) {
    if (character === bracket) count += 1;
  }
  return count;
}

/**
 * Returns the index one past the declaration that starts at `start`, or
 * undefined when the braces never balance.
 */
function declarationEnd(lines: string[], start: number): number | undefined {
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    depth += countUnbracketed(line, "{") - countUnbracketed(line, "}");
    if (depth === 0 && line.trimEnd().endsWith(";")) return index + 1;
    if (depth < 0) return undefined;
  }
  return undefined;
}

/** Leading spaces or tabs of a line, without its content or line ending. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

/**
 * The bounds of a `declare namespace` body, found by indentation so a brace in
 * a JSDoc comment cannot throw the scan off. `declare namespace` is top-level,
 * so the body ends at the first `}` in the header's own column and every direct
 * member is indented one level in. Returns the closing line and that member
 * indentation, or undefined for an empty namespace.
 */
function namespaceBody(
  lines: string[],
  headerIndex: number,
): { closer: number; childIndent: string } | undefined {
  const closerPrefix = `${indentOf(lines[headerIndex])}}`;
  let closer = lines.length;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith(closerPrefix)) {
      closer = index;
      break;
    }
  }
  for (let index = headerIndex + 1; index < closer; index += 1) {
    if (lines[index].trim() !== "") {
      return { closer, childIndent: indentOf(lines[index]) };
    }
  }
  return undefined;
}

function memberStartPattern(childIndent: string): RegExp {
  return new RegExp(`^${childIndent}(?:var|function|const|let|class|enum)\\b`);
}

/**
 * Marks for removal the value members declared directly in the namespace whose
 * header is at `headerIndex`, leaving its interfaces and type aliases. A member
 * is a single line ending in `;`, a signature or type wrapped across several
 * lines, or a braced block that closes with a `}` back at the member's
 * indentation. Returns whether it removed anything.
 */
function dropNamespaceValueMembers(
  lines: string[],
  headerIndex: number,
  drop: Set<number>,
): boolean {
  const body = namespaceBody(lines, headerIndex);
  if (!body) return false;
  const { closer, childIndent } = body;
  const memberStart = memberStartPattern(childIndent);
  const memberClose = `${childIndent}}`;
  let removedAny = false;

  for (let index = headerIndex + 1; index < closer; index += 1) {
    if (!memberStart.test(lines[index])) continue;

    let end: number;
    if (lines[index].trimEnd().endsWith("{")) {
      // A braced body: its JSDoc carries unbalanced braces, so the close is
      // found by indentation — the `}` back in the member's own column.
      end = index + 1;
      while (end < closer && !lines[end].startsWith(memberClose)) end += 1;
      if (end >= closer) {
        throw new Error(
          `Unbalanced namespace member at line ${index + 1}`,
        );
      }
      end += 1;
    } else {
      // A single line, or a signature or type wrapped across several lines
      // with no braced body. The latter carries no JSDoc, so brace depth
      // locates its terminating `;` safely.
      const declarationClose = declarationEnd(lines, index);
      if (declarationClose === undefined) {
        throw new Error(
          `Unbalanced namespace member at line ${index + 1}`,
        );
      }
      end = declarationClose;
    }
    for (let line = index; line < end; line += 1) drop.add(line);
    // Take one trailing blank line with it, matching the top-level case.
    if (end < lines.length && lines[end].trim() === "") drop.add(end);
    removedAny = true;
    index = end - 1;
  }
  return removedAny;
}

/** True when the namespace at `headerIndex` still declares a value member. */
function namespaceHasValueMember(
  lines: string[],
  headerIndex: number,
): boolean {
  const body = namespaceBody(lines, headerIndex);
  if (!body) return false;
  const memberStart = memberStartPattern(body.childIndent);
  for (let index = headerIndex + 1; index < body.closer; index += 1) {
    if (memberStart.test(lines[index])) return true;
  }
  return false;
}

export interface StripResult {
  text: string;

  /** Names whose declaration was found and removed. */
  removed: string[];
}

export function stripWithheldGlobals(
  source: string,
  names: ReadonlySet<string> = withheldGlobalSet,
): StripResult {
  const lines = splitKeepingLineEndings(source);
  const drop = new Set<number>();
  const removed: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const namespaceMatch = /^declare namespace ([A-Za-z_$][\w$]*)\b/.exec(
      lines[index],
    );
    if (namespaceMatch) {
      if (
        names.has(namespaceMatch[1]) &&
        dropNamespaceValueMembers(lines, index, drop)
      ) {
        removed.push(namespaceMatch[1]);
      }
      continue;
    }

    const match = /^declare (?:var|function) ([A-Za-z_$][\w$]*)\s*[:=(<]/.exec(
      lines[index],
    );
    if (!match || !names.has(match[1])) continue;

    const end = declarationEnd(lines, index);
    if (end === undefined) {
      throw new Error(
        `Unbalanced declaration for "${match[1]}" at line ${index + 1}`,
      );
    }
    for (let line = index; line < end; line += 1) drop.add(line);
    // Take one trailing blank line with it, so removing a declaration does not
    // leave a double blank behind.
    if (end < lines.length && lines[end].trim() === "") drop.add(end);
    removed.push(match[1]);
    index = end - 1;
  }

  const text = lines.filter((_, index) => !drop.has(index)).join("");
  // A namespace name is met once per merged block, so report it once.
  return { text, removed: [...new Set(removed)] };
}

/**
 * Withheld names still bound as values after a strip. A top-level
 * `declare var`/`function`/`const`/... binds its name outright; a
 * `declare namespace` binds its name only while it holds a value member, so it
 * counts only then — an emptied namespace whose interfaces remain does not.
 * This is the post-strip check that no withheld global slipped through, whether
 * because the stripper missed a form or the type libraries were not re-stripped.
 */
export function stillDeclared(
  text: string,
  names: ReadonlySet<string> = withheldGlobalSet,
): string[] {
  const lines = splitKeepingLineEndings(text);
  const found = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const namespaceMatch = /^declare namespace ([A-Za-z_$][\w$]*)\b/.exec(
      lines[index],
    );
    if (namespaceMatch) {
      if (
        names.has(namespaceMatch[1]) &&
        namespaceHasValueMember(lines, index)
      ) {
        found.add(namespaceMatch[1]);
      }
      continue;
    }

    const valueMatch =
      /^declare (?:var|function|const|let|class|enum) ([A-Za-z_$][\w$]*)/.exec(
        lines[index],
      );
    if (valueMatch && names.has(valueMatch[1])) found.add(valueMatch[1]);
  }

  return [...found];
}

/** The type libraries the pattern compiler serves that bind globals. */
const TYPE_LIB_FILES = ["es2023.d.ts", "dom.d.ts"] as const;

const STRIP_TASK = "deno task strip-withheld-globals";

function typeLibPath(file: string): string {
  return fromFileUrl(new URL(`../assets/types/${file}`, import.meta.url));
}

/**
 * Runs the command-line interface and returns the process exit code. With
 * `--check` it reports whether the checked-in libraries still declare a
 * withheld global; otherwise it rewrites them.
 */
export interface RunCliOptions {
  /** Type-library file names to process; defaults to the checked-in set. */
  files?: readonly string[];

  /** Reads a file's text; defaults to the filesystem. */
  readFile?: (path: string) => Promise<string>;

  /** Writes a file's text; defaults to the filesystem. */
  writeFile?: (path: string, text: string) => Promise<void>;
}

export async function runCli(
  args: string[],
  options: RunCliOptions = {},
): Promise<number> {
  const check = args.includes("--check");
  const files = options.files ?? TYPE_LIB_FILES;
  const readFile = options.readFile ?? Deno.readTextFile;
  const writeFile = options.writeFile ?? Deno.writeTextFile;
  let stale = false;

  for (const file of files) {
    const path = typeLibPath(file);
    const before = await readFile(path);
    const { text, removed } = stripWithheldGlobals(before);

    const unstrippable = stillDeclared(text);
    if (unstrippable.length > 0) {
      stale = true;
      console.error(
        `${file} still declares ${unstrippable.join(", ")} after stripping. ` +
          `The declaration is in a form stripWithheldGlobals does not handle; ` +
          `remove it by hand, or teach the stripper the form.`,
      );
    }

    if (check) {
      if (removed.length > 0) {
        stale = true;
        console.error(
          `${file} still declares ${removed.join(", ")}. ` +
            `Run \`${STRIP_TASK}\` to remove them.`,
        );
      }
      continue;
    }

    if (text !== before) await writeFile(path, text);
    console.log(
      removed.length > 0
        ? `${file}: removed ${removed.join(", ")}`
        : `${file}: already up to date`,
    );
  }

  if (check && !stale) {
    console.log("Type libraries declare no withheld globals.");
  }
  return stale ? 1 : 0;
}

/**
 * Entry point: runs the CLI and exits with its status, but only when this
 * module is the program's entry point. `isMain` and `exit` are injectable so
 * the entry behavior can be exercised without terminating the test runner.
 */
export async function cliMain(
  args: string[] = Deno.args,
  isMain: boolean = import.meta.main,
  exit: (code: number) => void = Deno.exit,
): Promise<void> {
  if (!isMain) return;
  exit(await runCli(args));
}

await cliMain();
