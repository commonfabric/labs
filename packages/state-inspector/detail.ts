// Rich per-entity detail — everything a human (or agent) needs to understand
// ONE entity, with crystal-clear, context-aware labels.
//
// The fluent model (model.ts) classifies an entity by kind. This layer goes
// further: it resolves what each cell/stream actually IS from its CONTEXT and
// VALUE, so a generic "stream" becomes "⊙ createProfile" (named by the key that
// points at it in its owner piece) and a bare "{ link, specifier }" becomes
// "import ./piece-grid.tsx". It also surfaces every salient field: the full
// value, schema, CFC (information-flow) labels, version history, resolved
// lineage, outgoing links (with target labels), and module source.
//
// Built in one reconstruction pass over the space (buildAllDetails) so link
// targets and owner→child names resolve against the whole space.

import {
  isObjectNotArray,
  type ReadonlyRecord,
} from "@commonfabric/utils/types";

import type { SpaceDb } from "./db.ts";
import {
  annotate,
  decodedLinkOf,
  linksWithPaths,
  type LinkWalkBounds,
  parseSigilLink,
  summarize,
} from "./decode.ts";
import { reconstructOutcome } from "./reconstruct.ts";
import type { EntityDocument } from "./reconstruct.ts";
import {
  absentEntity,
  classifyDocument,
  type EntityKind,
  isModuleValue,
  type ModuleEntry,
  type ScanExtent,
  scanLimit,
  spaceDocumentReader,
  storedSchemaOf,
  streamDeclarationOf,
  visibleEntityRows,
} from "./model.ts";

/** A resolved reference to another entity (or a cross-space target). */
export interface LinkRef {
  id: string;

  /** Resolved label of the target (if in this space). */
  label?: string;

  kind?: EntityKind;

  /** Cross-space target space DID. */
  space?: string;

  path?: string[];

  /** True when the target is in another space (not resolvable locally). */
  external?: boolean;

  /** Where this link sits in the source value (a JSON path), for "links" lists. */
  at?: string;
}

export interface VersionRow {
  seq: number;
  op: string;
  session: string;
  createdAt: string;
}

/** Parsed, render-ready CFC (information-flow) metadata. */
export interface CfcSummary {
  schemaHash?: string;
  entries: {
    path: string;
    confidentiality: string[];
    integrity: string[];
    origin?: string;

    /**
     * Set when the entry holds its label by a reference the space could
     * not supply a label for, so the empty atom lists above say "not
     * read" rather than "no label".
     */
    unresolved?: true;
  }[];
}

export interface EntityDetail {
  id: string;
  kind: EntityKind;
  regime: string;
  owned: boolean;

  /** Context-aware label (key-name / import specifier / $NAME / module file). */
  label: string;

  /** Short human role, e.g. "input cell", "owned stream", "module import". */
  role: string;

  /** The key in the owner piece that names this entity, if any. */
  contextName?: string;

  /** Top-level document paths present (the control plane). */
  paths: string[];

  valueShape: string;

  /** The annotated value (links/streams normalized; depth-bounded). */
  value: unknown;

  valuePreview: string;

  /** The result JSONSchema (annotated), if the entity carries one. Streams and
   * named owned cells get their DECLARED schema resolved from the owner piece. */
  schema?: unknown;

  schemaKeys?: string[];

  /** Where `schema` came from when it isn't the entity's own (e.g. owner piece). */
  schemaSource?: string;

  /** True when the declared schema is a stream payload (`asCell:["stream"]`). */
  streamPayload?: boolean;

  /** IFC labels from a schema-as-value entity, if present. */
  ifc?: unknown;

  /** Parsed CFC labels from the `cfc` meta path, if present. */
  cfc?: CfcSummary;

  revisions: number;
  headSeq: number | null;
  firstSeq: number | null;
  versions: VersionRow[];
  lineage: {
    pattern?: LinkRef & {
      filename?: string;
      symbol?: string;
      codeLines?: number;
    };
    argument?: LinkRef;
    internal?: LinkRef[];
    owner?: LinkRef;

    /** Legacy regime: the result cell a process cell produces (`resultRef`). */
    result?: LinkRef;
  };

