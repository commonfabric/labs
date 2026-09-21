// Scope awareness — the per-identity dimension the runtime composes and this
// tool (until now) ignored.
//
// `revision.scope_key` partitions an entity's rows into scopes that OVERLAP by
// id:
//   space                              shared / default      (PerSpace cells)
//   user:did:key:<DID>                 per-user state        (PerUser cells)
//   session:did:key:<DID>:<uuid>       per-session state     (PerSession cells)
//
// The same cell id can hold a `space` value AND a per-user override, and they
// differ (verified: `space` a link/default; `user` the concrete per-user state,
// e.g. a per-user VDOM).
//
// IMPORTANT — what the runtime actually does vs. what this view approximates.
// The runtime reads ONE declared scope_key at a time (via the engine's
// `resolveScopeKey`), and a narrowed write stores a LINK at the base-scope slot
// pointing at the narrow instance; readers reach the narrow value by FOLLOWING
// that link (see `packages/runner/src/data-updating.ts` / `scope.ts`). There is
// no read-time "fall back from session→user→space". So `valueAsIdentity` below
// is an APPROXIMATION — "the most-specific scope that holds this id" — not the
// runtime's resolution. {@link scopeOverlay} (every scope side-by-side) is the
// honest, runtime-true divergence view; prefer it. Scope-key construction reuses
// the wire-shape module's `resolveScopeKey` — the ONE definition of the
// scope_key format (key-vocabulary.md §3) — so encoding never drifts.

import type { SpaceDb } from "./db.ts";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { hashStringOf } from "@commonfabric/data-model";
import { isDID } from "@commonfabric/identity/did";

import { annotate, summarize } from "./decode.ts";
import {
  branchReadChain,
  type EntityDocument,
  reconstructDocument,
  selectAtPath,
  visibleRevisionRows,
} from "./reconstruct.ts";

export type ScopeKind = "space" | "user" | "session" | "other";

export interface Scope {
  /** The raw scope_key as stored (often %-encoded). */
  raw: string;

  kind: ScopeKind;

  /** Owning principal DID (user/session scopes). */
  principal?: string;

  /** Session uuid (session scopes). */
  sessionId?: string;

  entities: number;
  revisions: number;
}

/** One `:`-separated part of a scope key, percent-decoded when it can be. */
function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Parse a stored scope_key into its kind + principal/session.
 *
 * The engine writes each part percent-encoded (`resolveScopeKey`), which
 * escapes the colons inside a DID and makes the split on `:` exact: a session
 * key is the kind, the principal, and the session id, and nothing else.
 *
 * A key written without that encoding carries no mark of where its principal
 * ends, and the two parts are read as `did:<method>:<id>` followed by the
 * session id. That is the only boundary such a key can be read at, so a
 * principal whose own identifier holds a colon cannot be recovered from one —
 * which is what the encoding exists to prevent.
 *
 * Either way the principal has to come out a DID; anything else is `other`,
 * and counted as no-user.
 */
export function parseScope(raw: string): Scope {
  if (raw === "space") {
    return { raw, kind: "space", entities: 0, revisions: 0 };
  }
  const [kind, ...rest] = raw.split(":");
  if (kind === "session" && rest.length >= 2) {
    const [principal, sessionId] = rest.length === 2
      ? [decodePart(rest[0]), decodePart(rest[1])]
      : [rest.slice(0, 3).join(":"), rest.slice(3).join(":")];
    if (isDID(principal)) {
      return {
        raw,
        kind: "session",
        principal,
        sessionId,
        entities: 0,
        revisions: 0,
      };
    }
  }
  if (kind === "user" && rest.length >= 1) {
    const principal = decodePart(rest.join(":"));
    if (isDID(principal)) {
      return { raw, kind: "user", principal, entities: 0, revisions: 0 };
    }
  }
  return { raw, kind: "other", entities: 0, revisions: 0 };
}

const KIND_ORDER: Record<ScopeKind, number> = {
  space: 0,
  user: 1,
  session: 2,
  other: 3,
};

/**
 * Enumerate the scopes a read on this branch can see, with entity/revision
 * counts.
 *
 * Reads through branch ancestry, because a child branch inherits its parent's
 * per-user and per-session state along with everything else: enumerating only
 * the scopes written ON the branch drops those, and a caller that walks this
 * list to cover "every scope" would cover a subset without knowing. Each
 * (scope, entity) is attributed to the nearest branch holding it, exactly as a
 * read resolves it, so counts describe what is visible from here rather than
 * summing a parent's history into a child's. A space with no child branches
 * has a one-link chain, where this is the query it always was.
 */
