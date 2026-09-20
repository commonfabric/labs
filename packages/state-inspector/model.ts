// The unified entity model — what makes the inspector *fluent* instead of
// guessing from `doc.value`.
//
// A memory v2 entity stores ONE document (`is`) per id, and that document is a
// TREE of top-level paths. The reactive value lives at `value`; the control
// plane lives at sibling meta paths on the SAME entity:
//
//   value           the reactive value (a cell's contents)
//   argument        SigilLink → the piece's INPUT cell
//   result          SigilLink → the OWNING piece's result cell (ownership back-link)
//   patternIdentity { identity, symbol } → the durable piece → pattern(module) pointer
//   internal        manifest [{ partialCause, link }] of the piece's owned child cells
//   schema          the result's JSONSchema
//   cfc             information-flow label map
//   pattern/slug    other piece metadata
//
// Classifying by *which top-level paths exist* (plus the shape of `value`) tells
// us what an entity actually IS. Ground-truthed against a real modern space
// (145 entities): pieces carry {argument, internal, patternIdentity, schema,
// value}; owned cells carry {result(, value)}; free cells carry {value}.
//
// Two regimes:
//   modern (post-#3522 "Remove Process Cell") — pieces carry `patternIdentity`.
//   legacy (pre-#3522) — a separate process cell whose `value` carries
//     { $TYPE, resultRef, … }; the result cell links to it via `source`.
// We classify both; modern is the verified path, legacy is best-effort.
//
// ┌─ LEGACY-PROCESS-CELL — retirement note (grep this tag to find every site) ─┐
// The `legacy`/process-cell era (`$TYPE` / `spell` / `resultRef` pieces) is a
// CLOSED format: it is only emitted by stores written before the spell→
// patternIdentity flip (#3522, then the runtime cutover ~2026-06; no space mixes
// the two). Once such stores have aged out of every cache/box we inspect, ALL of
// this support can be deleted — it is dead weight on a tool that only ever reads
// fresh data. We keep it now solely to read old DBs faithfully (and label them
// honestly as "legacy process").
//
// To retire it, grep `LEGACY-PROCESS-CELL` and delete each marked site:
//   • model.ts   — `isLegacyProcessValue`, the two `regime: "legacy"` branches in
//                  `classifyDocument`, `lineage.source`, and collapse `Regime`
//                  to `"modern" | "n/a"` (drop the union member + its consumers).
//   • detail.ts  — `legacyResultId`, `legacyName`, and the `regime === "legacy"`
//                  branches that call them.
// That is the WHOLE surface — it is intentionally confined to classification
// (model.ts) and rendering (detail.ts).
//
// Do NOT remove the other two, UNRELATED "legacy" axes when you do this; they
// retire on their own (different) timelines:
//   • decode.ts  — at-rest codec routing (codec envelope vs plain-JSON sigil
//                  links). A serialization concern, orthogonal to process cells.
//   • db.ts / reconstruct.ts — DBs lacking branch/snapshot/scope_key tables
//                  (`hasTable`, the scope_key shim). A schema-migration concern.
// └────────────────────────────────────────────────────────────────────────────┘

import type { JSONSchema } from "@commonfabric/api";
import {
  classifySchemaMetaValue,
  SCHEMA_DOCUMENT_REF_PREFIX,
} from "@commonfabric/data-model-schema/schema-refs";
import {
  declaredHandleKind,
  definitionNamed,
  type ExternalReferenceResolver,
  externalReferenceResolverOver,
  followExternalReferences,
} from "@commonfabric/runner/stream-declaration";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { utf8Compare } from "@commonfabric/utils/utf8";

import type { SpaceDb } from "./db.ts";
import {
  decodedLinkOf,
  linksWithPaths,
  type LinkWalkBounds,
  summarize,
} from "./decode.ts";
import {
  branchReadChain,
  type BranchReadLink,
  reconstructDocument,
  reconstructOutcome,
  visibleRevisionRows,
} from "./reconstruct.ts";
import type {
  AbsenceStatus,
  EntityDocument,
  ReconstructOptions,
  ReconstructOutcome,
} from "./reconstruct.ts";

export type EntityKind =
  | "piece" // a running pattern instance (result cell + lineage meta)
  | "module" // pattern source/compiled module (value carries code + identity)
  | "stream" // write-only event channel, declared by its owner's manifest
  | "schema" // a JSONSchema stored as a cell value
  | "owned-cell" // a cell owned by a piece (carries a `result` back-link)
  | "free-cell" // a standalone cell, owned by no piece
  | "deleted" // a tombstone: the visible head row is a `delete`
  | "unknown"; // present but unreadable, or a shape nothing above recognizes

/** How an entity that carries no document reads: its kind, and its label. */
export interface AbsentEntity {
  kind: EntityKind;
  label: string;
}

/**
 * Name an entity by WHY it has no document. `deleted` is its own kind because a
 * tombstone is an ordinary thing to find and says what happened; the rest are
 * `unknown`, which therefore means the entity is there and cannot be read. A
 * tombstone's original shape is genuinely gone at HEAD — recovering "this was a
 * piece" takes a reconstruction at the seq before the delete.
 */
export function absentEntity(status: AbsenceStatus): AbsentEntity {
  return { kind: ABSENT_KIND[status], label: ABSENT_LABEL[status] };
}

const ABSENT_KIND: Record<AbsenceStatus, EntityKind> = {
  deleted: "deleted",
  empty: "unknown",
  absent: "unknown",
  undecodable: "unknown",
};

