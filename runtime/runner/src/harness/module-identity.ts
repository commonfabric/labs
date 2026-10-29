import { hashStringOf } from "@commonfabric/data-model";
import type {
  ModuleDeclarations,
  Program,
  Source,
} from "@commonfabric/js-compiler";
import { resolveImportSpecifier } from "@commonfabric/js-compiler/specifier";

import { compilerStack } from "./deferred-compiler-stack.ts";

/**
 * Per-module content-addressed identity.
 *
 * Each module is identified by a Merkle hash over (1) its own authored
 * TypeScript source and (2) the hashes of every module it imports — value and
 * type alike. The resulting identity is:
 *
 *  - **entry-point independent**: it depends only on the module's own reachable
 *    import closure and its authored (bundle-relative) path, not on which entry
 *    point pulled it into a compilation, nor on unrelated sibling files. The
 *    authored path is included so two byte-identical modules at different paths
 *    keep distinct identities; that path is stable across entry points, unlike
 *    the whole-program `/<id>/` prefix this replaces;
 *  - **TCB independent**: it hashes authored source, not compiled output, so a
 *    transformer/compiler upgrade does not change it (the scheduler's separate
 *    `runtimeFingerprint` covers compilation-semantics changes);
 *  - **transitively sensitive**: changing any module in the closure — including a
 *    type that the transformer lowers into a generated schema — changes the
 *    hash of every module that transitively imports it.
 *
 * See docs/specs/module-loading.md for the full rationale.
 */

const VERSION_TAG = "cf/module-id/v1";

// Candidate suffixes used to match a resolved bare path (which usually omits an
// extension, e.g. `./b`) against a concrete file name in the program.
// Extensioned and directory-index candidates are tried before the bare ""
// match so that, like TypeScript module resolution, `import "./a"` prefers
// `/a.ts` over a literal extensionless `/a` when both exist.
const RESOLUTION_SUFFIXES = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".mjs",
  ".d.ts",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
  "/index.mts",
  "/index.mjs",
  "",
];

export interface ModuleIdentityOptions {
  /**
   * Identity of the trusted runtime/transformer surface. Folded into the leaf
   * for external (runtime) module imports so a runtime upgrade invalidates
   * modules that import runtime modules, without otherwise affecting code
   * identity. Defaults to the empty string.
   */
  runtimeFingerprint?: string;

  /** Internal dependency edges that participate in identity without executing. */
  additionalInternalDeps?: ReadonlyMap<
    string,
    readonly { specifier: string; target: string }[]
  >;

  /**
   * Paths carrying data rather than code. A data file hashes as a leaf over its
   * own bytes and path: it is never scanned for imports, and never the target of
   * another module's import edge.
   */
  dataFiles?: ReadonlySet<string>;

  /**
   * Modules already scanned, by name, as {@link scanModules} returns them. A
   * module with an entry here is resolved from it rather than parsed again.
   */
  declarations?: ReadonlyMap<string, ModuleDeclarations>;
}

interface ModuleNode {
  path: string;
  src: string;

  /** Imports resolved to another file within the program. */
  internalDeps: { specifier: string; target: string }[];

  /** Imports that do not resolve to a program file (bare/runtime modules). */
  externalDeps: string[];
}

/** Resolved import edges of a single module. */
export interface ModuleImportEdges {
  /** Imports resolving to another file in the program (specifier → target path). */
  internalDeps: { specifier: string; target: string }[];

  /** Imports that do not resolve to a program file (bare/runtime specifiers). */
  externalDeps: string[];
}

/**
 * Resolve every module's import edges against the program's file set, split into
 * internal (program-file) and external (bare/runtime) deps. Shared by the
 * identity hash and the content-addressed cache's import links so they agree on
 * what counts as an internal edge. Self-imports are dropped.
 *
 * `options.dataFiles` names the program's data files. Their bytes are not
 * TypeScript, so they are not parsed and carry no edges, and an import that
 * would land on one resolves to nothing instead — such a specifier is reported
 * as external, and fails to resolve at compile time.
 *
 * A module with an entry in `options.declarations` is resolved from that scan,
 * and any other is parsed here.
 */
