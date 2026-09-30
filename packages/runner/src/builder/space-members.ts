/** Reads authoritative space membership and stages atomic handler changes. */

import type { Cell } from "@commonfabric/api";
import { type ACL, aclDocId, isACL } from "@commonfabric/memory/acl";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { topFrame } from "./frame-context.ts";
import { stageAclChange } from "../storage/acl-change.ts";
import { isCell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import { scopeRank } from "../scope.ts";

/** Spaces whose authoritative ACL has completed its initial replica load. */
const loadedMemberships = new WeakMap<Runtime, Set<MemorySpace>>();

/** Loads membership before retrying a synchronous pattern action. */
export async function loadSpaceMembership(
  runtime: Runtime,
  space: MemorySpace,
): Promise<void> {
  const cell = runtime.getCellFromLink<unknown>({
    space,
    id: aclDocId(space) as URI,
    path: [],
  });
  try {
    await cell.sync();
  } catch {
    // Access status is read separately from data so an unavailable room can
    // render its state without failing the containing pattern.
  }
  let loaded = loadedMemberships.get(runtime);
  if (!loaded) loadedMemberships.set(runtime, loaded = new Set());
  loaded.add(space);
}

/** Reads the current space's authoritative access list as a reactive dependency. */
export function spaceMembers(target?: Cell<unknown>): ACL | undefined {
  const frame = topFrame();
  if (!frame?.runtime || !frame.tx || !frame.space) {
    throw new Error("`spaceMembers()` requires an active execution.");
  }
  if (target !== undefined && !isCell(target)) {
    throw new Error("Membership target must be a cell");
  }
  const space = target && isCell(target)
    ? target.resolveAsCell().getAsNormalizedFullLink().space
    : frame.space;
  if (!frame.runtime.servingPosture && frame.frameKind === "lift") {
    if (scopeRank(frame.tx.getNarrowestReadScope()) < scopeRank("user")) {
      frame.tx.resetNarrowestReadScope("user");
    }
    const action = frame.runtime.scheduler.executingAction;
    if (action) frame.runtime.spaceAccessWatch.rerunOnChange(space, action);
  }
  if (!loadedMemberships.get(frame.runtime)?.has(space)) {
    (frame.pendingMembershipSpaces ??= new Set()).add(space);
    return undefined;
  }
  const cell = frame.runtime.getCellFromLink<unknown>(
    {
      space,
      id: aclDocId(space) as URI,
      path: [],
    },
    undefined,
    frame.tx,
  );
  const value = cell.get();
  if (!frame.runtime.servingPosture) {
    const storage = frame.runtime.storageManager;
    if (
      (storage.spaceAccessError?.(space) ??
        storage.authorizationError?.(space)) !== undefined
    ) {
      return undefined;
    }
  }
  if (value === undefined) return undefined;
  if (!isACL(value)) throw new Error("The space has an invalid access list.");
  return value;
}

/** Atomically replaces the current space's ACL with the handler's metadata writes. */
export function setSpaceMembers(after: ACL, target?: Cell<unknown>): void {
  const frame = topFrame();
  if (!frame?.inHandler || !frame.tx || !frame.space) {
    throw new Error("`setSpaceMembers()` requires a handler transaction.");
  }
  const before = spaceMembers(target);
  if (!before || !isACL(after)) {
    throw new Error("A membership change requires valid access lists.");
  }
  const space = target && isCell(target)
    ? target.resolveAsCell().getAsNormalizedFullLink().space
    : frame.space;
  if (space !== frame.space) {
    frame.tx.enableMultiSpaceWrites?.([space, frame.space]);
  }
  stageAclChange(frame.tx.tx, space, { before, after });
}
