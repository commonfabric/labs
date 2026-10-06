import {
  type FabricPlainObject,
  type FabricValue,
  isFabricPlainObject,
} from "@commonfabric/data-model";

// Space grouping — "a user's whole world" from a pile of space DBs.
//
// A user's state is spread across SEVERAL spaces; understanding it means
// grouping them, not inspecting one DB in isolation. We recover the implicated
// group from on-disk signals, each verified against real DBs:
//
//   1. Home `profiles[]`  — a home space holds home-piece instances whose
//      `profiles` cell is an ARRAY of cross-space links { id, space } where each
//      `space` is a PROFILE space DID. This is the home → profiles edge.
//   2. `commit.session_id` = `session:did:key:<DID>:<uuid>` (often %-encoded).
//      The embedded <DID> is the ACTING PRINCIPAL — the owner whose session
//      wrote here. For a home space the principal equals the space's own DID
//      (home DID = user identity DID); for a main/pattern space it points at the
//      owner's (possibly empty/placeholder) home space.
//   3. Cross-space links anywhere — any link whose `space` ≠ self names a
//      related space.
//
// Lifecycle note (verified): creating a space pre-creates EMPTY placeholder
// spaces (e.g. the owner's home), so a referenced space may exist locally with
// zero commits, or not exist locally at all (remote / not-yet-synced). We mark
// both: `empty` (present, 0 commits) and `present:false` (referenced, no local
// DB).

import { openSpace, type SpaceDb } from "./db.ts";
import { linksWithPaths, type LinkWalkBounds } from "./decode.ts";
import { shortDid } from "./did-display.ts";
import { candidatesMatching, reconstructDocument } from "./reconstruct.ts";
import { parseScope } from "./scopes.ts";
import type { DiscoveredSpace } from "./discover.ts";

export type SpaceRole =
  | "home" // user registry: profiles[], favorites, mru, self-model
  | "profile" // a profile space (a target of a home's profiles[])
  | "main" // a pattern/main space (acted on by a principal)
  | "unknown";

export interface SpaceSignals {
  did: string;

  /** A home-piece was found here (result keys include profiles + createProfile). */
  isHome: boolean;

  /** Profile space DIDs from this home's `profiles[]` cells (cross-space links). */
  profileDids: string[];

  /** Session principal DIDs from `commit.session_id` (owners acting here). */
  principals: string[];

  /** Dominant (most frequent) session principal, if any. */
  principal: string | null;

  /** All cross-space link target space DIDs (space ≠ self). */
  crossSpaceDids: string[];

  commits: number;
  entities: number;
}

/**
 * How far the space-signal walks reach. A signal here is "which other spaces
 * does this one name", and the answer is a claim about a whole space, so the
 * walk wants every link a document holds — twelve levels of nesting reaches
 * past any value this tool has met.
 *
 * `maxNodes` is unbounded because `SpaceSignals` carries no field saying its
 * DID lists are partial, and a space silently missing from the group is worse
 * than a walk that does not stop early. Giving it a finite value belongs with
 * giving `SpaceSignals` that field.
 */
const SPACE_SIGNAL_WALK: LinkWalkBounds = {
  maxDepth: 12,
  maxNodes: Number.POSITIVE_INFINITY,
};

/** The acting-principal DID embedded in a `session_id`, if present. */
export function principalFromSession(sessionId: string): string | null {
  const scope = parseScope(sessionId);
  return scope.kind === "session" ? scope.principal ?? null : null;
}

/** A space DB's own DID, from its file path (basename minus `.sqlite`). */
function didFromPath(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.sqlite$/, "");
}

/** A home piece's result value carries both `profiles` and `createProfile`. */
function isHomeResultValue(v: FabricValue): v is FabricPlainObject {
  return isFabricPlainObject(v) &&
    "profiles" in v && "createProfile" in v;
}

/**
 * Read the grouping signals from a single space DB. Cheap by design: it never
 * does a full reconstruction pass — it targets home pieces and cross-space
 * carriers with `data LIKE` candidate queries, then reconstructs only those.
 */