  /** Outgoing data links found in the value, resolved to target labels. */
  outLinks: LinkRef[];

  /** Module source (only on module entities). */
  code?: string;
}

/** A `{ link, specifier }` cell is a module-import entry. */
function importSpecifier(v: unknown): string | undefined {
  if (
    isObjectNotArray(v) && typeof v.specifier === "string" && "link" in v &&
    Object.keys(v).length === 2
  ) return v.specifier;
  return undefined;
}

/**
 * The `resultRef` target of a legacy process cell (`{ $TYPE, resultRef, … }`).
 * LEGACY-PROCESS-CELL: this and `legacyName` (plus their `regime === "legacy"`
 * callers below) retire with the closed process-cell era — see the retirement
 * note at the top of model.ts for the full removal checklist.
 */
function legacyResultId(v: unknown): string | undefined {
  if (isObjectNotArray(v) && "$TYPE" in v && "resultRef" in v) {
    return parseSigilLink(v.resultRef)?.id;
  }
  return undefined;
}

/**
 * A legacy process cell's human name lives on its RESULT cell's `$NAME` (the
 * process cell itself only carries `$TYPE`/refs). Resolve it through the docs.
 */
function legacyName(
  v: unknown,
  docs: Map<string, EntityDocument>,
): string | undefined {
  const rid = legacyResultId(v);
  const rv = rid ? docs.get(rid)?.value : undefined;
  return isObjectNotArray(rv) && typeof rv.$NAME === "string"
    ? rv.$NAME
    : undefined;
}

/** Render a CFC atom (string sigil, or an object atom) to a short string. */
function atomLabel(a: unknown): string {
  if (typeof a === "string") return a;
  if (isObjectNotArray(a)) {
    const t = typeof a.type === "string" ? a.type.split("/").pop() : "atom";
    const extra = a.name ?? a.subject ?? a.class ?? a.symbol;
    return extra ? `${t}:${extra}` : String(t);
  }
  return String(a);
}

/**
 * The label a stored entry holds: its own when inline, else the value of
 * the `cid:` label document its single-member `$ref` names, read out of the
 * space. `undefined` for a reference the space cannot supply a label for —
 * no document, one holding no record, or a reference outside the `cid:`
 * namespace, which names no label document and is not followed into
 * whatever entity it names.
 */
function storedLabelOf(
  entry: Record<string, unknown>,
  readDocument: DetailContext["readDocument"],
): Record<string, unknown> | undefined {
  const label = isObjectNotArray(entry.label) ? entry.label : {};
  const ref = label.$ref;
  if (typeof ref !== "string" || Object.keys(label).length !== 1) {
    return label;
  }
  if (!ref.startsWith("cid:")) return undefined;
  const content = readDocument(ref)?.value;
  return isObjectNotArray(content) ? content : undefined;
}

function parseCfc(
  cfc: unknown,
  readDocument: DetailContext["readDocument"],
): CfcSummary | undefined {
  if (!isObjectNotArray(cfc)) return undefined;
  const out: CfcSummary = {
    schemaHash: typeof cfc.schemaHash === "string" ? cfc.schemaHash : undefined,
    entries: [],
  };
  const lm = cfc.labelMap;
  const entries = isObjectNotArray(lm) && Array.isArray(lm.entries)
    ? lm.entries
    : [];
  for (const e of entries) {
    if (!isObjectNotArray(e)) continue;
    const label = storedLabelOf(e, readDocument);
    out.entries.push({
      path: Array.isArray(e.path) ? (e.path as string[]).join("/") : "",
      confidentiality: Array.isArray(label?.confidentiality)
        ? label.confidentiality.map(atomLabel)
        : [],
      integrity: Array.isArray(label?.integrity)
        ? label.integrity.map(atomLabel)
        : [],
      origin: typeof e.origin === "string" ? e.origin : undefined,
      ...(label === undefined ? { unresolved: true as const } : {}),
    });
  }
  return out;
}

/**
 * A stream / owned cell carries no schema of its own — its DECLARED schema (a
 * stream's event payload, a cell's value type) is attached where it is NAMED in
 * its owner piece, under the key `<key>`. Two sources, link-first:
 *   1. the inline `schema` on the LINK itself, in either at-rest form — present
 *      even when the result schema omits the handler (e.g. addFavorite),
 *   2. else the owner's `schema.properties[<key>]`, following a `$ref` into `$defs`.
 */