const ABSENT_LABEL: Record<AbsenceStatus, string> = {
  deleted: "(deleted)",
  empty: "(no data)",
  absent: "(absent)",
  undecodable: "(undecodable)",
};

// LEGACY-PROCESS-CELL: `"legacy"` collapses out when the process-cell era is
// retired, leaving `"modern" | "n/a"` (see top-of-file retirement note).
export type Regime = "modern" | "legacy" | "n/a";

export type ValueShape =
  | "stream"
  | "module"
  | "schema"
  | "piece-result"
  | "object"
  | "array"
  | "scalar"
  | "absent";

/** Resolved lineage links for an entity (ids only — targets are not followed). */
export interface Lineage {
  /** Input cell — a piece's `argument` link target. */
  argument?: string;

  /** Pattern pointer + resolved module entity (modern pieces). */
  pattern?: { identity: string; symbol?: string; moduleId?: string };

  /** Owning piece — an owned cell's `result` back-link target. */
  owner?: string;

  /** Owned child cell ids — a piece's `internal` manifest. */
  internal?: string[];

  /**
   * Legacy process/source cell link target.
   * LEGACY-PROCESS-CELL: removed with the process-cell era (top-of-file note).
   */
  source?: string;
}

export interface EntityModel {
  id: string;
  scope: string;
  kind: EntityKind;
  regime: Regime;

  /** True when the entity carries a `result` ownership back-link. */
  owned: boolean;

  /** Human label: piece $NAME, module:<file>, stream, schema, or value summary. */
  label: string;

  /** Top-level paths present in the document (the control plane, sorted). */
  paths: string[];

  valueShape: ValueShape;
  lineage: Lineage;
  revisions?: number;
  links?: number;
}

/** The target id of a SigilLink value, if it is one. */
function linkId(v: unknown): string | undefined {
  return decodedLinkOf(v)?.id ?? undefined;
}

/** Owned child cell ids from a piece's `internal` manifest. */
function internalIds(internal: unknown): string[] {
  if (!Array.isArray(internal)) return [];
  const out: string[] = [];
  for (const el of internal) {
    if (isObjectNotArray(el) && "link" in el) {
      const id = linkId(el.link);
      if (id) out.push(id);
    }
  }
  return out;
}

function basename(p: string): string {
  return p.split("/").pop() || p;
}

/** A value shaped like a module: `{ code, identity, … }`. */
export function isModuleValue(
  v: unknown,
): v is { code: string; identity: string; filename?: string; kind?: string } {
  return isObjectNotArray(v) && typeof v.code === "string" &&
    typeof v.identity === "string";
}

/** A value shaped like a JSONSchema stored as data: `{ type, properties|$defs }`. */
function isSchemaValue(v: unknown): boolean {
  if (!isObjectNotArray(v)) return false;
  if (typeof v.type !== "string") return false;
  if (!(isObjectNotArray(v.properties) || isObjectNotArray(v.$defs))) {
    return false;
  }
  // Schemas-as-data don't carry render markers.
  return !("$UI" in v) && !("$NAME" in v);
}

/**
 * The stored sentinel a stream document held before its owner's manifest
 * declared it. Documents written since carry no value; this reads the ones
 * written before.
 */
function isStreamValue(v: unknown): boolean {
  return isObjectNotArray(v) && v.$stream === true;
}

/**
 * Reads one document out of the space by id, for a classification that has to
 * read past the document in hand: the owner a `result` back-link names, whose
 * manifest declares a stream, and the schema document a `cid:` reference
 * names.
 */
export type DocumentReader = (id: string) => EntityDocument | undefined;

/**
 * A reader over `space` at `branch`, reading an ordinary document at `scope`
 * and a content-addressed one at space scope, which is the only scope those
 * live at whatever scope the caller describes. It reads at `atSeq` where one
 * is given, so that what a historical read reads past resolves against the
 * same snapshot.
 */
export function spaceDocumentReader(
  space: SpaceDb,
  opts: { branch?: string; scope?: string; atSeq?: number } = {},
): DocumentReader {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  return (id) => {
    const outcome = reconstructOutcome(space, {
      id,
      branch,
      scope: id.startsWith(SCHEMA_DOCUMENT_REF_PREFIX) ? "space" : scope,
      ...(opts.atSeq === undefined ? {} : { atSeq: opts.atSeq }),
    });
    return outcome.status === "present" ? outcome.document : undefined;
  };
}

/**
 * A schema read out of a `schema` member — a document's meta, or a link's —
 * together with the document its local references resolve against: the
 * schema itself where it was held inline, and the schema document's value
 * where it was reached by reference.
 */
export interface ResolvedSchema {
  schema: unknown;

  /** The document whose `$defs` a local `$ref` in `schema` names. */
  root: unknown;

  /** Whether the schema was held inline or read out of a schema document. */
  via: "own" | "document";

  /** The `cid:` reference followed, for `via: "document"`. */
  ref?: string;
}

/**
 * The schema a `schema` member holds, in either of the two forms the grammar
 * admits: the schema itself, or a single-member `{ "$ref": "cid:…" }`, the
 * `#/$defs/<name>` fragment form included, read through `readDocument`.
 * `undefined` for an absent member, for a reference no reader was given for
 * or that the space cannot supply, and for a member outside the grammar,
 * which declares nothing rather than whatever a lenient read of it would
 * find.
 */