export function analyzeSpaceSignals(
  space: SpaceDb,
  opts: { branch?: string; scope?: string } = {},
): SpaceSignals {
  const branch = opts.branch ?? "";
  const scope = opts.scope ?? "space";
  const own = didFromPath(space.path);

  const agg = space.db
    .prepare(
      `SELECT (SELECT count(*) FROM "commit") commits,
              (SELECT count(DISTINCT id) FROM revision) entities`,
    )
    .get<{ commits: number; entities: number }>();

  // Session principals (owners who wrote here)
  const principalCounts = new Map<string, number>();
  for (
    const r of space.db
      .prepare(
        `SELECT session_id, count(*) n FROM "commit" GROUP BY session_id`,
      )
      .all<{ session_id: string; n: number }>()
  ) {
    const p = r.session_id ? principalFromSession(r.session_id) : null;
    if (p) principalCounts.set(p, (principalCounts.get(p) ?? 0) + r.n);
  }
  const principals = [...principalCounts.keys()];
  let principal: string | null = null;
  let best = -1;
  for (const [p, n] of principalCounts) {
    if (n > best) {
      best = n;
      principal = p;
    }
  }

  // Home detection + profiles[] edges
  let isHome = false;
  const profileDids = new Set<string>();
  const homeCandidates = candidatesMatching(space, {
    branch,
    scope,
    like: ["%createProfile%", '%"profiles"%'],
  });
  for (const id of homeCandidates) {
    let doc;
    try {
      doc = reconstructDocument(space, { id, branch, scope });
    } catch {
      continue;
    }
    const value = doc?.value;
    if (!isHomeResultValue(value)) continue;
    isHome = true;
    // `profiles` is a link to the profiles cell; follow it and read the array.
    const profilesField = value.profiles;
    const link = linksWithPaths(profilesField, SPACE_SIGNAL_WALK)
      .links[0]?.link;
    if (!link?.id) continue;
    let pdoc;
    try {
      pdoc = reconstructDocument(space, { id: link.id, branch, scope });
    } catch {
      continue;
    }
    for (
      const { link: l } of linksWithPaths(pdoc?.value, SPACE_SIGNAL_WALK).links
    ) {
      if (l.space && l.space !== own) profileDids.add(l.space);
    }
  }

  // All cross-space link targets (cheap candidate query)
  const crossSpaceDids = new Set<string>();
  for (
    const id of candidatesMatching(space, {
      branch,
      scope,
      like: ['%"space":"did:key:%'],
    })
  ) {
    let doc;
    try {
      doc = reconstructDocument(space, { id, branch, scope });
    } catch {
      continue;
    }
    for (const { link: l } of linksWithPaths(doc, SPACE_SIGNAL_WALK).links) {
      if (l.space && l.space !== own) crossSpaceDids.add(l.space);
    }
  }

  return {
    did: own,
    isHome,
    profileDids: [...profileDids],
    principals,
    principal,
    crossSpaceDids: [...crossSpaceDids],
    commits: agg?.commits ?? 0,
    entities: agg?.entities ?? 0,
  };
}

export interface GroupedSpace {
  did: string;
  role: SpaceRole;

  /** A local DB file was found for this DID. */
  present: boolean;

  /** Present but with zero commits — a pre-created placeholder. */
  empty: boolean;

  commits?: number;
  entities?: number;

  /** Why this space is in the group / has this role. */
  evidence: string[];
}

export interface SpaceGroup {
  /** The owner principal / home DID this group centers on. */
  principal: string;

  /** A non-empty home space was found locally for the principal. */
  homePresent: boolean;

  spaces: GroupedSpace[];
}

export interface GroupingResult {
  groups: SpaceGroup[];

  /** Discovered spaces not attachable to any principal. */
  ungrouped: GroupedSpace[];
}

interface Analyzed {
  disc: DiscoveredSpace;
  sig: SpaceSignals;
}

/**
 * Group discovered space DBs into per-user worlds. Centers each group on a
 * principal DID (the owner's home) and attaches its home, profile, and main
 * spaces, plus placeholder nodes for referenced-but-absent spaces.
 */
