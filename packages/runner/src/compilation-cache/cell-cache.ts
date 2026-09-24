import { normalize } from "@std/path/posix";

import { CFC_COMPILED_BY_ATOM } from "@commonfabric/api/cfc";
import { type FabricValue, taggedHashStringOf } from "@commonfabric/data-model";
import type {
  BuilderSourceSitesV1,
  PatternCoverageSpan,
} from "@commonfabric/ts-transformers";
import { isBuilderSourceSitesV1 } from "@commonfabric/ts-transformers/runtime-contract";
import { getLogger } from "@commonfabric/utils/logger";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { JSONSchema } from "../builder/types.ts";
import { type Cell, isCell } from "../cell.ts";
import { readStoredCfcMetadata } from "../cfc/metadata.ts";
import { validateCfcPolicyArtifactManifest } from "../cfc/policy.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_UNDECLARABLE_STORE,
  runtimeWritePolicyAuthorization,
} from "../cfc/types.ts";
import { ensureCompilerStack } from "../harness/deferred-compiler-stack.ts";
import { computeModuleHashes } from "../harness/module-identity.ts";
import type { CacheableModule } from "../harness/types.ts";
import { createSigilLinkFromParsedLink, parseLink } from "../link-utils.ts";
import { snapshotQueryResult } from "../query-result-proxy.ts";
import type { MemorySpace, Runtime } from "../runtime.ts";
import {
  isFabricImportSpecifier,
  parseFabricRef,
  pinnedIdentity,
} from "../sandbox/fabric-import-specifier.ts";
import {
  DATA_FILE_SPECIFIER,
  deriveModuleRecordFields,
  SOURCE_ROOT_SPECIFIER,
} from "../sandbox/module-record-compiler.ts";
import type { SigilLink } from "../sigil-types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  COMPILE_CACHE_RUNTIME_VERSION,
  SOURCE_COMPILE_CACHE_RUNTIME_VERSION,
} from "./compile-cache-version.ts";

const logger = getLogger("cell-cache");

/**
 * Content-addressed compilation cache — document model and key scheme.
 *
 * See docs/specs/module-loading.md §"Storage model: two content-addressed
 * document sets, per space". The persistent cache is a pair of per-module
 * document sets stored as regular cells in the target space:
 *
 *  - **Source set** `pattern:<identity>` — authored TypeScript, keyed by the
 *    per-module Merkle identity (`computeModuleHashes`). Runtime-version
 *    independent.
 *  - **Compiled set** `compileCache:<runtimeVersion>/<identity>` — verified
 *    compiled JS, keyed by `(runtimeVersion, identity)`.
 *
 * Each document records its authored `filename` and the resolved internal
 * `imports` (`{ specifier, identity }`) — the identity is what the document's
 * sigil link points at (`sourceDocKey`/`compiledDocKey` of the dependency) —
 * and its `code` as a link to the content-addressed `cid:` document holding
 * the string, so identical module text is one document however many records
 * name it. A record may instead hold the string inline, and reads accept
 * both. This module owns the pure
 * key/identity/verification logic; the cell read/write + link wiring layer
 * builds on it.
 */

/** A resolved internal import edge of a cached module. */
export interface ModuleImportRef {
  /** Authored import specifier, e.g. `"./util.ts"`. */
  readonly specifier: string;

  /** Content-addressed identity of the imported module's document. */
  readonly identity: string;
}

/**
 * Per-module update authority: a module identity maps to the predecessor
 * identities whose writer authority it may exercise. Values are cumulative;
 * save paths merge them with the document already stored under the
 * content-addressed key.
 */
export type ModuleDelegationMap = ReadonlyMap<
  string,
  ReadonlySet<string>
>;

const EMPTY_MODULE_DELEGATIONS: ModuleDelegationMap = new Map();

/**
 * Runtime-minted compiler attestation. Compiled documents carry it at their
 * root; source documents carry it only on delegation metadata, whose mutable
 * value is otherwise excluded from the source Merkle identity.
 */
export const COMPILED_INTEGRITY_ATOM: string = CFC_COMPILED_BY_ATOM;

const SOURCE_DELEGATION_PATH = ["delegatedModuleIdentities"] as const;

interface ModuleDocBase {
  /** Module code: authored TS (source set) or compiled JS (compiled set). */
  readonly code: string;

  /** Authored module path, e.g. `/main.tsx`. */
  readonly filename: string;

  /** Resolved internal imports; each points at another document by identity. */
  readonly imports: readonly ModuleImportRef[];

  /** Predecessor module identities whose writer authority this module inherits. */
  readonly delegatedModuleIdentities?: readonly string[];
}

/** A source-set document (`pattern:<identity>`). */
export interface SourceDoc extends ModuleDocBase {
  readonly kind: "source";

  /**
   * Optional, NON-NORMATIVE product annotations (a name doc, a spec doc,
   * lineage — typically sigil links). The runtime NEVER reads these for
   * execution and {@link verifySourceDocs} EXCLUDES them from the content hash:
   * the document identity is a Merkle hash of `(source, import identities)`
   * only, so an annotated and an unannotated doc verify identically. Present
   * only on the entry document, written by `PatternManager.annotatePattern`.
   */
  readonly annotations?: Record<string, unknown>;
}

/**
 * A compiled-set document (`compileCache:<runtimeVersion>/<identity>`).
 *
 * `kind` separates the two things this set holds. A `"compiled"` document's
 * `code` is an emitted module body, built into a record and executed. A
 * `"data"` document's `code` is the verbatim bytes of an attached data file:
 * the compiled set carries them so a warm load has everything the pattern
 * needs without reading the source set, and nothing ever parses, verifies, or
 * executes them.
 */
export interface CompiledDoc extends ModuleDocBase {
  readonly kind: "compiled" | "data";

  /** Per-module source map, if any (registered for authored error stacks). */
  readonly sourceMap?: unknown;

  /**
   * Precomputed record surface (Fix B): the direct export names, `export *`
   * target specifiers, and runtime import specifiers derived from `code` at
   * compile time. Lets the boot-time record build skip the in-worker TS parse.
   * Absent on documents written before the field existed (→ parse fallback).
   */
  readonly exportNames?: readonly string[];

  readonly starTargetSpecs?: readonly string[];
  readonly importSpecs?: readonly string[];
  readonly policyManifests?: readonly unknown[];

  /** Debug-only authored builder sites, keyed by runtime artifact symbol. */
  readonly builderSourceSites?: BuilderSourceSitesV1;

  /**
   * Authored-line spans for the coverage probes the transformer baked into
   * `code`, keyed by `(fileName, id)`. Present only on documents written by a
   * coverage-instrumented compile, which store under their own runtime-version
   * variant (`<runtimeVersion>/pattern-coverage`), so an ordinary
   * document never carries them. A collector maps a probe's `(fileName, id)`
   * back to source lines through these spans; a warm load that registers none
   * reports nothing.
   */
  readonly patternCoverageSpans?: readonly PatternCoverageSpan[];
}

const canonicalModuleFilename = (filename: string): string =>
  normalize(filename.replaceAll("\\", "/"));

const validDelegatedModuleIdentities = (
  identity: string,
  ...values: readonly unknown[]
): string[] => {
  const merged = new Set<string>();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const candidate of value) {
      if (
        typeof candidate === "string" && candidate.length > 0 &&
        candidate !== identity
      ) {
        merged.add(candidate);
      }
    }
  }
  return [...merged].sort();
};

/**
 * The roots two module names sit under when they end the same way.
 * `/api/patterns/system/x.tsx` and `/packages/patterns/system/x.tsx` share
 * the tail `/patterns/system/x.tsx` under the roots `/api` and `/packages`;
 * a name mounted at `/` has the empty root. Undefined when the two share no
 * tail at all, which is a rename rather than the same tree under another
 * root.
 */
const rootsOfSharedTail = (
  previous: string,
  next: string,
): { previous: string; next: string } | undefined => {
  const previousSegments = previous.split("/");
  const nextSegments = next.split("/");
  let shared = 0;
  while (
    shared < previousSegments.length && shared < nextSegments.length &&
    previousSegments[previousSegments.length - 1 - shared] ===
      nextSegments[nextSegments.length - 1 - shared]
  ) {
    shared++;
  }
  if (shared === 0) return undefined;
  return {
    previous: previousSegments.slice(0, previousSegments.length - shared)
      .join("/"),
    next: nextSegments.slice(0, nextSegments.length - shared).join("/"),
  };
};

/**
 * Match a previous verified source closure to a newly emitted module set by
 * canonical full filename. Matching deliberately uses the whole normalized
 * path, never a basename: `../shared/writer.ts` has already resolved to the
 * stored module filename, while two different `writer.ts` files remain
 * distinct. Ambiguous matches are skipped fail-closed.
 *
 * `entries` names the two entry modules a source update moves a piece
 * between, and the update itself is what says the one succeeds the other, so
 * they match whatever they are called. When their names share a tail, the
 * roots each sits under ({@link rootsOfSharedTail}) read as the same authored
 * tree mounted at two places — a program the toolshed serves under
 * `/api/patterns` and the same checkout supplied from a repository root as
 * `/packages/patterns` — and every other module additionally matches the
 * previous module named by its own name under the previous root. A module
 * with candidates under both rules, or one that two successors claim, is
 * ambiguous and matches nothing.
 *
 * Each successor inherits both its direct predecessor and that predecessor's
 * cumulative delegation list, preserving update chains across a cold reload.
 */
export function deriveModuleDelegations<
  Module extends Pick<CacheableModule, "identity" | "filename">,
