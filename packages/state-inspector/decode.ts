// Decoding stored `FabricValue`s into an inspectable form.
//
// Stored payloads (`revision.data`, `commit.original`, …) come in TWO at-rest
// formats, BOTH seen in real DBs:
//   - modern: a `data-model` codec-json envelope, carrying that codec's prefix
//     (decode via `fabricFromJsonValue()`)
//   - legacy: plain JSON
// In both, links/refs/streams appear as plain-data sigils:
//   link   { "/": { "link@1": { id, space?, path?, scope?, schema? } } }
//   ref    { "/": "of:…" | "computed:…" | "fid1:…" }
//   stream { "$stream": true }   (legacy: a stream document now holds no value)
// `decodeStored()` routes on the presence of that prefix, whichever codec
// version it names; everything else here is pure JSON walking + recognition (no
// live runtime/Cell needed). In the encoded form embedded links are
// `/quote`-escaped literals, so a context-less decode is inert.

import {
  type FabricValue,
  hashStringOf,
  toCompactDebugString,
} from "@commonfabric/data-model";
import { JsonCodecEngine } from "@commonfabric/data-model/codec-json";
import { fabricFromJsonValue } from "@commonfabric/data-model/codecs";
import { FabricLink } from "@commonfabric/data-model/fabric-instances";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { isObjectNotArray, isPlainObject } from "@commonfabric/utils/types";

import { shortDid } from "./did-display.ts";

/**
 * Decode a stored payload string, routing the `data-model` codec envelope. An
 * untagged payload is plain JSON, whose every value is a `FabricValue` too.
 */
export function decodeStored(data: string): FabricValue {
  return JsonCodecEngine.seemsLikeEncoded(data)
    ? fabricFromJsonValue(data)
    : JSON.parse(data);
}

export interface DecodedLink {
  id?: string;
  space?: string;
  path?: readonly string[];
  scope?: string;

  /**
   * The schema stored on the link, or `undefined` when it stores none. A
   * stored schema is a JSON Schema, so `true` and `false` are among the values
   * it can hold — `true` constrains nothing, `false` admits nothing — and
   * neither may be synthesized to stand for a schema that is merely present.
   */
  schema?: Json;
}

type Json = unknown;

/**
 * Whether `v` is a record this file may descend by property name.
 *
 * The question is about SHAPE, and a class instance is not one whatever its
 * contents: a `FabricSpecialObject` keeps its state in private fields, so
 * rebuilding one from its enumerable properties yields `{}`. Descending is
 * reserved for values whose properties are the whole of what they say.
 */
function isNameWalkable(v: Json): v is Record<string, Json> {
  return isPlainObject(v);
}