function declaredSchemaFor(
  ownerDoc: EntityDocument | undefined,
  key: string,
): { schema: unknown; keys?: string[]; via: string } | undefined {
  // 1. inline schema carried on the naming link, in either at-rest form.
  const naming = isObjectNotArray(ownerDoc?.value)
    ? (ownerDoc!.value as Record<string, unknown>)[key]
    : undefined;
  const linkSchema = decodedLinkOf(naming)?.schema;
  if (linkSchema !== undefined) {
    return {
      schema: annotate(linkSchema),
      // A boolean schema has no keys to list, and `true` in particular is the
      // one that constrains nothing — reporting it is the point, since the
      // owner's declaration would otherwise stand in for it.
      keys: isObjectNotArray(linkSchema) ? Object.keys(linkSchema) : undefined,
      via: "link",
    };
  }
  // 2. fallback: owner's result-schema property ($ref into $defs).
  // A deliberately NARROW lookup, for display only: a single top-level
  // `#/$defs/<name>`, with no pointer-escape decoding, no nested `$ref`, and
  // no `$defs` re-attached to what it finds, so a nested or escaped ref shows
  // its raw `{ $ref }`. Nothing is classified through here: a stream is told
  // from its owner's manifest by the reading in
  // `@commonfabric/runner/stream-declaration`, which the runtime reads through
  // as well and which carries none of the live runtime.
  const osch = ownerDoc?.schema;
  if (isObjectNotArray(osch) && isObjectNotArray(osch.properties)) {
    const prop = osch.properties[key];
    if (isObjectNotArray(prop)) {
      let resolved: ReadonlyRecord = prop;
      const ref = typeof prop.$ref === "string" ? prop.$ref : undefined;
      if (ref?.startsWith("#/$defs/") && isObjectNotArray(osch.$defs)) {
        const def = osch.$defs[ref.slice("#/$defs/".length)];
        if (isObjectNotArray(def)) resolved = def;
      }
      return {
        schema: annotate(resolved),
        keys: Object.keys(resolved),
        via: "schema",
      };
    }
  }
  return undefined;
}

/**
 * How far a detail's link walks reach. A detail describes ONE entity for a
 * reader, and the rendering it feeds is itself depth-bounded, so a link past
 * ten levels of nesting is one no reader of this output would have seen
 * anyway. That depth is small enough to bound the walk's work on its own —
 * see `LinkWalkBounds` for why a larger one would not be — so no node count is
 * imposed on top of it.
 */
const DETAIL_LINK_WALK: LinkWalkBounds = {
  maxDepth: 10,
  maxNodes: Number.POSITIVE_INFINITY,
};

interface DetailContext {
  ownDid: string;
  labelOf: Map<string, { kind: EntityKind; label: string }>;

  /** entityId → { ownerId, key } naming it in its owner piece's value. */
  nameOf: Map<string, { owner: string; key: string }>;

  moduleIndex: Map<string, ModuleEntry>;
  docs: Map<string, EntityDocument>;

  /**
   * Reads one document out of the space by id, whether or not the detail
   * pass scanned it: the pass is capped, and a `cid:` label document has one
   * revision and so sits past the cap whenever it is exceeded.
   */
  readDocument: (id: string) => EntityDocument | undefined;
}

function refTo(
  id: string | undefined,
  ctx: DetailContext,
): LinkRef | undefined {
  if (!id) return undefined;
  const info = ctx.labelOf.get(id);
  return { id, label: info?.label, kind: info?.kind };
}