>(
  previous: ReadonlyMap<string, SourceDoc>,
  next: readonly Module[],
  entries?: { previous: string; next: string },
): Map<string, ReadonlySet<string>> {
  const previousByName = new Map<
    string,
    { identity: string; doc: SourceDoc }[]
  >();
  for (const [identity, doc] of previous) {
    const name = canonicalModuleFilename(doc.filename);
    const entryList = previousByName.get(name) ?? [];
    entryList.push({ identity, doc });
    previousByName.set(name, entryList);
  }

  // The entry pair, once both sides are present: a closure missing either
  // one has no pair to match, and matching falls back to names alone.
  const previousEntryDoc = entries === undefined
    ? undefined
    : previous.get(entries.previous);
  const nextEntry = entries === undefined
    ? undefined
    : next.find((module) => module.identity === entries.next);
  const entryPair = entries !== undefined && previousEntryDoc !== undefined &&
      nextEntry !== undefined
    ? {
      previous: { identity: entries.previous, doc: previousEntryDoc },
      next: nextEntry,
    }
    : undefined;
  const roots = entryPair === undefined ? undefined : rootsOfSharedTail(
    canonicalModuleFilename(entryPair.previous.doc.filename),
    canonicalModuleFilename(entryPair.next.filename),
  );
  const namesFor = (name: string): string[] => {
    if (roots === undefined || roots.previous === roots.next) return [name];
    if (!name.startsWith(`${roots.next}/`)) return [name];
    return [name, `${roots.previous}${name.slice(roots.next.length)}`];
  };

  // The predecessor each successor names, before ambiguity is settled: a
  // successor with more than one candidate is dropped here, and one whose
  // candidate another successor also names is dropped below.
  const claims = new Map<string, { identity: string; doc: SourceDoc }>();
  for (const module of next) {
    if (
      entryPair !== undefined && module.identity === entryPair.next.identity
    ) {
      claims.set(module.identity, entryPair.previous);
      continue;
    }
    const candidates = new Map<string, { identity: string; doc: SourceDoc }>();
    for (const name of namesFor(canonicalModuleFilename(module.filename))) {
      for (const match of previousByName.get(name) ?? []) {
        if (
          entryPair !== undefined &&
          match.identity === entryPair.previous.identity
        ) {
          continue;
        }
        candidates.set(match.identity, match);
      }
    }
    if (candidates.size !== 1) continue;
    claims.set(module.identity, [...candidates.values()][0]);
  }
  const claimants = new Map<string, number>();
  for (const predecessor of claims.values()) {
    claimants.set(
      predecessor.identity,
      (claimants.get(predecessor.identity) ?? 0) + 1,
    );
  }

  const delegations = new Map<string, ReadonlySet<string>>();
  for (const module of next) {
    const predecessor = claims.get(module.identity);
    if (
      predecessor === undefined || claimants.get(predecessor.identity) !== 1
    ) {
      continue;
    }
    const inherited = validDelegatedModuleIdentities(
      module.identity,
      predecessor.identity === module.identity ? [] : [predecessor.identity],
      predecessor.doc.delegatedModuleIdentities,
    );
    if (inherited.length > 0) {
      delegations.set(module.identity, new Set(inherited));
    }
  }
  return delegations;
}

export function moduleDelegationsFromDocs(
  docs: ReadonlyMap<string, ModuleDocBase>,
): Map<string, ReadonlySet<string>> {
  const result = new Map<string, ReadonlySet<string>>();
  for (const [identity, doc] of docs) {
    const delegated = validDelegatedModuleIdentities(
      identity,
      doc.delegatedModuleIdentities,
    );
    if (delegated.length > 0) result.set(identity, new Set(delegated));
  }
  return result;
}

/**
 * Version tag for the compiled-set axis (`compileCache:<runtimeVersion>/...`).
 * A compiled document is only reused under a matching tag, so a change to this
 * value invalidates the whole compiled set after any change to the compiler /
 * transformer pipeline or SES verifier that alters emitted bytes (the source
 * set, keyed by content identity alone, persists across the change).
 *
 * The value is generated from a hash of the compiler inputs defined in
 * `compiler-fingerprint.deno.ts`. Editing those inputs moves the tag and
 * invalidates stale compiled docs. Deno source runs resolve the checked-in
 * source marker to that hash at runtime. Runtimes without repository file access
 * skip the compiled cache until a binary build bakes the hash into
 * `compile-cache-version.ts`. See `getCompileCacheRuntimeVersion()` and
 * `compiler-fingerprint.deno.ts`.
 */
export {
  COMPILE_CACHE_RUNTIME_VERSION,
  SOURCE_COMPILE_CACHE_RUNTIME_VERSION,
} from "./compile-cache-version.ts";

type CompilerFingerprintModule = {
  computeCurrentCompilerVersion(): Promise<string>;
};

type CompileCacheVersionGlobal = typeof globalThis & {
  __cfCompileCacheRuntimeVersion?: unknown;
};

let compileCacheRuntimeVersion: Promise<string | undefined> | undefined;
let compileCacheRuntimeVersionForTesting:
  | Promise<string | undefined>
  | undefined;

export function getCompileCacheRuntimeVersion(): Promise<string | undefined> {
  if (compileCacheRuntimeVersionForTesting !== undefined) {
    return compileCacheRuntimeVersionForTesting;
  }
  compileCacheRuntimeVersion ??= resolveCompileCacheRuntimeVersion();
  return compileCacheRuntimeVersion;
}

export function setCompileCacheRuntimeVersionForTesting(
  version: string | undefined,
): () => void {
  const previous = compileCacheRuntimeVersionForTesting;
  compileCacheRuntimeVersionForTesting = Promise.resolve(version);
  return () => {
    compileCacheRuntimeVersionForTesting = previous;
  };
}

export function resolveBakedCompileCacheRuntimeVersionForTesting(
  version: string,
): Promise<string | undefined> {
  return resolveCompileCacheRuntimeVersion(version);
}

async function resolveCompileCacheRuntimeVersion(): Promise<
  string | undefined
>;
async function resolveCompileCacheRuntimeVersion(
  version: string,
): Promise<string | undefined>;
async function resolveCompileCacheRuntimeVersion(
  version = COMPILE_CACHE_RUNTIME_VERSION,
): Promise<string | undefined> {
  const definedVersion = buildDefinedCompileCacheRuntimeVersion();
  if (definedVersion !== undefined) {
    return definedVersion;
  }
  if (version !== SOURCE_COMPILE_CACHE_RUNTIME_VERSION) {
    return version;
  }
  if (!hasDenoRuntime()) {
    return undefined;
  }
  const specifier = new URL(
    "./compiler-fingerprint.deno.ts",
    import.meta.url,
  ).href;
  try {
    const module = await import(specifier) as CompilerFingerprintModule;
    return await module.computeCurrentCompilerVersion();
  } catch (error) {
    if (isUnavailableSourceFingerprint(error)) {
      return undefined;
    }
    throw error;
  }
}

function buildDefinedCompileCacheRuntimeVersion(): string | undefined {
  const value = (globalThis as CompileCacheVersionGlobal)
    .__cfCompileCacheRuntimeVersion;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasDenoRuntime(): boolean {
  const candidate = globalThis as { Deno?: { stat?: unknown } };
  return typeof candidate.Deno?.stat === "function";
}

function isUnavailableSourceFingerprint(error: unknown): boolean {
  return [
    "NotFound",
    "NotADirectory",
    "NotCapable",
    "PermissionDenied",
  ].some((name) => isDenoError(error, name));
}

function isDenoError(error: unknown, name: string): boolean {
  const errors = (globalThis as {
    Deno?: { errors?: Record<string, unknown> };
  }).Deno?.errors;
  const errorClass = errors?.[name];
  return typeof errorClass === "function" && error instanceof errorClass;
}

/** Cell key (id) for a source-set document. */
export function sourceDocKey(identity: string): string {
  return `pattern:${identity}`;
}

/** Cell key (id) for a compiled-set document. */
export function compiledDocKey(
  runtimeVersion: string,
  identity: string,
): string {
  return `compileCache:${runtimeVersion}/${identity}`;
}

/**
 * Synthetic import specifier prefix for a link the cache adds from the entry
 * document to a module that is part of the emitted program but not reachable
 * from the entry through the natural import graph (e.g. the injected `cfc.ts`
 * helper, pulled in via a `.d.ts` re-export with no runtime import edge).
 * Without it the link-following loader would never fetch such a module, so a
 * warm closure would always be incomplete. These links carry no authored
 * specifier, so they are ignored by the Merkle identity recompute (which
 * resolves a module's edges from its own source, not its stored links).
 * Explicit source-package roots use {@link SOURCE_ROOT_SPECIFIER} and attached
 * data files use {@link DATA_FILE_SPECIFIER} instead; both participate in the
 * entry module's identity.
 */
export const ROOT_LINK_SPECIFIER = "cf:cache-root/";

/** Identities of emitted modules not reachable from the entry via imports. */
function unreachedRoots(
  modules: readonly CacheableModule[],
  entryIdentity: string,
): string[] {
  const byId = new Map(modules.map((m) => [m.identity, m]));
  const seen = new Set<string>();
  const queue: string[] = [entryIdentity];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const imp of byId.get(id)?.imports ?? []) {
      queue.push(imp.targetIdentity);
    }
  }
  return modules.filter((m) => !seen.has(m.identity)).map((m) => m.identity);
}

/**
 * Persisted cache entries must be a pure function of their module identity.
 * An UNPINNED fabric specifier breaks that: the Merkle identity folds the
 * specifier TEXT (not the resolution result), so two compiles of
 * byte-identical source can chase to different targets and produce different
 * documents under the same `pattern:`/`compileCache:` key. Unpinned
 * resolution (`FabricImportOptions.allowUnpinned`) is therefore dev-only and
 * must never reach the persistent cache — both write paths fail loudly here.
 */
