// Cross-space convergence diagnosis — the multiplayer-native autopsy primitive.
//
// The same entity id can appear in several spaces for TWO very different reasons,
// and telling them apart is the whole game:
//
//  1. Cross-space replica — a link in space A points to `space B / entity X`, so
//     A materializes a replica of B's X. These SHOULD converge; divergence is a
//     real drift bug.
//  2. Same-pattern instance — every space independently instantiates the same
//     pattern (e.g. home.tsx), so its program/result entity shares a content-
//     addressed id across spaces by coincidence of code. These legitimately
//     diverge; same-id divergence here is expected, not a bug.
//
// `convergence()` compares an entity's value across N spaces and clusters it. The
// link index (`buildCrossSpaceLinkIndex`) then classifies each divergence:
// `cross-space-linked` (case 1 — real drift) vs `no-cross-space-link` (case 2 —
// likely independent instances). NOTE: real dev DBs frequently contain ZERO
// cross-space links, in which case every same-id divergence is correctly labeled
// `no-cross-space-link` — the classifier exists to stop false alarms now and to
// catch real drift the moment cross-space replicas appear.
//
// HONESTY (server-view only): this sees durable committed state, not client
// state. A "converged" verdict means the stored values agree — NOT that every
// client is displaying them. Client cursor lag, pending optimistic writes, and
// render/VDOM state require the (future) client-correlation overlay. Likewise
// `seq` is per-space and is NOT comparable across spaces; divergence is judged
// by value equality, with per-space write metadata offered as evidence.

import { type FabricValue, hashStringOf } from "@commonfabric/data-model";

import { openSpace, type SpaceDb } from "./db.ts";
import { annotate, linksWithPaths, type LinkWalkBounds } from "./decode.ts";
import {
  candidatesMatching,
  getValueAt,
  owningLink,
  reconstructDocument,
  visibleRevisionRows,
} from "./reconstruct.ts";

export interface SpaceRef {
  /** Display label — usually the space DID (DB file basename). */
  label: string;

  space: SpaceDb;
}

export interface SpaceEntityView {
  label: string;
  present: boolean;
  headSeq: number | null;
  revisions: number;
  lastSession: string | null;
  lastWriteAt: string | null;

  /** Annotated value at the requested path (links/streams normalized). */
  value?: unknown;

  /** Whether the requested path exists within a present entity. */
  pathExists?: boolean;

  /** Canonical key used for clustering equal values. */
  valueKey?: string;

  /** Set if reconstruction/decode threw for this space (entity still counts as present). */
  error?: string;
}

export type ConvergenceVerdict =
  | "converged"
  | "diverged"
  | "partial"
  | "absent";

/** A verdict that also represents values which could not be reconstructed. */
export type ExactConvergenceVerdict = ConvergenceVerdict | "unknown";

export interface ValueCluster {
  valueKey: string;
  value: unknown;
  labels: string[];

  /** Whether this cluster represents values found at the requested path. */
  pathExists?: boolean;
}

export type ConvergenceRelationship =
  | "cross-space-linked" // a space links to this entity@another-space → real replica drift
  | "no-cross-space-link" // shared id, no cross-space link → likely independent instances
  | "n/a"; // converged, absent, or unknown — relationship not meaningful

export interface ConvergenceResult {
  id: string;
  scope: string;
  branch: string;
  path: string[];
  verdict: ConvergenceVerdict;
  views: SpaceEntityView[];
  clusters: ValueCluster[];
  caveat: string;

  /** Set when a link index is supplied — distinguishes drift from instances. */
  relationship?: ConvergenceRelationship;
}

/** A convergence result that distinguishes unavailable values. */
export interface ExactConvergenceResult
  extends Omit<ConvergenceResult, "verdict"> {
  verdict: ExactConvergenceVerdict;
}

export interface CrossSpaceEdge {
  fromSpace: string;
  fromEntity: string;
  toSpace: string;
  toId: string;
}