function setOwn(
  target: Record<string, FabricValue>,
  key: string,
  value: FabricValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function payloadToLink(payload: Record<string, Json>): DecodedLink {
  return {
    id: typeof payload.id === "string" ? payload.id : undefined,
    space: typeof payload.space === "string" ? payload.space : undefined,
    path: Array.isArray(payload.path)
      ? (payload.path as readonly string[])
      : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    schema: payload.schema,
  };
}

/** A sigil link: `{ "/": { "link@N": {...} } }` (legacy at-rest form). */
export function parseSigilLink(v: Json): DecodedLink | null {
  if (!isNameWalkable(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "/") return null;
  const inner = v["/"];
  if (!isNameWalkable(inner)) return null;
  const linkKey = Object.keys(inner).find((k) => k.startsWith("link@"));
  if (!linkKey) return null;
  const payload = inner[linkKey];
  if (!isNameWalkable(payload)) return null;
  return payloadToLink(payload);
}

/**
 * A link in EITHER at-rest form: the legacy `{ "/": { "link@N": … } }` sigil, or
 * a modern `FabricLink` instance (which `fabricFromJsonValue()` can restore
 * from a codec envelope). Detected by class — `cell-rep`'s `isLinkRef` is gated
 * on a global modern-mode flag the inspector doesn't set, so we check
 * `FabricLink` directly and read its `.payload`. Without this, a modern link is
 * an opaque instance with no enumerable keys and vanishes from
 * links/lineage/graph.
 */
export function decodedLinkOf(v: Json): DecodedLink | null {
  const sigil = parseSigilLink(v);
  if (sigil) return sigil;
  if (v instanceof FabricLink) {
    const payload = v.payload as Record<string, Json>;
    return payloadToLink(payload);
  }
  return null;
}

/** An entity reference: `{ "/": "of:…" | "computed:…" | "fid1:…" }`. */
export function parseEntityRef(v: Json): string | null {
  if (!isNameWalkable(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "/") return null;
  return typeof v["/"] === "string" ? (v["/"] as string) : null;
}

export function isStream(v: Json): boolean {
  return isNameWalkable(v) && v["$stream"] === true;
}

function shortSpace(space?: string): string | undefined {
  // did:key:z6Mk…wQ2n  ->  z6Mk…wQ2n
  return space ? shortDid(space) : undefined;
}

function shortId(id?: string): string | undefined {
  if (!id) return undefined;
  // Strip `of:` for brevity; keep a `computed:` scheme visible — the hash
  // preimage is kind-free, so the scheme is the only thing distinguishing a
  // computed doc from a state sibling of the same cause.
  if (id.startsWith("computed:")) {
    const body = id.slice("computed:".length);
    return body.length > 14
      ? `computed:${body.slice(0, 8)}…${body.slice(-4)}`
      : id;
  }
  const body = id.replace(/^of:/, "");
  return body.length > 14 ? `${body.slice(0, 8)}…${body.slice(-4)}` : body;
}

const SAFE_SUMMARY_SEGMENT = /^[A-Za-z0-9_$@.:%+~-]+$/;
const UNSAFE_TERMINAL_UNICODE =
  /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

function escapeUnsafeTerminalUnicode(value: string): string {
  return value.replace(
    UNSAFE_TERMINAL_UNICODE,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Escape text for safe inclusion within one line of terminal output. */
export function escapeTerminalText(value: string): string {
  const quoted = escapeUnsafeTerminalUnicode(JSON.stringify(value));
  return quoted.slice(1, -1);
}

function quoteTerminalText(value: string): string {
  return escapeUnsafeTerminalUnicode(JSON.stringify(value));
}

function summarizePath(path: readonly string[]): string {
  if (path.every((segment) => SAFE_SUMMARY_SEGMENT.test(segment))) {
    return `/${path.join("/")}`;
  }
  return escapeUnsafeTerminalUnicode(JSON.stringify(path));
}

function summarizeKey(key: string): string {
  return SAFE_SUMMARY_SEGMENT.test(key) ? key : quoteTerminalText(key);
}

/** One-line, human-readable summary of a link for tables. */
export function summarizeLink(link: DecodedLink): string {
  const id = escapeTerminalText(shortId(link.id) ?? "?");
  const path = link.path && link.path.length ? summarizePath(link.path) : "";
  const space = link.space
    ? ` @${escapeTerminalText(shortSpace(link.space) ?? "")}`
    : "";
  const schema = link.schema !== undefined ? " +schema" : "";
  return `🔗 ${id}${path}${space}${schema}`;
}

interface AnnotationVisit {
  kind: "visit";
  value: Json;
  depth: number;
  target: Record<string, FabricValue>;
  key: string;
}

interface AnnotationLeave {
  kind: "leave";
  value: object;
}

type AnnotationFrame = AnnotationVisit | AnnotationLeave;

/**
 * Largest schema, in bytes of stored JSON, written into annotated output as
 * itself. A link's schema is unbounded and routinely dwarfs the value carrying
 * it — kilobytes of `$defs` hanging off one array element — so a larger one is
 * summarized by `elideSchema()` instead. The bound is on stored size rather
 * than on depth, because a schema is metadata about the link rather than part
 * of the value's own shape, and so is not what a caller's `maxDepth` is
 * budgeting.
 */
const MAX_INLINE_SCHEMA_BYTES = 200;

const utf8 = new TextEncoder();

/**
 * Byte length of `value` as JSON. Falls back to measuring the annotated form
 * for what `JSON.stringify()` refuses — a `bigint` anywhere in the value, or a
 * cycle — so that a schema holding one is still measurable rather than fatal.
 * `annotate()` lowers both, and neither it nor `JSON.stringify()` recurses, so
 * the fallback has nothing left to fail on however deeply the value nests.
 *
 * The measurement is of the value as stored, which a `FabricSpecialObject`
 * under-reports: it stringifies to `{}` whatever it holds. Such a schema can
 * therefore be written out inline while rendering a little longer than the
 * bound. Nothing downstream reads the count as an allocation size.
 */
function jsonByteLength(value: Json): number {
  try {
    return utf8.encode(JSON.stringify(value)).length;
  } catch {
    const json = JSON.stringify(annotate(value, Number.POSITIVE_INFINITY));
    return utf8.encode(json).length;
  }
}

/**
 * Truncated hash of `schema`, or `undefined` when it cannot be computed —
 * hashing descends recursively, so a schema nested past the call stack has no
 * digest to report. An absent digest means it was not computed, and two
 * summaries that both lack one say nothing about whether their schemas agree.
 */
function schemaDigest(schema: Json): string | undefined {
  try {
    return hashStringOf(schema).slice(0, 12);
  } catch {
    return undefined;
  }
}

/**
 * Summary of a schema too large to write out as itself: its top-level keys,
 * its size in bytes as stored, and a truncated hash of it. Different digests
 * prove the two schemas differ; equal ones make them overwhelmingly likely to
 * agree without proving it, since the hash is truncated. Either way that is
 * usually enough to settle whether one link's schema is stale against
 * another's, and `--full-depth` settles it outright.
 *
 * `bytes` is always present. `digest` is absent when it could not be computed,
 * for which see `schemaDigest()`, and `keys` when the stored schema is not an
 * object and so has none.
 */
function schemaSummary(schema: Json, bytes: number): FabricValue {
  const digest = schemaDigest(schema);
  return {
    ...(isNameWalkable(schema) ? { keys: Object.keys(schema) } : {}),
    bytes,
    ...(digest === undefined ? {} : { digest }),
  };
}

/**
 * The `$link` fields describing the schema stored on a link: `schema` holding
 * it as itself when it is small enough to read or when `maxDepth` is infinite,
 * and `$schemaSummary` holding a `schemaSummary()` of it otherwise. Never
 * synthesizes a schema — a rendered `true` means `true` was what the link
 * stored.
 *
 * The summary is a SIBLING of `schema` rather than a value under it, and the
 * two are never both present. A link can store a schema of any shape, so a
 * summary written into the `schema` slot could be a schema some link really
 * holds, and a reader would have no way to tell the summary from the thing it
 * summarizes. Nothing stored reaches a `$`-prefixed sibling — `payloadToLink()`
 * bounds what a link contributes to `id`, `space`, `path`, `scope`, and
 * `schema` — so the distinction holds for every possible stored value rather
 * than for the ones that happen not to collide.
 *
 * "As itself" is the annotated form, not the stored bytes. A schema is walked
 * like any other value, so a sigil-shaped literal inside one — under `const`,
 * `default`, or `enum` — reads back as `{ $link }` or `{ $ref }` the way it
 * would anywhere else in the output. That keeps the rendering JSON-safe, which
 * the stored form is not: a `bigint` in a schema breaks `JSON.stringify()`
 * outright, and a `FabricLink` in one flattens to `{}` and disappears. A
 * summary's digest hashes the stored schema rather than this rendering, so it
 * stays the thing to compare two schemas by.
 */
function linkSchemaFields(
  schema: Json,
  maxDepth: number,
): Record<string, FabricValue> {
  if (!Number.isFinite(maxDepth)) {
    return { schema: annotate(schema, Number.POSITIVE_INFINITY) };
  }
  // Measured before rendering, so that a schema headed for a summary is never
  // walked into a copy that only gets discarded. A space's worth of links each
  // carrying kilobytes of `$defs` is the case that makes the difference.
  const bytes = jsonByteLength(schema);
  return bytes <= MAX_INLINE_SCHEMA_BYTES
    ? { schema: annotate(schema, Number.POSITIVE_INFINITY) }
    : { $schemaSummary: schemaSummary(schema, bytes) };
}

/**
 * Transform a stored value into an annotated, JSON-printable form. Links
 * become `{ $link: … }`, entity refs become `{ $ref: … }`, and streams become
 * `"$stream"`. `maxDepth` limits how many nested containers are retained, and
 * an infinite one additionally writes out every link's schema in full; see
 * `linkSchemaFields()` for what a finite one does with a large schema.
 */
export function annotate(v: Json, maxDepth = 8): FabricValue {
  const root: Record<string, FabricValue> = {};
  const detectCycles = !Number.isFinite(maxDepth);
  const ancestors = new WeakSet<object>();
  const work: AnnotationFrame[] = [{
    kind: "visit",
    value: v,
    depth: maxDepth,
    target: root,
    key: "value",
  }];

  while (work.length > 0) {
    const frame = work.pop()!;
    if (frame.kind === "leave") {
      ancestors.delete(frame.value);
      continue;
    }

    const assign = (value: FabricValue) =>
      setOwn(frame.target, frame.key, value);
    if (frame.depth < 0) {
      assign("…");
      continue;
    }

    const link = decodedLinkOf(frame.value);
    if (link) {
      assign({
        $link: {
          id: link.id,
          ...(link.path && link.path.length ? { path: link.path } : {}),
          ...(link.space ? { space: link.space } : {}),
          ...(link.scope ? { scope: link.scope } : {}),
          // `maxDepth` rather than `frame.depth`: full schema fidelity is a
          // property of the whole rendering, not of where a link sits in it.
          ...(link.schema !== undefined
            ? linkSchemaFields(link.schema, maxDepth)
            : {}),
        },
      });
      continue;
    }
    if (isStream(frame.value)) {
      assign("$stream");
      continue;
    }
    const ref = parseEntityRef(frame.value);
    if (ref !== null) {
      assign({ $ref: ref });
      continue;
    }

    // Lower non-JSON-safe Fabric leaves to a stable, printable form so the
    // bundle and its JSON output retain every stored value.
    if (frame.value === undefined) {
      assign({ $undefined: true });
      continue;
    }
    if (typeof frame.value === "bigint") {
      assign({ $bigint: frame.value.toString() });
      continue;
    }
    if (typeof frame.value === "symbol") {
      assign(String(frame.value));
      continue;
    }
    if (typeof frame.value === "function") {
      assign("[function]");
      continue;
    }

    if (Array.isArray(frame.value)) {
      if (detectCycles && ancestors.has(frame.value)) {
        assign("…");
        continue;
      }
      if (detectCycles) {
        ancestors.add(frame.value);
        work.push({ kind: "leave", value: frame.value });
      }

      const keys = Object.keys(frame.value);
      if (
        keys.length === frame.value.length &&
        keys.every(isArrayIndexPropertyName)
      ) {
        const output = new Array<FabricValue>(frame.value.length);
        assign(output);
        const target = output as unknown as Record<string, FabricValue>;
        for (let index = frame.value.length - 1; index >= 0; index--) {
          work.push({
            kind: "visit",
            value: frame.value[index],
            depth: frame.depth - 1,
            target,
            key: String(index),
          });
        }
        continue;
      }

      const entries: Record<string, FabricValue> = {};
      const properties: Record<string, FabricValue> = {};
      const sparseArray: Record<string, FabricValue> = {};
      setOwn(sparseArray, "length", frame.value.length);
      setOwn(sparseArray, "entries", entries);
      if (keys.some((key) => !isArrayIndexPropertyName(key))) {
        setOwn(sparseArray, "properties", properties);
      }
      assign({ $sparseArray: sparseArray });
      const source = frame.value as unknown as Record<string, Json>;
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index];
        work.push({
          kind: "visit",
          value: source[key],
          depth: frame.depth - 1,
          target: isArrayIndexPropertyName(key) ? entries : properties,
          key,
        });
      }
      continue;
    }

    if (isNameWalkable(frame.value)) {
      if (detectCycles && ancestors.has(frame.value)) {
        assign("…");
        continue;
      }
      if (detectCycles) {
        ancestors.add(frame.value);
        work.push({ kind: "leave", value: frame.value });
      }

      const output: Record<string, FabricValue> = {};
      assign(output);
      const entries = Object.entries(frame.value);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, value] = entries[index];
        work.push({
          kind: "visit",
          value,
          depth: frame.depth - 1,
          target: output,
          key,
        });
      }
      continue;
    }

    const leaf = frame.value;
    if (
      leaf === null || typeof leaf === "string" || typeof leaf === "number" ||
      typeof leaf === "boolean"
    ) {
      assign(leaf);
    } else {
      // A `FabricInstance` has no enumerable state to walk by property name.
      assign({ $fabric: toCompactDebugString(leaf) });
    }
  }

  return root.value;
}

interface JsonValueFrame {
  kind: "value";
  value: Json;
  depth: number;
}

interface JsonTextFrame {
  kind: "text";
  value: string;
}

interface JsonLeaveFrame {
  kind: "leave";
  value: object;
}

type JsonFrame = JsonValueFrame | JsonTextFrame | JsonLeaveFrame;

const INSPECTOR_JSON_INDENTS = Array.from(
  { length: 33 },
  (_, depth) => "  ".repeat(depth),
);

function inspectorJsonIndent(depth: number): string {
  return INSPECTOR_JSON_INDENTS[Math.min(depth, 32)];
}

function omittedJsonObjectValue(value: Json): boolean {
  return value === undefined || typeof value === "function" ||
    typeof value === "symbol";
}

/**
 * Serialize annotated inspector data without recursive descent. Indentation
 * stops growing after 32 levels so deeply nested output stays linear in size.
 */
export function stringifyInspectorJson(value: Json): string {
  const output: string[] = [];
  const ancestors = new WeakSet<object>();
  const work: JsonFrame[] = [{
    kind: "value",
    value,
    depth: 0,
  }];

  while (work.length > 0) {
    const frame = work.pop()!;
    if (frame.kind === "text") {
      output.push(frame.value);
      continue;
    }
    if (frame.kind === "leave") {
      ancestors.delete(frame.value);
      continue;
    }

    if (frame.value === null) {
      output.push("null");
      continue;
    }
    switch (typeof frame.value) {
      case "string":
      case "boolean":
      case "number":
        output.push(JSON.stringify(frame.value));
        continue;
      case "undefined":
      case "function":
      case "symbol":
        output.push("null");
        continue;
      case "bigint":
        throw new TypeError("Inspector JSON contains an unannotated BigInt.");
    }

    if (ancestors.has(frame.value)) {
      throw new TypeError("Inspector JSON contains a circular structure.");
    }
    ancestors.add(frame.value);
    work.push({ kind: "leave", value: frame.value });

    if (Array.isArray(frame.value)) {
      output.push("[");
      if (frame.value.length === 0) {
        output.push("]");
        continue;
      }
      work.push({
        kind: "text",
        value: `\n${inspectorJsonIndent(frame.depth)}]`,
      });
      for (let index = frame.value.length - 1; index >= 0; index--) {
        work.push({
          kind: "value",
          value: frame.value[index],
          depth: frame.depth + 1,
        });
        work.push({
          kind: "text",
          value: `${index === 0 ? "\n" : ",\n"}${
            inspectorJsonIndent(frame.depth + 1)
          }`,
        });
      }
      continue;
    }

    const keys = Object.keys(frame.value).filter((key) =>
      !omittedJsonObjectValue((frame.value as Record<string, Json>)[key])
    );
    output.push("{");
    if (keys.length === 0) {
      output.push("}");
      continue;
    }
    work.push({
      kind: "text",
      value: `\n${inspectorJsonIndent(frame.depth)}}`,
    });
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      work.push({
        kind: "value",
        value: (frame.value as Record<string, Json>)[key],
        depth: frame.depth + 1,
      });
      work.push({
        kind: "text",
        value: `${index === 0 ? "\n" : ",\n"}${
          inspectorJsonIndent(frame.depth + 1)
        }${JSON.stringify(key)}: `,
      });
    }
  }

  return output.join("");
}