function assertNoUnpinnedFabricImports(
  modules: readonly CacheableModule[],
): void {
  for (const module of modules) {
    for (const imp of module.imports) {
      if (!isFabricImportSpecifier(imp.specifier)) continue;
      const ref = parseFabricRef(imp.specifier);
      if (ref !== undefined && pinnedIdentity(ref) === undefined) {
        throw new Error(
          `refusing to cache module '${module.filename}': unpinned fabric import '${imp.specifier}' (unpinned resolution is dev-only; pin before deploy)`,
        );
      }
    }
  }
}

/**
 * The resolved internal-import edges to store on a module's document, augmented
 * (for the entry module only) with synthetic root links to any otherwise-
 * unreachable emitted module so the link-following loader fetches the whole set.
 */
function storedImportRefs(
  module: CacheableModule,
  entryIdentity: string,
  extraRoots: readonly string[],
  options: { includeFabricEdges: boolean },
): ModuleImportRef[] {
  const refs: ModuleImportRef[] = module.imports
    .filter((imp) =>
      options.includeFabricEdges || !isFabricImportSpecifier(imp.specifier)
    )
    .map((imp) => ({
      specifier: imp.specifier,
      identity: imp.targetIdentity,
    }));
  if (module.identity === entryIdentity) {
    for (const rootIdentity of extraRoots) {
      refs.push({
        specifier: `${ROOT_LINK_SPECIFIER}${rootIdentity}`,
        identity: rootIdentity,
      });
    }
  }
  return refs;
}

/**
 * Build the source-set documents for an emitted module set, keyed by module
 * identity. Each document's `imports` resolve internal edges to the imported
 * module's identity (so a reader can follow links to the dependency documents);
 * the entry document additionally links any module unreachable through the
 * natural import graph (see {@link ROOT_LINK_SPECIFIER}).
 */
export function buildSourceDocs(
  modules: readonly CacheableModule[],
  entryIdentity: string,
  moduleDelegations: ModuleDelegationMap = EMPTY_MODULE_DELEGATIONS,
  extraRootsOverride?: readonly string[],
): Map<string, SourceDoc> {
  // `extraRootsOverride` exists for chunked (incremental) write-backs: the
  // synthetic root links on the ENTRY doc must be computed over the FULL
  // emitted module set, while `modules` here may be just the chunk being
  // written in this transaction (see planCompileCacheWriteChunks).
  const extraRoots = extraRootsOverride ??
    unreachedRoots(modules, entryIdentity);
  const out = new Map<string, SourceDoc>();
  for (const module of modules) {
    const delegatedModuleIdentities = validDelegatedModuleIdentities(
      module.identity,
      [...(moduleDelegations.get(module.identity) ?? [])],
    );
    out.set(module.identity, {
      kind: "source",
      code: module.source,
      filename: module.filename,
      imports: storedImportRefs(module, entryIdentity, extraRoots, {
        includeFabricEdges: false,
      }),
      ...(delegatedModuleIdentities.length > 0
        ? { delegatedModuleIdentities }
        : {}),
    });
  }
  return out;
}

/** Result of verifying a loaded source-document closure. */
export interface SourceDocVerification {
  readonly ok: boolean;

  /** The entry document's authored filename, when present. */
  readonly entryFilename?: string;

  /** Identities whose recomputed Merkle hash does not match their key. */
  readonly mismatches: readonly string[];

  /** Import-link target identities absent from the loaded document set. */
  readonly missing: readonly string[];
}

/**
 * Verify a loaded source-document closure by **recomputing** each module's
 * Merkle identity from the documents' authored source and import graph and
 * checking it equals the identity the document is keyed by. This is the
 * content-addressed analog of the structural graph verifier: because the
 * identity is a one-way Merkle hash over `(source, import identities)`, a
 * single document's content does not determine its key — the reachable
 * closure must recompute consistently. Tampering with any source, or rewiring
 * an import link, makes the recomputed identity diverge from the key.
 *
 * Each document is verified against **its own view**: the documents reachable
 * from it over authored-import and source-package edges (cache root links
 * excluded — a
 * {@link ROOT_LINK_SPECIFIER} edge is never part of any module's Merkle
 * preimage). One closure may legally hold several generations of the same
 * ambient filename (e.g. two seals' injected `cfc.ts`, each root-linked by a
 * different entry): identities are entry-point independent, so a shared
 * dependency document keeps whichever seal's root links wrote it last, and a
 * link walk then reaches sibling generations. Hashing the whole closure as
 * one program would collide those filenames and permanently fail one
 * generation; per-view recomputation verifies each against the emission
 * that produced it. Within a single view, filenames are unique by
 * construction (one program emission cannot contain two files at one path) —
 * a view that violates this cannot be attributed to any emission, and its
 * root document is rejected.
 *
 * Extra unrelated documents in the set are harmless to their siblings: a
 * module's identity depends only on its own reachable view. Every document in
 * the set is still verified (in its own view).
 */
export function verifySourceDocs(
  entryIdentity: string,
  docsByIdentity: ReadonlyMap<string, SourceDoc>,
  runtimeFingerprint = "",
): SourceDocVerification {
  const entry = docsByIdentity.get(entryIdentity);
  if (entry === undefined) {
    return { ok: false, mismatches: [], missing: [entryIdentity] };
  }

  const missing: string[] = [];
  for (const doc of docsByIdentity.values()) {
    for (const imp of doc.imports) {
      if (!docsByIdentity.has(imp.identity)) missing.push(imp.identity);
    }
  }

  // Data documents, collected across the whole closure by IDENTITY. Reaching
  // the verdict "this is data" must not depend on which document a view happens
  // to be rooted at, since a data document rooted in its own view names nothing
  // itself. Identity rather than filename is what makes that safe: one closure
  // may legally hold several generations of a filename, so a filename set would
  // condemn a code module that merely shares a name with data elsewhere.
  // A forged data edge buys nothing: it changes the identity of the document
  // carrying it, and hashing a real module as a leaf changes that module's
  // identity too, so both diverge from their keys here.
  const dataIdentities = new Set<string>();
  for (const doc of docsByIdentity.values()) {
    for (const imp of doc.imports) {
      if (!imp.specifier.startsWith(DATA_FILE_SPECIFIER)) continue;
      if (docsByIdentity.has(imp.identity)) dataIdentities.add(imp.identity);
    }
  }

  // identity → whether its recomputed hash matches its key. A verdict reached
  // inside one view holds in every view (entry-point independence), so each
  // document is hashed at most once.
  const verdicts = new Map<string, boolean>();
  for (const [rootIdentity, rootDoc] of docsByIdentity) {
    if (verdicts.has(rootIdentity)) continue;

    // The root's view: BFS over authored-import edges only.
    const viewIds: string[] = [];
    const seen = new Set<string>();
    const queue = [rootIdentity];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const doc = docsByIdentity.get(id);
      if (doc === undefined) continue; // dangling edge — recorded in `missing`
      viewIds.push(id);
      for (const imp of doc.imports) {
        if (imp.specifier.startsWith(ROOT_LINK_SPECIFIER)) continue;
        queue.push(imp.identity);
      }
    }

    const files = viewIds.map((id) => {
      const doc = docsByIdentity.get(id)!;
      return { name: doc.filename, contents: doc.code };
    });
    if (new Set(files.map((f) => f.name)).size !== files.length) {
      // Duplicate filename within one view: not attributable to any emission.
      // Only the root is condemned — an intact member still verifies in its
      // own (necessarily smaller) view when the loop reaches it.
      verdicts.set(rootIdentity, false);
      continue;
    }

    const additionalInternalDeps = new Map<
      string,
      { specifier: string; target: string }[]
    >();
    for (const id of viewIds) {
      const doc = docsByIdentity.get(id)!;
      const packageEdges = doc.imports
        .filter((imp) =>
          imp.specifier.startsWith(SOURCE_ROOT_SPECIFIER) ||
          imp.specifier.startsWith(DATA_FILE_SPECIFIER)
        )
        .flatMap((imp) => {
          const target = docsByIdentity.get(imp.identity);
          return target === undefined
            ? []
            : [{ specifier: imp.specifier, target: target.filename }];
        });
      if (packageEdges.length > 0) {
        additionalInternalDeps.set(doc.filename, packageEdges);
      }
    }
    // Within one view, filenames are unique by construction, so mapping the
    // view's data identities to their filenames is unambiguous here.
    const viewDataFiles = new Set(
      viewIds
        .filter((id) => dataIdentities.has(id))
        .map((id) => docsByIdentity.get(id)!.filename),
    );
    const recomputed = computeModuleHashes(
      { main: rootDoc.filename, files },
      {
        runtimeFingerprint,
        ...(additionalInternalDeps.size === 0
          ? {}
          : { additionalInternalDeps }),
        ...(viewDataFiles.size === 0 ? {} : { dataFiles: viewDataFiles }),
      },
    );
    for (const id of viewIds) {
      if (!verdicts.has(id)) {
        verdicts.set(
          id,
          recomputed.get(docsByIdentity.get(id)!.filename) === id,
        );
      }
    }
  }

  const mismatches = [...verdicts.entries()]
    .filter(([, ok]) => !ok)
    .map(([identity]) => identity);

  return {
    ok: mismatches.length === 0 && missing.length === 0,
    entryFilename: entry.filename,
    mismatches,
    missing,
  };
}