/** Build the rich detail for a single (already reconstructed) document. */
function detailFromDoc(
  id: string,
  doc: EntityDocument,
  ctx: DetailContext,
  versions: VersionRow[],
): EntityDetail {
  const c = classifyDocument(doc, { id, readDocument: ctx.readDocument });
  const value = doc.value;
  const spec = importSpecifier(value);
  const named = ctx.nameOf.get(id);

  // context-aware label + role
  // Label comes from the shared index (it already folds in import/context/legacy
  // refinements); role is computed here.
  let label = ctx.labelOf.get(id)?.label ?? c.label;
  let role: string = c.kind;
  if (spec) {
    label = `import ${spec}`;
    role = "module import";
  } else if (named) {
    role = c.kind === "stream"
      ? `stream · ${named.key}`
      : `cell · ${named.key}`;
  } else if (c.kind === "piece" && c.regime === "legacy") {
    role = "piece (legacy process)";
  } else {
    role = roleFor(c.kind, c.owned);
  }

  // lineage, resolved to target labels
  const lineage: EntityDetail["lineage"] = {};
  if (c.lineage.argument) {
    lineage.argument = refTo(c.lineage.argument, ctx);
  }
  if (c.lineage.owner) lineage.owner = refTo(c.lineage.owner, ctx);
  // Legacy: surface the result cell + the owned-cell manifest from the value.
  if (c.kind === "piece" && c.regime === "legacy" && isObjectNotArray(value)) {
    const rid = legacyResultId(value);
    if (rid) lineage.result = refTo(rid, ctx);
    // The links alone. A detail is a rendering bounded to a depth its own
    // output would not have shown past, so `tooDeep` and `budgetExhausted`
    // change nothing a reader could act on. `opaque` is not covered by that
    // argument — a `ProblematicValue` holds the state it wrapped out of a
    // structural walk's reach, so a link inside one is missing from this list
    // and nothing here says so. Reporting it needs a field on `EntityDetail`
    // and a place in what renders it, which is a change to the detail rather
    // than to the walk.
    const internalIds = linksWithPaths(value.internal, DETAIL_LINK_WALK).links
      .map((l) => l.link.id).filter((x): x is string => !!x);
    if (internalIds.length) {
      lineage.internal = internalIds.map((cid) => refTo(cid, ctx)!);
    }
  }
  if (c.lineage.internal?.length) {
    lineage.internal = c.lineage.internal.map((cid) => refTo(cid, ctx)!);
  }
  if (c.lineage.pattern) {
    const mid = ctx.moduleIndex.get(c.lineage.pattern.identity);
    const ref: EntityDetail["lineage"]["pattern"] = {
      id: mid?.id ?? c.lineage.pattern.identity,
      label: mid ? ctx.labelOf.get(mid.id)?.label : undefined,
      kind: "module",
      symbol: c.lineage.pattern.symbol,
      filename: mid?.filename,
    };
    if (mid) {
      const mdoc = ctx.docs.get(mid.id);
      const mv = mdoc?.value;
      if (isModuleValue(mv)) ref.codeLines = mv.code.split("\n").length;
    }
    lineage.pattern = ref;
  }

  // outgoing links, resolved. The links alone, for the reason above — and
  // with the same gap: a link inside a value the walk could read only in part
  // is absent from this list without the list saying so.
  const outLinks: LinkRef[] = linksWithPaths(value, DETAIL_LINK_WALK).links.map(
    ({ link, at }) => {
      const external = !!link.space && link.space !== ctx.ownDid &&
        link.space !== `did:key:${ctx.ownDid}`;
      return {
        id: link.id ?? "?",
        label: link.id ? ctx.labelOf.get(link.id)?.label : undefined,
        kind: link.id ? ctx.labelOf.get(link.id)?.kind : undefined,
        space: link.space,
        path: link.path ? [...link.path] : undefined,
        external,
        at: at.join("/"),
      };
    },
  );

  // module source
  let code: string | undefined;
  if (isModuleValue(value)) code = value.code;

  // schema / ifc / cfc. A `schema` meta is the schema itself or a reference
  // to the schema document holding it; the detail shows the schema either
  // way and says which.
  const own = storedSchemaOf(doc, ctx.readDocument);
  let schema = own === undefined ? undefined : annotate(own.schema);
  let schemaKeys = own !== undefined && isObjectNotArray(own.schema)
    ? Object.keys(own.schema)
    : undefined;
  let schemaSource: string | undefined = own?.via === "document"
    ? `schema document · ${own.ref}`
    : undefined;
  let streamPayload: boolean | undefined = own !== undefined &&
      c.kind === "stream"
    ? true
    : undefined;
  // A stream carries no schema of its own: the one shown is the DECLARED one,
  // read from the manifest link its owner keeps for it, and the source names
  // that manifest and, where the link held a reference, the schema document
  // it was followed into.
  if (schema === undefined && c.kind === "stream") {
    const decl = streamDeclarationOf(id, doc, ctx.readDocument);
    if (decl) {
      schema = annotate(decl.schema);
      schemaKeys = isObjectNotArray(decl.schema)
        ? Object.keys(decl.schema)
        : undefined;
      streamPayload = true;
      schemaSource = `declared in owner manifest · ${decl.owner}` +
        (decl.via === "document" ? ` · schema document · ${decl.ref}` : "");
    }
  }
  // A named owned cell with no schema read so far — a value cell, or a stream
  // no manifest declares — takes the DECLARED one from the owner piece that
  // names it.
  if (schema === undefined && named) {
    const decl = declaredSchemaFor(ctx.docs.get(named.owner), named.key);
    if (decl) {
      schema = decl.schema;
      schemaKeys = decl.keys;
      streamPayload = c.kind === "stream";
      schemaSource = decl.via === "link"
        ? `declared at owner · ${named.key} (link)`
        : `declared in owner schema · ${named.key}`;
    }
  }
  const ifc = isObjectNotArray(value) && "ifc" in value
    ? annotate(value.ifc)
    : undefined;
  const cfc = parseCfc(doc.cfc, ctx.readDocument);

  return {
    id,
    kind: c.kind,
    regime: c.regime,
    owned: c.owned,
    label,
    role,
    contextName: named?.key,
    paths: c.paths,
    valueShape: c.valueShape,
    value: annotate(value),
    valuePreview: summarize(value),
    schema,
    schemaKeys,
    schemaSource,
    streamPayload,
    ifc,
    cfc,
    revisions: versions.length,
    headSeq: versions.length ? versions[versions.length - 1].seq : null,
    firstSeq: versions.length ? versions[0].seq : null,
    versions,
    lineage,
    outLinks,
    code,
  };
}

