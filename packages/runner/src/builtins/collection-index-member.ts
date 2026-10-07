/** Maintains one index occurrence from a tagged reactive selector result. */

import type { AddCancel } from "../cancel.ts";
import type { Cell } from "../cell.ts";
import type { RawBuiltinReturnType } from "../module.ts";
import { resolveLinkTracingDereferences } from "../link-resolution.ts";
import { toMemorySpaceAddress } from "../link-types.ts";
import type { Runtime } from "../runtime.ts";
import type { URI } from "../sigil-types.ts";
import type { CfcAddress } from "../cfc/mod.ts";
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
    // every link on the way included: each hop's source, the slot and any
    // link it reaches the document through, is read below as an ordinary
    // dependency, so a write that retargets any of them runs the member
    // again rather than leaving it silently stale against the old document.
    // The coordinator fixes both references for the member's lifetime, and
    // relocating one is not supported: the write envelope below names the
    // index the member was created for.
    // Resolving the named documents is runtime plumbing, not an observation:
    // every member writes into the one index document, and each write stamps
    // that document's CFC label map. A member that took the shared documents'
    // labels as ordinary dependencies would wake on every other member's
    // stamp, so one added source element re-ran every member the index
    // already had. The resolution's probe of the document itself is plumbing
    // too: where a link is an atomic value, that probe reads the document's
    // root, which every bucket write overlaps.
    const hops: CfcAddress[] = [];
    const [state, index] = tx.runWithAmbientReadMeta(
      { ...ignoreReadForScheduling, ...machineryRead },
      () => {
        const resolve = <T>(slot: "state" | "index"): Cell<T> => {
          const { traces } = resolveLinkTracingDereferences(
            runtime,
            tx,
            args.key(slot).getAsNormalizedFullLink(),
          );
          for (const trace of traces) hops.push(trace.source);
          return args.key(slot).resolveAsCell().asSchema<T>(undefined);
        };
        return [
          resolve<CollectionIndexMembership>("state"),
          resolve<MaintainedCollectionIndex>("index"),
        ] as const;
      },
    );
    for (const hop of hops) {
      tx.read(
        toMemorySpaceAddress({
          ...hop,
          id: hop.id as URI,
          path: [...hop.path],
        }),
      );
    }
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
