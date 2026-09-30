import { hashOf } from "@commonfabric/data-model";
import { cloneCfcLabelView } from "@commonfabric/runner/cfc/label-view-core";

import type { CellRef } from "@/protocol/mod.ts";

/**
 * Renders a thrown value as text, for a message that has to be produced
 * whatever was thrown.
 *
 * A thrown value can refuse even to be stringified: an object made with
 * `Object.create(null)` has no `toString` to reach, and a proxy can throw from
 * any property read. So the derivation of a failure's description must not
 * fail in turn, which is what would turn a report of one failure into a second
 * one in its place. `/undescribable` is the fixed token for that.
 */
export function describeFailure(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "/undescribable";
  }
}

/**
 * A stored cell's address, excluding schema and display-label metadata.
 *
 * All four fields are needed to tell two cells apart: an id alone names a
 * document in every space that stores it, one id in two scopes is two
 * documents, and two paths into one document are two cells.
 *
 * The two exclusions are what separate this from `CellHandle.equals()`, which
 * weighs `cfcLabelView` as well. That view is a display copy which drifts
 * while CFC settles, so two handles on one cell can carry different views;
 * a caller asking whether it has the same cell wants those to agree, and
 * weighing the view would have it decide they are different cells for as
 * long as the drift lasted. Schema is out for the converse reason:
 * `asSchema()` answers with another handle on the same cell, and a lens over
 * a cell is not a different cell. Equality that weighs either belongs to a
 * caller comparing HANDLES; this answers about cells.
 *
 * Structural rather than joined text, so a path segment holding a separator
 * cannot spell another cell's key.
 */
export function cellRefToIdentityKey(cell: CellRef): string {
  return JSON.stringify({
    space: cell.space,
    scope: cell.scope ?? "space",
    id: cell.id,
    path: cell.path,
  });
}

/** Returns an opaque identity for one concrete scoped document instance. */
export function cellRefToInstanceId(
  cell: CellRef,
  identity: { principal: string; sessionId: string },
): string {
  const scopeKey = cell.scope === "user"
    ? { scope: "user", principal: identity.principal }
    : cell.scope === "session"
    ? {
      scope: "session",
      principal: identity.principal,
      sessionId: identity.sessionId,
    }
    : { scope: "space" };
  return hashOf({
    purpose: "runtime-client:cell-instance:v1",
    cell: cellRefToIdentityKey(cell),
    scopeKey,
  }).toString();
}

/** Identifies a subscription, including its projection and acquisition history. */
export function cellRefToKey(cell: CellRef): string {
  // Key on the FULL id including its URI scheme: the hash preimage is
  // kind-free, so `of:fid1:H` and `computed:fid1:H` can name two distinct
  // docs for the same cause — stripping the scheme would conflate their
  // subscriptions.
  // Scope is part of a cell's address: the same space/id/path can name
  // distinct space-, user-, and session-scoped documents. Encode the whole
  // key structurally so neither scope nor separator-like path segments can
  // collide.
  return JSON.stringify({
    space: cell.space,
    scope: cell.scope,
    id: cell.id,
    path: cell.path,
    ...(cell.schema !== undefined && { schema: cell.schema }),
    ...(cell.cfcReferenceToken !== undefined && {
      cfcReferenceToken: cell.cfcReferenceToken,
    }),
    ...(cell.cfcLabelView !== undefined && {
      cfcLabelView: cloneCfcLabelView(cell.cfcLabelView),
    }),
  });
}
