import { dirname } from "@std/path";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

// The compiled-module-byte cache, in full. The runtime defines only the
// `ModuleByteCache` interface it consults during a compile; this test-side
// module owns the implementation and its disk persistence, and is the only
// place an instance is created. So the cache is, by construction, a single
// feature that exists only when tests install it — never in production.
//
// `createCompileByteCache` returns the instance to inject into test runtimes.
// The in-memory cache is always created for cross-runtime reuse within the
// process. Disk persistence is added only when `CF_COMPILE_CACHE_FILE` is set,
// so a run can reuse bytes it compiled on a previous run. Cross-run correctness
// rests on the cache key used by the caller: the persisted bytes are a function
// of the compiler and transformer build, which a module's content identity does
// not cover.

/** A serialized {@link ProcessModuleByteCache} entry (for disk persistence). */
export interface SerializedModuleBytes {
  key: string;
  js: string;
  sourceMap?: unknown;
  patternCoverageSpans?: CachedPatternCoverageSpan[];
  builderSourceSites?: CachedBuilderSourceSitesV1;
  policyManifests?: readonly unknown[];
}

export interface CachedBuilderSourceSitesV1 {
  formatVersion: 1;
  sites: Record<
    string,
    { line: number; col: number; bindingName?: string }
  >;
}

export interface CachedPatternCoverageSpan {
  fileName: string;
  id: number;
  kind: "runtime";
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

export interface CompiledModuleArtifact {
  js: string;
  sourceMap?: unknown;
  patternCoverageSpans?: CachedPatternCoverageSpan[];
  builderSourceSites?: CachedBuilderSourceSitesV1;
  policyManifests?: readonly unknown[];
}

export interface ModuleByteCache {
  getCompleteSet(
    runtimeVersion: string,
    identities: readonly string[],
  ): Map<string, CompiledModuleArtifact> | undefined;

  putAll(
    runtimeVersion: string,
    modules: readonly ({ identity: string } & CompiledModuleArtifact)[],
  ): void;
}

const cacheFiles = new WeakMap<ProcessModuleByteCache, string>();

/**
 * Process-level, content-addressed cache of compiled module bytes. An entry is
 * the emitted JavaScript for one module (plus its optional source map), keyed by
 * the module's content identity scoped by the compiled-set `runtimeVersion`. The
 * emitted bytes are a deterministic function of that key, so a hit always returns
 * the bytes the identity addresses. Holds emitted JS only, never live pattern
 * instances. A byte cap bounds the total retained JS and evicts oldest-first.
 */
export class ProcessModuleByteCache implements ModuleByteCache {
  /**
   * The cached artifacts, keyed by `${runtimeVersion}\0${identity}`. Map
   * insertion order gives FIFO eviction (recency-refreshed on read, so
   * eviction is ~LRU).
   */
  readonly #entries = new Map<
    string,
    { artifact: CompiledModuleArtifact; size: number }
  >();

  #totalBytes = 0;
  readonly #maxBytes: number;

  constructor(maxBytes = 256 * 1024 * 1024) {
    this.#maxBytes = maxBytes;
  }

  static #key(runtimeVersion: string, identity: string): string {
    return `${runtimeVersion}\0${identity}`;
  }

