import type { Cell } from "../cell.ts";
import { createCell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CellScope } from "../builder/types.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { RawNodeCause } from "../module.ts";
import { readMaybeLink, resolveLink } from "../link-resolution.ts";
import { machineryRead } from "../storage/reactivity-log.ts";
import { narrowestScope, scopeRank } from "../scope.ts";
import { createSigilLinkFromParsedLink, getMetaLink } from "../link-utils.ts";
import { rawMetaWriteAuthorization } from "../meta-seam.ts";

export function resolvedCellScope(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<any>,
): CellScope {
  return resolveLink(runtime, tx, cell.getAsNormalizedFullLink()).scope;
}

export function scopedCell<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<T>,
  scope: CellScope,
): Cell<T> {
  const link = cell.getAsNormalizedFullLink();
  if (link.scope === scope) {
    return cell;
  }
  return createCell<T>(runtime, { ...link, scope }, tx);
}

/**
 * The position-derived identity coordinates (`space`/`id`/`path`) of a node's
 * resolved output binding — the stable, program-independent cause that
 * map/filter/flatMap key their result container on (CT-1623). Deliberately
 * drops `scope`/`schema` so the identity stays scope-independent (a scoped vs
 * unscoped container at the same spot share one id; scope re-addresses the
 * instance, it does not fork identity).
 */
export function outputSpotFromBinding(
  binding: NormalizedFullLink | undefined,
): { space: string; id: string; path: readonly unknown[] } | undefined {
  if (!binding) return undefined;
  return { space: binding.space, id: binding.id, path: [...binding.path] };
}

/**
 * Returns an expression builtin's result-store cause from its operation,
 * owning piece, and output coordinates. The cause stays equal across changes
 * to the serialized inputs while the owning piece and output spot are
 * unchanged.
 *
 * Throws if the node's output binding has no write redirect.
 */
export function ownedResultCause(
  op: "ifElse" | "when" | "unless",
  cause: RawNodeCause,
  parentCell: Cell<any>,
): Record<string, unknown> {
  if (!cause.outputSpot) {
    throw new Error(
      `${op}: result store requires a write-redirect output binding`,
    );
  }
  return { [op]: parentCell.entityId, outputSpot: cause.outputSpot };
}

export function cellIdentityKey(cell: Cell<any>): {
  dedupKey: string;
  linkKey: readonly unknown[];
} {
  const { space, id, path, scope } = cell.getAsNormalizedFullLink();
  const linkKey = [space, id, scope, path] as const;
  return {
    dedupKey: JSON.stringify(linkKey),
    linkKey,
  };
}

export function narrowestCellScope(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cells: Iterable<Cell<any> | undefined>,
): CellScope {
  return narrowestScope(
    Array.from(
      cells,
      (cell) =>
        cell === undefined ? undefined : resolvedCellScope(runtime, tx, cell),
    ),
  );
}

/**
 * If the cell contains a top level link, and its scope is narrower than the
 * cell's scope, create a copy of the cell.
 *
 * Copy over the value and the "result" meta link.
 */
export function exposedResultCell<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<T>,
): Cell<T> {
  // Ideally, we'd just call getRaw on the cell, but since that may be a link,
  // we need to know the base to use to parse that link.
  // Coordinator scaffolding (machineryRead): the redirect resolution reads
  // link topology only and must not consume `*`-path membership templates
  // on plumbing containers (template-population §6). The value COPY below
  // stays unmarked — the exposed cell genuinely depends on it.
  const target = tx.runWithAmbientReadMeta(
    machineryRead,
    () =>
      resolveLink(
        runtime,
        tx,
        cell.getAsNormalizedFullLink(),
        "writeRedirect",
      ),
  );
  const initialCell = cell.withTx(tx);
  // Resolve topology without reading a scalar result's content. Observing
  // the value here would subscribe the list coordinator to every child value.
  const link = tx.runWithAmbientReadMeta(
    machineryRead,
    () => readMaybeLink(tx, target) ?? target,
  );
  if (
    scopeRank(link.scope) <= scopeRank(cell.getAsNormalizedFullLink().scope)
  ) {
    return cell;
  }

  const exposed = scopedCell(runtime, tx, cell, link.scope);
  // Copy the value and result linkage into the new exposed cell
  const resultLink = getMetaLink(initialCell, "result");
  if (resultLink !== undefined) {
    exposed.setMetaRaw(
      "result",
      createSigilLinkFromParsedLink(resultLink, {
        base: exposed,
        includeSchema: true,
      }),
      rawMetaWriteAuthorization,
    );
  }
  const value = initialCell.get();
  if (value !== undefined) {
    exposed.withTx(tx).set(value);
  }
  return exposed;
}
