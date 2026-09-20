import { debugStr } from "@commonfabric/data-model";
import { LRUCache } from "@commonfabric/utils/cache";
import { MappedPosition, SourceMapConsumer } from "source-map-js";

import { SourceMap } from "./interface.ts";

export type { MappedPosition };

//
// VLQ-level composition (the fast path of `composeBundleSourceMap`)
//

/**
 * A mappings stream the transcoder cannot compose: malformed VLQs, unsorted
 * segments, out-of-range indices, or shapes our compiler never emits (a
 * non-empty `sourceRoot`). These indicate corrupt or foreign input, so they
 * fail loud rather than degrade — the pre-#4455 consumer/generator
 * implementation survives only as the differential oracle in the tests.
 */
export class SourceMapComposeError extends Error {
  constructor(reason: string) {
    super(`composeBundleSourceMap: ${reason}`);
    this.name = "SourceMapComposeError";
  }
}

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE64_CHARS.length; i++) {
    table[BASE64_CHARS.charCodeAt(i)] = i;
  }
  return table;
})();

/** Decode one signed base64-VLQ value starting at `cursor.i`; advances it. */
function decodeVLQ(mappings: string, cursor: { i: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const code = mappings.charCodeAt(cursor.i++);
    const digit = code < 128 ? BASE64_VALUES[code] : -1;
    if (digit === -1) throw new SourceMapComposeError("malformed VLQ");
    result += (digit & 0x1f) << shift;
    if ((digit & 0x20) === 0) break;
    shift += 5;
  }
  const negative = (result & 1) === 1;
  result >>>= 1;
  return negative ? -result : result;
}

/** Encode one signed value as base64 VLQ. */
function encodeVLQ(value: number): string {
  let vlq = value < 0 ? ((-value) << 1) + 1 : value << 1;
  let out = "";
  do {
    let digit = vlq & 0x1f;
    vlq >>>= 5;
    if (vlq > 0) digit |= 0x20;
    out += BASE64_CHARS[digit];
  } while (vlq > 0);
  return out;
}

const atSegmentEnd = (mappings: string, i: number): boolean =>
  i >= mappings.length || mappings[i] === "," || mappings[i] === ";";

/**
 * Textual `composeBundleSourceMap`: transcode each module's `mappings` stream
 * directly — one decode+re-encode pass per segment, no mapping objects, no
 * sort, no generator, no JSON round-trip. Segment fields 2–5 are deltas that
 * run across the whole stream, so each module's stream is rebased onto the
 * running output state (plus its source/name index base) as it is appended;
 * per-line field 1 restarts at every `;` exactly as in the inputs.
 *
 * Position-equivalent to the legacy path, with one benign divergence: modules
 * contribute their declared `sources`/`names` arrays wholesale (indices stay
 * valid), where the generator collects only first-use entries — lookups
 * resolve identically, the arrays may just carry unused entries. Mappings
 * without an original position (1-field segments) are dropped, matching the
 * legacy `m.source == null` filter. Corrupt or foreign shapes (malformed
 * VLQs, unsorted streams, out-of-range indices, non-empty `sourceRoot`) throw
 * {@link SourceMapComposeError} — fail loud, no silent degradation.
 */