  static #sizeOf(artifact: CompiledModuleArtifact): number {
    let size = artifact.js.length;
    if (typeof artifact.sourceMap === "string") {
      size += artifact.sourceMap.length;
    }
    if (artifact.patternCoverageSpans !== undefined) {
      size += JSON.stringify(artifact.patternCoverageSpans).length;
    }
    if (artifact.builderSourceSites !== undefined) {
      size += JSON.stringify(artifact.builderSourceSites).length;
    }
    if (artifact.policyManifests !== undefined) {
      size += JSON.stringify(artifact.policyManifests).length;
    }
    return size;
  }

  get(
    runtimeVersion: string,
    identity: string,
  ): CompiledModuleArtifact | undefined {
    const key = ProcessModuleByteCache.#key(runtimeVersion, identity);
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.artifact;
  }

  getCompleteSet(
    runtimeVersion: string,
    identities: readonly string[],
  ): Map<string, CompiledModuleArtifact> | undefined {
    const bodies = new Map<string, CompiledModuleArtifact>();
    for (const identity of identities) {
      const artifact = this.get(runtimeVersion, identity);
      if (artifact === undefined) return undefined;
      bodies.set(identity, artifact);
    }
    return bodies;
  }

  put(
    runtimeVersion: string,
    identity: string,
    artifact: CompiledModuleArtifact,
  ): void {
    this.#insert(
      ProcessModuleByteCache.#key(runtimeVersion, identity),
      artifact,
      { replaceExisting: true },
    );
  }

  #insert(
    key: string,
    artifact: CompiledModuleArtifact,
    options: { replaceExisting: boolean },
  ): void {
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#entries.delete(key);
      this.#totalBytes -= existing.size;
      if (!options.replaceExisting) {
        this.#entries.set(key, existing);
        this.#totalBytes += existing.size;
        return;
      }
    }
    const size = ProcessModuleByteCache.#sizeOf(artifact);
    this.#entries.set(key, { artifact, size });
    this.#totalBytes += size;
    this.#evictToCap();
  }

  putAll(
    runtimeVersion: string,
    modules: readonly ({ identity: string } & CompiledModuleArtifact)[],
  ): void {
    for (const module of modules) {
      this.put(runtimeVersion, module.identity, artifactFromModule(module));
    }
  }

  #evictToCap(): void {
    while (this.#totalBytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.#entries.get(oldest);
      this.#entries.delete(oldest);
      if (entry !== undefined) this.#totalBytes -= entry.size;
    }
  }

  /** A serializable dump of every cached module. Pairs with {@link restore}. */
  snapshot(): SerializedModuleBytes[] {
    const out: SerializedModuleBytes[] = [];
    for (const [key, { artifact }] of this.#entries) {
      const serialized: SerializedModuleBytes = { key, js: artifact.js };
      if (artifact.sourceMap !== undefined) {
        serialized.sourceMap = artifact.sourceMap;
      }
      if (artifact.patternCoverageSpans !== undefined) {
        serialized.patternCoverageSpans = artifact.patternCoverageSpans.map(
          copyPatternCoverageSpan,
        );
      }
      if (artifact.builderSourceSites !== undefined) {
        serialized.builderSourceSites = copyBuilderSourceSites(
          artifact.builderSourceSites,
        );
      }
      if (artifact.policyManifests !== undefined) {
        serialized.policyManifests = artifact.policyManifests;
      }
      out.push(serialized);
    }
    return out;
  }

  /**
   * Merge a {@link snapshot} back in (idempotent; content-addressed, so a key
   * collision is the same bytes). Malformed entries are skipped.
   */
  restore(entries: readonly unknown[]): void {
    for (const entry of entries) {
      if (!isObjectOrArray(entry)) continue;
      const e = entry as Partial<SerializedModuleBytes>;
      if (typeof e.key !== "string" || typeof e.js !== "string") continue;
      const patternCoverageSpans = normalizePatternCoverageSpans(
        e.patternCoverageSpans,
      );
      const builderSourceSites = normalizeBuilderSourceSites(
        e.builderSourceSites,
      );
      if (
        e.patternCoverageSpans !== undefined &&
        patternCoverageSpans === undefined
      ) continue;
      if (
        e.builderSourceSites !== undefined && builderSourceSites === undefined
      ) continue;
      if (
        e.policyManifests !== undefined &&
        !Array.isArray(e.policyManifests)
      ) continue;
      const artifact: CompiledModuleArtifact = { js: e.js };
      if (e.sourceMap !== undefined) artifact.sourceMap = e.sourceMap;
      if (patternCoverageSpans !== undefined) {
        artifact.patternCoverageSpans = patternCoverageSpans;
      }
      if (builderSourceSites !== undefined) {
        artifact.builderSourceSites = builderSourceSites;
      }
      if (e.policyManifests !== undefined) {
        artifact.policyManifests = [...e.policyManifests];
      }
      this.#insert(
        e.key,
        artifact,
        { replaceExisting: false },
      );
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#totalBytes = 0;
  }

  stats(): { entries: number; bytes: number } {
    return { entries: this.#entries.size, bytes: this.#totalBytes };
  }
}

function artifactFromModule(
  module: { identity: string } & CompiledModuleArtifact,
): CompiledModuleArtifact {
  const artifact: CompiledModuleArtifact = { js: module.js };
  if (module.sourceMap !== undefined) artifact.sourceMap = module.sourceMap;
  if (module.patternCoverageSpans !== undefined) {
    artifact.patternCoverageSpans = module.patternCoverageSpans.map(
      copyPatternCoverageSpan,
    );
  }
  if (module.builderSourceSites !== undefined) {
    artifact.builderSourceSites = copyBuilderSourceSites(
      module.builderSourceSites,
    );
  }
  if (module.policyManifests !== undefined) {
    artifact.policyManifests = [...module.policyManifests];
  }
  return artifact;
}

function normalizePatternCoverageSpans(
  spans: unknown,
): CachedPatternCoverageSpan[] | undefined {
  if (spans === undefined) return undefined;
  if (!Array.isArray(spans)) return undefined;
  const normalized: CachedPatternCoverageSpan[] = [];
  for (const span of spans) {
    if (!isPatternCoverageSpan(span)) return undefined;
    normalized.push(copyPatternCoverageSpan(span));
  }
  return normalized;
}

function isPatternCoverageSpan(
  span: unknown,
): span is CachedPatternCoverageSpan {
  if (!isObjectOrArray(span)) return false;
  const s = span as Partial<CachedPatternCoverageSpan>;
  return typeof s.fileName === "string" &&
    typeof s.id === "number" &&
    s.kind === "runtime" &&
    typeof s.startLine === "number" &&
    typeof s.endLine === "number" &&
    typeof s.startColumn === "number" &&
    typeof s.endColumn === "number";
}

function copyPatternCoverageSpan(
  span: CachedPatternCoverageSpan,
): CachedPatternCoverageSpan {
  return {
    fileName: span.fileName,
    id: span.id,
    kind: span.kind,
    startLine: span.startLine,
    endLine: span.endLine,
    startColumn: span.startColumn,
    endColumn: span.endColumn,
  };
}

