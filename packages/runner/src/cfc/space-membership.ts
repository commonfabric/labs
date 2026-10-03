import {
  type ACL,
  aclDocId,
  ANYONE_USER,
  type Capability,
  hasConcreteOwner,
  isACL,
  isCapable,
} from "@commonfabric/memory/acl";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { Cancel } from "../cancel.ts";
import { type Cell, cellDocumentHeld } from "../cell.ts";
import type { Runtime } from "../runtime.ts";

/**
 * §4.9.3 render membership lookup (design:
 * docs/history/specs/cfc-render-membership-lookup.md). The verified source of the
 * `HasRole(actingUser, space, reader)` facts the render ceiling mints to admit
 * a cross-space `Space(...)` label — sourced from the space's declared ACL
 * document, NEVER from a cell's mere local residency (residency is not read
 * authority; H3b commit 4fc05f800).
 */

/** A principal's role in a space, or `null` if none (fail closed). */
export type SpaceRole = "owner" | "writer" | "reader";

const capToRole: Record<Capability, SpaceRole> = {
  READ: "reader",
  WRITE: "writer",
  OWNER: "owner",
};

/**
 * A principal's reader-or-higher role in a space, or `null` when it holds
 * none. This uses the same valid-ACL resolution as the memory server, but is
 * deliberately stricter for an absent ACL: the synchronous render path cannot
 * distinguish "confirmed absent" from "not synced yet", so absence supplies no
 * positive membership evidence even though the transport temporarily treats a
 * populated ACL-less space as public.
 *
 * Resolution order:
 *  1. Implicit `OWNER` when `principal` is a configured service DID, which
 *     holds regardless of ACL contents or deployment ACL mode.
 *  2. Otherwise the ACL document decides: `acl[principal] ?? acl["*"]`. A
 *     missing/malformed/ownerless ACL, an unlisted principal with no `"*"`
 *     grant, or a capability short of READ all yield `null` (fail closed).
 *     A space's own DID is no exception: a Home space's user is its owner
 *     through the OWNER entry its ACL names, so a Home that has no ACL
 *     document yet yields `null` for its own user too.
 *
 * `acl` is the space's ACL doc value (`undefined` = not yet read / absent):
 * both `undefined` and a malformed value fail closed. A returned role is
 * always reader-or-higher — every `Capability` is `isCapable(_, "READ")`, so
 * any explicit grant admits reader access; the exact rank is returned for
 * callers that need it, but the render mint only needs non-`null`.
 */
export const spaceReaderRole = (
  acl: ACL | undefined,
  principal: string,
  serviceDids: readonly string[] = [],
): SpaceRole | null => {
  // Implicit OWNER: service principals.
  if (serviceDids.includes(principal)) return "owner";
  // Missing, malformed, or ownerless ACL grants no membership evidence.
  if (!isACL(acl) || !hasConcreteOwner(acl)) return null;
  const byPrincipal = acl as Record<string, Capability | undefined>;
  const cap = byPrincipal[principal] ?? byPrincipal[ANYONE_USER];
  // `undefined` = principal not listed and no `"*"` grant. The `isCapable`
  // mirror of the server's requirement check is folded in: a valid `Capability`
  // is only ever READ/WRITE/OWNER and each clears READ (WRITE/OWNER imply READ),
  // so it is vacuously true here, but kept so the client cannot drift from the
  // server if READ's rank ever changes.
  if (cap === undefined || !isCapable(cap, "READ")) return null;
  return capToRole[cap];
};

/**
 * A synchronous membership oracle for the render fit (which runs inside a
 * `cell.sink` callback and cannot await). `readerRole` gives a sync snapshot
 * from the local replica; `subscribe` lets a gated render re-evaluate when a
 * space's ACL later syncs or changes (Stage 2 reactive upgrade, §3.4).
 */
export interface SpaceMembershipProvider {
  /**
   * The acting principal's reader-or-higher role in `space` from the local
   * replica, or `null` when unknown/not-a-member (both fail closed). Reads the
   * space's ACL doc synchronously and — when it is not yet synced — kicks a
   * background sync, so a later reactive tick (see `subscribe`) can upgrade an
   * over-block to an admit.
   */
  readerRole(space: string): SpaceRole | null;