function composeBundleSourceMapTextual(
  modules: ReadonlyArray<ComposeModuleEntry>,
  bundleFilename: string,
  startLineOffset = 0,
): SourceMap | undefined {
  const sources: string[] = [];
  const names: string[] = [];
  const contents: (string | null)[] = [];
  let anyContent = false;
  const out: string[] = [];
  // Running absolutes of the emitted stream (fields 2–5 are stream-global).
  let prevSrc = 0;
  let prevOrigLine = 0;
  let prevOrigCol = 0;
  let prevName = 0;
  // Line index (0-based) the next emitted `;` would move past.
  let emittedLines = 0;
  let any = false;
  let lineOffset = startLineOffset;

  for (const { body, bodyLineCount, map, source } of modules) {
    if (body === undefined && bodyLineCount === undefined) {
      throw new SourceMapComposeError(
        "module entry needs body or bodyLineCount (line extent is required)",
      );
    }
    if (map) {
      if (typeof map.sourceRoot === "string" && map.sourceRoot !== "") {
        throw new SourceMapComposeError(
          "non-empty sourceRoot (never emitted by our compiler)",
        );
      }
      // Materialize every map field into plain locals ONCE. On the cached
      // boot path these maps are storage-backed proxies whose property reads
      // run a transaction read each — per-segment `.length` checks against
      // the live objects turn the hot loop into tens of ms of storage reads
      // (measured: ~9ms → ~87ms per boot). One shallow copy per module keeps
      // the loop on plain data for proxies and plain maps alike.
      const mapSources = [...(map.sources ?? [])];
      // A `source` override collapses every mapping onto the override entry
      // (srcGlobal below always emits the override index), so multi-source
      // inputs are fine; range checks still validate against the declared set.
      const effectiveSources = source !== undefined ? [source] : mapSources;
      const mapNames = [...(map.names ?? [])];
      const rawContents =
        (map as { sourcesContent?: (string | null)[] }).sourcesContent;
      const mapContents = rawContents ? [...rawContents] : undefined;
      const sourceCount = mapSources.length;
      const nameCount = mapNames.length;
      const sourceBase = sources.length;
      const nameBase = names.length;

      // In-module absolutes (every stream starts its deltas from 0).
      let mSrc = 0;
      let mOrigLine = 0;
      let mOrigCol = 0;
      let mName = 0;
      let moduleLine = 0;
      let genColAbs = 0;
      let linePrevGen = 0;
      let lineOpen = false; // an output segment exists for the current line
      let emitted = false;
      const s = map.mappings ?? "";
      const cursor = { i: 0 };
      while (cursor.i < s.length) {
        const ch = s[cursor.i];
        if (ch === ";") {
          moduleLine++;
          genColAbs = 0;
          linePrevGen = 0;
          lineOpen = false;
          cursor.i++;
          continue;
        }
        if (ch === ",") {
          cursor.i++;
          continue;
        }
        genColAbs += decodeVLQ(s, cursor);
        if (genColAbs < 0) {
          throw new SourceMapComposeError("negative generated column");
        }
        if (atSegmentEnd(s, cursor.i)) continue; // 1-field segment: dropped
        mSrc += decodeVLQ(s, cursor);
        mOrigLine += decodeVLQ(s, cursor);
        mOrigCol += decodeVLQ(s, cursor);
        let hasName = false;
        if (!atSegmentEnd(s, cursor.i)) {
          mName += decodeVLQ(s, cursor);
          hasName = true;
          if (!atSegmentEnd(s, cursor.i)) {
            throw new SourceMapComposeError("segment with more than 5 fields");
          }
        }
        if (
          mSrc < 0 || mSrc >= sourceCount || mOrigLine < 0 ||
          mOrigCol < 0 || (hasName && (mName < 0 || mName >= nameCount))
        ) {
          throw new SourceMapComposeError("source/name index out of range");
        }
        if (lineOpen) {
          if (genColAbs < linePrevGen) {
            throw new SourceMapComposeError(
              "mappings not sorted by generated position",
            );
          }
          out.push(",");
        } else {
          const bundleLine = lineOffset + moduleLine;
          if (bundleLine < emittedLines) {
            throw new SourceMapComposeError(
              "module mapping extends past its body",
            );
          }
          out.push(";".repeat(bundleLine - emittedLines));
          emittedLines = bundleLine;
          lineOpen = true;
        }
        const srcGlobal = sourceBase + (source !== undefined ? 0 : mSrc);
        let segment = encodeVLQ(genColAbs - linePrevGen) +
          encodeVLQ(srcGlobal - prevSrc) +
          encodeVLQ(mOrigLine - prevOrigLine) +
          encodeVLQ(mOrigCol - prevOrigCol);
        linePrevGen = genColAbs;
        prevSrc = srcGlobal;
        prevOrigLine = mOrigLine;
        prevOrigCol = mOrigCol;
        if (hasName) {
          const nameGlobal = nameBase + mName;
          segment += encodeVLQ(nameGlobal - prevName);
          prevName = nameGlobal;
        }
        out.push(segment);
        emitted = true;
        any = true;
      }

      if (emitted) {
        sources.push(...effectiveSources);
        names.push(...mapNames);
        if (source !== undefined) {
          // Overridden single source: its content is the first non-null entry
          // (per-module compiler maps carry exactly one source).
          const content = mapContents?.find((c) => c != null) ?? null;
          contents.push(content);
          if (content != null) anyContent = true;
        } else {
          for (let i = 0; i < effectiveSources.length; i++) {
            const content = mapContents?.[i] ?? null;
            contents.push(content);
            if (content != null) anyContent = true;
          }
        }
      }
    }
    // Lines this body occupies in the "\n"-joined bundle = (newlines in body)+1.
    // Robust to trailing newlines, unlike split().length. Callers that no
    // longer hold the body pass the precomputed count instead (the lazy
    // boot-path registration, CT-1819) — the count is the ONLY thing compose
    // needs from the body text.
    lineOffset += bodyLineCount ?? ((body!.match(/\n/g)?.length ?? 0) + 1);
  }
  if (!any) return undefined;
  const composed = {
    version: 3,
    file: bundleFilename,
    sources,
    names,
    mappings: out.join(""),
    ...(anyContent ? { sourcesContent: contents } : {}),
  };
  // Same `version` shape as the legacy path's `JSON.parse(generator.toString())`
  // (a numeric 3 behind the RawSourceMap string type).
  return composed as unknown as SourceMap;
}