export interface CrossSpaceLinkIndex {
  edges: CrossSpaceEdge[];

  /** `${toSpace} ${toId}` for every entity referenced cross-space. */
  targets: Set<string>;

  examinedEntities: number;
}

/** Recover a space's own DID from its DB-file label (basename minus `.sqlite`). */
export function spaceDidFromLabel(label: string): string {
  return label.endsWith(".sqlite") ? label.slice(0, -".sqlite".length) : label;
}

const CAVEAT =
  "Server-view only: durable values compared. Client cursor lag, pending " +
  "optimistic writes, and render state are not visible here — 'converged' " +
  "means the stored values agree, not that every client is displaying them.";

/**
 * Canonical content key for cross-space clustering. Reuses the data-model's
 * fabric-aware `hashStringOf` (key-order-insensitive, and correct for
 * BigInt/`FabricInstance`s) instead of a hand-rolled sorted `JSON.stringify`,
 * which throws on BigInt and erases the fabric type — a value-model fork the
 * convergence verdict must not depend on.
 */
function canonical(v: FabricValue): string {
  return v === undefined ? "undefined" : hashStringOf(v);
}

const MISSING_PATH_KEY = "«missing-path»";
const MISSING_PATH_VALUE = Object.freeze({ $missing: true } as const);
const DECODE_ERROR_KEY = "«decode-error»";

interface MetaRow {
  headSeq: number | null;
  revisions: number;
}
interface LastRow {
  session_id: string;
  created_at: string;
}

function entityMeta(
  space: SpaceDb,
  id: string,
  scope: string,
  branch: string,
): SpaceEntityView {
  // Resolved through the OWNING branch, like every other surface describing one
  // entity. `present` gates the value read below, so a branch-local count marks
  // an inherited entity absent before reconstruction runs — and then the scan
  // reports it as held by nobody and suppresses the divergence it exists to
  // find.
  const owner = owningLink(space, { branch, scope, id });
  const meta = owner === undefined ? undefined : space.db
    .prepare(
      `SELECT max(seq) headSeq, count(*) revisions FROM revision
       WHERE branch = ? AND id = ? AND scope_key = ? AND seq <= ?`,
    )
    .get<MetaRow>(owner.branch, id, scope, owner.atSeq);
  const present = !!meta && meta.revisions > 0;
  if (!present) {
    return {
      label: "",
      present: false,
      headSeq: null,
      revisions: 0,
      lastSession: null,
      lastWriteAt: null,
    };
  }
  const last = space.db
    .prepare(
      `SELECT c.session_id, c.created_at FROM revision r
       JOIN "commit" c ON c.seq = r.commit_seq
       WHERE r.branch = ? AND r.id = ? AND r.scope_key = ? AND r.seq <= ?
       ORDER BY r.seq DESC, r.op_index DESC LIMIT 1`,
    )
    .get<LastRow>(owner!.branch, id, scope, owner!.atSeq);
  return {
    label: "",
    present: true,
    headSeq: meta!.headSeq,
    revisions: meta!.revisions,
    lastSession: last?.session_id ?? null,
    lastWriteAt: last?.created_at ?? null,
  };
}

export interface ConvergenceOptions {
  id: string;
  scope?: string;
  branch?: string;
  path?: string[];
}