/** Compact one-line summary of any value, for table cells. */
export function summarize(v: Json): string {
  const link = decodedLinkOf(v);
  if (link) return summarizeLink(link);
  if (isStream(v)) return "⊙ stream";
  const ref = parseEntityRef(v);
  if (ref !== null) return `#${escapeTerminalText(shortId(ref) ?? ref)}`;
  if (v === null) return "null";
  if (typeof v === "bigint") return `${v}n`;
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isNameWalkable(v)) {
    return `{${Object.keys(v).map(summarizeKey).join(", ")}}`;
  }
  if (typeof v === "object") {
    return escapeTerminalText(toCompactDebugString(v));
  }
  if (typeof v === "string") {
    const preview = v.length > 40 ? `${v.slice(0, 37)}…` : v;
    return quoteTerminalText(preview);
  }
  return escapeTerminalText(String(v));
}

/** One link found inside a value, and the path within that value it sits at. */
export interface LinkAtPath {
  link: DecodedLink;

  /**
   * Where the link sits, as path segments from the walked value's root. An
   * array index is a segment like any other.
   *
   * Segments arrive as an array rather than as one joined string because a
   * segment is an arbitrary key: one holding `/`, or `~`, is a key the store
   * writes like any other, and joining it makes it indistinguishable from two
   * segments. A caller that wants a joined form joins at the point it knows
   * what the joined form is for.
   */
  at: readonly string[];
}