export function resolveModuleImports(
  program: Program,
  options: Pick<ModuleIdentityOptions, "dataFiles" | "declarations"> = {},
): Map<string, ModuleImportEdges> {
  const dataFiles = options.dataFiles ?? new Set<string>();
  const fileNames = new Set(
    program.files.map((f) => f.name).filter((name) => !dataFiles.has(name)),
  );
  const edges = new Map<string, ModuleImportEdges>();
  for (const file of program.files) {
    const internalDeps: { specifier: string; target: string }[] = [];
    const externalDeps: string[] = [];
    if (dataFiles.has(file.name)) {
      edges.set(file.name, { internalDeps, externalDeps });
      continue;
    }
    const declared = options.declarations?.get(file.name) ??
      scanModule(file);
    for (const specifier of declared.imports) {
      const resolved = resolveImportSpecifier(specifier, file);
      const target = findInternalTarget(fileNames, resolved);
      if (target !== undefined && target !== file.name) {
        internalDeps.push({ specifier, target });
      } else if (target === undefined) {
        externalDeps.push(specifier);
      }
      // A self-import contributes nothing.
    }
    edges.set(file.name, { internalDeps, externalDeps });
  }
  return edges;
}

/**
 * Scans each of `files` once, keyed by its name, so the steps that resolve a
 * module's imports and its `dataFile()` reads share one parse of it.
 * `scanned(file)` supplies a scan already made of the same bytes under a name
 * with the same base name, which is taken instead of parsing again.
 *
 * `files` holds code only: a data file is never parsed.
 */
export function scanModules(
  files: readonly Source[],
  scanned: (file: Source) => ModuleDeclarations | undefined = () => undefined,
): Map<string, ModuleDeclarations> {
  return new Map(
    files.map((file) => [file.name, scanned(file) ?? scanModule(file)]),
  );
}

/**
 * Helper for `resolveModuleImports()` and `scanModules()`, which parses one
 * module.
 */
function scanModule(file: Source): ModuleDeclarations {
  // Deferred compiler stack: scanning parses with the TS parser, so every flow
  // reaching this must have awaited ensureCompilerStack().
  const { scanModuleDeclarations, ts } = compilerStack();
  return scanModuleDeclarations(file, ts.ScriptTarget.ES2023);
}

/**
 * Compute a stable content hash for every module in `program`.
 * Returns a map from each file's path to its hash.
 */
export function computeModuleHashes(
  program: Program,
  options: ModuleIdentityOptions = {},
): Map<string, string> {
  const runtimeFingerprint = options.runtimeFingerprint ?? "";
  const edges = resolveModuleImports(program, options);
  const nodes = new Map<string, ModuleNode>();

  for (const file of program.files) {
    const { internalDeps, externalDeps } = edges.get(file.name)!;
    const additionalInternalDeps = options.additionalInternalDeps?.get(
      file.name,
    ) ?? [];
    for (const dependency of additionalInternalDeps) {
      if (!edges.has(dependency.target)) {
        throw new Error(
          `Additional identity dependency from '${file.name}' targets missing ` +
            `module '${dependency.target}'.`,
        );
      }
    }
    // A data file's bytes are the payload the runtime hands to a pattern, so
    // line endings are content rather than formatting: two data files differing
    // only in them are different files and must not share an identity.
    const isData = options.dataFiles?.has(file.name) === true;
    nodes.set(file.name, {
      path: file.name,
      src: isData ? file.contents : normalizeSource(file.contents),
      internalDeps: [...internalDeps, ...additionalInternalDeps],
      externalDeps,
    });
  }

  // Condense strongly-connected components so import cycles hash as a unit.
  // Tarjan yields components in reverse-topological order (dependencies before
  // importers), which is exactly the order we need to hash bottom-up.
  const { components, componentOf } = tarjanSccs(nodes);

  const result = new Map<string, string>();
  for (const component of components) {
    const members = [...component].sort();
    const memberEntries = members.map((path) => {
      const node = nodes.get(path)!;
      const external = unique(node.externalDeps)
        .sort()
        .map((specifier) => ({
          specifier,
          leaf: `runtime:${specifier}@${runtimeFingerprint}`,
        }));
      const crossDeps = node.internalDeps
        .filter((dep) => componentOf.get(dep.target) !== componentOf.get(path))
        .map((dep) => ({
          specifier: dep.specifier,
          hash: result.get(dep.target)!,
        }))
        .sort(compareCrossDep);
      // Intra-component dependency *structure* is folded in so two different
      // cycle shapes over the same sources hash differently. The dependency
      // bodies themselves are already present via the members' `src`.
      const intraDeps = node.internalDeps
        .filter((dep) => componentOf.get(dep.target) === componentOf.get(path))
        .map((dep) => ({ specifier: dep.specifier, target: dep.target }))
        .sort(compareIntraDep);
      return { path, src: node.src, external, crossDeps, intraDeps };
    });

    const componentHash = hashStringOf({
      v: VERSION_TAG,
      members: memberEntries,
    });

    for (const path of members) {
      result.set(
        path,
        hashStringOf([VERSION_TAG, "module", componentHash, path]),
      );
    }
  }

  return result;
}