export function resolveSchemaMember(
  member: unknown,
  readDocument?: DocumentReader,
): ResolvedSchema | undefined {
  const form = classifySchemaMetaValue(member);
  if (form.kind === "inline") {
    return { schema: form.schema, root: form.schema, via: "own" };
  }
  if (form.kind !== "reference") return undefined;
  const root = readDocument?.(`${SCHEMA_DOCUMENT_REF_PREFIX}${form.taggedHash}`)
    ?.value;
  if (root === undefined) return undefined;
  const schema = form.defName === undefined
    ? root
    : definitionNamed(root as JSONSchema, form.defName);
  return schema === undefined
    ? undefined
    : { schema, root, via: "document", ref: form.ref };
}

/** Like {@link resolveSchemaMember}, over the `schema` meta of `doc`. */
export function storedSchemaOf(
  doc: EntityDocument,
  readDocument?: DocumentReader,
): ResolvedSchema | undefined {
  return resolveSchemaMember(doc.schema, readDocument);
}

/**
 * How the declaration reading follows an external reference here: into the
 * schema document the space holds, through `readDocument`, read the way the
 * runtime reads one. A reference the space cannot supply resolves to nothing,
 * and the position declares nothing.
 */
function externalReferenceResolver(
  readDocument?: DocumentReader,
): ExternalReferenceResolver {
  return externalReferenceResolverOver((taggedHash) =>
    readDocument?.(`${SCHEMA_DOCUMENT_REF_PREFIX}${taggedHash}`)?.value as
      | JSONSchema
      | undefined
  );
}

/** Where a stream's declaration was read, and the schema found there. */
export interface StreamDeclaration extends ResolvedSchema {
  /** The owner whose manifest declares the stream: the back-link's target. */
  owner: string;
}

/**
 * The declaration under which the owner of the document `id` names it a
 * stream, or `undefined` when no owner does.
 *
 * A stream's document holds only the `result` back-link its setup writes, so
 * the document alone says nothing about it. The declaration is on the owner,
 * in the manifest link its result document keeps for each derived internal
 * cell, and this follows the back-link to read it there: the entry whose link
 * names the document at its root, with a schema declaring a stream. A
 * document naming no owner, one whose owner the space does not hold, and one
 * its owner's manifest does not carry are declared by no one.
 */
export function streamDeclarationOf(
  id: string,
  doc: EntityDocument,
  readDocument?: DocumentReader,
): StreamDeclaration | undefined {
  const owner = linkId(doc.result);
  if (owner === undefined) return undefined;
  const manifest = readDocument?.(owner)?.internal;
  if (!Array.isArray(manifest)) return undefined;
  const resolveExternal = externalReferenceResolver(readDocument);
  for (const entry of manifest) {
    if (!isObjectNotArray(entry)) continue;
    const link = decodedLinkOf(entry.link);
    if (link === null || link.id !== id || (link.path?.length ?? 0) > 0) {
      continue;
    }
    const schema = link.schema as JSONSchema | undefined;
    if (declaredHandleKind(schema, { resolveExternal }) !== "stream") continue;
    // The declaration held, so the chain of references it was read through
    // resolves; what is shown is the schema at its end, and the source names
    // the last document followed into.
    const reached = followExternalReferences(schema, { resolveExternal });
    if (reached === undefined) return undefined;
    const ref = reached.followed.at(-1);
    return {
      schema: reached.schema,
      root: reached.root,
      via: ref === undefined ? "own" : "document",
      ...(ref === undefined ? {} : { ref }),
      owner,
    };
  }
  return undefined;
}

/** A piece result value: carries render/name markers. */
function isPieceResultValue(v: unknown): boolean {
  return isObjectNotArray(v) && ("$UI" in v || "$NAME" in v || "$TILE_UI" in v);
}

/**
 * A legacy process cell value: `{ $TYPE, resultRef|spell|source, … }`.
 * LEGACY-PROCESS-CELL: delete with the closed process-cell era (see top-of-file
 * retirement note).
 */
function isLegacyProcessValue(
  v: unknown,
): v is {
  $TYPE: string;
  resultRef?: unknown;
  argument?: unknown;
  spell?: unknown;
  source?: unknown;
} {
  return isObjectNotArray(v) && typeof v.$TYPE === "string" &&
    ("resultRef" in v || "spell" in v || "source" in v);
}

function valueShapeOf(v: unknown): ValueShape {
  if (v === undefined) return "absent";
  if (isStreamValue(v)) return "stream";
  if (isModuleValue(v)) return "module";
  if (isSchemaValue(v)) return "schema";
  if (isPieceResultValue(v)) return "piece-result";
  if (Array.isArray(v)) return "array";
  if (isObjectNotArray(v)) return "object";
  return "scalar";
}

/** Module label, e.g. `module:foo.tsx` or `module:foo.tsx (compiled)`. */
function moduleLabel(v: { filename?: string; kind?: string }): string {
  const file = v.filename ? basename(v.filename) : "?";
  const k = v.kind && v.kind !== "source" ? ` (${v.kind})` : "";
  return `module:${file}${k}`;
}

export interface Classification {
  kind: EntityKind;
  regime: Regime;
  owned: boolean;
  label: string;
  paths: string[];
  valueShape: ValueShape;
  lineage: Lineage;
}

/**
 * Classify a reconstructed entity document by its top-level path-set and value
 * shape. Resolves lineage to link-target ids but does not follow them or
 * resolve `patternIdentity` to a module (that needs the space-wide module index;
 * see {@link modelEntity}). What it reads besides `doc`, through
 * `readDocument`, is what tells a stream from an owned cell: the owner its
 * `result` back-link names, whose `internal` manifest declares the stream, and
 * the schema document a manifest link's `cid:` reference names. A stream's
 * document holds no value, so its owner is what says it is one, and a
 * classification given no `id` to match a manifest entry by finds no stream
 * that way.
 */
