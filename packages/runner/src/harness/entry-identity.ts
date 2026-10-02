import type { Source } from "@commonfabric/js-compiler";
import { resolveImportSpecifier } from "@commonfabric/js-compiler/specifier";

import { computeModuleIdentities } from "../sandbox/module-record-compiler.ts";
import { attachDeclaredDataFiles } from "./declared-data-files.ts";
import {
  compilerStack,
  ensureCompilerStack,
} from "./deferred-compiler-stack.ts";
import {
  type ModuleImportEdges,
  resolveModuleImports,
} from "./module-identity.ts";

// A fixed, arbitrary program id. `computeModuleIdentities` strips this prefix
// before hashing (see `stripIdentityPrefix`), so its exact value never reaches
// the hash — only the per-file relative paths and contents do. Using a constant
// (rather than the engine's content-hash id) is what makes this a pure function
// of `(main, files)` while still matching the engine's stored identity.
const ENTRY_ID = "cf-entry-id";

function prefixName(name: string): string {
  return `/${ENTRY_ID}${name}`;
}

/**
 * The entry-module content identity of `main` within `files`, computed WITHOUT
 * compiling — the same value `Engine.compileToRecordGraph` stores as
 * `patternIdentity.identity` for a same-build compile of the same source
 * package. A program carrying extra source roots or data files must name
 * them in `options`: the compiler folds both into the entry's hash, so the
 * bare import-closure identity is not the stored one for such a program.
 *
 * `files` must include the entry's full internal import closure (a superset is
 * fine — unreachable files neither affect the entry's identity nor are they
 * validated). Ambient (non-rooted) `.d.ts` files are dropped as the engine
 * drops them; an authored, rooted declaration file is a module like any
 * other, and a data file is kept whatever its name says. `contents` must be
 * the **authored**
 * (pre-transform) source: the engine hashes pristine authored bytes, restoring
 * them via `pristineModuleSources` after the helper-injection pretransform, so
 * hashing the injected form here would diverge (see
 * `test/module-identity-engine.test.ts` "CT-1740").
 *
 * The caller must have `await ensureCompilerStack()`-ed first: import scanning
 * (via `resolveModuleImports`) parses with the TS parser.
 *
 * Throws if, walking the entry's reachable closure, any module still has an
 * internal-looking dependency (`./`, `../`, `/`) that did not resolve to an
 * included file — the closure is incomplete and the identity would be silently
 * wrong. Also throws on a `cf:` fabric import, which the light path does not
 * model (fabric mounts fold the imported pattern's identity into the leaf; use
 * the full compile path for those).
 */
export function computeEntryIdentity(
  main: string,
  files: readonly Source[],
  options: EntryIdentityOptions = {},
): string {
  const dataPaths = [...new Set(options.dataFiles ?? [])].sort();
  if (dataPaths.includes(main)) {
    throw new Error(`the program entry \`${main}\` cannot be a data file`);
  }
  const rootPaths = [...new Set(options.sourceRoots ?? [])]
    .filter((root) => root !== main);

  // Partition before the `.d.ts` filter and before any parsing: a data file
  // is stored uninterpreted whatever its name says, and import-like text
  // inside one is data, not an import. The `.d.ts` line matches the engine's
  // `persistableSourceFiles`: authored (rooted) declaration files are part of
  // the closure and the hash; only ambient ones are dropped.
  const dataSet = new Set(dataPaths);
  const moduleFiles = files.filter((f) =>
    !dataSet.has(f.name) &&
    (!f.name.endsWith(".d.ts") || f.name.startsWith("/"))
  );
  const dataSources = files.filter((f) => dataSet.has(f.name));
  const prefixedCode = moduleFiles.map((f) => ({
    name: prefixName(f.name),
    contents: f.contents,
  }));
  const prefixedData = dataSources.map((f) => ({
    name: prefixName(f.name),
    contents: f.contents,
  }));
  const entryKey = prefixName(main);

  const codeNames = new Set(prefixedCode.map((file) => file.name));
  for (const root of rootPaths) {
    if (!codeNames.has(prefixName(root))) {
      throw new Error(
        `package path \`${root}\` is not among the provided files`,
      );
    }
  }
  const dataNames = new Set(dataSources.map((file) => file.name));
  for (const path of dataPaths) {
    if (!dataNames.has(path)) {
      throw new Error(
        `package path \`${path}\` is not among the provided files`,
      );
    }
  }

  // Also validates each entry is present (throws if it is not among the
  // files), so `identities` is guaranteed to contain `entryKey` below. Every
  // source root is an entry of its own, so each root's closure has to be as
  // complete as the main entry's.
  const edges = resolveModuleImports({ main: entryKey, files: prefixedCode });
  assertClosureComplete(main, entryKey, edges);
  for (const root of rootPaths) {
    assertClosureComplete(root, prefixName(root), edges);
  }

  const identities = computeModuleIdentities(
    [...prefixedCode, ...prefixedData],
    {
      idPrefix: `/${ENTRY_ID}`,
      ...(rootPaths.length || dataPaths.length
        ? {
          sourcePackage: {
            entryPath: entryKey,
            rootPaths: rootPaths.map(prefixName),
            dataPaths: dataPaths.map(prefixName),
          },
        }
        : {}),
    },
  );
  return identities.get(entryKey)!;
}

/**
 * The package half of a program's identity. The compiler folds extra source
 * roots and data files into the entry's hash, so a program carrying either
 * has an identity its bare import closure does not produce; passing them
 * here folds them the same way. Every named path must be among `files`.
 */
export interface EntryIdentityOptions {
  /** Additional entry roots beyond `main`. */
  sourceRoots?: readonly string[];

