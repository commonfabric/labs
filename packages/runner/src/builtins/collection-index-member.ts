/** Maintains one index occurrence from a tagged reactive selector result. */

import type { AddCancel } from "../cancel.ts";
import type { Cell } from "../cell.ts";
import type { RawBuiltinReturnType } from "../module.ts";
import { resolveLink } from "../link-resolution.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  ignoreReadForScheduling,
  machineryRead,
} from "../storage/reactivity-log.ts";
import { resolveCollectionKey } from "./collection-index-key.ts";
import {
  type CollectionIndexMembership,
  maintainCollectionIndexMembership,
  type MaintainedCollectionIndex,
} from "./collection-index-membership.ts";

/** Inputs whose source addresses are owned by the index coordinator. */
export interface CollectionIndexMemberInput {
  /** Serialized selector result; an absent tag means extraction is pending. */
  extracted: { isCell: boolean; value: unknown };

  /** Durable maintenance records for this index instance. */
  state: CollectionIndexMembership;

  /** Public descriptor maintained by all occurrences of this index. */
  index: MaintainedCollectionIndex;

  /** Stable source occurrence identity, including duplicate position. */
  occurrence: string;

  /** Original source element whose address is published into the bucket. */
  element: unknown;

  /** Duplicate-selection behavior. */
  mode: "group" | "key";
}

/**
 * Resolves a tagged selector and updates its occurrence in one transaction.
 * Bucket and occupancy materializer envelopes keep extraction demanded
 * when only an absent destination bucket is observed.
 */
export function collectionIndexMember(
  inputs: Cell<CollectionIndexMemberInput>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  _addCancel: AddCancel,
  _cause: unknown,
  _parent: Cell<unknown>,
  runtime: Runtime,
): RawBuiltinReturnType {
  const index = inputs.key("index").resolveAsCell();
  return Object.assign((tx: IExtendedStorageTransaction) => {
    const args = inputs.withTx(tx);
    const extracted = args.key("extracted").resolveAsCell()
      .asSchema<CollectionIndexMemberInput["extracted"]>(undefined);
    const cellKey = extracted.key("isCell").get();
    if (cellKey === undefined) return;
    const value = cellKey
      ? extracted.key("value").asSchema({ asCell: ["cell"] }).get()
      : extracted.key("value").get();
    // Maintenance reads concrete slots behind the opaque setup references.
    // Which documents the two slots name is this member's own dependency,
    // every link on the way included: the walk here reads the slot and each
    // link it reaches the document through as ordinary dependencies, so a
    // write that retargets any of them runs the member again rather than
    // leaving it silently stale against the old document. The coordinator
    // fixes both references for the member's lifetime, and relocating one is
    // not supported: the write envelope below names the index the member was
    // created for. The scoped resolution below walks the same links again and
    // kicks any cross-space targets, so this walk kicks none.
    // The named documents' labels are runtime plumbing, not an observation:
    // every member writes into the one index document, and each write stamps
    // that document's CFC label map. A member that took the shared documents'
    // labels as ordinary dependencies would wake on every other member's
    // stamp, so one added source element re-ran every member the index
    // already had. Only the label view the resolved cells carry is derived in
    // the machinery scope.
    for (const slot of ["state", "index"] as const) {
      resolveLink(
        runtime,
        tx,
        args.key(slot).getAsNormalizedFullLink(),
        "value",
        { kickCrossSpaceTargets: false },
      );
    }
    const [state, index] = tx.runWithAmbientReadMeta(
      { ...ignoreReadForScheduling, ...machineryRead },
      () =>
        [
          args.key("state").resolveAsCell().asSchema<CollectionIndexMembership>(
            undefined,
          ),
          args.key("index").resolveAsCell().asSchema<MaintainedCollectionIndex>(
            undefined,
          ),
        ] as const,
    );
    maintainCollectionIndexMembership(
      tx,
      state,
      index,
      args.key("mode").get(),
      args.key("occurrence").get(),
      resolveCollectionKey(runtime, tx, value),
      args.key("element").resolveAsCell().asSchema<unknown>(undefined),
    );
    sendResult(tx, true);
  }, {
    materializerWriteEnvelopes: [
      index.key("buckets").getAsNormalizedFullLink(),
      inputs.key("state").resolveAsCell().key("occupied")
        .getAsNormalizedFullLink(),
    ],
  });
}