export function classifyDocument(
  doc: EntityDocument,
  opts: {
    /** The document's own id, which a manifest entry naming it is matched by. */
    id?: string;

    /** Reads past `doc`: its owner, and a schema document a reference names. */
    readDocument?: DocumentReader;
  } = {},
): Classification {
  const paths = Object.keys(doc).sort();
  const value = doc.value;
  const owned = "result" in doc;
  const valueShape = valueShapeOf(value);
  const lineage: Lineage = {};
  if (owned) lineage.owner = linkId(doc.result);

  // Pieces
  // Modern: the durable piece → pattern pointer is `patternIdentity`.
  if (isObjectNotArray(doc.patternIdentity)) {
    const pi = doc.patternIdentity as { identity?: unknown; symbol?: unknown };
    lineage.argument = linkId(doc.argument);
    lineage.internal = internalIds(doc.internal);
    if (typeof pi.identity === "string") {
      lineage.pattern = {
        identity: pi.identity,
        symbol: typeof pi.symbol === "string" ? pi.symbol : undefined,
      };
    }
    const name = isObjectNotArray(value) && typeof value.$NAME === "string"
      ? value.$NAME
      : undefined;
    return {
      kind: "piece",
      regime: "modern",
      owned,
      label: name || "(piece)",
      paths,
      valueShape,
      lineage,
    };
  }
  // LEGACY-PROCESS-CELL: both `regime: "legacy"` branches below retire together
  // with the closed process-cell era (see top-of-file retirement note).
  // Legacy: a process cell carries `{ $TYPE, resultRef, … }`.
  if (isLegacyProcessValue(value)) {
    lineage.source = linkId(value.resultRef) ?? linkId(value.source);
    lineage.argument = linkId(value.argument);
    return {
      kind: "piece",
      regime: "legacy",
      owned,
      label: "(piece, legacy process)",
      paths,
      valueShape,
      lineage,
    };
  }
  // Legacy: a result cell links to its process cell via top-level `source`.
  if ("source" in doc && isPieceResultValue(value)) {
    lineage.source = linkId(doc.source);
    const name = isObjectNotArray(value) && typeof value.$NAME === "string"
      ? value.$NAME
      : undefined;
    return {
      kind: "piece",
      regime: "legacy",
      owned,
      label: name || "(piece, legacy)",
      paths,
      valueShape,
      lineage,
    };
  }

  // Cell sub-kinds by value shape
  if (isModuleValue(value)) {
    return {
      kind: "module",
      regime: "n/a",
      owned,
      label: moduleLabel(value),
      paths,
      valueShape,
      lineage,
    };
  }
  if (
    isStreamValue(value) ||
    (opts.id !== undefined &&
      streamDeclarationOf(opts.id, doc, opts.readDocument) !== undefined)
  ) {
    return {
      kind: "stream",
      regime: "n/a",
      owned,
      label: "⊙ stream",
      paths,
      valueShape,
      lineage,
    };
  }
  if (isSchemaValue(value)) {
    const ifc = isObjectNotArray(value) && "ifc" in value ? "+ifc" : "";
    return {
      kind: "schema",
      regime: "n/a",
      owned,
      label: `schema${ifc}`,
      paths,
      valueShape,
      lineage,
    };
  }

  // Plain cells
  if (owned) {
    const label = value === undefined ? "(lineage)" : summarize(value);
    return {
      kind: "owned-cell",
      regime: "n/a",
      owned,
      label,
      paths,
      valueShape,
      lineage,
    };
  }
  if ("value" in doc) {
    return {
      kind: "free-cell",
      regime: "n/a",
      owned,
      label: summarize(value),
      paths,
      valueShape,
      lineage,
    };
  }
  return {
    kind: "unknown",
    regime: "n/a",
    owned,
    label: `{${paths.join(",")}}`,
    paths,
    valueShape,
    lineage,
  };
}

export interface ModuleEntry {
  id: string;
  filename?: string;
  kind?: string;
}

/**
 * Map a module `identity` (the `patternIdentity.identity` hash) to its module
 * entity. One `.tsx` yields source + compiled entities sharing an identity; we
 * prefer the `source` entity (it holds TS code + filename).
 */
export function buildModuleIndex(
  space: SpaceDb,
  opts: { branch?: string; scope?: string } = {},
): Map<string, ModuleEntry> {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  // Same enumeration every space-wide scan walks: branch-visible, and without
  // the tombstones that could never reconstruct into a module anyway.
  const ids = visibleEntityRows(space, { branch, scope }).map((r) => r.id);

  const index = new Map<string, ModuleEntry>();
  for (const id of ids) {
    let doc: EntityDocument | undefined;
    try {
      doc = reconstructDocument(space, { id, branch, scope });
    } catch {
      continue;
    }
    const v = doc?.value;
    if (!isModuleValue(v)) continue;
    const existing = index.get(v.identity);
    // First wins, but a `source` entity always supersedes a `compiled` one.
    if (!existing || v.kind === "source") {
      index.set(v.identity, { id, filename: v.filename, kind: v.kind });
    }
  }
  return index;
}

/** Model a single entity: classify + resolve `patternIdentity` → module id. */
export function modelEntity(
  space: SpaceDb,
  address: ReconstructOptions,
  moduleIndex?: Map<string, ModuleEntry>,
): EntityModel | undefined {
  const doc = reconstructDocument(space, address);
  if (doc === undefined) return undefined;
  return modelFromDocument(doc, {
    id: address.id,
    scope: address.scope ?? "space",
    moduleIndex,
    readDocument: spaceDocumentReader(space, {
      branch: address.branch,
      scope: address.scope,
      atSeq: address.atSeq,
    }),
  });
}