  /** Files stored uninterpreted as data. */
  dataFiles?: readonly string[];
}

/** What {@link resolveEntryIdentity} assembles beyond the entry, and how. */
export interface ResolveEntryIdentityOptions extends EntryIdentityOptions {
  /**
   * Reads a data file by the rooted name the program stores it under. Omitted,
   * data files are read through `readFile`, which is right wherever source and
   * data are read the same way. A reader that decodes source text differently
   * — consuming a leading byte order mark, say — supplies this, so that each
   * data file is hashed byte for byte as the program stores it.
   */
  readDataFile?: (name: string) => Promise<string>;
}

/**
 * Helper for `computeEntryIdentity()`, which checks a root's reachable closure
 * against the shared import graph. Throws for dangling internal or fabric
 * imports; unreachable files do not affect this root's validation.
 */
function assertClosureComplete(
  main: string,
  entryKey: string,
  edges: ReadonlyMap<string, ModuleImportEdges>,
): void {
  const seen = new Set<string>([entryKey]);
  const queue: string[] = [entryKey];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const edge = edges.get(current);
    if (!edge) {
      // Only reachable if `main` itself is absent; internal targets always
      // resolve to a present file by construction.
      throw new Error(
        `entry '${main}' produced no identity (not present in the provided files?)`,
      );
    }
    for (const specifier of edge.externalDeps) {
      if (
        specifier.startsWith("./") || specifier.startsWith("../") ||
        specifier.startsWith("/")
      ) {
        throw new Error(
          `incomplete closure: '${specifier}' imported by '${
            unprefix(current)
          }' did not resolve to an included file`,
        );
      }
      if (specifier.startsWith("cf:")) {
        throw new Error(
          `fabric import '${specifier}' in '${
            unprefix(current)
          }' is not supported by the light identity path`,
        );
      }
    }
    for (const { target } of edge.internalDeps) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
}

function unprefix(name: string): string {
  const p = `/${ENTRY_ID}`;
  return name.startsWith(`${p}/`) ? name.slice(p.length) : name;
}

/**
 * Assemble the program that `main` names from single-file reads, as resolving
 * it for a compile does, then compute its light identity (see
 * {@link computeEntryIdentity}). `readFile(name)` receives a root-relative
 * module path (leading `/`, e.g. `/system/default-app.tsx`) and returns its
 * authored source; it must throw if the file does not exist.
 *
 * The program is the internal import closure of the entry and of each source
 * root, together with each data file that `options` names or that a
 * `dataFile()` call in that closure reads. Only relative (`./`, `../`) imports
 * are followed. Fabric authored sources use explicit file extensions, so each
 * relative specifier resolves to an exact path — no suffix guessing, no
 * directory enumeration. Bare and `cf:` specifiers are left to
 * {@link computeEntryIdentity}'s guard.
 *
 * This answers for the program a set of files describes. A program already in
 * hand compiles with the data files it names and no others, so its identity is
 * {@link computeEntryIdentity}'s to compute.
 *
 * Reads files one at a time and never lists a directory, so it behaves
 * identically in dev and in a compiled binary's embedded file system.
 */
export async function resolveEntryIdentity(
  main: string,
  readFile: (name: string) => Promise<string>,
  options: ResolveEntryIdentityOptions = {},
): Promise<string> {
  const rooted = (name: string) => name.startsWith("/") ? name : `/${name}`;
  const entry = rooted(main);
  const sourceRoots = (options.sourceRoots ?? []).map(rooted);
  const dataFiles = [...new Set((options.dataFiles ?? []).map(rooted))];
  const readDataFile = options.readDataFile ?? readFile;
  // Every root is an entry of its own, so the import walk seeds from each.
  // A data file is read and never parsed: import-like text inside one is
  // data, and following it would read files the program never named.
  const files = await collectEntryClosure([entry, ...sourceRoots], readFile);
  const collected = new Set(files.map((file) => file.name));
  for (const dataPath of dataFiles) {
    if (!collected.has(dataPath)) {
      files.push({ name: dataPath, contents: await readDataFile(dataPath) });
    }
  }
  const program = await attachDeclaredDataFiles(
    { main: entry, files, dataFiles },
    {
      resolveSource: sourceReader(readFile),
      resolveDataFile: sourceReader(readDataFile),
    },
  );
  return computeEntryIdentity(entry, program.files, {
    sourceRoots,
    dataFiles: program.dataFiles,
  });
}

async function collectEntryClosure(
  entries: readonly string[],
  readFile: (name: string) => Promise<string>,
): Promise<Source[]> {
  // Import scanning parses with the TS parser (compilerStack).
  await ensureCompilerStack();
  const { collectImportSpecifiers, ts } = compilerStack();
  const byName = new Map<string, Source>();
  const queue: string[] = [...entries];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (byName.has(name)) continue;
    const source: Source = { name, contents: await readFile(name) };
    byName.set(name, source);
    for (
      const specifier of collectImportSpecifiers(source, ts.ScriptTarget.ES2023)
    ) {
      const resolved = resolveImportSpecifier(specifier, source);
      // resolveImportSpecifier returns the specifier unchanged for bare/`cf:`
      // imports; a changed value means it was relative and resolved to a path.
      if (resolved === specifier) continue;
      if (!byName.has(resolved)) queue.push(resolved);
    }
  }
  return [...byName.values()];
}

/**
 * Helper for {@link resolveEntryIdentity}, which turns a reader of a file's text
 * into one answering with the file as a named `Source`.
 */
function sourceReader(
  read: (name: string) => Promise<string>,
): (name: string) => Promise<Source> {
  return async (name) => ({ name, contents: await read(name) });
}