/**
 * A module's contribution to a composed bundle map. Exactly one of `body` /
 * `bodyLineCount` must describe the module's generated-line extent —
 * composition only ever needs the LINE COUNT of the body, so callers that
 * defer composition (the lazy boot-path registration, CT-1819) capture the
 * precomputed count instead of retaining the body text.
 */
export type ComposeModuleEntry = {
  body?: string;
  bodyLineCount?: number;
  map?: SourceMap;
  source?: string;
};

// Tests-only observability: cold-boot laziness is asserted by counting
// compositions (a profile-level claim otherwise only visible on the rig).
let composeCallsForTesting = 0;
export function getComposeBundleSourceMapCallsForTesting(): number {
  return composeCallsForTesting;
}

/**
 * Compose a single bundle source map for the concatenated module bodies
 * (`[...bodies].join("\n")`) from each module's own source map, offsetting each
 * module's generated lines by its starting line in the concatenation.
 *
 * Runtime stack frames report positions in the concatenated bundle. Registering
 * this composed map resolves those positions back to the original authored
 * source (e.g. `/main.tsx:6:2`).
 *
 * Returns `undefined` if no module contributed a map.
 */
export function composeBundleSourceMap(
  // `source`, when set, overrides the map's recorded source path for ALL of that
  // module's mappings. The per-module compiler maps can record only the
  // basename (e.g. `main.tsx`); overriding preserves the full authored module
  // path in mapped stack frames (e.g. `/<id>/dir/main.tsx`).
  modules: ReadonlyArray<ComposeModuleEntry>,
  bundleFilename: string,
  // Generated-line offset applied to the FIRST module. Use this when the
  // generated text is wrapped by a fixed prefix of N lines (e.g. the ESM
  // loader's `(function (exports, require, module) {\n` factory wrapper adds 1
  // line before the compiled body), so coordinates from `new Error().stack`
  // (1-based, relative to the eval'd string) map correctly.
  startLineOffset = 0,
): SourceMap | undefined {
  composeCallsForTesting++;
  return composeBundleSourceMapTextual(
    modules,
    bundleFilename,
    startLineOffset,
  );
}

/**
 * Build an IDENTITY source map for a compiled body whose authored source map
 * was not retained — every generated line maps to the same line/column of
 * `source`. Used by the warm/cached module-record load path so error stacks
 * name the module source rather than a raw bundle coordinate.
 *
 * Line/column coordinates are preserved verbatim (the compiled body IS the
 * eval'd text under this load), so no positional information is invented — the
 * map only re-labels the bundle coordinate with the per-module source name.
 */
export function identitySourceMap(
  // The compiled body, or its precomputed line count — the map is a fixed
  // token per line, so the count is all the body contributes (lets the lazy
  // boot-path registration avoid retaining body text, CT-1819).
  body: string | number,
  source: string,
): SourceMap {
  const lineCount = typeof body === "number"
    ? body
    : (body.match(/\n/g)?.length ?? 0) + 1;
  // Synthesized directly — the stream is a fixed token per line: line 1 maps
  // column 0 to source 0, line 1, column 0 (`AAAA`); every following line
  // advances only the original line by one (`AACA`). Byte-identical to what a
  // SourceMapGenerator loop over the same mappings emits, without paying the
  // per-line addMapping/serialize round-trip on the boot path.
  const mappings = "AAAA" + ";AACA".repeat(lineCount - 1);
  return {
    version: 3,
    file: source,
    sources: [source],
    names: [],
    mappings,
  } as unknown as SourceMap;
}

