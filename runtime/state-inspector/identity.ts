// Identity world — everything about one DID across the multiplayer surface.
//
// An identity (a DID) implicates both SPACES and SCOPES:
//   - spaces: its home (space DID == identity DID), its profile spaces, and the
//     main/pattern spaces it acts in (grouping.ts recovers these).
//   - scopes: within ANY of those spaces, the `user:<DID>` and
//     `session:<DID>:*` rows that identity owns (scopes.ts reads these).
//
// `describeIdentity` joins the two: the DID's spaces, and per space the scopes
// it owns there with counts — the agent's "show me this user's whole world".

import { openSpace, type SpaceDb } from "./db.ts";
import { shortDid } from "./did-display.ts";
import type { DiscoveredSpace } from "./discover.ts";
import {
  groupDiscoveredSpaces,
  type GroupedSpace,
  type SpaceRole,
} from "./grouping.ts";
import { listScopes, type Scope } from "./scopes.ts";

export interface IdentitySpace {
  did: string;
  role: SpaceRole;
  present: boolean;
  empty: boolean;
  commits?: number;
  entities?: number;

  /** Scopes in this space OWNED BY this identity (user:<DID>, session:<DID>:*). */
  ownedScopes: Scope[];

  /** Total per-user + per-session entities this identity has here. */
  scopedEntities: number;

  evidence: string[];
}

export interface IdentityWorld {
  did: string;

  /** A non-empty home space exists locally for this identity. */
  homePresent: boolean;

  spaces: IdentitySpace[];
  totals: {
    spaces: number;
    presentSpaces: number;

    /** Spaces where this identity has per-user/session state. */
    spacesWithScopedState: number;

    scopedEntities: number;
  };
}

/** Scopes whose principal is `did` (the per-user + per-session ones it owns). */
function ownedScopesIn(space: SpaceDb, did: string): Scope[] {
  return listScopes(space).filter((s) =>
    (s.kind === "user" || s.kind === "session") && s.principal === did
  );
}

/**
 * Build the identity world for a DID from a set of discovered spaces: its
 * grouped spaces (home/profiles/mains) plus, per present space, the scopes it
 * owns there. Falls back to scanning all discovered spaces for owned scopes if
 * the DID forms no group (e.g. a profile-only or main-only actor).
 */
export function describeIdentity(
  discovered: DiscoveredSpace[],
  did: string,
  opts: { branch?: string } = {},
): IdentityWorld {
  const { groups } = groupDiscoveredSpaces(discovered, opts);
  const group = groups.find((g) => g.principal === did);

  const byDidPath = new Map(discovered.map((d) => [d.did, d.path]));
  const seen = new Map<string, GroupedSpace>();
  if (group) { for (const s of group.spaces) seen.set(s.did, s); }

  // Also catch present spaces where this DID owns scopes but that aren't in its
  // group (it acted there without being the dominant principal).
  for (const d of discovered) {
    if (seen.has(d.did)) continue;
    let space: SpaceDb | undefined;
    try {
      space = openSpace(d.path);
      if (ownedScopesIn(space, did).length > 0) {
        seen.set(d.did, {
          did: d.did,
          role: "main",
          present: true,
          empty: false,
          evidence: [`owns scopes for ${shortDid(did)} here`],
        });
      }
    } catch {
      /* not a v2 DB */
    } finally {
      space?.close();
    }
  }

  const spaces: IdentitySpace[] = [];
  for (const s of seen.values()) {
    const path = byDidPath.get(s.did);
    let ownedScopes: Scope[] = [];
    if (path && s.present) {
      let space: SpaceDb | undefined;
      try {
        space = openSpace(path);
        ownedScopes = ownedScopesIn(space, did);
      } catch {
        /* ignore */
      } finally {
        space?.close();
      }
    }
    spaces.push({
      did: s.did,
      role: s.role,
      present: s.present,
      empty: s.empty,
      commits: s.commits,
      entities: s.entities,
      ownedScopes,
      scopedEntities: ownedScopes.reduce((n, sc) => n + sc.entities, 0),
      evidence: s.evidence,
    });
  }

  // Order: home, profiles, mains; within, those with scoped state first.
  const rank: Record<SpaceRole, number> = {
    home: 0,
    profile: 1,
    main: 2,
    unknown: 3,
  };
  spaces.sort((a, b) =>
    rank[a.role] - rank[b.role] || b.scopedEntities - a.scopedEntities
  );

  const present = spaces.filter((s) => s.present);
  return {
    did,
    homePresent: !!group?.homePresent,
    spaces,
    totals: {
      spaces: spaces.length,
      presentSpaces: present.length,
      spacesWithScopedState: spaces.filter((s) => s.scopedEntities > 0).length,
      scopedEntities: spaces.reduce((n, s) => n + s.scopedEntities, 0),
    },
  };
}