/** Compare one entity and report unavailable values as an exact verdict. */
export function convergenceExact(
  spaces: SpaceRef[],
  opts: ConvergenceOptions,
  index?: CrossSpaceLinkIndex,
): ExactConvergenceResult {
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const path = opts.path ?? [];

  const views: SpaceEntityView[] = spaces.map(({ label, space }) => {
    const view = entityMeta(space, opts.id, scope, branch);
    view.label = label;
    if (view.present) {
      // Decode can throw (e.g. an encoded payload referencing a live cell).
      // Keep the entity counted as present and expose the unavailable view.
      try {
        const res = getValueAt(space, { id: opts.id, scope, branch }, path);
        if (!res.exists) {
          // Revisions exist but the entity is tombstoned (deleted) at head — it
          // has no current value, so don't cluster it with live values as if it
          // converged. Treat it as absent for the verdict.
          view.present = false;
        } else {
          // Cluster on the RAW value (depth-complete, fabric-aware). Annotate is
          // for DISPLAY only — hashing it would falsely converge values that
          // differ below the annotate depth cap or only by BigInt vs its tag.
          view.pathExists = res.pathExists;
          view.value = res.pathExists
            ? annotate(res.value)
            : MISSING_PATH_VALUE;
          view.valueKey = res.pathExists
            ? canonical(res.value)
            : MISSING_PATH_KEY;
        }
      } catch (e) {
        view.error = (e as Error).message;
      }
    }
    return view;
  });

  const present = views.filter((v) => v.present);
  const available = present.filter((view) => view.error === undefined);
  const clusterMap = new Map<string, ValueCluster>();
  for (const v of available) {
    const key = v.valueKey!;
    const c = clusterMap.get(key);
    if (c) c.labels.push(v.label);
    else {
      clusterMap.set(key, {
        valueKey: key,
        value: v.value,
        labels: [v.label],
        pathExists: v.pathExists,
      });
    }
  }
  const clusters = [...clusterMap.values()];

  let verdict: ExactConvergenceVerdict;
  if (present.some((view) => view.error !== undefined)) verdict = "unknown";
  else if (present.length === 0) verdict = "absent";
  else if (clusters.length > 1) verdict = "diverged";
  else if (present.length < views.length) verdict = "partial";
  else verdict = "converged";

  const result: ExactConvergenceResult = {
    id: opts.id,
    scope,
    branch,
    path,
    verdict,
    views,
    clusters,
    caveat: CAVEAT,
  };
  if (index) result.relationship = classifyRelationship(result, index);
  return result;
}

/** Compare one entity using the published convergence verdicts. */
export function convergence(
  spaces: SpaceRef[],
  opts: ConvergenceOptions,
  index?: CrossSpaceLinkIndex,
): ConvergenceResult {
  const exact = convergenceExact(spaces, opts);
  const views = exact.views.map((view) =>
    view.error === undefined ? view : { ...view, valueKey: DECODE_ERROR_KEY }
  );
  const present = views.filter((view) => view.present);
  const clusterMap = new Map<string, ValueCluster>();
  for (const view of present) {
    const valueKey = view.valueKey!;
    const cluster = clusterMap.get(valueKey);
    if (cluster) {
      cluster.labels.push(view.label);
    } else {
      clusterMap.set(valueKey, {
        valueKey,
        value: view.error === undefined ? view.value : undefined,
        labels: [view.label],
        pathExists: view.error === undefined ? view.pathExists : undefined,
      });
    }
  }
  const clusters = [...clusterMap.values()];
  let verdict: ConvergenceVerdict;
  if (present.length === 0) verdict = "absent";
  else if (clusters.length > 1) verdict = "diverged";
  else if (present.length < views.length) verdict = "partial";
  else verdict = "converged";

  const result: ConvergenceResult = {
    ...exact,
    verdict,
    views,
    clusters,
  };
  if (index) result.relationship = classifyRelationship(result, index);
  return result;
}

/**
 * How far the cross-space index's link walk reaches. The index's answer is
 * which entities in one space name another, and a link it misses is an edge
 * the index reports as absent, so the walk wants every link a document holds
 * — twelve levels of nesting reaches past any value this tool has met.
 *
 * `maxNodes` is unbounded because `CrossSpaceLinkIndex` counts the entities it
 * examined but carries no field saying an entity was examined only in part,
 * and an edge silently missing from the index is worse than a walk that does
 * not stop early. Giving it a finite value belongs with giving the index that
 * field.
 */