/**
 * Maximum number of source maps to cache in memory.
 * When exceeded, oldest (least recently used) entries are evicted.
 *
 * Sized for the ESM module-record loader, which registers ONE map per load —
 * the composed `${loadId}.js` bundle map — PLUS one map per module (keyed by the
 * module's eval `//# sourceURL`) so the browser stack path can resolve each
 * module's eval frame. A single multi-file load therefore registers
 * `1 + moduleCount` entries that must all stay live until `loadModuleGraph`
 * annotates functions; a small cap (the old value was 50) would evict the bundle
 * map — and early per-module maps — mid-load for larger graphs, regressing
 * mapped stacks to lose their authored module names.
 * This bound comfortably exceeds realistic per-load module counts while still
 * capping total memory across loads (stale maps from superseded loads evict via
 * LRU; the parser is also fully cleared on runtime dispose).
 */
const MAX_SOURCE_MAP_CACHE_SIZE = 1024;

// Parses strings like the following into function, filename, line and columns:
/// ```
// at doubleOrThrow (recipe-abc.js, <anonymous>:14:15)
// at Object.eval [as factory] (recipe-abc.js, <anonymous>:4:52)
// at Object.errorOnLine6 [as default] (known-line.js, <anonymous>:5:15)
// at Loader.resolveModule (recipe-abc.js, <anonymous>:1:1764)
// at eval (recipe-abc.js, <anonymous>:17:10)
// at async Scheduler.execute (http://localhost:8000/scripts/worker-runtime.js:241550:11)
// at GmailClient.googleRequest (somefile.js:24414:23)
/// ```
// Pattern breakdown:
// - Optional "async " prefix for async stack frames
// - Function name: [\w\.$<>]* allows alphanumeric, underscore, dot, $, and <> (for <anonymous>)
// - [as identifier]: \[as \w+\] matches any identifier, not just "factory"
const stackTracePattern =
  /at (?:async )?(.+?) (?:\[as [^\]]+\] )?\((.+?)(?:, <anonymous>)?(?:\):|\:)(\d+):(\d+)\)/;
// V8 eval frames without a function name show the filename directly after "at".
// When there is a nested position in parens, it is the more precise location:
//   at recipe-abc.js, <anonymous>:14:15 (recipe-abc.js, <anonymous>:20:10)
//   at recipe-abc.js, <anonymous>:14:15
// The nested pattern matches the inner (more precise) position first.
const evalFrameNestedPattern =
  /at .+?, <anonymous>:\d+:\d+ \((.+?), <anonymous>:(\d+):(\d+)\)/;
const evalFramePattern = /at (.+?), <anonymous>:(\d+):(\d+)/;
const CF_INTERNAL = `    at <CF_INTERNAL>`;
const UNMAPPED = `    at <UNMAPPED>`;