//
// Source-set store (4.3.2): write/read `pattern:<identity>` cells
//

/**
 * Stored shape of a source-set cell. Mirrors {@link SourceDoc} but each import
 * carries a sigil **link** to the dependency's cell (so the storage layer
 * follows it and loads the closure), plus the module's own `identity` for
 * read-side keying. The stored identity is not trusted — {@link verifySourceDocs}
 * recomputes it. `code` is stored as a link to the code document and read
 * back through the schema as the string that document holds; a record may
 * instead store the string itself.
 */
interface StoredSourceDoc {
  kind: "source";
  identity: string;
  code: string | SigilLink;
  filename: string;
  imports: { specifier: string; link: unknown }[];
  delegatedModuleIdentities?: string[];
  // Optional product annotations — see {@link SourceDoc.annotations}. Stored
  // verbatim; never part of the content identity.
  annotations?: Record<string, unknown>;
}

/**
 * Schema for a source-set document. **Recursive**: each `imports[].link` is an
 * `asCell` reference back to a source document (`$ref: "#/$defs/sourceDoc"`), so
 * syncing the entry cell under this schema transitively loads the *entire*
 * import closure in one round-trip — the storage layer follows the sigil links
 * and pulls every reachable document. No per-cell `sync()` is needed on load.
 */
export const SOURCE_DOC_SCHEMA = {
  $defs: {
    sourceDoc: {
      type: "object",
      properties: {
        kind: { type: "string" },
        identity: { type: "string" },
        code: { type: "string" },
        filename: { type: "string" },
        imports: {
          type: "array",
          items: {
            type: "object",
            properties: {
              specifier: { type: "string" },
              link: { $ref: "#/$defs/sourceDoc", asCell: ["cell"] },
            },
          },
        },
        delegatedModuleIdentities: {
          type: "array",
          items: { type: "string" },
        },
        // Optional, non-normative product annotations (see SourceDoc).
        annotations: { type: "object" },
      },
    },
  },
  $ref: "#/$defs/sourceDoc",
} as const satisfies JSONSchema;

/**
 * Flat source-document write schema. Only delegation metadata receives the
 * runtime-minted compiler attestation: source code/imports remain
 * self-verifying through their content identity, while annotations remain
 * independently mutable. `code` is admitted as whatever is stored — the link
 * to the code document — since a write schema is also the value condition
 * CFC prepare checks the written record against; the read schema is the one
 * that declares the string a read resolves the link to.
 */
function sourceDocWriteSchema(): JSONSchema {
  return {
    type: "object",
    properties: {
      kind: { type: "string" },
      identity: { type: "string" },
      code: true,
      filename: { type: "string" },
      imports: {
        type: "array",
        items: {
          type: "object",
          properties: {
            specifier: { type: "string" },
            link: true,
          },
        },
      },
      delegatedModuleIdentities: {
        type: "array",
        items: { type: "string" },
        ifc: { addIntegrity: [COMPILED_INTEGRITY_ATOM] },
      },
      annotations: { type: "object" },
    },
  };
}

/**
 * Stages the code document holding `code` in `space` and returns the link a
 * record stores in its `code` field. The document is installed in the same
 * transaction as the record, so a committed record never names a document
 * the space does not hold.
 */
function codeLink(
  space: MemorySpace,
  code: string,
  tx: IExtendedStorageTransaction,
): SigilLink {
  const id = tx.stageContentAddressedDocument(space, code);
  return createSigilLinkFromParsedLink({ id, path: [], space });
}

/**
 * Whether a record's `code` reads as the string its storage names. A string
 * stored inline is itself; a link verifies only when the code document it
 * names is the one the string hashes to, so a document that reached this
 * replica holding other content is refused. A reading that is not a string
 * — the code document absent from the replica — verifies nothing.
 */
export function codeFieldVerifies(
  cell: Cell<unknown>,
  code: unknown,
): code is string {
  if (typeof code !== "string") return false;
  const stored = (cell.getRaw() as { code?: unknown } | undefined)?.code;
  if (typeof stored === "string") return stored === code;
  return parseLink(stored, cell)?.id === `cid:${taggedHashStringOf(code)}`;
}

/**
 * Name `doc` to the §8.12.4 writer-fit measurement as a store no pattern
 * declares a policy on.
 *
 * A cache document holds the compiler's own record of a module: the `cid:`
 * document its bytes live in, its filename, the identities of its imports, and
 * the predecessor identities its writer authority descends from. No pattern
 * names it and no pattern-authored schema describes a field on it — the
 * schemas that do are the cache's own, further down this file, and they
 * declare integrity alone. That, not the content addressing, is what leaves
 * the ceiling empty: §17.1 makes content-addressing under the causal path an
 * implementation detail that does not change IFC semantics. What the content
 * address does decide is the id shape, which is why the class is named here
 * rather than enumerated in `isUndeclarableIdClass` (`cfc/prepare.ts`): the id
 * the cache's cause mints is an ordinary `of:fid1:<hash>`, so there is nothing
 * for a predicate over id strings to recognize.
 *
 * Spec §18.6.2 names the class — "program/source text
 * loaded to execute the handler", beside the `cid:` schema documents — and
 * calls both public infrastructure. The bytes themselves already take that
 * route: a `cid:` document is outside the flow join on both sides, so what
 * remains on the record is the compiler's bookkeeping.
 *
 * Without the marker, any transaction that both reads labeled data and reaches
 * a cache write is refused at `enforce-strict` — which a piece's source
 * transition does by construction, because it stages a module's delegation
 * union on the same transaction that moves the piece's source pointer.
 *
 * A cache document is not on §8.12.5's route 2, whose declaration would be the
 * other answer. Route 2 declares one piece's flow join as the store's policy,
 * so it wants a store keyed on that piece's own nodes. A cache document is
 * keyed on module content: every piece in the space running that module
 * addresses it, and it outlives all of them. What route 2 leaves behind is
 * also permanent — a `declared` entry per measured path, which §8.12.1 does
 * not let back, on a document nothing collects — where the flow stamp this
 * keeps is a per-value component §8.12.8 replaces on overwrite.
 *
 * The write stays a flow stamp target, which is where this stops short of
 * §18.6.2's write-side mirror — that section says the same addresses are not
 * value-write targets at all, which would leave the record unstamped too.
 * Safety invariant 9 is why it does not go that far. The delegation metadata
 * holds module identities, and §17.7 says holding one grants no access to the
 * artifact it names, so the content written here is public. WHICH identity
 * appears is the other question: a transaction that read a labeled value and
 * chose a successor by it writes that choice here, and §8.11.3 puts a
 * decision's label on every downstream output whatever the output's own
 * content is. That is the router attack at one bit per update, so the stamp
 * stays and the ceiling is what the marker skips. The module's bytes are
 * unaffected either way, being in a `cid:` document of their own.
 *
 * Every write to a cache record goes through here, whichever field it touches.
 * The claim is about the document, so a write site that skipped it would leave
 * the same refusal waiting for whichever transaction first reaches that site
 * carrying a join. `anchorValueAsEntity` carries the claim down the same way
 * it carries a runtime-owned store's, because a document anchored out of a
 * marked value holds part of that value at an id derived from it; the cache's
 * own records are written raw, with their import edges inline, so nothing
 * here anchors.
 */
export function recordUndeclarablePolicyStore(
  tx: IExtendedStorageTransaction,
  doc: Cell<unknown>,
): void {
  const link = doc.getAsNormalizedFullLink();
  tx.recordCfcWritePolicyInput({
    kind: "structural-provenance",
    target: {
      space: link.space,
      id: link.id,
      scope: link.scope,
      path: [...link.path],
    },
    claim: CFC_STRUCTURAL_PROVENANCE_UNDECLARABLE_STORE,
    sources: [],
  }, runtimeWritePolicyAuthorization);
}

/** Attribute cache-document writes to the trusted compiler builtin. */
function withCompileCacheBuiltin<T>(
  tx: IExtendedStorageTransaction,
  action: () => T,
): T {
  const priorIdentity = tx.getCfcState().implementationIdentity;
  tx.setCfcImplementationIdentity({
    kind: "builtin",
    builtinId: "compile-cache",
  });
  try {
    return action();
  } finally {
    tx.setCfcImplementationIdentity(priorIdentity);
  }
}

/**
 * Write every emitted module as a `pattern:<identity>` cell into `space`, each
 * import a sigil link to its dependency cell (the entry additionally linking any
 * otherwise-unreachable module). Idempotent (content-addressed keys). The caller
 * owns the transaction's commit. Returns the authenticated delegation union
 * actually staged by this write.
 */