function normalizeBuilderSourceSites(
  value: unknown,
): CachedBuilderSourceSitesV1 | undefined {
  if (value === undefined) return undefined;
  if (!isObjectNotArray(value)) {
    return undefined;
  }
  const sidecar = value as Partial<CachedBuilderSourceSitesV1>;
  if (
    sidecar.formatVersion !== 1 || !isObjectNotArray(sidecar.sites)
  ) {
    return undefined;
  }
  const sites = Object.create(null) as CachedBuilderSourceSitesV1["sites"];
  for (const [symbol, value] of Object.entries(sidecar.sites)) {
    if (symbol.length === 0 || !isObjectOrArray(value)) {
      return undefined;
    }
    const site = value as {
      line?: unknown;
      col?: unknown;
      bindingName?: unknown;
    };
    if (
      !Number.isInteger(site.line) || (site.line as number) < 1 ||
      !Number.isInteger(site.col) || (site.col as number) < 0 ||
      (site.bindingName !== undefined &&
        (typeof site.bindingName !== "string" || site.bindingName.length === 0))
    ) {
      return undefined;
    }
    sites[symbol] = {
      line: site.line as number,
      col: site.col as number,
      ...(site.bindingName === undefined
        ? {}
        : { bindingName: site.bindingName }),
    };
  }
  return { formatVersion: 1, sites };
}

function copyBuilderSourceSites(
  sidecar: CachedBuilderSourceSitesV1,
): CachedBuilderSourceSitesV1 {
  return normalizeBuilderSourceSites(sidecar)!;
}

/**
 * Create the compiled-module-byte cache and return it for injection into test
 * runtimes. When `CF_COMPILE_CACHE_FILE` is set, the cache is seeded from that
 * file now and written back at process exit.
 */
export function createCompileByteCache(): ModuleByteCache {
  const cache = new ProcessModuleByteCache();
  const cacheFile = Deno.env.get("CF_COMPILE_CACHE_FILE");
  if (!cacheFile) return cache;

  const restored = restoreCompileByteCache(cache, cacheFile);
  if (restored !== undefined) {
    console.log(
      `[compile-byte-cache] restored ${restored} modules from ${cacheFile}`,
    );
  }

  cacheFiles.set(cache, cacheFile);
  globalThis.addEventListener("unload", () => {
    try {
      const written = flushCompileByteCache(cache);
      console.log(
        `[compile-byte-cache] wrote ${written} modules to ${cacheFile}`,
      );
    } catch (error) {
      console.error(
        `[compile-byte-cache] failed to write ${cacheFile}:`,
        error,
      );
    }
  });

  return cache;
}

export function flushCompileByteCache(
  cache: ModuleByteCache,
): number | undefined {
  if (!(cache instanceof ProcessModuleByteCache)) return undefined;
  const cacheFile = cacheFiles.get(cache);
  if (cacheFile === undefined) return undefined;
  return writeCompileByteCache(cache, cacheFile);
}

function restoreCompileByteCache(
  cache: ProcessModuleByteCache,
  cacheFile: string,
): number | undefined {
  let text: string | undefined;
  try {
    text = Deno.readTextFileSync(cacheFile);
  } catch (error) {
    // A missing file is the expected cold start. Any other read failure
    // (permissions, I/O) is real — let it surface rather than masking it.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (text !== undefined) {
    // A malformed cache file is a real fault, not a cold start: let the parse
    // error surface. `restore` itself tolerates individual malformed entries.
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      cache.restore(parsed);
      return parsed.length;
    }
  }
  return undefined;
}

export function writeCompileByteCacheForTesting(
  cache: ProcessModuleByteCache,
  cacheFile: string,
): number {
  return writeCompileByteCache(cache, cacheFile);
}

export function restoreCompileByteCacheForTesting(
  cache: ProcessModuleByteCache,
  cacheFile: string,
): number | undefined {
  return restoreCompileByteCache(cache, cacheFile);
}

function writeCompileByteCache(
  cache: ProcessModuleByteCache,
  cacheFile: string,
): number {
  Deno.mkdirSync(dirname(cacheFile), { recursive: true });
  const lock = Deno.openSync(`${cacheFile}.lock`, {
    create: true,
    read: true,
    write: true,
  });
  let locked = false;
  try {
    lock.lockSync(true);
    locked = true;
    restoreCompileByteCache(cache, cacheFile);
    const snapshot = cache.snapshot();
    writeTextFileAtomicSync(cacheFile, JSON.stringify(snapshot));
    return snapshot.length;
  } finally {
    try {
      if (locked) lock.unlockSync();
    } finally {
      lock.close();
    }
  }
}

function writeTextFileAtomicSync(path: string, text: string): void {
  const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    Deno.writeTextFileSync(tempPath, text);
    Deno.renameSync(tempPath, path);
  } catch (error) {
    try {
      Deno.removeSync(tempPath);
    } catch {
      // The temp file may not have been created yet.
    }
    throw error;
  }
}