/** Build an EntityModel from an already-reconstructed document. */
export function modelFromDocument(
  doc: EntityDocument,
  ctx: {
    id: string;
    scope?: string;
    moduleIndex?: Map<string, ModuleEntry>;
    readDocument?: DocumentReader;
  },
): EntityModel {
  const c = classifyDocument(doc, {
    id: ctx.id,
    readDocument: ctx.readDocument,
  });
  if (c.lineage.pattern && ctx.moduleIndex) {
    c.lineage.pattern.moduleId = ctx.moduleIndex.get(c.lineage.pattern.identity)
      ?.id;
  }
  return {
    id: ctx.id,
    scope: ctx.scope ?? "space",
    kind: c.kind,
    regime: c.regime,
    owned: c.owned,
    label: c.label,
    paths: c.paths,
    valueShape: c.valueShape,
    lineage: c.lineage,
  };
}

const KIND_ORDER: Record<EntityKind, number> = {
  piece: 0,
  module: 1,
  stream: 2,
  schema: 3,
  "owned-cell": 4,
  "free-cell": 5,
  // Unreadable entities sort above tombstones: corruption is worth looking at,
  // and a deletion is the ordinary end of an entity's life.
  unknown: 6,
  deleted: 7,
};

/** Every kind an entity classifies as, in the order a listing presents them. */
export const entityKinds: readonly EntityKind[] = Object.keys(
  KIND_ORDER,
) as EntityKind[];

/** Whether a string names one of the kinds an entity classifies as. */
export function isEntityKind(value: string): value is EntityKind {
  return (entityKinds as readonly string[]).includes(value);
}

/**
 * How many entities a space-wide scan reconstructs before it stops. Every scan
 * is capped, because reconstruction is per-entity work and a space can hold
 * more entities than anyone wants to wait for.
 */
export const DEFAULT_SCAN_LIMIT = 5000;

/**
 * The end index a row listing slices to, for a limit that may be anything a
 * caller passed.
 *
 * These listings were SQL `LIMIT ?` clauses, where SQLite reads a NEGATIVE as
 * UNLIMITED, and the CLI still accepts one. A JS `slice` reads the same number
 * as "drop the last N", so moving the bound out of SQL turns an operator asking
 * for everything into a silent under-report. Distinct from `scanLimit`, which
 * governs a reconstruction CAP and floors a negative to zero: nothing to
 * reconstruct is a coherent answer, while nothing to list is not what a
 * negative meant here. A limit that is not a whole number is refused, which is
 * also what the SQL did.
 */
export function rowLimit(limit: number): number | undefined {
  // A non-integer is REFUSED rather than rounded, because that is what these
  // listings did before the bound moved into JS: SQLite answers `LIMIT 1.5`,
  // `LIMIT NaN` and `LIMIT Infinity` with a datatype mismatch, while `slice`
  // reads them as one row, no rows, and every row. Silently coercing a limit
  // the caller could not have meant is how a listing under-reports without
  // saying so. `Number.isInteger` rejects all four in one test.
  if (!Number.isInteger(limit)) {
    throw new Error(
      `a row limit must be a whole number of rows, not ${limit}.`,
    );
  }
  return limit < 0 ? undefined : limit;
}

/**
 * The cap a scan will actually apply, for a limit that may be anything a caller
 * passed. Entities are counted one at a time, so a cap has to be a whole
 * number: a fractional one no integer count can ever equal is a cap that never
 * takes effect, and the three scans disagreed about which way to round it.
 */
export function scanLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_SCAN_LIMIT;
  return Math.max(0, Math.floor(limit));
}

/**
 * How far a capped space-wide scan reached. A scan that stops at its cap
 * returns a SUBSET, and a caller that cannot tell a capped result from a
 * complete one will read the subset as the whole space — so every capped scan
 * reports this alongside its result.
 */
export interface ScanExtent {
  /** The cap the scan applied. */
  limit: number;

  /**
   * Entities this branch and scope can see, before any `kind` filter — the
   * size of the set the scan walked (`visibleEntityRows`), so a complete pass
   * describes exactly this many.
   */
  total: number;

  /** True when the scan reached more of what was asked for than `limit`. */
  truncated: boolean;

  /**
   * Entities the scan enumerated and could NOT describe — a payload that would
   * not decode, or a reconstruction that threw. A separate count from
   * `truncated` because it is a separate kind of incompleteness: raising
   * `limit` does not recover one. Zero where a pass returns a row for every
   * entity it reached, as `listEntityModels` does by modeling an unreadable
   * entity `unknown`.
   */
  unreadable: number;
}

/** Whether a scan returned less than the whole set, for any reason. */
export function isCompleteScan(extent: ScanExtent): boolean {
  return !extent.truncated && extent.unreadable === 0;
}

/** One entity a scan can reach, and how many of its revisions it can see. */
export interface EntityScanRow {
  id: string;
  revisions: number;

  /**
   * The chain link that owns the visible row. A pass describing an entity's
   * history has to read THIS branch and no other: nearest-branch ownership
   * hides a parent's log exactly as it hides the parent's value.
   */
  link: BranchReadLink;
}