export function writeSourceDocs(
  runtime: Runtime,
  space: MemorySpace,
  modules: readonly CacheableModule[],
  entryIdentity: string,
  tx: IExtendedStorageTransaction,
  moduleDelegations: ModuleDelegationMap = EMPTY_MODULE_DELEGATIONS,
  extraRootsOverride?: readonly string[],
): ModuleDelegationMap {
  assertNoUnpinnedFabricImports(modules);
  const effectiveModuleDelegations = effectiveModuleDelegationsForWrite(
    runtime,
    space,
    modules,
    tx,
    moduleDelegations,
    { source: true },
  );
  const docs = buildSourceDocs(
    modules,
    entryIdentity,
    effectiveModuleDelegations,
    extraRootsOverride,
  );
  withCompileCacheBuiltin(tx, () => {
    for (const [identity, doc] of docs) {
      const baseCell = runtime.getCell<StoredSourceDoc>(
        space,
        sourceDocKey(identity),
        undefined,
        tx,
      );
      recordUndeclarablePolicyStore(tx, baseCell);
      // Preserve product annotations on the entry doc only. Annotations are
      // only written there; reading every dependency doc here turns unrelated
      // stale cache cells into writeback conflict preconditions. They carry
      // over as stored: an annotation is typically a link to another document,
      // and the raw write below has to keep it a link rather than a copy of
      // what it reads through to.
      const existingAnnotations = identity === entryIdentity
        ? baseCell.getRaw()?.annotations
        : undefined;
      const delegatedModuleIdentities = [
        ...(doc.delegatedModuleIdentities ?? []),
      ];
      // A source document without delegation metadata remains an ordinary,
      // self-verifying cache write. Attaching an addIntegrity schema even when
      // the field is absent would make every legacy/direct source-cache write
      // CFC-relevant and require an otherwise-unnecessary prepare step.
      const cell = delegatedModuleIdentities.length > 0
        ? baseCell.asSchema(sourceDocWriteSchema())
        : baseCell;
      writeCacheRecord(
        cell,
        {
          kind: "source",
          identity,
          code: codeLink(space, doc.code, tx),
          filename: doc.filename,
          imports: doc.imports.map((imp) => ({
            specifier: imp.specifier,
            link: runtime.getCell(
              space,
              sourceDocKey(imp.identity),
              undefined,
              tx,
            ).getAsLink(),
          })),
          ...(delegatedModuleIdentities.length > 0
            ? { delegatedModuleIdentities }
            : {}),
          ...(isObjectOrArray(existingAnnotations)
            ? { annotations: existingAnnotations }
            : {}),
        } satisfies StoredSourceDoc,
      );
    }
  });
  return effectiveModuleDelegations;
}

/**
 * Writes a cache record whole, and only when the stored record differs.
 *
 * The write is raw: each `imports` element is stored inline in the record,
 * and the write touches no document but the record's own, so a write of the
 * same record from any session lands on that one document, and an unchanged
 * record is not written at all. The diff walk is not usable here, because it
 * anchors every plain object in an array into a document of its own, named
 * by the ambient frame's counter and cause; a second session writing the
 * same record names the documents the first session minted, without having
 * read them, and its commit is refused as stale. A stored record whose
 * elements sit in documents of their own differs from the one written and is
 * rewritten whole; those element documents are left untouched.
 */
function writeCacheRecord(
  cell: Cell<unknown>,
  record: StoredSourceDoc | StoredCompiledDoc,
): void {
  cell.setRawUntyped(record as unknown as FabricValue, true);
}

/**
 * Load the source-document closure reachable from `entryIdentity` in `space` by
 * following import links. A **single** `sync()` on the entry cell under the
 * recursive {@link SOURCE_DOC_SCHEMA} transitively loads the whole closure (the
 * storage layer follows the `asCell` sigil links), so the walk below reads the
 * already-loaded linked cells synchronously — no per-cell `sync()`. Returns the
 * raw documents keyed by their **stored** identity (verify with
 * {@link verifySourceDocs} before trusting). Resolves to `undefined` if the
 * entry document is absent or any cache import link crosses out of `space`.
 */
export async function loadSourceClosure(
  runtime: Runtime,
  space: MemorySpace,
  entryIdentity: string,
  tx: IExtendedStorageTransaction,
): Promise<Map<string, SourceDoc> | undefined> {
  const entry = runtime.getCell(
    space,
    sourceDocKey(entryIdentity),
    SOURCE_DOC_SCHEMA,
    tx,
  );
  // One sync pulls the entire link closure (recursive schema). No further syncs.
  await entry.sync();
  return readLoadedSourceClosure(runtime, space, entryIdentity, tx);
}

/**
 * Read a source closure that has already been synchronized into the replica.
 *
 * Reads remain attached to `tx`, so a later write commit conflicts if any
 * source document changes between verification and commit.
 */
export function readLoadedSourceClosure(
  runtime: Runtime,
  space: MemorySpace,
  entryIdentity: string,
  tx: IExtendedStorageTransaction,
): Map<string, SourceDoc> | undefined {
  const entry = runtime.getCell(
    space,
    sourceDocKey(entryIdentity),
    SOURCE_DOC_SCHEMA,
    tx,
  );
  const root = entry.get() as StoredSourceDoc | undefined;
  if (!root || typeof root.identity !== "string") return undefined;

  const out = new Map<string, SourceDoc>();
  const queue: { doc: StoredSourceDoc; cell: Cell<unknown> }[] = [{
    doc: root,
    cell: entry,
  }];
  while (queue.length > 0) {
    const { doc, cell } = queue.shift()!;
    if (out.has(doc.identity)) continue;
    // A document whose code does not verify is left out, and the closure
    // then fails its identity verification exactly as a missing document
    // does, so the caller recompiles.
    if (!codeFieldVerifies(cell, doc.code)) continue;
    const imports: ModuleImportRef[] = [];
    const childDocs: { doc: StoredSourceDoc; cell: Cell<unknown> }[] = [];
    for (const imp of doc.imports ?? []) {
      // `link` is already a loaded Cell (the entry sync pulled it). View it
      // under the recursive schema so its own links resolve as cells too.
      if (!isCell(imp.link)) continue;
      const linkedCell = imp.link as Cell<unknown>;
      // Cache attestations are space-local. A cross-space child may be validly
      // compiler-stamped in its own space, but must never be flattened into
      // the requested space's verified closure (and delegation registry).
      if (linkedCell.space !== space) return undefined;
      const childCell = linkedCell.asSchema(
        SOURCE_DOC_SCHEMA,
      );
      const child = childCell.get() as StoredSourceDoc | undefined;
      if (!child || typeof child.identity !== "string") continue;
      imports.push({ specifier: imp.specifier, identity: child.identity });
      childDocs.push({ doc: child, cell: childCell });
    }
    const delegatedModuleIdentities = cellCarriesIntegrity(
        cell,
        COMPILED_INTEGRITY_ATOM,
        tx,
        SOURCE_DELEGATION_PATH,
      )
      ? validDelegatedModuleIdentities(
        doc.identity,
        doc.delegatedModuleIdentities,
      )
      : [];
    out.set(doc.identity, {
      kind: "source",
      code: doc.code,
      filename: doc.filename,
      imports,
      ...(delegatedModuleIdentities.length > 0
        ? { delegatedModuleIdentities }
        : {}),
      ...(isObjectOrArray(doc.annotations)
        ? { annotations: doc.annotations }
        : {}),
    });
    for (const child of childDocs) {
      if (!out.has(child.doc.identity)) queue.push(child);
    }
  }
  return out;
}

function verifyLoadedSourceClosure(
  entryIdentity: string,
  closure: Map<string, SourceDoc> | undefined,
  runtimeFingerprint: string,
): Map<string, SourceDoc> | undefined {
  if (closure === undefined) return undefined;
  const verification = verifySourceDocs(
    entryIdentity,
    closure,
    runtimeFingerprint,
  );
  if (!verification.ok) {
    // Name the offenders (bounded): a bare count forces whoever hits this
    // into probe archaeology to find which doc failed and why.
    const describe = (identities: readonly string[]) =>
      identities.slice(0, 4)
        .map((id) => `${id}(${closure.get(id)?.filename ?? "absent"})`)
        .join(",") + (identities.length > 4 ? ",…" : "");
    logger.warn("source-closure-verify-failed", () => [
      `entry=${entryIdentity}`,
      `mismatches=${verification.mismatches.length}` +
      (verification.mismatches.length > 0
        ? ` [${describe(verification.mismatches)}]`
        : ""),
      `missing=${verification.missing.length}` +
      (verification.missing.length > 0
        ? ` [${describe(verification.missing)}]`
        : ""),
    ]);
    return undefined;
  }
  return closure;
}

/**
 * Load the deferred parser used by synchronous source-closure verification.
 */
export async function prepareSourceClosureVerification(): Promise<void> {
  await ensureCompilerStack();
}

/**
 * Verify a synchronized source closure while retaining its reads in `tx`.
 *
 * Callers first synchronize the recursive closure and await
 * {@link prepareSourceClosureVerification}.
 */
export function readVerifiedSourceClosure(
  runtime: Runtime,
  space: MemorySpace,
  entryIdentity: string,
  tx: IExtendedStorageTransaction,
  runtimeFingerprint = "",
): Map<string, SourceDoc> | undefined {
  return verifyLoadedSourceClosure(
    entryIdentity,
    readLoadedSourceClosure(runtime, space, entryIdentity, tx),
    runtimeFingerprint,
  );
}

/**
 * Load the source closure (see {@link loadSourceClosure}) and **graph-wiring
 * verify** it (step 4.3.6): recompute every module's Merkle identity from the
 * loaded source + import graph and require it to equal its document key. This is
 * the content-addressed analog of `verifyModuleGraph` — the source set is
 * self-verifying (content-addressing IS the integrity), so a tampered source, a
 * rewired link, or an incomplete closure is rejected here. Resolves to the
 * verified closure, or `undefined` if the entry is absent or verification fails.
 */
export async function loadVerifiedSourceClosure(
  runtime: Runtime,
  space: MemorySpace,
  entryIdentity: string,
  tx: IExtendedStorageTransaction,
  runtimeFingerprint = "",
): Promise<Map<string, SourceDoc> | undefined> {
  const closure = await loadSourceClosure(runtime, space, entryIdentity, tx);
  if (closure === undefined) return undefined;
  // Identity verification parses source (module hashing scans imports), and
  // every source-closure consumer parses further downstream (fabric-import
  // scans, recompiles) — this is the shared entry those flows funnel through,
  // so load the deferred compiler stack here, once.
  await prepareSourceClosureVerification();
  const verified = verifyLoadedSourceClosure(
    entryIdentity,
    closure,
    runtimeFingerprint,
  );
  // A transaction with writes may expose staged grants. Only a read of durable
  // metadata can publish authority independently of the transaction's verdict.
  if (verified !== undefined && !tx.hasWrites()) {
    runtime.registerModuleDelegations(
      space,
      moduleDelegationsFromDocs(verified),
    );
  }
  return verified;
}

