import type { SpaceAccessLevel } from "@commonfabric/api";
import { type ACL, aclDocId } from "@commonfabric/memory/acl";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import { type Cell, isCell } from "../cell.ts";
import { spaceReaderRole, type SpaceRole } from "../cfc/space-membership.ts";
import { getCellOrThrow, isCellResult } from "../query-result-proxy.ts";
import type { Runtime } from "../runtime.ts";
import { scopeRank } from "../scope.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { topFrame } from "./frame-context.ts";

/** The level each role {@link spaceReaderRole} returns stands for. */
const LEVEL_OF_ROLE: Record<SpaceRole, SpaceAccessLevel> = {
  owner: "OWNER",
  writer: "WRITE",
  reader: "READ",
};

/**
 * Returns the current principal's own access to the space `target`'s value
 * lives in: its membership as the space's access list states it,
 * `acl[principal] ?? acl["*"]`, with the space's own identity holding `OWNER`
 * implicitly. {@link spaceReaderRole} decides it, as it does for the render
 * membership lookup. The memory server also grants configured service DIDs
 * `OWNER`, which never arises here since the principal is never the service.
 *
 * `"none"` means the principal holds nothing there: the list grants them
 * nothing, or, on a client, the memory server has refused the principal the
 * space outright. `undefined` means the answer is not known yet, which is
 * what an access list that has not arrived, a space that has no access list,
 * a run with no principal, and a `target` passed as `undefined` all return.
 *
 * `target` is required, and names the space explicitly even when it is the
 * calling code's own. A `target` passed as `undefined` is one not known yet:
 * a computation's by-value input reads `undefined` while the value it names
 * cannot be read, which is when the principal may not belong to its space.
 *
 * Who the principal is depends on where the call runs. In a reactive
 * computation it is the principal demanding the value, and the call makes the
 * computation's value a per-user one, so two users never share an answer. In
 * a handler it is the event's actor. In a pattern body it throws, since a
 * pattern body builds one graph for every viewer.
 *
 * The level names no principal, and tells a member only what a member can
 * already read, since any member can read the whole access list.
 *
 * @throws If called outside a handler or a reactive computation, with no
 *   `target`, or with a `target` that is neither a cell nor `undefined`.
 */
export function spaceAccess(
  // Optional here, though the declared API requires it, so that the runtime
  // check below has a case to catch from untyped callers.
  ...args: [target?: unknown]
): SpaceAccessLevel | undefined {
  const frame = topFrame();
  const kind = frame?.frameKind;
  if (kind !== "lift" && kind !== "handler") {
    throw new Error(
      "`spaceAccess(target)` can only be called from a handler or a reactive " +
        "computation, where there is one principal to ask about.",
    );
  }
  const { runtime, tx } = frame!;
  if (runtime === undefined || tx === undefined) {
    throw new Error("`spaceAccess(target)` requires an executing runtime.");
  }
  if (args.length === 0) {
    throw new Error(
      "`spaceAccess()` requires a `target`: a cell in the space to ask about.",
    );
  }
  const [target] = args;

  let principal: string | undefined;
  if (kind === "lift") {
    // The answer depends on who is asking, so the computation's value is a
    // per-user one whatever the principal turns out to be. This goes first so
    // that no return below skips it.
    if (scopeRank(tx.getNarrowestReadScope()) < scopeRank("user")) {
      tx.resetNarrowestReadScope("user");
    }
    principal = runtime.homeSpacePrincipalFor(tx);
  } else {
    principal = runtime.actingPrincipalFor(tx);
  }

  if (target === undefined) return undefined;
  return accessLevel(
    runtime,
    tx,
    spaceOfTarget(target),
    principal,
    kind === "lift",
  );
}

/**
 * Helper for {@link spaceAccess}, which returns the space `target` lives in,
 * after following any links it holds.
 */
function spaceOfTarget(target: unknown): MemorySpace {
  let cell: Cell<unknown>;
  if (isCell(target)) {
    cell = target;
  } else if (isCellResult(target)) {
    cell = getCellOrThrow(target);
  } else {
    throw new Error(
      "`spaceAccess(target)` takes a cell, or `undefined`, as its target.",
    );
  }
  return cell.resolveAsCell().getAsNormalizedFullLink().space;
}

/**
 * Helper for {@link spaceAccess}, which returns `principal`'s access to
 * `space`, reading the space's access list through `tx`. With `reactive`, a
 * change to whether the memory server admits this runtime to `space` runs the
 * executing action again.
 */
function accessLevel(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  principal: string | undefined,
  reactive: boolean,
): SpaceAccessLevel | undefined {
  if (principal === undefined) return undefined;
  if (principal === space) return "OWNER";

  // A serving runtime reads every space as that space's owner, so what the
  // memory server thinks of its own session says nothing about the principal
  // whose level it returns. Only a client's session is that principal's.
  const sessionIsPrincipal = !runtime.servingPosture;
  const action = runtime.scheduler.executingAction;
  if (sessionIsPrincipal && reactive && action !== null) {
    runtime.spaceAccessWatch.rerunOnChange(space, action);
  }

  const acl = runtime.getCellFromLink<unknown>(
    { space, id: aclDocId(space) as URI, path: [] },
    undefined,
    tx,
  ).get();

  if (sessionIsPrincipal && isRefused(runtime, space)) return "none";
  if (acl === undefined) return undefined;
  const role = spaceReaderRole(acl as ACL, space, principal);
  return role === null ? "none" : LEVEL_OF_ROLE[role];
}

/**
 * Helper for {@link accessLevel}, which returns whether the memory server has
 * refused this runtime's session `space` for good.
 */
function isRefused(runtime: Runtime, space: MemorySpace): boolean {
  const storage = runtime.storageManager;
  return (storage.spaceAccessError?.(space) ??
    storage.authorizationError?.(space)) !== undefined;
}