/**
 * How far a link walk reaches. There is no default here, because the two
 * bounds trade completeness against work and only the caller knows which way
 * it wants that traded. A caller rendering a value for a reader may stop
 * early, since a link it never shows costs the reader nothing. A caller for
 * which a link missed is indistinguishable from a value that holds no link
 * cannot, and sets bounds far above any value it expects to meet.
 */
export interface LinkWalkBounds {
  /**
   * The longest path the walk descends to. A value at a deeper path is not
   * visited, so a link sitting there is not reported.
   */
  maxDepth: number;

  /**
   * The most values the walk visits.
   *
   * A decoded document is plain JSON — finite and acyclic — so the walk ends
   * on its own, and its cost is the size of a value the store has already
   * decoded into memory. This bound is against the value that is not that: a
   * malformed row, or an at-rest form restoring as an object graph with a
   * cycle in it, is otherwise walked forever. `maxDepth` settles that on its
   * own only while it is small AND the value branches narrowly, because a
   * cycle that branches `b` ways costs `b` to the depth — so the node count is
   * what makes the work finite, and the depth is what keeps one deep chain
   * cheap.
   *
   * A finite value here states a fact about the answer — that the walk may
   * have stopped short — and `budgetExhausted` is where that fact comes back.
   * A caller with nowhere to carry it forward has no honest finite value to
   * set, since a truncation nothing reports is worse than one that cannot
   * happen; such a caller passes `Number.POSITIVE_INFINITY` and takes the
   * depth as its whole bound.
   */
  maxNodes: number;
}