//
// Compiled-set store (4.3.3): `compileCache:<rtver>/<identity>` + CFC
//

// The write-side property set. `code` is admitted as whatever is stored —
// the link to the code document — because the write schema doubles as the
// value condition CFC prepare checks the written record against before it
// persists the root integrity label; a `string` condition would fail on the
// link and drop the label. The read schema below declares the string a read
// resolves the link to.
const compiledDocProperties = {
  kind: { type: "string" },
  identity: { type: "string" },
  code: true,
  filename: { type: "string" },
  sourceMap: {},
  exportNames: { type: "array", items: { type: "string" } },
  starTargetSpecs: { type: "array", items: { type: "string" } },
  importSpecs: { type: "array", items: { type: "string" } },
  patternCoverageSpansJson: { type: "string" },
  builderSourceSitesJson: { type: "string" },
  policyManifests: {
    type: "array",
    items: { type: "object", additionalProperties: true },
  },
  delegatedModuleIdentities: {
    type: "array",
    items: { type: "string" },
  },
  imports: {
    type: "array",
    items: {
      type: "object",
      properties: {
        specifier: { type: "string" },
        link: { asCell: ["cell"] },
      },
    },
  },
} as const;

/**
 * Read schema for a compiled document. **Recursive**: each `imports[].link` is
 * an `asCell` reference back to a compiled document, so a single `sync()` on the
 * entry cell transitively loads the entire compiled closure (one round-trip),
 * and the loader reads the linked cells synchronously — no per-cell `sync()`.
 */
export const COMPILED_DOC_SCHEMA = {
  $defs: {
    compiledDoc: {
      type: "object",
      properties: {
        kind: { type: "string" },
        identity: { type: "string" },
        code: { type: "string" },
        filename: { type: "string" },
        sourceMap: {},
        exportNames: { type: "array", items: { type: "string" } },
        starTargetSpecs: { type: "array", items: { type: "string" } },
        importSpecs: { type: "array", items: { type: "string" } },
        patternCoverageSpansJson: { type: "string" },
        builderSourceSitesJson: { type: "string" },
        policyManifests: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
        delegatedModuleIdentities: {
          type: "array",
          items: { type: "string" },
        },
        imports: {
          type: "array",
          items: {
            type: "object",
            properties: {
              specifier: { type: "string" },
              link: { $ref: "#/$defs/compiledDoc", asCell: ["cell"] },
            },
          },
        },
      },
    },
  },
  $ref: "#/$defs/compiledDoc",
} as const satisfies JSONSchema;

/**
 * Write schema: stamps the compiler integrity atom on the stored value. Flat
 * (no recursive `$ref`) — writing a single document does not transitively load.
 */
export function compiledDocWriteSchema(): JSONSchema {
  return {
    type: "object",
    properties: compiledDocProperties,
    ifc: { addIntegrity: [COMPILED_INTEGRITY_ATOM] },
  };
}

interface StoredCompiledDoc {
  kind: "compiled" | "data";
  identity: string;

  /** A link to the code document, or the string itself. */
  code: string | SigilLink;

  filename: string;
  sourceMap?: unknown;
  exportNames?: readonly string[];
  starTargetSpecs?: readonly string[];
  importSpecs?: readonly string[];
  patternCoverageSpansJson?: string;
  builderSourceSitesJson?: string;
  policyManifests?: readonly unknown[];
  delegatedModuleIdentities?: string[];
  imports: { specifier: string; link: unknown }[];
}

/** A stored compiled document whose `code` has been read and verified. */
type VerifiedCompiledDoc = Omit<StoredCompiledDoc, "code"> & { code: string };

/**
 * The coverage spans stored as scalar JSON on a compiled document, parsed and
 * shape-checked. Yields `undefined` for a document written without spans, and
 * for a stored value that does not match the span shape. The load then carries
 * no spans for that module, and the collector reports no lines for it rather
 * than reporting against malformed coordinates. Spans are a reporting aid,
 * never an execution input, so a rejection here cannot affect what the module
 * does.
 */
function storedCoverageSpans(
  stored: unknown,
): readonly PatternCoverageSpan[] | undefined {
  if (typeof stored !== "string") return undefined;
  let spans: unknown;
  try {
    spans = JSON.parse(stored);
  } catch {
    return undefined;
  }
  if (!Array.isArray(spans)) return undefined;
  const out: PatternCoverageSpan[] = [];
  for (const span of spans) {
    if (!isObjectOrArray(span)) return undefined;
    const { fileName, id, kind, startLine, endLine, startColumn, endColumn } =
      span;
    if (
      typeof fileName !== "string" || typeof id !== "number" ||
      kind !== "runtime" || typeof startLine !== "number" ||
      typeof endLine !== "number" || typeof startColumn !== "number" ||
      typeof endColumn !== "number"
    ) {
      return undefined;
    }
    out.push({
      fileName,
      id,
      kind,
      startLine,
      endLine,
      startColumn,
      endColumn,
    });
  }
  return out;
}

/** Parses and validates a debug-only builder-source-site sidecar. */
function storedBuilderSourceSites(
  stored: unknown,
): BuilderSourceSitesV1 | undefined {
  if (typeof stored !== "string") return undefined;
  let sidecar: unknown;
  try {
    sidecar = JSON.parse(stored);
  } catch {
    return undefined;
  }
  return isBuilderSourceSitesV1(sidecar) ? sidecar : undefined;
}

/** Whether a cell's persisted CFC label carries `atom` at `path`. */
function cellCarriesIntegrity(
  cell: Cell<unknown>,
  atom: string,
  tx: IExtendedStorageTransaction,
  path: readonly (string | number)[] = [],
): boolean {
  const link = cell.getAsNormalizedFullLink();
  // A `StoredCfcMetadataError` propagates, deliberately: an envelope this
  // build cannot produce labels from must not read as cacheable-unlabeled.
  const metadata = readStoredCfcMetadata(tx, {
    space: link.space,
    id: link.id,
    scope: link.scope,
  });
  if (metadata === undefined) return false;
  return metadata.labelMap.entries.some((entry) =>
    entry.path.length === path.length &&
    entry.path.every((segment, index) => segment === path[index]) &&
    Array.isArray(entry.label.integrity) &&
    entry.label.integrity.some((a) => a === atom)
  );
}

/**
 * Compute the authority that a cache write may persist. Requested delegations
 * are unioned with only compiler-authenticated metadata already stored at the
 * selected source/compiled targets. Combined source+compiled saves use both
 * targets so the two document sets cannot diverge when shared successors are
 * updated by different patterns.
 */
function effectiveModuleDelegationsForWrite(
  runtime: Runtime,
  space: MemorySpace,
  modules: readonly Pick<CacheableModule, "identity">[],
  tx: IExtendedStorageTransaction,
  requested: ModuleDelegationMap,
  targets: {
    source?: boolean;
    compiledRuntimeVersion?: string;
  },
): Map<string, ReadonlySet<string>> {
  const effective = new Map<string, ReadonlySet<string>>();
  for (const module of modules) {
    const candidates: unknown[] = [
      [...(requested.get(module.identity) ?? [])],
    ];
    if (targets.source) {
      const sourceCell = runtime.getCell<StoredSourceDoc>(
        space,
        sourceDocKey(module.identity),
        undefined,
        tx,
      );
      const existing = sourceCell.get();
      // Mutable source metadata is authority only when the compiler attested
      // this exact field; the source code/import graph verifies separately.
      if (
        cellCarriesIntegrity(
          sourceCell,
          COMPILED_INTEGRITY_ATOM,
          tx,
          SOURCE_DELEGATION_PATH,
        )
      ) {
        candidates.push(existing?.delegatedModuleIdentities);
      }
    }
    if (targets.compiledRuntimeVersion !== undefined) {
      const compiledCell = runtime.getCell<StoredCompiledDoc>(
        space,
        compiledDocKey(
          targets.compiledRuntimeVersion,
          module.identity,
        ),
        undefined,
        tx,
      );
      const existing = compiledCell.get();
      if (
        cellCarriesIntegrity(
          compiledCell,
          COMPILED_INTEGRITY_ATOM,
          tx,
        )
      ) {
        candidates.push(existing?.delegatedModuleIdentities);
      }
    }
    const delegated = validDelegatedModuleIdentities(
      module.identity,
      ...candidates,
    );
    if (delegated.length > 0) {
      effective.set(module.identity, new Set(delegated));
    }
  }
  return effective;
}

/**
 * Stage a source update's delegation union on its durable artifacts. The source
 * transition owns this transaction; the returned union becomes runtime authority
 * only after that transaction commits. Compiled bodies stay in bounded cache
 * writes while these field updates share the source pointer's atomic boundary.
 */
