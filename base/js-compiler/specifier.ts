import { dirname, join } from "@std/path/posix";
import type { Source } from "./interface.ts";

/**
 * Resolve an import specifier relative to the importing source's path.
 * Relative specifiers (`./`, `../`) are joined against the importer's
 * directory; bare specifiers (e.g. `commonfabric`) are returned unchanged.
 *
 * Lives outside `typescript/resolver.ts` so runtime consumers (the worker's
 * module-record path) can import it without a static edge into the TypeScript
 * compiler — this module must stay free of `typescript` value imports.
 */
export function resolveImportSpecifier(
  specifier: string,
  from: Source,
): string {
  return isImportRelative(specifier)
    ? resolveAgainstModule(specifier, from.name)
    : specifier;
}

/**
 * Whether an import specifier is written relative to the importing module.
 *
 * The two prefixes are the ones the language gives a module specifier, and a
 * specifier with neither names a package rather than a file.
 */
function isImportRelative(specifier: string): boolean {
  return specifier.substring(0, 2) === "./" ||
    specifier.substring(0, 3) === "../";
}

/**
 * Whether a data-file path is written relative to the module that reads it.
 *
 * Every data-file path names a file the package carries, so there is no bare
 * specifier to hold back the way an import has: a path is either grounded at
 * the package root or relative to the reader. `./` contributes nothing to a
 * directory walk, so `data/cities.json` and `./data/cities.json` are one path.
 */
function isDataFileRelative(path: string): boolean {
  return path.substring(0, 1) !== "/";
}

/** Join a relative path against the directory of the module named by `fromName`. */
function resolveAgainstModule(path: string, fromName: string): string {
  return join(dirname(fromName), path);
}

/**
 * Resolve a `dataFile()` path against the module that reads it, as
 * {@link resolveImportSpecifier} resolves an import against the module that
 * imports it. `./words.txt`, `words.txt` and `../shared/words.txt` name files
 * beside or above the reader, so the same source names the same file whichever
 * directory the program was rooted at.
 *
 * A path beginning with `/` is grounded at the package root and returned
 * unchanged, so `/data/cities.json` names one file for every module in the
 * package.
 *
 * Takes the reading module's path rather than its {@link Source} because the
 * runtime resolves a read from a module record, which holds the path and not
 * the text.
 */
export function resolveDataFilePath(path: string, fromName: string): string {
  return isDataFileRelative(path) ? resolveAgainstModule(path, fromName) : path;
}

/**
 * Whether a relative import climbs above the program root.
 *
 * Source names inside a program are grounded absolute paths (`/main.tsx`), and
 * a posix join against an absolute base drops any `..` segments that would
 * climb past `/`. {@link resolveImportSpecifier} therefore maps an escaping
 * import to an in-root identifier that names a file the author never wrote.
 * This predicate answers whether that clamping would occur, by rejoining
 * against the importer's directory made relative: a relative base preserves
 * leading `..` segments, so an escape survives as a leading `..` in the
 * result.
 *
 * Only grounded importers can be judged: for a source whose name carries no
 * leading `/` there is no root to escape, and the answer is `false`.
 *
 * Kept separate from {@link resolveImportSpecifier}, which stays total: the
 * identity paths (module and entry identity, the worker's module-record
 * compiler) must keep producing the same identifier for every input the
 * compile path accepted, so refusing an escape is the graph resolver's call,
 * not this module's.
 */
export function importEscapesProgramRoot(
  specifier: string,
  from: Source,
): boolean {
  return isImportRelative(specifier) &&
    escapesProgramRoot(specifier, from.name);
}

function escapesProgramRoot(path: string, fromName: string): boolean {
  if (fromName.substring(0, 1) !== "/") return false;
  // Every leading slash: an HTTP-derived name preserves its URL pathname,
  // which may begin "//...", and a base left absolute would clamp again.
  const relativeDir = dirname(fromName).replace(/^\/+/, "");
  const joined = join(relativeDir, path);
  return joined === ".." || joined.substring(0, 3) === "../";
}

/**
 * Refuse an import that climbs above the program root, naming the import and
 * the importer. Every graph walk that resolves raw sources calls this before
 * {@link resolveImportSpecifier}, so the refusal reads the same wherever the
 * escape surfaces; walks over already-compiled programs do not, because their
 * inputs passed a walk that did.
 */
export function assertImportInsideProgramRoot(
  specifier: string,
  from: Source,
): void {
  if (importEscapesProgramRoot(specifier, from)) {
    throw new Error(
      `Import "${specifier}" in "${from.name}" escapes the program root.`,
    );
  }
}

/**
 * Refuse a `dataFile()` path that climbs above the program root, naming the
 * path and the module that reads it. {@link resolveDeclaredDataFile} calls this
 * before resolving, so the refusal names the path the author wrote rather than
 * the in-root path the clamping join would produce.
 *
 * {@link resolveDataFilePath} stays total for the same reason
 * {@link resolveImportSpecifier} does: the runtime read resolves a path the
 * build already accepted, and must produce the same answer for it.
 */
export function assertDataFileInsideProgramRoot(
  path: string,
  from: Source,
): void {
  if (isDataFileRelative(path) && escapesProgramRoot(path, from.name)) {
    throw new Error(
      `Data file "${path}" read in "${from.name}" escapes the program root.`,
    );
  }
}

/**
 * Resolves a path a `dataFile()` call in `from` names to the name the program
 * stores that file under, which is the name the runtime looks it up by.
 *
 * @throws If the path climbs above the program root.
 */
export function resolveDeclaredDataFile(path: string, from: Source): string {
  assertDataFileInsideProgramRoot(path, from);
  return resolveDataFilePath(path, from.name);
}