/**
 * Every entity a read on this branch and scope can see, busiest-first.
 *
 * This is the DOMAIN of every space-wide scan, and the set `ScanExtent.total`
 * counts — one enumeration so that a scan's rows and its own report of how far
 * it reached can never describe different sets. Two properties earn it:
 *
 *  - It reads through branch ancestry, not just the rows written ON `branch`.
 *    A child branch inherits every entity its parent held at the fork
 *    (`branchReadChain`), and a scan that enumerated only local rows would
 *    report a listing complete while omitting entities the same branch reads
 *    fine. `revisions` counts the history on the branch that OWNS the visible
 *    row, which is the history a read from here can reach.
 *  - It drops entities whose visible head is a `delete`, unless
 *    `includeDeleted`. A tombstone reconstructs to nothing, so a pass that
 *    describes reconstructed entities would otherwise count rows it never
 *    describes — inflating the total and raising a truncation notice for a
 *    result that was never truncated.
 *
 * Ties on `revisions` break by id through `utf8Compare`, so which entities a
 * cap admits is a property of the space rather than of the day's query plan.
 */
export function visibleEntityRows(
  space: SpaceDb,
  opts: {
    branch?: string;
    scope?: string;

    /** Include entities whose visible head is a `delete`. Default false. */
    includeDeleted?: boolean;
  } = {},
): EntityScanRow[] {
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const rows = visibleRevisionRows(space, { branch, scope });

  // Entities on ONE branch whose LAST row up to the cut is a delete. Asked for
  // the other way round — find the deletes, then ask which are final — because
  // deletes are a sliver of a space's rows, where deriving every entity's head
  // op reads all of them. Keyed by the branch that OWNS the entity: a delete on
  // a farther link is hidden by the nearer branch that claimed it.
  const gone = new Set<string>();
  if (!opts.includeDeleted) {
    const tombstoned = space.db.prepare(
      `SELECT r.id FROM revision r
       WHERE r.branch = ? AND r.scope_key = ? AND r.op = 'delete' AND r.seq <= ?
         AND NOT EXISTS (
           SELECT 1 FROM revision h
           WHERE h.branch = r.branch AND h.id = r.id
             AND h.scope_key = r.scope_key AND h.seq <= ?
             AND (h.seq > r.seq OR (h.seq = r.seq AND h.op_index > r.op_index))
         )`,
    );
    for (const link of branchReadChain(space, branch)) {
      for (
        const r of tombstoned.all<{ id: string }>(
          link.branch,
          scope,
          link.atSeq,
          link.atSeq,
        )
      ) {
        gone.add(`${link.branch}\u0000${r.id}`);
      }
    }
  }

  return rows
    .filter((r) => !gone.has(`${r.link.branch}\u0000${r.id}`))
    .map((r) => ({ id: r.id, revisions: r.revisions, link: r.link }))
    // `utf8Compare` rather than `<`, matching `fingerprint.ts` and every other
    // id ordering in the tree. The tie-break exists to make the order a
    // property of the space; a hand-rolled comparison is a second definition of
    // string order in the one domain that already has a shared one.
    .sort((a, b) => b.revisions - a.revisions || utf8Compare(a.id, b.id));
}

/**
 * How many entities a read on this branch and scope can see — the size of
 * `visibleEntityRows`, and by construction the same set a scan walks.
 */
export function countEntities(
  space: SpaceDb,
  opts: { branch?: string; scope?: string; includeDeleted?: boolean } = {},
): number {
  return visibleEntityRows(space, opts).length;
}

/**
 * An entity's kind without modeling it. An entity carrying no document is named
 * by WHY it carries none, so a tombstone answers `deleted` and only a genuinely
 * unreadable one answers `unknown`.
 */
function kindOf(
  id: string,
  outcome: ReconstructOutcome,
  readDocument: DocumentReader,
): EntityKind {
  return outcome.status === "present"
    ? classifyDocument(outcome.document, { id, readDocument }).kind
    : absentEntity(outcome.status).kind;
}

/**
 * The pattern identity a document's `moduleId` would resolve through — the
 * same `patternIdentity.identity` `classifyDocument` reads into
 * `lineage.pattern`, without paying for a full classification.
 */
function patternIdentityOf(
  doc: EntityDocument | undefined,
): string | undefined {
  if (doc === undefined || !isObjectNotArray(doc.patternIdentity)) return;
  const identity = (doc.patternIdentity as { identity?: unknown }).identity;
  return typeof identity === "string" ? identity : undefined;
}

/** A capped listing of a space's entities, with how far its scan reached. */
export interface EntityListing {
  /** The entities modeled, at most `extent.limit` of them. */
  entities: EntityModel[];

  extent: ScanExtent;
}

/**
 * How far a listing's link count reaches. The count is a fan-out proxy in one
 * column of a table over every entity in a space, read beside the others to
 * tell a hub from a leaf, so it is bounded shallow: eight levels is deeper
 * than the nesting that distinguishes them, and the walk runs once per entity.
 *
 * `maxNodes` is unbounded because `EntityModel` carries a link count and no
 * field saying the count is a floor, and a number silently short is worse than
 * a walk that does not stop early. Giving it a finite value belongs with
 * giving the model that field.
 */
const LISTING_LINK_WALK: LinkWalkBounds = {
  maxDepth: 8,
  maxNodes: Number.POSITIVE_INFINITY,
};

/**
 * Model the entities in a space — the fluent "what is in here?" view. One
 * reconstruction pass: collect documents, build the module index from them,
 * then classify each. Sorted pieces → modules → streams → schemas → cells.
 *
 * `limit` bounds what the caller asked for, so `kind` selects DURING the scan
 * rather than over its result: filtering afterwards would yield "the pieces
 * among the first `limit` entities" rather than "up to `limit` pieces", which
 * reads the same and is a different set. A `kind` scan therefore walks the
 * space until it has enough matches, and costs more than an unfiltered one.
 */
