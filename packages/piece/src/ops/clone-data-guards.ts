/**
 * Validates and pins the storage values used by cross-space piece cloning.
 * These helpers inspect clone inputs only; creating and restoring the clone
 * remains the piece controller's responsibility.
 */

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  type Cell,
  type IExtendedStorageTransaction,
} from "@commonfabric/runner";
import { cfcLabelViewForCellFailClosed } from "@commonfabric/runner/cfc";
import {
  FabricInstance,
  isWalkableObjectOrArray,
} from "@commonfabric/data-model";
import { commitPreconditionValueHash } from "@commonfabric/memory/v2";
import { isObjectOrArray } from "@commonfabric/utils/types";

export function cloneCellKey(cell: Cell<unknown>): string {
  const link = cell.getAsNormalizedFullLink();
  return `${link.space}:${link.id}:${JSON.stringify(link.scope)}:${
    JSON.stringify(link.path)
  }`;
}

export function cloneEntityKey(cell: Cell<unknown>): string {
  const link = cell.getAsNormalizedFullLink();
  return `${link.space}:${link.id}:${JSON.stringify(link.scope)}`;
}

/** Reject special values whose private state cannot be inspected for labels. */
export function assertNoCloneFabricInstance(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (value instanceof FabricInstance) {
    throw new Error(
      "piece data containing FabricInstance values cannot be copied",
    );
  }
  if (!isWalkableObjectOrArray(value) || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    assertNoCloneFabricInstance(child, seen);
  }
}

/** Reject a value copy that would discard Common Fabric Control labels. */
export function assertCloneDataUnlabeled(carrier: unknown): void {
  const view = cfcLabelViewForCellFailClosed(carrier);
  const labeled = view?.entries.some((entry) =>
    (entry.label.confidentiality?.length ?? 0) > 0 ||
    (entry.label.integrity?.some((atom) =>
      !isObjectOrArray(atom) || atom.type !== CFC_ATOM_TYPE.LinkReference
    ) ?? false)
  );
  if (labeled) {
    throw new Error(
      "piece data with confidentiality or integrity labels cannot be copied " +
        "into another space",
    );
  }
}

/** The internal-cell manifest entries written during pattern setup. */
export function cloneInternalManifest(
  piece: Cell<unknown>,
): Record<string, unknown>[] {
  const manifest = piece.getMetaRaw("internal");
  if (manifest === undefined) return [];
  if (!Array.isArray(manifest)) {
    throw new Error("piece has invalid internal data metadata");
  }
  return manifest.map((entry) => {
    if (
      !isObjectOrArray(entry) ||
      !("partialCause" in entry) || !("link" in entry)
    ) {
      throw new Error("piece has invalid internal data metadata");
    }
    return entry as Record<string, unknown>;
  });
}

/** Require every mutable source entity in a clone snapshot to stay unchanged. */
export function pinCloneSnapshotCells(
  tx: IExtendedStorageTransaction,
  cells: Iterable<Cell<unknown>>,
): void {
  const linksByEntity = new Map<
    string,
    ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>
  >();
  for (const cell of cells) {
    const link = cell.getAsNormalizedFullLink();
    if (link.id.startsWith("data:")) continue;
    linksByEntity.set(cloneEntityKey(cell), link);
  }
  const links = [...linksByEntity.values()];
  const spaces = [...new Set(links.map((link) => link.space))];
  if (spaces.length > 1) {
    throw new Error(
      "piece data linked from another space cannot be copied consistently",
    );
  }
  if (!tx.addCommitPrecondition) {
    throw new Error("storage cannot validate a piece data snapshot");
  }
  for (const link of links) {
    const raw = tx.readOrThrow({
      space: link.space,
      id: link.id,
      scope: link.scope,
      type: "application/json",
      path: ["value"],
    });
    tx.addCommitPrecondition(link.space, {
      kind: "entity-value-hash",
      id: link.id,
      scope: link.scope,
      valueHash: raw === undefined ? null : commitPreconditionValueHash(raw),
    });
  }
}