export function listScopes(
  space: SpaceDb,
  opts: { branch?: string } = {},
): Scope[] {
  // Counts cover every entity the branch holds records for, tombstoned ones
  // included: a scope is a fact about what the store contains, and one whose
  // entities were all deleted is still a scope that was written to.
  const totals = new Map<string, { entities: number; revisions: number }>();
  for (const row of visibleRevisionRows(space, { branch: opts.branch })) {
    const total = totals.get(row.scope) ?? { entities: 0, revisions: 0 };
    total.entities += 1;
    total.revisions += row.revisions;
    totals.set(row.scope, total);
  }
  return sortedScopes(totals);
}

/**
 * The scopes {@link listScopes} would report, from rows a caller already
 * grouped by scope — the shape `visibleEntityRowsByScope` returns. A caller
 * that needs both the scopes and their rows takes them from one pass this way,
 * rather than walking the branch's revisions a second time, and the two cannot
 * disagree about which scopes exist.
 */
export function scopesOfRows(
  rowsByScope: ReadonlyMap<string, readonly { readonly revisions: number }[]>,
): Scope[] {
  const totals = new Map<string, { entities: number; revisions: number }>();
  for (const [scope, rows] of rowsByScope) {
    let revisions = 0;
    for (const row of rows) revisions += row.revisions;
    totals.set(scope, { entities: rows.length, revisions });
  }
  return sortedScopes(totals);
}