  /**
   * Subscribe to a space's ACL doc; `onChange` fires when it later syncs or
   * changes — NOT synchronously at subscribe time (the initial snapshot is
   * `readerRole`'s job). Returns a cancel. Used by the reconciler to re-render
   * a gated `Space(...)`-labeled cell within its existing cancel group (§3.4
   * Stage 2), so a fail-closed over-block upgrades to an admit when the ACL
   * arrives (and a revoke re-blocks).
   */
  subscribe(space: string, onChange: () => void): Cancel;

  /**
   * Whether the local replica holds `space`'s ACL doc, or its confirmed
   * absence, so that `readerRole` answers from what the ACL says rather than
   * from its not having loaded yet. A provider that cannot say leaves it out.
   */
  held?(space: string): boolean;

  /**
   * Resolves once the local replica holds `space`'s ACL doc, or its confirmed
   * absence. A decision made once and not again, which no `subscribe` will
   * make again, waits on this before it is made on an ACL that has not loaded.
   */
  whenHeld?(space: string): Promise<void>;
}

/**
 * The cell whose value is the space's ACL document — entity id
 * `aclDocId(space)`, read in-space (the same id `ACLManager` and the server
 * resolve through that shared helper). One Cell
 * per space, reused across `readerRole` reads and `subscribe` so both observe
 * the same reactive state.
 */
const aclCellFor = (
  runtime: Pick<Runtime, "getCellFromLink">,
  cache: Map<string, Cell<unknown>>,
  space: string,
): Cell<unknown> => {
  let cell = cache.get(space);
  if (cell === undefined) {
    // Read in-space — the same link `ACLManager` uses.
    cell = runtime.getCellFromLink<unknown>({
      id: aclDocId(space) as URI,
      path: [],
      space: space as MemorySpace,
    });
    cache.set(space, cell);
  }
  return cell;
};

/**
 * A runtime-backed {@link SpaceMembershipProvider}: `readerRole` reads each
 * space's ACL doc from the local replica via `Cell.get()` (sync value + a
 * background-sync kick when unsynced) and runs {@link spaceReaderRole}.
 *
 * Deliberately NOT memoized: the ACL is the authority record, and a stale memo
 * would keep admitting a `Space(...)` clause after a revoke (unsound) — so each
 * call reflects the latest replica. `Cell.get()`'s per-transaction read cache
 * already amortizes repeated reads within a single synchronous render pass, so
 * a fresh read is cheap; the ACL doc is tiny and the whole path only runs when
 * a ceiling is in force and the label carries a `Space(...)` atom.
 *
 * `serviceDids` grants implicit OWNER to configured service principals; the
 * worker does not thread `MEMORY_SERVICE_DIDS` today (design §9), so callers
 * pass `[]` and service principals — which rarely render — fail closed.
 */
export const createRuntimeSpaceMembershipProvider = (
  runtime: Pick<Runtime, "getCellFromLink">,
  actingPrincipal: string,
  serviceDids: readonly string[] = [],
): SpaceMembershipProvider => {
  const cells = new Map<string, Cell<unknown>>();
  return {
    readerRole(space) {
      // Service principals are implicit OWNER — decided WITHOUT reading (or
      // syncing) any ACL doc.
      if (serviceDids.includes(actingPrincipal)) return "owner";
      const acl = aclCellFor(runtime, cells, space).get() as ACL | undefined;
      return spaceReaderRole(acl, actingPrincipal, serviceDids);
    },
    held(space) {
      return cellDocumentHeld(aclCellFor(runtime, cells, space));
    },
    async whenHeld(space) {
      await aclCellFor(runtime, cells, space).sync();
    },
    subscribe(space, onChange) {
      // `Cell.sink` runs its action once synchronously at subscribe time (the
      // current snapshot); skip that fire so `onChange` signals CHANGE only —
      // the caller already has the snapshot from `readerRole`. Every later
      // re-fire (the ACL syncing in, or a subsequent write) invokes `onChange`.
      let primed = false;
      return aclCellFor(runtime, cells, space).sink(() => {
        if (!primed) {
          primed = true;
          return;
        }
        onChange();
      });
    },
  };
};