const CROSS_SPACE_LINK_WALK: LinkWalkBounds = {
  maxDepth: 12,
  maxNodes: Number.POSITIVE_INFINITY,
};

/**
 * Build a cross-space link index over the given spaces: every link whose `space`
 * field names a DIFFERENT space than the one holding it. Only entities whose
 * stored data carries an explicit `"space":"did:key:` are reconstructed, which
 * keeps the index cheap (most links omit `space` = same-space and can't be
 * cross-space). Decode failures on individual entities are skipped, not fatal.
 */
export function buildCrossSpaceLinkIndex(
  spaces: SpaceRef[],
  opts: { scope?: string; branch?: string } = {},
): CrossSpaceLinkIndex {
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const edges: CrossSpaceEdge[] = [];
  const targets = new Set<string>();
  let examinedEntities = 0;

  for (const { label, space } of spaces) {
    const ownDid = spaceDidFromLabel(label);
    // Candidates across every branch the read can reach: a child branch
    // inherits its parent's link holders, and an index built from local rows
    // only would drop their targets' `cross-space-linked` classification while
    // the scan beside it still finds those targets.
    const candidates = candidatesMatching(space, {
      branch,
      scope,
      like: ['%"space":"did:key:%'],
    });
    for (const id of candidates) {
      examinedEntities++;
      let doc: unknown;
      try {
        doc = reconstructDocument(space, { id, scope, branch });
      } catch {
        continue;
      }
      for (
        const { link } of linksWithPaths(doc, CROSS_SPACE_LINK_WALK).links
      ) {
        if (link.id && link.space && link.space !== ownDid) {
          edges.push({
            fromSpace: ownDid,
            fromEntity: id,
            toSpace: link.space,
            toId: link.id,
          });
          targets.add(`${link.space} ${link.id}`);
        }
      }
    }
  }
  return { edges, targets, examinedEntities };
}

/** Label a divergence as real replica drift vs. likely independent instances. */
export function classifyRelationship(
  result: ConvergenceResult | ExactConvergenceResult,
  index: CrossSpaceLinkIndex,
): ConvergenceRelationship {
  if (
    result.verdict === "converged" || result.verdict === "absent" ||
    result.verdict === "unknown"
  ) {
    return "n/a";
  }
  // A cross-space link to (space, id) makes the relationship a replica link
  // whether or not the TARGET space currently holds the entity — a missing or
  // tombstoned replica is still cross-space-linked, not an independent instance.
  const linked = result.views.some(
    (v) => index.targets.has(`${spaceDidFromLabel(v.label)} ${result.id}`),
  );
  return linked ? "cross-space-linked" : "no-cross-space-link";
}

export interface ScanOptions {
  scope?: string;
  branch?: string;

  /** Max diverged, partial, or unknown findings to return. */
  limit?: number;

  /** Max shared entities to reconstruct (cost guard). */
  examineCap?: number;

  /** Build the cross-space link index to classify findings (default true). */
  linkIndex?: boolean;
}

export interface ScanResult {
  /** Entity ids present in >= 2 spaces. */
  sharedEntities: number;

  examined: number;
  examineCapped: boolean;

  /** Cross-space link edges found across all spaces (0 ⇒ no replica relationships). */
  crossSpaceLinkEdges: number;

  /** Findings labeled cross-space-linked (real replica drift). */
  linkedFindings: number;

  /** Findings labeled no-cross-space-link (likely independent instances). */
  unlinkedFindings: number;

  findings: ConvergenceResult[];
}

/** A scan result that distinguishes unavailable values from known findings. */
export interface ExactScanResult extends Omit<ScanResult, "findings"> {
  /** Findings whose values could not all be reconstructed. */
  unknownFindings: number;

  findings: ExactConvergenceResult[];
}