export function stageModuleDelegations(
  runtime: Runtime,
  space: MemorySpace,
  requested: ModuleDelegationMap,
  runtimeVersion: string | undefined,
  tx: IExtendedStorageTransaction,
): ModuleDelegationMap {
  const modules = [...requested.keys()].map((identity) => ({ identity }));
  const effective = effectiveModuleDelegationsForWrite(
    runtime,
    space,
    modules,
    tx,
    requested,
    { source: true, compiledRuntimeVersion: runtimeVersion },
  );
  withCompileCacheBuiltin(tx, () => {
    for (const [identity, predecessors] of effective) {
      const source = runtime.getCell<StoredSourceDoc>(
        space,
        sourceDocKey(identity),
        undefined,
        tx,
      );
      if (source.get()?.identity !== identity) {
        throw new Error(`source update artifact ${identity} is unavailable`);
      }
      recordUndeclarablePolicyStore(tx, source);
      source.asSchema(sourceDocWriteSchema()).key("delegatedModuleIdentities")
        .set([...predecessors]);
      if (runtimeVersion !== undefined) {
        const compiled = runtime.getCell<StoredCompiledDoc>(
          space,
          compiledDocKey(runtimeVersion, identity),
          undefined,
          tx,
        );
        // Source-only recovery is valid; a compiled record, when present, must
        // retain the compiler's attestation before its metadata can be extended.
        if (compiled.get() !== undefined) {
          if (!cellCarriesIntegrity(compiled, COMPILED_INTEGRITY_ATOM, tx)) {
            throw new Error(
              `compiled source update artifact ${identity} is untrusted`,
            );
          }
          recordUndeclarablePolicyStore(tx, compiled);
          compiled.asSchema(compiledDocWriteSchema()).key(
            "delegatedModuleIdentities",
          )
            .set([...predecessors]);
        }
      }
    }
  });
  return effective;
}

/**
 * Write every emitted module's compiled body as a
 * `compileCache:<runtimeVersion>/<identity>` cell into `space`, stamped with the
 * compiler integrity atom, imports linked to dependency compiled cells (the
 * entry additionally linking any otherwise-unreachable module). The caller must
 * `prepareCfc()` + commit the tx under an enforcing CFC mode for the integrity
 * label to persist. Returns the authenticated delegation union actually staged
 * by this write.
 */
export function writeCompiledDocs(
  runtime: Runtime,
  space: MemorySpace,
  modules: readonly CacheableModule[],
  entryIdentity: string,
  opts: {
    runtimeVersion: string;
    moduleDelegations?: ModuleDelegationMap;

    /** See {@link buildSourceDocs}: full-set root links for chunked writes. */
    extraRoots?: readonly string[];
  },
  tx: IExtendedStorageTransaction,
): ModuleDelegationMap {
  assertNoUnpinnedFabricImports(modules);
  const effectiveModuleDelegations = effectiveModuleDelegationsForWrite(
    runtime,
    space,
    modules,
    tx,
    opts.moduleDelegations ?? EMPTY_MODULE_DELEGATIONS,
    { compiledRuntimeVersion: opts.runtimeVersion },
  );
  const extraRoots = opts.extraRoots ??
    unreachedRoots(modules, entryIdentity);
  const schema = compiledDocWriteSchema();
  withCompileCacheBuiltin(tx, () => {
    for (const module of modules) {
      const cell = runtime.getCell(
        space,
        compiledDocKey(opts.runtimeVersion, module.identity),
        schema,
        tx,
      );
      recordUndeclarablePolicyStore(tx, cell);
      // Fix B: derive the record surface from the compiled body once, here, so
      // the boot-time record build reads it instead of re-parsing per load. A
      // data entry has no record surface and its bytes are not JavaScript, so
      // it is never handed to the extractor.
      const derived = module.isData
        ? undefined
        : deriveModuleRecordFields(module.js);
      const delegatedModuleIdentities = validDelegatedModuleIdentities(
        module.identity,
        [...(effectiveModuleDelegations.get(module.identity) ?? [])],
      );
      const policyManifests = module.policyManifests?.map((input) => {
        const artifact = validateCfcPolicyArtifactManifest(input);
        if (artifact.manifest.moduleIdentity !== module.identity) {
          throw new Error(
            `policy manifest module identity mismatch for '${module.filename}'`,
          );
        }
        return artifact;
      });
      if (policyManifests !== undefined) {
        runtime.registerCfcPolicyManifests(undefined, policyManifests);
      }
      writeCacheRecord(cell, {
        kind: module.isData ? "data" : "compiled",
        identity: module.identity,
        code: codeLink(space, module.js, tx),
        filename: module.filename,
        ...(derived === undefined ? {} : {
          exportNames: derived.exportNames,
          starTargetSpecs: derived.starTargetSpecs,
          importSpecs: derived.importSpecs,
        }),
        ...(module.sourceMap !== undefined
          ? { sourceMap: module.sourceMap }
          : {}),
        ...(module.patternCoverageSpans === undefined ? {} : {
          patternCoverageSpansJson: JSON.stringify(
            module.patternCoverageSpans,
          ),
        }),
        ...(module.builderSourceSites === undefined ? {} : {
          builderSourceSitesJson: JSON.stringify(module.builderSourceSites),
        }),
        ...(policyManifests === undefined ? {} : { policyManifests }),
        ...(delegatedModuleIdentities.length > 0
          ? { delegatedModuleIdentities }
          : {}),
        imports: storedImportRefs(module, entryIdentity, extraRoots, {
          includeFabricEdges: true,
        }).map((ref) => ({
          specifier: ref.specifier,
          link: runtime.getCell(
            space,
            compiledDocKey(opts.runtimeVersion, ref.identity),
            undefined,
            tx,
          ).getAsLink(),
        })),
      } as StoredCompiledDoc);
    }
  });
  return effectiveModuleDelegations;
}

/**
 * Save matching source and compiled document sets with one authenticated
 * delegation union. This is the cache write path for compilation and repair:
 * an authority chain already present in either set is preserved in both, and
 * the returned map is the exact committed authority the caller must install in
 * its runtime after the transaction succeeds.
 */
export function writeSourceAndCompiledDocs(
  runtime: Runtime,
  space: MemorySpace,
  modules: readonly CacheableModule[],
  entryIdentity: string,
  opts: {
    runtimeVersion: string;
    moduleDelegations?: ModuleDelegationMap;

    /** See {@link buildSourceDocs}: full-set root links for chunked writes. */
    extraRoots?: readonly string[];
  },
  tx: IExtendedStorageTransaction,
): ModuleDelegationMap {
  assertNoUnpinnedFabricImports(modules);
  const effectiveModuleDelegations = effectiveModuleDelegationsForWrite(
    runtime,
    space,
    modules,
    tx,
    opts.moduleDelegations ?? EMPTY_MODULE_DELEGATIONS,
    {
      source: true,
      compiledRuntimeVersion: opts.runtimeVersion,
    },
  );
  writeSourceDocs(
    runtime,
    space,
    modules,
    entryIdentity,
    tx,
    effectiveModuleDelegations,
    opts.extraRoots,
  );
  writeCompiledDocs(
    runtime,
    space,
    modules,
    entryIdentity,
    { ...opts, moduleDelegations: effectiveModuleDelegations },
    tx,
  );
  return effectiveModuleDelegations;
}

/**
 * How many modules a single compile-cache write-back transaction covers.
 *
 * Why not one transaction for the whole closure: the first client session
 * over a space whose compiled refs went stale (a compiler/transformer output
 * change, e.g. #4980) re-writes the ENTIRE closure. As one all-or-nothing
 * commit, a session interrupted mid-write persists nothing, the next session
 * redoes everything, and under aggressive client timeouts no session ever
 * lands the write — the space retries forever (the estuary first-open
 * outage). Chunked commits make that recovery durable and incremental:
 * every committed chunk survives an interruption, re-runs re-write already
 * durable docs as empty diffs, and a few interrupted sessions converge to
 * the settled closure.
 *
 * 4 modules ≈ 8 docs per commit keeps each commit well under typical
 * ws-message/commit-validation budgets while bounding the commit count for
 * large closures. A closure of ≤4 modules still commits exactly once,
 * identical to the pre-chunking behavior.
 */
export const COMPILE_CACHE_WRITEBACK_CHUNK_MODULES = 4;

/**
 * Plan the transaction chunks for an incremental compile-cache write-back.
 *
 * Ordering makes every prefix of committed chunks a maximally useful partial
 * state: dependencies first (DFS post-order over the import graph), the
 * ENTRY module last.
 *
 * What the entry-last pin actually guarantees: an interrupted write-back
 * never persists the entry doc of a namespace that did not already have one
 * (a fresh compiled `compileCache:<version>/` namespace, or a fresh space's
 * source set), and an ABSENT ENTRY is exactly the miss test of both load
 * paths (`loadCompiledClosure` returns empty; `loadSourceClosure` resolves
 * undefined). So every partial prefix this ordering can produce reads as a
 * plain cache miss whose already-durable docs make the next session's
 * re-write cheaper (equal-value re-writes diff to nothing).
 *
 * The loaders are deliberately NOT fail-closed on missing DESCENDANTS:
 * `loadCompiledClosure` drops an absent/unstamped child along with the edge
 * to it (pinned by "skips compiled import links without integrity"), and the
 * by-identity hit test is entry presence. Chunk interruption cannot create
 * an entry-present/descendant-missing state, but should one arise out of
 * band, it degrades to a clean RECOMPILE rather than a corrupt load: the
 * source path rejects the partial graph in `loadVerifiedSourceClosure`
 * (verifySourceDocs' missing-import check) and the compiled path fails
 * cached-module evaluation, both funneling into the cold recompile fallback
 * — pinned by the descendant-missing tests in
 * compile-cache-incremental-writeback.test.ts.
 *
 * `extraRoots` is computed over the FULL module set and must be passed to
 * each chunk's write (the entry doc's synthetic root links enumerate every
 * module unreachable through the natural import graph; computing it over a
 * chunk would corrupt the entry doc's link set).
 */