function sortedScopes(
  totals: ReadonlyMap<string, { entities: number; revisions: number }>,
): Scope[] {
  return [...totals.entries()]
    .map(([scope, total]) => ({ ...parseScope(scope), ...total }))
    .sort((a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.revisions - a.revisions
    );
}

/**
 * The most-specific-first chain of stored scope_keys for an identity. With a
 * sessionId: `[session:X:sid, user:X, space]`; without: `[user:X, space]`.
 * Encoding goes through the shared `resolveScopeKey`, so the keys are exactly
 * what the runtime writes (no hand-rolled %-encoding to drift).
 *
 * @throws {Error} When `identity` or a provided `sessionId` is empty.
 */
export function resolveScopeChain(
  identity: string,
  sessionId?: string,
): string[] {
  if (identity.length === 0) {
    throw new Error("`identity` must not be empty.");
  }
  if (sessionId !== undefined && sessionId.length === 0) {
    throw new Error("`sessionId` must not be empty.");
  }
  const chain: string[] = [];
  if (sessionId) {
    chain.push(
      resolveScopeKey("session", { principal: identity, sessionId }),
    );
  }
  chain.push(resolveScopeKey("user", { principal: identity }));
  chain.push(resolveScopeKey("space", {}));
  return chain;
}

export interface IdentityValue {
  exists: boolean;

  /** The scope the value resolved from (the most specific that held the id). */
  resolvedScope?: string;

  resolvedKind?: ScopeKind;
  value?: unknown;

  /** True if a more-general scope ALSO holds this id (i.e. this is an override). */
  overrides?: boolean;

  /** Honest reminder this is an approximation, not the runtime read path. */
  approximation: true;
}

/** An identity view that distinguishes a missing selected path. */
export interface SelectedIdentityValue extends IdentityValue {
  /** Whether the requested path exists within the resolved document. */
  pathExists: boolean;
}

/**
 * Does this scope hold a row for `id` visible at `atSeq`? Bounded by `atSeq`, so
 * a scope whose only row is in the FUTURE (after atSeq) is not treated as
 * present — otherwise a time-travel read picks a future override and reports the
 * entity absent instead of falling through to the value visible at that seq.
 */
function scopeHasEntity(
  space: SpaceDb,
  id: string,
  scope: string,
  branch: string,
  atSeq?: number,
): boolean {
  // Across the chain, since a child branch inherits its parent's rows: the
  // chain's own caps already fold in `atSeq`, so a time-travel read never sees
  // a parent row from after the fork.
  const stmt = space.db.prepare(
    `SELECT 1 AS one FROM revision
     WHERE branch = ? AND id = ? AND scope_key = ? AND seq <= ? LIMIT 1`,
  );
  return branchReadChain(space, branch, atSeq ?? Number.MAX_SAFE_INTEGER)
    .some((link) =>
      !!stmt.get<{ one: number }>(link.branch, id, scope, link.atSeq)
    );
}

/**
 * APPROXIMATE an identity's view of an entity by returning the value from the
 * most-specific scope that holds the id (session ⊕ user ⊕ space). This is NOT
 * the runtime's read resolution (see the file header) — it cannot, from an id
 * alone, know which declared scope a real read would target, nor follow the
 * base-scope link the runtime uses. Use {@link scopeOverlay} for the ground
 * truth. The `approximation` flag is here so callers can't forget that.
 *
 * @throws {Error} When selectors conflict or identity/session values are empty.
 */
export function valueAsIdentity(
  space: SpaceDb,
  opts: {
    id: string;
    identity: string;
    sessionId?: string;
    branch?: string;
    atSeq?: number;

    /** Exact path segments within the resolved value. */
    path?: string[];

    /** Return the resolved document instead of selecting within its value. */
    doc?: boolean;

    /** Maximum depth retained in annotated output. Defaults to eight. */
    annotationDepth?: number;
  },
): SelectedIdentityValue {
  if (opts.doc && opts.path !== undefined) {
    throw new Error("`doc` and `path` cannot be used together.");
  }
  const branch = opts.branch ?? "";
  const chain = resolveScopeChain(opts.identity, opts.sessionId);
  for (let i = 0; i < chain.length; i++) {
    const scope = chain[i];
    if (!scopeHasEntity(space, opts.id, scope, branch, opts.atSeq)) continue;
    let doc: EntityDocument | undefined;
    try {
      doc = reconstructDocument(space, {
        id: opts.id,
        scope,
        branch,
        atSeq: opts.atSeq,
      });
    } catch {
      continue; // a corrupt row in this scope — fall through to a more general one
    }
    const overrides = chain
      .slice(i + 1)
      .some((s) => scopeHasEntity(space, opts.id, s, branch, opts.atSeq));
    const selected = doc === undefined
      ? { found: false, value: undefined }
      : opts.doc
      ? { found: true, value: doc }
      : Object.hasOwn(doc, "value")
      ? selectAtPath(doc.value, opts.path ?? [])
      : { found: false, value: undefined };
    return {
      exists: doc !== undefined,
      resolvedScope: scope,
      resolvedKind: parseScope(scope).kind,
      pathExists: selected.found,
      value: doc === undefined
        ? undefined
        : annotate(selected.value, opts.annotationDepth),
      overrides,
      approximation: true,
    };
  }
  return { exists: false, pathExists: false, approximation: true };
}

export interface Participant {
  /** The identity (user) DID. */
  did: string;

  /** True when this DID owns the space (space DID == did → it's their home). */
  isOwner: boolean;

  /** Commits whose session principal is this DID. */
  commits: number;

  /** Distinct sessions (browser tabs/devices) this DID acted from. */
  sessions: number;

  /** Entities this DID has in a `user:<DID>` scope here. */
  userEntities: number;

  /** Entities this DID has in `session:<DID>:*` scopes here. */
  sessionEntities: number;
}

/**
 * The identities (users) that touched a space: everyone who committed (by
 * session principal) plus everyone with per-user/session scoped state. The
 * "who is in this space" view — each `did` is browsable via
 * {@link describeIdentity} (its home + profiles across the discovered DBs).
 */
export function spaceParticipants(
  space: SpaceDb,
  opts: { branch?: string } = {},
): Participant[] {
  const ownDid = (space.path.split("/").pop() ?? "").replace(/\.sqlite$/, "");
  const acc = new Map<string, Participant>();
  const get = (did: string): Participant => {
    let p = acc.get(did);
    if (!p) {
      p = {
        did,
        isOwner: did === ownDid,
        commits: 0,
        sessions: 0,
        userEntities: 0,
        sessionEntities: 0,
      };
      acc.set(did, p);
    }
    return p;
  };

  // Commits + distinct sessions by principal, read across the branch chain to
  // match the scoped-entity counts below — those come from `listScopes`, which
  // reads through ancestry, so counting only local commits would pair a child
  // branch's inherited entities with none of the principals who wrote them.
  const branch = opts.branch ?? "";
  const perBranch = space.db.prepare(
    `SELECT session_id, count(*) n FROM "commit"
     WHERE branch = ? AND seq <= ? GROUP BY session_id`,
  );
  // Totalled per SESSION before anything is attributed, because the two numbers
  // combine differently across the chain: commits on a parent and on a child
  // are different commits and add up, while one session that wrote on both is
  // still one session. Incrementing per link would count it twice.
  const commitsBySession = new Map<string, number>();
  for (const link of branchReadChain(space, branch)) {
    for (
      const r of perBranch.all<{ session_id: string; n: number }>(
        link.branch,
        link.atSeq,
      )
    ) {
      commitsBySession.set(
        r.session_id,
        (commitsBySession.get(r.session_id) ?? 0) + r.n,
      );
    }
  }
  for (const [sessionId, commits] of commitsBySession) {
    // A commit `session_id` has the same shape as a session scope_key.
    const did = sessionId ? parseScope(sessionId).principal : undefined;
    if (!did) continue;
    const p = get(did);
    p.commits += commits;
    p.sessions += 1;
  }

  // per-user / per-session scoped entities by principal
  for (const sc of listScopes(space, opts)) {
    if (sc.kind === "user" && sc.principal) {
      get(sc.principal).userEntities += sc.entities;
    } else if (sc.kind === "session" && sc.principal) {
      get(sc.principal).sessionEntities += sc.entities;
    }
  }

  return [...acc.values()].sort((a, b) =>
    (b.isOwner ? 1 : 0) - (a.isOwner ? 1 : 0) || b.commits - a.commits
  );
}

export interface ScopeVariant {
  scope: string;
  kind: ScopeKind;
  principal?: string;
  sessionId?: string;
  value: unknown;
  summary: string;
  revisions: number;
}

export interface ScopeOverlay {
  id: string;
  variants: ScopeVariant[];

  /** True when the id appears in >1 scope (a per-identity override exists). */
  overridden: boolean;

  /** True when those scopes hold DIFFERENT values (real divergence). */
  divergent: boolean;
}

/**
 * Every scope an entity appears in, with its value there — the per-user/session
 * divergence table for one id. The multiplayer "who sees what" view.
 */
export function scopeOverlay(
  space: SpaceDb,
  id: string,
  opts: { branch?: string } = {},
): ScopeOverlay {
  const branch = opts.branch ?? "";
  // The scopes this branch holds records for, not only those written on it: an
  // inherited entity's per-user variants live on the parent, and an overlay
  // that missed them would report no divergence where there is some. Tombstoned
  // heads are wanted here too — an entity present in one scope and DELETED in
  // another is a divergence, and `(absent)` below is its own class of one.
  const rows = visibleRevisionRows(space, { branch, id })
    .map((r) => ({ scope_key: r.scope, revs: r.revisions }));
  // Content-key each variant from the RAW reconstructed value (hashStringOf is
  // already fabric-aware and depth-complete). Hashing the *annotated* value
  // would falsely converge — depth-8 truncation collapses values that differ
  // only deep, and BigInt-lowering collapses `10n` with the literal
  // `{$bigint:"10"}`. The divergence verdict must compare what's actually stored.
  const keyed = rows.map((r) => {
    const s = parseScope(r.scope_key);
    let value: unknown;
    let summary: string;
    let key: string;
    try {
      const doc = reconstructDocument(space, {
        id,
        scope: r.scope_key,
        branch,
      });
      value = doc === undefined ? undefined : annotate(doc.value);
      summary = doc === undefined ? "(absent)" : summarize(doc.value);
      // raw value drives the divergence key; "absent" is its own class.
      key = doc === undefined ? "\x00absent" : hashStringOf(doc.value);
    } catch (e) {
      value = undefined;
      summary = `«decode-error: ${(e as Error).message}»`;
      key = `\x00error:${(e as Error).message}`;
    }
    const variant: ScopeVariant = {
      scope: r.scope_key,
      kind: s.kind,
      principal: s.principal,
      sessionId: s.sessionId,
      value,
      summary,
      revisions: r.revs,
    };
    return { variant, key };
  }).sort((a, b) => KIND_ORDER[a.variant.kind] - KIND_ORDER[b.variant.kind]);

  const variants = keyed.map((k) => k.variant);
  const keys = new Set(keyed.map((k) => k.key));
  return {
    id,
    variants,
    overridden: variants.length > 1,
    divergent: keys.size > 1,
  };
}