/**
 * Match a resolved (relative) import path against a concrete file name in the
 * program, trying TypeScript-style extension and directory-index candidates.
 * Shared by module identity and the ESM record adapter so they agree on what
 * counts as an internal edge.
 */
export function findInternalTarget(
  fileNames: Set<string>,
  resolved: string,
): string | undefined {
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = resolved + suffix;
    if (fileNames.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeSource(contents: string): string {
  // Identity is over authored source; the only normalization is line endings,
  // so a CRLF/LF difference does not change a module's hash. Data files are
  // excluded from this: their bytes are content, not source text.
  return contents.replace(/\r\n/g, "\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function compareCrossDep(
  a: { specifier: string; hash: string },
  b: { specifier: string; hash: string },
): number {
  return a.specifier === b.specifier
    ? (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
    : (a.specifier < b.specifier ? -1 : 1);
}

function compareIntraDep(
  a: { specifier: string; target: string },
  b: { specifier: string; target: string },
): number {
  return a.specifier === b.specifier
    ? (a.target < b.target ? -1 : a.target > b.target ? 1 : 0)
    : (a.specifier < b.specifier ? -1 : 1);
}

interface SccResult {
  /** Components in reverse-topological order (dependencies first). */
  components: string[][];

  /** Map from each module path to an opaque component id. */
  componentOf: Map<string, number>;
}

/** Tarjan's strongly-connected-components algorithm over the import graph. */
function tarjanSccs(nodes: Map<string, ModuleNode>): SccResult {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  const componentOf = new Map<string, number>();

  // Iterative DFS to avoid stack overflow on large graphs.
  for (const start of nodes.keys()) {
    if (indices.has(start)) continue;

    const work: { path: string; depIndex: number }[] = [
      { path: start, depIndex: 0 },
    ];
    indices.set(start, index);
    lowlinks.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const node = nodes.get(frame.path)!;
      const deps = node.internalDeps;

      if (frame.depIndex < deps.length) {
        const target = deps[frame.depIndex].target;
        frame.depIndex++;
        if (!indices.has(target)) {
          indices.set(target, index);
          lowlinks.set(target, index);
          index++;
          stack.push(target);
          onStack.add(target);
          work.push({ path: target, depIndex: 0 });
        } else if (onStack.has(target)) {
          lowlinks.set(
            frame.path,
            Math.min(lowlinks.get(frame.path)!, indices.get(target)!),
          );
        }
      } else {
        if (lowlinks.get(frame.path) === indices.get(frame.path)) {
          const component: string[] = [];
          const componentId = components.length;
          let member: string;
          do {
            member = stack.pop()!;
            onStack.delete(member);
            component.push(member);
            componentOf.set(member, componentId);
          } while (member !== frame.path);
          components.push(component);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1];
          lowlinks.set(
            parent.path,
            Math.min(lowlinks.get(parent.path)!, lowlinks.get(frame.path)!),
          );
        }
      }
    }
  }

  return { components, componentOf };
}