export function planCompileCacheWriteChunks(
  modules: readonly CacheableModule[],
  entryIdentity: string,
  chunkSize: number = COMPILE_CACHE_WRITEBACK_CHUNK_MODULES,
): { chunks: CacheableModule[][]; extraRoots: readonly string[] } {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`invalid compile-cache write chunk size: ${chunkSize}`);
  }
  const extraRoots = unreachedRoots(modules, entryIdentity);
  const byId = new Map(modules.map((m) => [m.identity, m]));
  const ordered: CacheableModule[] = [];
  const visited = new Set<string>();
  // Iterative DFS post-order (import cycles are legal in ES modules; the
  // visited set breaks them — chunking is commit batching, not a semantic
  // ordering requirement, so any cycle cut is fine).
  const visit = (rootId: string): void => {
    const stack: { id: string; expanded: boolean }[] = [
      { id: rootId, expanded: false },
    ];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      const module = byId.get(frame.id);
      if (module === undefined) continue;
      if (frame.expanded) {
        ordered.push(module);
        continue;
      }
      if (visited.has(frame.id)) continue;
      visited.add(frame.id);
      stack.push({ id: frame.id, expanded: true });
      for (const imp of module.imports) {
        if (!visited.has(imp.targetIdentity)) {
          stack.push({ id: imp.targetIdentity, expanded: false });
        }
      }
    }
  };
  // Every module is either reachable from the entry or listed in extraRoots
  // (unreachedRoots returns ALL unreachable modules), so these walks cover
  // the full set. The entry is pinned visited during the root walks (an
  // unreachable module may import back INTO the entry) and walked last, so
  // the entry doc is always in the final chunk.
  visited.add(entryIdentity);
  for (const rootIdentity of extraRoots) visit(rootIdentity);
  visited.delete(entryIdentity);
  visit(entryIdentity);
  const chunks: CacheableModule[][] = [];
  for (let i = 0; i < ordered.length; i += chunkSize) {
    chunks.push(ordered.slice(i, i + chunkSize));
  }
  return { chunks, extraRoots };
}

/**
 * Load the integrity-valid compiled documents reachable from `entryIdentity` by
 * following import links. A **single** `sync()` on the entry cell under the
 * recursive {@link COMPILED_DOC_SCHEMA} transitively loads the whole closure
 * (the storage layer follows the `asCell` sigil links), so the walk reads the
 * already-loaded linked cells synchronously — no per-cell `sync()`.
 *
 * Fail-closed and link-faithful: the walk follows the *actual linked cells*
 * (never re-deriving a cell from a stored `identity` field), and a cell's stored
 * doc is used only after its own persisted CFC label is confirmed to carry the
 * compiler integrity atom. So every document in the result — and every import
 * edge — came from an integrity-stamped cell in `space` that the parent's sigil
 * link actually points at; an unstamped/tampered child is dropped along with
 * the edge to it (treated as a cache miss, so the caller recompiles), while a
 * mixed-space link rejects the whole closure. The entry is the one cell looked
 * up by key, from the caller's trusted `entryIdentity`.
 *
 * Resolves to the valid documents keyed by their stored identity (empty map if
 * the entry itself is missing/unstamped).
 */
export async function loadCompiledClosure(
  runtime: Runtime,
  space: MemorySpace,
  entryIdentity: string,
  opts: { runtimeVersion: string },
  tx: IExtendedStorageTransaction,
): Promise<Map<string, CompiledDoc>> {
  const atom = COMPILED_INTEGRITY_ATOM;
  const out = new Map<string, CompiledDoc>();
  const visited = new Set<string>();

  // Integrity-gated read (fail-closed): the cell's stored doc only if its
  // persisted CFC label carries the compiler atom. No sync here — the entry's
  // single sync (below) has already transitively loaded the whole closure.
  const verifiedDoc = (
    cell: Cell<unknown>,
  ): VerifiedCompiledDoc | undefined => {
    if (!cellCarriesIntegrity(cell, atom, tx)) return undefined;
    const doc = cell.get() as StoredCompiledDoc | undefined;
    if (!doc || typeof doc.identity !== "string") return undefined;
    if (!codeFieldVerifies(cell, doc.code)) return undefined;
    const code = doc.code;
    const policyManifests: unknown[] = [];
    try {
      for (const input of doc.policyManifests ?? []) {
        const snapshot = snapshotQueryResult(input);
        const artifact = validateCfcPolicyArtifactManifest(snapshot);
        if (artifact.manifest.moduleIdentity !== doc.identity) return undefined;
        policyManifests.push(artifact);
      }
    } catch {
      return undefined;
    }
    // `cell.get()` hands back a live query-result view, and `sourceMap` is the
    // one stored field consumers carry VERBATIM into module artifacts (the
    // process byte cache, storage-served compile bodies, repair and
    // replication write-backs). Written back into another space, a live view
    // serializes as a link to the place it was read from — a cross-space
    // `/sourceMap` link instead of the map, which either lands silently
    // corrupt (fresh target doc) or aborts the write-back when the target doc
    // already carries its stored CFC envelope ("missing link source metadata
    // … at /sourceMap" — the ensure-ON sx2-scale red). Materialize it to a
    // plain value here, at the one read boundary every consumer funnels
    // through, exactly as `policyManifests` are snapshotted above. The other
    // verbatim-reused fields are immune: strings and string arrays either
    // re-derive on write (`deriveModuleRecordFields`) or serialize through
    // `JSON.stringify`.
    let sourceMap: unknown;
    try {
      sourceMap = doc.sourceMap === undefined
        ? undefined
        : snapshotQueryResult(doc.sourceMap);
    } catch {
      // Mirror the policyManifests degradation above: a synchronously
      // throwing resolution — e.g. an authorization error against an
      // unreachable space behind a legacy cross-space `/sourceMap` link —
      // drops THIS doc (a cache miss, so the caller recompiles) instead of
      // failing the whole closure load.
      return undefined;
    }
    if (doc.policyManifests === undefined && sourceMap === undefined) {
      return { ...doc, code };
    }
    if (doc.policyManifests !== undefined) {
      runtime.registerCfcPolicyManifests(undefined, policyManifests);
    }
    return {
      ...doc,
      code,
      ...(sourceMap === undefined ? {} : { sourceMap }),
      ...(doc.policyManifests === undefined ? {} : { policyManifests }),
    };
  };

  const entryCell = runtime.getCell(
    space,
    compiledDocKey(opts.runtimeVersion, entryIdentity),
    COMPILED_DOC_SCHEMA,
    tx,
  );
  // One sync pulls the entire link closure (recursive schema). No further syncs.
  await entryCell.sync();
  const entryDoc = verifiedDoc(entryCell);
  if (entryDoc === undefined) return out;

  const queue: { doc: VerifiedCompiledDoc }[] = [{ doc: entryDoc }];
  while (queue.length > 0) {
    const { doc } = queue.shift()!;
    if (visited.has(doc.identity)) continue;
    visited.add(doc.identity);

    // Detach the spans from the transaction: the callers abort their read tx
    // before the closure is consumed, and a collector holds registered spans for
    // the life of the process.
    const coverageSpans = storedCoverageSpans(
      doc.patternCoverageSpansJson,
    );
    const builderSourceSites = storedBuilderSourceSites(
      doc.builderSourceSitesJson,
    );

    const imports: ModuleImportRef[] = [];
    for (const imp of doc.imports ?? []) {
      if (!isCell(imp.link)) continue;
      // `link` is an already-loaded Cell (the entry sync pulled it). View it
      // under the recursive schema so its own links resolve as cells too, then
      // integrity-check + read synchronously — no re-lookup by id, no sync.
      const linkedCell = imp.link as Cell<unknown>;
      // Compiled-cache integrity and module delegation authority are attested
      // only in the linked cell's space. Mixed-space cache graphs fail closed
      // instead of rebasing a child space's attestation onto `space`.
      if (linkedCell.space !== space) return new Map();
      const child = verifiedDoc(linkedCell.asSchema(COMPILED_DOC_SCHEMA));
      if (child === undefined) continue;
      imports.push({ specifier: imp.specifier, identity: child.identity });
      if (!visited.has(child.identity)) queue.push({ doc: child });
    }
    out.set(doc.identity, {
      // A stored `kind` the writer did not produce is read as compiled, the
      // conservative reading: a data entry is only ever treated as data when
      // the document says so.
      kind: doc.kind === "data" ? "data" : "compiled",
      code: doc.code,
      filename: doc.filename,
      ...(doc.sourceMap !== undefined ? { sourceMap: doc.sourceMap } : {}),
      ...(doc.exportNames !== undefined
        ? { exportNames: doc.exportNames }
        : {}),
      ...(doc.starTargetSpecs !== undefined
        ? { starTargetSpecs: doc.starTargetSpecs }
        : {}),
      ...(doc.importSpecs !== undefined
        ? { importSpecs: doc.importSpecs }
        : {}),
      ...(coverageSpans === undefined
        ? {}
        : { patternCoverageSpans: coverageSpans }),
      ...(builderSourceSites === undefined ? {} : { builderSourceSites }),
      ...(doc.policyManifests !== undefined
        ? { policyManifests: doc.policyManifests }
        : {}),
      ...(() => {
        const delegatedModuleIdentities = validDelegatedModuleIdentities(
          doc.identity,
          doc.delegatedModuleIdentities,
        );
        return delegatedModuleIdentities.length > 0
          ? { delegatedModuleIdentities }
          : {};
      })(),
      imports,
    });
  }
  if (!tx.hasWrites()) {
    runtime.registerModuleDelegations(space, moduleDelegationsFromDocs(out));
  }
  return out;
}