/**
 * What a bounded walk found, and where it stopped short of finding more. The
 * two ways it stops are separate fields because they state different things,
 * and a caller that treated either as the other would overstate what it knows.
 */
export interface LinkWalk {
  /** The links found, in the order the walk met them. */
  links: LinkAtPath[];

  /**
   * The paths the walk did not descend into because they sit deeper than
   * `maxDepth`, one per value it refused at. Nothing was read at such a path
   * or under it, so a link there is neither reported nor ruled out — and the
   * statement is exact, because every path of the value not at or under one
   * of these was walked.
   */
  tooDeep: readonly (readonly string[])[];

  /**
   * The paths holding a value the walk could read only in part: an object
   * that is neither a link, an array, nor a plain record — a class instance,
   * whose state lives in private fields where a structural walk cannot reach
   * it. The walk descends such a value's enumerable properties, so a link on
   * one is reported like any other, but those properties are some of what the
   * value holds rather than all of it, and a link in the part not reached is
   * neither reported nor ruled out.
   *
   * Some values named here hold nothing at all — a hash, a byte string, a
   * timestamp. Others hold a whole value out of reach: a `ProblematicValue` or
   * an `UnknownValue` keeps the state it wrapped in a private field, and that
   * state is exactly the data whose decoding went wrong or arrived under a tag
   * this build does not know, links in it included. So a path here is a place
   * the walk cannot answer for, not a place a link is known to be.
   */
  opaque: readonly (readonly string[])[];

