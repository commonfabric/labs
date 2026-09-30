/** Shared live-reference resolution for conditional and list builtins. */

import { type Cell, getCarriedCfcLabelView } from "../cell.ts";
import {
  cfcLabelViewForDereferenceTraces,
  mergeCfcLabelViews,
} from "../cfc/label-view-state.ts";
import { resolveLinkTracingDereferences } from "../link-resolution.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/** Follows a live reference while retaining its acquired restrictions. */
export function resolveCellReference<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<T>,
): Cell<T> {
  const carriedView = getCarriedCfcLabelView(cell);
  const { link, traces } = resolveLinkTracingDereferences(
    runtime,
    tx,
    cell.getAsNormalizedFullLink(),
    "value",
  );
  return runtime.getCellFromLink(
    link,
    undefined,
    tx,
    mergeCfcLabelViews([
      carriedView,
      cfcLabelViewForDereferenceTraces(tx, traces, carriedView),
    ]),
  );
}
