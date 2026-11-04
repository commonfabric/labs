/**
 * Whether a declaration belongs to TypeScript's default library — what the
 * native-type formatter and the node-based analyzer's library-alias rules ask
 * before they treat a name such as `Readonly` or `Map` as the library's rather
 * than an author's, and what tells a well-known symbol from an author's. The
 * program's answer is believed when a caller has one; the file-name fallback
 * serves a generator running without a program.
 */
import ts from "typescript";

/**
 * Whether `fileName` is a name the default library's declaration files ship
 * under: TypeScript's own `lib.d.ts` and `lib.<target>.d.ts`, the bare
 * `es20xx.d.ts` / `dom.d.ts` / `jsx.d.ts` this repository bundles
 * (`base/static/assets/types`, mounted at `$types/` by the compiler host),
 * and Node's `@types` package.
 *
 * This is the FALLBACK, for a generator running without a program — a test
 * harness that loads the libraries as plain root files. It is never the first
 * word: when the program is reachable, its own `isSourceFileDefaultLibrary`
 * decides (see {@link isDefaultLibrarySourceFile}).
 */
export function isDefaultLibraryFileName(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, "/");
  return normalized === "lib.d.ts" ||
    normalized.endsWith("/lib.d.ts") ||
    /(^|\/)lib\.[^/]+\.d\.ts$/i.test(normalized) ||
    /(^|\/)(es\d+(?:\.[^/]+)?|dom|jsx)\.d\.ts$/i.test(normalized) ||
    /(^|\/)node_modules\/@types\/node\//.test(normalized);
}

/** A caller's own word on default-library membership, where it has one. */
export interface DefaultLibraryOracle {
  readonly isDefaultLibrarySourceFile?: (sourceFile: ts.SourceFile) => boolean;
}

/**
 * Whether `sourceFile` belongs to the default library: the caller's own word
 * when it has one — the transformer hands down
 * `program.isSourceFileDefaultLibrary`, which the compiler host makes truthful
 * by mounting the bundled libraries under its default-library location — and
 * the file-name fallback otherwise. A supplied `false` is believed; only an
 * absent predicate falls back.
 */
export function isDefaultLibrarySourceFile(
  sourceFile: ts.SourceFile,
  context: DefaultLibraryOracle,
): boolean {
  return context.isDefaultLibrarySourceFile?.(sourceFile) ??
    isDefaultLibraryFileName(sourceFile.fileName);
}

/**
 * Whether `type` is one of the language's well-known symbols, such as
 * `Symbol.iterator`: a `unique symbol` the default library declares on
 * `SymbolConstructor`. The language never enters a well-known symbol in the
 * symbol registry, so no value the runtime stores is one.
 */
export function isWellKnownSymbol(
  type: ts.Type,
  context: DefaultLibraryOracle,
): boolean {
  if ((type.flags & ts.TypeFlags.UniqueESSymbol) === 0) return false;
  const owner = type.symbol.valueDeclaration?.parent;
  return owner !== undefined && ts.isInterfaceDeclaration(owner) &&
    owner.name.text === "SymbolConstructor" &&
    isDefaultLibrarySourceFile(owner.getSourceFile(), context);
}