  /**
   * Whether `maxNodes` ran out, which stops the walk wherever it had reached.
   * This is a statement about the walk rather than about a path: the values
   * it never visited were never enumerated, so nothing names them, and
   * `links` is some of the value's links rather than all of them. A caller
   * may not read a path's absence from `links` as the value holding no link
   * there.
   */
  budgetExhausted: boolean;
}

/**
 * The path to the value a walk is at, as a chain back to the root.
 *
 * A walk visits far more values than it reports, so it carries the path in the
 * shape that costs one cell per step rather than a copy of the path so far per
 * step, and materializes the array only where a result names a path. That is
 * what lets one traversal serve both a caller wanting every link with its
 * location and a caller wanting a count over every entity in a space.
 */
type Trail = { readonly parent: Trail; readonly segment: string } | null;

/** The root-to-here segments of a trail, in that order. */
function pathOf(at: Trail): readonly string[] {
  const reversed: string[] = [];
  for (let step = at; step !== null; step = step.parent) {
    reversed.push(step.segment);
  }
  return reversed.reverse();
}

/**
 * Every link in a value that `bounds` reaches, in either at-rest form, each
 * with the path inside the value it sits at — and, beside them, where the
 * bounds stopped the walk and where it read a value only in part. The walk
 * descends the objects and arrays of the value and stops at each link it
 * meets, so a linked value's own links belong to that value rather than to
 * this one.
 *
 * It is generic over shape rather than over an enumeration of the places a
 * link may appear: `decodedLinkOf` is the whole of the link knowledge in it,
 * which is why no caller keeps a list of link-bearing keys in step with the
 * ones the store writes. It stops at nothing else either — a stream marker
 * and an entity reference are values like any other, and the walk reads them
 * for links rather than assuming their shape.
 *
 * A link past `bounds` is not found, and a caller for which a link missed and
 * a value holding none read alike must take `tooDeep`, `opaque` and
 * `budgetExhausted` with the links: they are what say that the found set is
 * partial, and which part of the value the walk can say nothing about.
 *
 * Links come back in the order the walk meets them, depth first, with an
 * object's keys in `Object.entries` order and an array's items in index order.
 */