export function groupDiscoveredSpaces(
  discovered: DiscoveredSpace[],
  opts: { branch?: string; scope?: string } = {},
): GroupingResult {
  const analyzed: Analyzed[] = [];
  for (const disc of discovered) {
    let space: SpaceDb | undefined;
    try {
      space = openSpace(disc.path);
      analyzed.push({ disc, sig: analyzeSpaceSignals(space, opts) });
    } catch {
      // not a readable v2 space DB — skip
    } finally {
      space?.close();
    }
  }

  const byDid = new Map<string, Analyzed>();
  for (const a of analyzed) byDid.set(a.sig.did, a);

  // Each space's owning principal: a home owns itself; everything else is owned
  // by its dominant session principal (falling back to its own DID).
  const principalOf = (a: Analyzed): string =>
    a.sig.isHome ? a.sig.did : (a.sig.principal ?? a.sig.did);

  // profileDid -> the home DID that lists it (for role + evidence).
  const profileOwner = new Map<string, string>();
  for (const a of analyzed) {
    if (a.sig.isHome) {
      for (const pd of a.sig.profileDids) profileOwner.set(pd, a.sig.did);
    }
  }

  // Collect every principal DID we should form a group around: every owner of a
  // present space, plus every home referenced as a profile-owner or session
  // principal even if its DB is absent.
  const principals = new Set<string>();
  for (const a of analyzed) principals.add(principalOf(a));
  for (const owner of profileOwner.values()) principals.add(owner);

  const roleOf = (did: string): { role: SpaceRole; evidence: string[] } => {
    const ev: string[] = [];
    const a = byDid.get(did);
    if (profileOwner.has(did)) {
      ev.push(`listed in profiles[] of ${shortDid(profileOwner.get(did)!)}`);
      return { role: "profile", evidence: ev };
    }
    if (a?.sig.isHome) {
      ev.push("home pieces (profiles + createProfile)");
      return { role: "home", evidence: ev };
    }
    if (a) {
      if (a.sig.principal) {
        ev.push(`written by principal ${shortDid(a.sig.principal)}`);
      }
      return { role: "main", evidence: ev };
    }
    return { role: "unknown", evidence: ev };
  };

  const nodeFor = (did: string, extraEvidence: string[] = []): GroupedSpace => {
    const a = byDid.get(did);
    const { role, evidence } = roleOf(did);
    return {
      did,
      role: a ? role : (profileOwner.has(did) ? "profile" : role),
      present: !!a,
      empty: !!a && a.sig.commits === 0,
      commits: a?.sig.commits,
      entities: a?.sig.entities,
      evidence: [...evidence, ...extraEvidence],
    };
  };

  const claimed = new Set<string>();
  const groups: SpaceGroup[] = [];
  for (const principal of principals) {
    const members = new Set<string>();
    members.add(principal); // the home (may be absent/empty)
    const homeAnalyzed = byDid.get(principal);
    // Spaces this principal acts on / owns.
    for (const a of analyzed) {
      if (principalOf(a) === principal) members.add(a.sig.did);
    }
    // The home's profile spaces.
    if (homeAnalyzed?.sig.isHome) {
      for (const pd of homeAnalyzed.sig.profileDids) members.add(pd);
    }
    // Spaces the home references via cross-space links but that aren't in
    // profiles[] — shown as related nodes (present:false if absent locally),
    // not silently omitted.
    if (homeAnalyzed) {
      for (const cd of homeAnalyzed.sig.crossSpaceDids) members.add(cd);
    }
    // A group of just an absent principal with nothing attached is noise.
    const presentMembers = [...members].filter((d) => byDid.has(d));
    if (presentMembers.length === 0) continue;

    const spaces: GroupedSpace[] = [...members].map((did) => {
      const extra: string[] = [];
      if (did === principal) extra.push("group principal (owner home)");
      return nodeFor(did, extra);
    });
    spaces.sort((x, y) => roleRank(x.role) - roleRank(y.role));
    for (const d of members) claimed.add(d);
    groups.push({
      principal,
      homePresent: !!homeAnalyzed?.sig.isHome &&
        (homeAnalyzed?.sig.commits ?? 0) > 0,
      spaces,
    });
  }

  groups.sort((a, b) => b.spaces.length - a.spaces.length);

  const ungrouped: GroupedSpace[] = analyzed
    .filter((a) => !claimed.has(a.sig.did))
    .map((a) => nodeFor(a.sig.did));

  return { groups, ungrouped };
}

function roleRank(r: SpaceRole): number {
  return r === "home" ? 0 : r === "profile" ? 1 : r === "main" ? 2 : 3;
}