export function listEntityModels(
  space: SpaceDb,
  opts: {
    branch?: string;
    scope?: string;
    limit?: number;
    kind?: EntityKind;
  } = {},
): EntityListing {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const limit = scanLimit(opts.limit);
  const kind = opts.kind;

  // A listing describes the space's RECORDS, so it keeps tombstones (they model
  // as `deleted`, which is why `--kind deleted` can ask for them) — and that
  // keeps `extent.total` counting exactly the set this pass returns.
  const rows = visibleEntityRows(space, {
    branch,
    scope,
    includeDeleted: true,
  });

  // Single reconstruction pass: cache docs + build the module index inline.
  // Only matching documents are cached; a `kind` scan may pass over far more
  // entities than it keeps, and holding every value would cost the space.
  const outcomes = new Map<string, ReconstructOutcome>();
  const moduleIndex = new Map<string, ModuleEntry>();
  const indexModule = (id: string, doc: EntityDocument | undefined): void => {
    const v = doc?.value;
    if (!isModuleValue(v)) return;
    const existing = moduleIndex.get(v.identity);
    // First wins, but a `source` entity always supersedes a `compiled` one.
    if (!existing || v.kind === "source") {
      moduleIndex.set(v.identity, { id, filename: v.filename, kind: v.kind });
    }
  };
  // A tombstone and a corrupt payload both yield no document, and only one of
  // them is an error: a deleted entity is definitively not a `piece`, while an
  // entity that would not decode might have been one. The outcome keeps the two
  // apart, so a `kind` filter that drops an error can still report it.
  const read = (id: string): ReconstructOutcome =>
    reconstructOutcome(space, { id, branch, scope });
  const documentOf = (o: ReconstructOutcome): EntityDocument | undefined =>
    o.status === "present" ? o.document : undefined;
  const readDocument = spaceDocumentReader(space, { branch, scope });
  // An entity that is HERE and cannot be read. A tombstone is not one: it says
  // what happened to it.
  const isUnreadable = (o: ReconstructOutcome): boolean =>
    o.status === "undecodable" || o.status === "empty";
  // Whether corruption could be hiding the kind that was asked for. It cannot
  // hide a tombstone: what makes an entity `deleted` is the OP of its visible
  // row, which is read before any payload is, and an unreadable row's op is a
  // `set` or a `patch`. So a `deleted` scan is exhaustive even over rows it
  // could not decode, and counting them would make a complete listing report
  // itself partial — turning `--require-complete` into a nonzero exit over an
  // answer that was whole.
  const concealable = kind !== "deleted";

  const kept: EntityScanRow[] = [];
  let truncated = false;
  let scanned = 0;
  // Rows a `kind` filter dropped BECAUSE they would not reconstruct. An
  // unfiltered listing keeps every row it reaches — an unreadable one included,
  // modeled `unknown` — so it never has any; a filtered one silently omits what
  // it cannot classify, and `--require-complete` has to hear about it.
  let unreadable = 0;
  // Collect: one entity past the limit is kept and dropped, because HOLDING it
  // is what proves more remain — truncation is never inferred from a count that
  // happened to land on the cap.
  for (; scanned < rows.length; scanned++) {
    const r = rows[scanned];
    const outcome = read(r.id);
    const doc = documentOf(outcome);
    indexModule(r.id, doc);
    if (kind !== undefined && kindOf(r.id, outcome, readDocument) !== kind) {
      if (concealable && isUnreadable(outcome)) unreadable++;
      continue;
    }
    if (kept.length === limit) {
      truncated = true;
      scanned++;
      break;
    }
    outcomes.set(r.id, outcome);
    kept.push(r);
  }

  // Resolve: a piece's `moduleId` comes from a module that can sit ANYWHERE in
  // the order — modules are written once, so they rank last among busiest-first
  // rows, and a `kind` scan that stopped at the cap can hold pieces whose module
  // it never reached. Their `moduleId` would come back `undefined`, which reads
  // as "this piece has no pattern" rather than "the scan stopped early".
  //
  // A `kind` scan is where that matters: the module is a DIFFERENT kind, so it
  // could never be in the result and the caller has no way to resolve the
  // identity themselves. An unfiltered capped listing is a prefix that says so,
  // and its unresolved ids point outside the prefix the same way `lineage.owner`
  // and `lineage.argument` already do — so it keeps its cheap scan.
  const wanted = new Set<string>();
  if (kind !== undefined) {
    for (const o of outcomes.values()) {
      const identity = patternIdentityOf(documentOf(o));
      if (
        identity !== undefined && moduleIndex.get(identity)?.kind !== "source"
      ) {
        wanted.add(identity);
      }
    }
  }
  // Reachable only when collection stopped at the cap — the loop above runs to
  // `rows.length` otherwise — so a failure this walk meets is already covered by
  // `truncated`, and counting it under `unreadable` would contradict the notice
  // that goes with it: raising `--limit` DOES bring these rows into the pass
  // above, which reports them. Pinned by a test, since the invariant lives in
  // the loop bounds rather than anywhere it can be read off.
  //
  // The walk ends the moment nothing is still wanted.
  for (; wanted.size > 0 && scanned < rows.length; scanned++) {
    const r = rows[scanned];
    const doc = documentOf(read(r.id));
    indexModule(r.id, doc);
    const v = doc?.value;
    // A `source` entity supersedes a `compiled` one, so a want is only settled
    // once source is seen — or the rows run out.
    if (isModuleValue(v) && v.kind === "source") wanted.delete(v.identity);
  }

  const out: EntityModel[] = kept.map((r): EntityModel => {
    const outcome = outcomes.get(r.id)!;
    if (outcome.status !== "present") {
      const { kind, label } = absentEntity(outcome.status);
      return {
        id: r.id,
        scope,
        kind,
        regime: "n/a",
        owned: false,
        label,
        paths: [],
        valueShape: "absent",
        lineage: {},
        revisions: r.revisions,
        links: 0,
      };
    }
    const m = modelFromDocument(outcome.document, {
      id: r.id,
      scope,
      moduleIndex,
      readDocument,
    });
    m.revisions = r.revisions;
    m.links = linksWithPaths(outcome.document.value, LISTING_LINK_WALK)
      .links.length;
    return m;
  });

  return {
    entities: out.sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        (b.revisions ?? 0) - (a.revisions ?? 0),
    ),
    extent: {
      // `rows`, not a second count: the listing and its own report of how far
      // it reached are the same enumeration, so they cannot drift. It counts
      // tombstones because this listing returns them, which is also why a
      // `graph` or `html` total over the same space is smaller — those describe
      // reconstructed entities, and a tombstone reconstructs to nothing.
      limit,
      total: rows.length,
      truncated,
      unreadable,
    },
  };
}