export function linksWithPaths(
  v: Json,
  bounds: LinkWalkBounds,
): LinkWalk {
  const links: LinkAtPath[] = [];
  const tooDeep: (readonly string[])[] = [];
  const opaque: (readonly string[])[] = [];
  let budget = bounds.maxNodes;
  let budgetExhausted = false;
  const walk = (held: Json, at: Trail, depth: number): void => {
    if (budgetExhausted) return;
    // Budget before depth: once the budget is gone the walk is over, and a
    // path it declines from there is one it never reached rather than one it
    // reached and refused, which is not a fact `tooDeep` may carry.
    if (budget <= 0) {
      budgetExhausted = true;
      return;
    }
    if (depth > bounds.maxDepth) {
      tooDeep.push(pathOf(at));
      return;
    }
    budget -= 1;
    const link = decodedLinkOf(held);
    if (link) {
      links.push({ link, at: pathOf(at) });
      return;
    }
    if (Array.isArray(held)) {
      held.forEach((item, index) =>
        walk(item, { parent: at, segment: String(index) }, depth + 1)
      );
      return;
    }
    if (isObjectNotArray(held)) {
      // Enumerable properties are the whole of a plain record and only a part
      // of anything else, so reading them is exact for the one and partial for
      // the other. Both are read; only the partial read is recorded.
      if (!isNameWalkable(held)) opaque.push(pathOf(at));
      for (const [key, child] of Object.entries(held)) {
        walk(child, { parent: at, segment: key }, depth + 1);
      }
    }
  };
  walk(v, null, 0);
  return { links, tooDeep, opaque, budgetExhausted };
}