function roleFor(kind: EntityKind, owned: boolean): string {
  switch (kind) {
    case "piece":
      return "piece (running pattern)";
    case "module":
      return "module (pattern source)";
    case "stream":
      return owned ? "owned stream" : "stream";
    case "schema":
      return "schema";
    case "owned-cell":
      return "owned cell";
    case "free-cell":
      return "free cell";
    default:
      return "entity";
  }
}

/** A capped detail pass over a space, with how far its scan reached. */
export interface DetailListing {
  /** The entities detailed, at most `extent.limit` of them. */
  details: EntityDetail[];

  extent: ScanExtent;
}

/**
 * Build rich details for every entity in a space — one reconstruction pass,
 * resolving link-target labels and owner→child context names space-wide.
 */
export function buildAllDetails(
  space: SpaceDb,
  opts: { branch?: string; scope?: string; limit?: number } = {},
): DetailListing {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const limit = scanLimit(opts.limit);
  const ownDid = (space.path.split("/").pop() ?? "").replace(/\.sqlite$/, "");

  // The entities a read on this branch can see, tombstones already dropped —
  // the same set the pass below describes, so `extent.total` counts what a
  // complete pass would return and truncation is a fact rather than an
  // inference from a count landing on the cap.
  const rows = visibleEntityRows(space, { branch, scope });
  const truncated = rows.length > limit;
  const scanned = truncated ? rows.slice(0, limit) : rows;
  let unreadable = 0;

  // Pass 1: reconstruct + module index + base labels.
  const docs = new Map<string, EntityDocument>();
  const moduleIndex = new Map<string, ModuleEntry>();
  const labelOf = new Map<string, { kind: EntityKind; label: string }>();
  for (const r of scanned) {
    const outcome = reconstructOutcome(space, { id: r.id, branch, scope });
    if (outcome.status !== "present") {
      // Enumerated but not described: counted, never silently dropped, or a pass
      // that skipped it would report itself complete over a smaller set. It
      // still earns a label, so a link INTO it resolves to why it cannot be
      // read rather than to nothing.
      labelOf.set(r.id, absentEntity(outcome.status));
      unreadable++;
      continue;
    }
    const doc = outcome.document;
    docs.set(r.id, doc);
    const v = doc.value;
    if (isModuleValue(v)) {
      const existing = moduleIndex.get(v.identity);
      if (!existing || v.kind === "source") {
        moduleIndex.set(v.identity, {
          id: r.id,
          filename: v.filename,
          kind: v.kind,
        });
      }
    }
  }

  // A document the pass did not scan — an owner past the cap, a label or
  // schema document — is read at the pass's own scope, and a content-addressed
  // one at space scope, where those live whatever scope the pass describes.
  const readSpaceDocument = spaceDocumentReader(space, { branch, scope });
  const readDocument = (id: string): EntityDocument | undefined =>
    docs.get(id) ?? readSpaceDocument(id);

  // Pass 2: context names (key in a piece's value that points at a child) +
  // base labels (refined by import specifier / context name).
  const nameOf = new Map<string, { owner: string; key: string }>();
  for (const [id, doc] of docs) {
    const c = classifyDocument(doc, { id, readDocument });
    // Only MODERN piece result values carry semantic names as keys (createProfile,
    // profiles, …). A legacy PROCESS cell's top-level keys are control-plane
    // ($TYPE/resultRef/internal/argument) — naming children by those is noise.
    if (
      c.kind === "piece" && c.regime === "modern" && isObjectNotArray(doc.value)
    ) {
      for (const [key, val] of Object.entries(doc.value)) {
        const tid = decodedLinkOf(val)?.id;
        if (tid && !nameOf.has(tid)) nameOf.set(tid, { owner: id, key });
      }
    }
  }
  for (const [id, doc] of docs) {
    const c = classifyDocument(doc, { id, readDocument });
    const spec = importSpecifier(doc.value);
    const named = nameOf.get(id);
    let label = c.label;
    if (spec) label = `import ${spec}`;
    else if (named) label = c.kind === "stream" ? `⊙ ${named.key}` : named.key;
    else if (c.kind === "piece" && c.regime === "legacy") {
      label = legacyName(doc.value, docs) ?? label;
    }
    labelOf.set(id, { kind: c.kind, label });
  }

  const ctx: DetailContext = {
    ownDid,
    labelOf,
    nameOf,
    moduleIndex,
    docs,
    readDocument,
  };

  // Pass 3: per-entity detail + version log, read from the branch that OWNS the
  // entity's visible row. An entity a child branch INHERITED has its writes on
  // the parent, so local-only rows would describe it with no history at all;
  // one the child OVERRODE has a parent log the child's value never came
  // through, and reporting it would credit this entity with revisions no read
  // from here can reach. Both are the same rule — nearest branch wins — which
  // `visibleEntityRows` already resolved, so each row carries its own link.
  const ownerOf = new Map(scanned.map((r) => [r.id, r.link]));
  const versionStmt = space.db.prepare(
    `SELECT r.seq, r.op, c.session_id, c.created_at
     FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
     WHERE r.branch = ? AND r.id = ? AND r.scope_key = ? AND r.seq <= ?
     ORDER BY r.seq ASC, r.op_index ASC`,
  );
  const out: EntityDetail[] = [];
  for (const [id, doc] of docs) {
    const owner = ownerOf.get(id);
    const versions = (owner === undefined ? [] : versionStmt.all<
      { seq: number; op: string; session_id: string; created_at: string }
    >(owner.branch, id, scope, owner.atSeq))
      .map((v) => ({
        seq: v.seq,
        op: v.op,
        session: v.session_id,
        createdAt: v.created_at,
      }));
    out.push(detailFromDoc(id, doc, ctx, versions));
  }

  const order: Record<EntityKind, number> = {
    piece: 0,
    module: 1,
    stream: 2,
    schema: 3,
    "owned-cell": 4,
    "free-cell": 5,
    unknown: 6,
    deleted: 7,
  };
  return {
    details: out.sort(
      (a, b) => order[a.kind] - order[b.kind] || (b.revisions - a.revisions),
    ),
    extent: {
      limit,
      total: rows.length,
      truncated,
      unreadable,
    },
  };
}