export interface PieceCellRef {
  id: string;

  /** Classified kind of the owned cell (stream / schema / owned-cell / …). */
  kind: EntityKind;

  label: string;
  summary: string;
}

export interface PieceModel {
  id: string;
  regime: Regime;
  name: string;

  /** The pattern (module) this piece instantiates, resolved via patternIdentity. */
  pattern?: {
    id?: string;
    identity: string;
    symbol?: string;
    filename?: string;
    codeLines?: number;

    /** Full TS source — only populated when `includeCode` is set. */
    code?: string;
  };

  /** The piece's input cell (the `argument` link). */
  input?: { id: string; summary: string };

  /** Top-level keys of the piece's result value ($UI, $NAME, …pattern outputs). */
  resultKeys: string[];

  /** Top-level keys of the result JSONSchema. */
  schemaKeys: string[];

  /** The piece's owned child cells (its `internal` manifest, resolved). */
  ownedCells: PieceCellRef[];
}

/**
 * Resolve a piece fully: its pattern source (follow `patternIdentity` → module),
 * input cell (`argument`), result value + schema, and owned cells (`internal`).
 * Returns `{ error }` if the entity is absent or is not a piece.
 */
export function describePiece(
  space: SpaceDb,
  id: string,
  opts: {
    branch?: string;
    scope?: string;
    includeCode?: boolean;
    moduleIndex?: Map<string, ModuleEntry>;
  } = {},
): PieceModel | { error: string } {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const outcome = reconstructOutcome(space, { id, branch, scope });
  if (outcome.status !== "present") {
    return { error: `entity ${absentEntity(outcome.status).label}` };
  }
  const doc = outcome.document;
  const readDocument = spaceDocumentReader(space, { branch, scope });
  const c = classifyDocument(doc, { id, readDocument });
  if (c.kind !== "piece") return { error: `not a piece (kind=${c.kind})` };

  const value = doc.value;
  const name = isObjectNotArray(value) && typeof value.$NAME === "string"
    ? value.$NAME
    : "(unnamed)";

  let pattern: PieceModel["pattern"];
  if (c.lineage.pattern) {
    const index = opts.moduleIndex ??
      buildModuleIndex(space, { branch, scope });
    const entry = index.get(c.lineage.pattern.identity);
    let codeLines: number | undefined;
    let code: string | undefined;
    if (entry) {
      const mdoc = reconstructDocument(space, { id: entry.id, branch, scope });
      const mv = mdoc?.value;
      if (isModuleValue(mv)) {
        codeLines = mv.code.split("\n").length;
        if (opts.includeCode) code = mv.code;
      }
    }
    pattern = {
      id: entry?.id,
      identity: c.lineage.pattern.identity,
      symbol: c.lineage.pattern.symbol,
      filename: entry?.filename,
      codeLines,
      code,
    };
  }

  let input: PieceModel["input"];
  if (c.lineage.argument) {
    const a = reconstructOutcome(space, {
      id: c.lineage.argument,
      branch,
      scope,
    });
    input = {
      id: c.lineage.argument,
      summary: a.status === "present"
        ? summarize(a.document.value)
        : absentEntity(a.status).label,
    };
  }

  const ownedCells: PieceCellRef[] = (c.lineage.internal ?? []).map(
    (cid): PieceCellRef => {
      const child = reconstructOutcome(space, { id: cid, branch, scope });
      if (child.status !== "present") {
        const { kind, label } = absentEntity(child.status);
        return { id: cid, kind, label, summary: label };
      }
      const cdoc = child.document;
      const cc = classifyDocument(cdoc, { id: cid, readDocument });
      return {
        id: cid,
        kind: cc.kind,
        label: cc.label,
        summary: cc.kind === "stream"
          ? cc.label
          : cc.valueShape === "absent"
          ? "(no value)"
          : summarize(cdoc.value),
      };
    },
  );

  // The keys of the schema itself, read out of the schema document where the
  // meta only references one.
  const schema = storedSchemaOf(doc, readDocument)?.schema;
  return {
    id,
    regime: c.regime,
    name,
    pattern,
    input,
    resultKeys: isObjectNotArray(value) ? Object.keys(value) : [],
    schemaKeys: isObjectNotArray(schema) ? Object.keys(schema) : [],
    ownedCells,
  };
}