export class SourceMapParser {
  #sourceMaps = new LRUCache<string, SourceMap>({
    capacity: MAX_SOURCE_MAP_CACHE_SIZE,
  });
  #consumers = new WeakMap<SourceMap, SourceMapConsumer>();

  /**
   * Deferred registrations: the boot path registers a _provider_ instead of
   * composing eagerly; the first lookup that needs the filename materializes
   * it. One-shot — the provider is dropped as soon as it runs, so its captured
   * inputs are released after first use. LRU-bounded like `#sourceMaps`: a
   * provider whose filename is _never_ looked up (its eval never errored)
   * would otherwise be retained until dispose — one per eval, an unbounded
   * leak on long-lived runners — so this caps it and evicts the oldest.
   * Evicting an unused provider only means a later error in that (old) eval
   * goes unmapped, exactly as when the composed-map LRU evicts a stale entry.
   */
  #pendingProviders = new LRUCache<
    string,
    () => SourceMap | undefined
  >({ capacity: MAX_SOURCE_MAP_CACHE_SIZE });

  load(filename: string, sourceMap: SourceMap) {
    // An explicit map supersedes any pending provider for the same name.
    this.#pendingProviders.delete(filename);
    this.#sourceMaps.put(filename, sourceMap);
  }

  /**
   * Register a deferred source map: `provider` runs (once) the first time a
   * lookup needs `filename`. A provider returning `undefined` (nothing to
   * compose) simply leaves the name unmapped, matching eager behavior.
   */
  loadLazy(filename: string, provider: () => SourceMap | undefined) {
    this.#pendingProviders.put(filename, provider);
  }

  /** Tests-only: count of still-deferred (not-yet-materialized) providers. */
  pendingProviderCountForTesting(): number {
    return this.#pendingProviders.size;
  }

  #materialize(filename: string): void {
    const provider = this.#pendingProviders.get(filename);
    if (provider === undefined) return;
    this.#pendingProviders.delete(filename);
    const sourceMap = provider();
    if (sourceMap !== undefined) {
      this.#sourceMaps.put(filename, sourceMap);
    }
  }

  /**
   * Clear all accumulated source maps, consumers, and pending providers.
   * Used for cleanup when the runtime is disposed.
   */
  clear(): void {
    this.#sourceMaps.clear();
    this.#pendingProviders.clear();
  }

  /**
   * Fixes stack traces to use source map from eval. Strangely, both Deno and
   * Chrome at least only observe `sourceURL` but not the source map, so we can
   * use the former to find the right source map and then apply this.
   */
  parse(stack: string): string {
    return stack.split("\n").map((line) => {
      const match = line.match(stackTracePattern);

      if (match) {
        return this.#mapFrame(match[1], match[2], match[3], match[4], line);
      }

      // V8 eval frames without a function name.
      // Try the nested pattern first (inner position is more precise).
      const nestedMatch = line.match(evalFrameNestedPattern);
      if (nestedMatch) {
        return this.#mapFrame(
          "",
          nestedMatch[1],
          nestedMatch[2],
          nestedMatch[3],
          line,
        );
      }

      const evalMatch = line.match(evalFramePattern);
      if (evalMatch) {
        return this.#mapFrame(
          "",
          evalMatch[1],
          evalMatch[2],
          evalMatch[3],
          line,
        );
      }

      return line;
    }).join("\n");
  }

  #mapFrame(
    fnName: string,
    filename: string,
    lineStr: string,
    colStr: string,
    originalLine: string,
  ): string {
    const lineNum = parseInt(lineStr, 10);
    const columnNum = parseInt(colStr, 10);

    this.#materialize(filename);
    const sourceMap = this.#sourceMaps.get(filename);
    if (!sourceMap) return originalLine;

    const consumer = this.#getConsumer(sourceMap);
    const originalPosition = consumer.originalPositionFor({
      line: lineNum,
      column: columnNum,
    });

    if (mapIsEmpty(originalPosition)) {
      if (fnName === "eval" || fnName === "") {
        return CF_INTERNAL;
      }
      return UNMAPPED;
    }

    const name = fnName || originalPosition.name || "<anonymous>";
    return `    at ${name} (${originalPosition.source}:${originalPosition.line}:${originalPosition.column})`;
  }

  /**
   * Maps a single position to its original source location. More efficient
   * than `parse()` when only one position is needed.
   */
  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    this.#materialize(filename);
    const sourceMap = this.#sourceMaps.get(filename);
    if (!sourceMap) return null;
    const consumer = this.#getConsumer(sourceMap);
    const pos = consumer.originalPositionFor({ line, column });
    return mapIsEmpty(pos) ? null : pos;
  }

  #getConsumer(sourceMap: SourceMap): SourceMapConsumer {
    let consumer = this.#consumers.get(sourceMap);
    if (consumer) {
      return consumer;
    }
    consumer = new SourceMapConsumer(sourceMap);
    this.#consumers.set(sourceMap, consumer);
    return consumer;
  }
}

function mapIsEmpty(position: MappedPosition): boolean {
  return position.source === null && position.name === null &&
    position.line === null && position.column === null;
}

export const isSourceMap = (value: unknown): value is SourceMap =>
  !!(value && typeof value === "object" &&
    "version" in value && value.version === "3" &&
    "file" in value && typeof value.file === "string" &&
    "sourceRoot" in value && typeof value.sourceRoot === "string" &&
    "sources" in value && Array.isArray(value.sources) &&
    "names" in value && Array.isArray(value.names) &&
    "mappings" in value && typeof value.mappings === "string");

// Parses string as a `SourceMap`, or throws if unable.
export function parseSourceMap(stringMap: string): SourceMap {
  const sourceMap = JSON.parse(stringMap);
  if (sourceMap && "version" in sourceMap) {
    // TypeScript correctly generates `version` as an integer,
    // but the `source-map-js` library's `RawSourceMap` we use
    // elsewhere expects `version` to be a string.
    sourceMap.version = `${sourceMap.version}`;
  }
  if (!isSourceMap(sourceMap)) {
    throw new Error(
      debugStr`Could not parse source map: $quote,indent${sourceMap}`,
    );
  }
  return sourceMap;
}
