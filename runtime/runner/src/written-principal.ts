/**
 * `writtenPrincipalAt()`, which a host calls to ask the principal a value's
 * own cell represents, by the rule `cfc/written-principal.ts` states.
 */

import type { DID } from "@commonfabric/api";

import { type Cell, resolveWriteTarget } from "./cell.ts";
import { cfcLabelViewFromMetadata } from "./cfc/label-view-state.ts";
import { readStoredCfcMetadata } from "./cfc/metadata.ts";
import { soleRepresentedPrincipal } from "./cfc/represents-principal.ts";
import { isOwnValueCell } from "./cfc/written-principal.ts";
import { unlessCyclic } from "./link-resolution.ts";
import type { NormalizedFullLink } from "./link-types.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

/**
 * Returns the principal the own cell of the value at `cell` represents, read
 * through `tx`: the one principal the label of the cell a write to `cell` lands in
 * names, when the value is the whole of that cell and no link stored there
 * leads elsewhere, or `undefined` otherwise, and for links that run in a
 * cycle. `visit` is called with the document whose label is read, before it
 * is read, so that a handler can wait for one still loading; no label is read
 * for a value that is not the whole of its own cell. The label read is one a
 * reactive computation reruns on.
 *
 * @throws When the label is stored in a form this build cannot interpret, or
 *   a read through `tx` fails.
 */
export function writtenPrincipalAt(
  tx: IExtendedStorageTransaction,
  cell: Cell<unknown>,
  visit: (document: NormalizedFullLink) => void = () => {},
): DID | undefined {
  const at = cell.withTx(tx);
  const written = unlessCyclic(() => resolveWriteTarget(at))
    ?.getAsNormalizedFullLink();
  const target = unlessCyclic(() => at.resolveAsCell())
    ?.getAsNormalizedFullLink();
  if (
    written === undefined || target === undefined ||
    !isOwnValueCell(written, target)
  ) {
    return undefined;
  }
  visit(target);
  const metadata = readStoredCfcMetadata(tx, {
    space: target.space,
    id: target.id,
    scope: target.scope,
  });
  return soleRepresentedPrincipal(cfcLabelViewFromMetadata(metadata, []));
}