/** Find shared entities with values that differ, are missing, or are unavailable. */
export function convergenceScanExact(
  spaces: SpaceRef[],
  opts: ScanOptions = {},
): ExactScanResult {
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const limit = opts.limit ?? 50;
  const examineCap = opts.examineCap ?? 1000;

  const index = opts.linkIndex === false
    ? undefined
    : buildCrossSpaceLinkIndex(spaces, { scope, branch });

  // id -> how many spaces hold it
  const counts = new Map<string, number>();
  for (const { space } of spaces) {
    // Entities each space can SEE on this branch, ancestry included: a
    // convergence scan that enumerated only local rows would silently skip
    // entities both spaces read fine, and report agreement it never checked.
    for (const { id } of visibleRevisionRows(space, { branch, scope })) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const shared = [...counts.entries()].filter(([, n]) => n >= 2).map(([id]) =>
    id
  );

  const findings: ExactConvergenceResult[] = [];
  let examined = 0;
  for (const id of shared) {
    if (examined >= examineCap) break;
    examined++;
    const result = convergenceExact(spaces, { id, scope, branch }, index);
    if (
      result.verdict === "diverged" || result.verdict === "partial" ||
      result.verdict === "unknown"
    ) {
      findings.push(result);
      if (findings.length >= limit) break;
    }
  }

  const linkedFindings =
    findings.filter((f) => f.relationship === "cross-space-linked").length;
  const unlinkedFindings =
    findings.filter((f) => f.relationship === "no-cross-space-link").length;
  const unknownFindings =
    findings.filter((f) => f.verdict === "unknown").length;
  return {
    sharedEntities: shared.length,
    examined,
    examineCapped: examined >= examineCap && shared.length > examineCap,
    crossSpaceLinkEdges: index?.edges.length ?? 0,
    linkedFindings,
    unlinkedFindings,
    unknownFindings,
    findings,
  };
}

/** Find shared entities using the published convergence verdicts. */
export function convergenceScan(
  spaces: SpaceRef[],
  opts: ScanOptions = {},
): ScanResult {
  const scope = opts.scope ?? "space";
  const branch = opts.branch ?? "";
  const limit = opts.limit ?? 50;
  const examineCap = opts.examineCap ?? 1000;

  const index = opts.linkIndex === false
    ? undefined
    : buildCrossSpaceLinkIndex(spaces, { scope, branch });
  const counts = new Map<string, number>();
  for (const { space } of spaces) {
    // Entities each space can SEE on this branch, ancestry included: a
    // convergence scan that enumerated only local rows would silently skip
    // entities both spaces read fine, and report agreement it never checked.
    for (const { id } of visibleRevisionRows(space, { branch, scope })) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const shared = [...counts.entries()].filter(([, count]) => count >= 2).map(
    ([id]) => id,
  );

  const findings: ConvergenceResult[] = [];
  let examined = 0;
  for (const id of shared) {
    if (examined >= examineCap) break;
    examined++;
    const result = convergence(spaces, { id, scope, branch }, index);
    if (result.verdict === "diverged" || result.verdict === "partial") {
      findings.push(result);
      if (findings.length >= limit) break;
    }
  }

  const linkedFindings =
    findings.filter((finding) => finding.relationship === "cross-space-linked")
      .length;
  const unlinkedFindings =
    findings.filter((finding) => finding.relationship === "no-cross-space-link")
      .length;
  return {
    sharedEntities: shared.length,
    examined,
    examineCapped: examined >= examineCap && shared.length > examineCap,
    crossSpaceLinkEdges: index?.edges.length ?? 0,
    linkedFindings,
    unlinkedFindings,
    findings,
  };
}

/** Open spaces from explicit file paths, labeling each by its basename. */
export function openSpaces(paths: string[]): SpaceRef[] {
  return paths.map((p) => ({
    label: p.split("/").pop() ?? p,
    space: openSpace(p),
  }));
}

/** List `*.sqlite` files in a directory (non-recursive). */
export function listSqliteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.isFile && entry.name.endsWith(".sqlite")) {
      out.push(`${dir}/${entry.name}`);
    }
  }
  return out.sort();
}
