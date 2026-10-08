import type { CfcListPosition } from "@commonfabric/api/cfc";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { Cancel } from "../cancel.ts";
import type { Cell } from "../cell.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { isPrimitiveCellLink } from "../link-types.ts";
import { type NormalizedFullLink, parseLink } from "../link-utils.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { MemorySpace, URI } from "../storage/interface.ts";
import type { CfcConfClause } from "./clause.ts";
import { cfcLabelViewFromMetadata } from "./label-view-state.ts";
import {
  listedInEntries,
  type ListMembershipProvider,
} from "./list-membership.ts";
import { loadStoredCfcEnvelope } from "./prepare.ts";

const linkOf = (list: CfcListPosition): NormalizedFullLink => ({
  space: list.space as MemorySpace,
  id: list.id as URI,
  path: [...list.path],
  scope: "space",
});

/**
 * Where the entries of the list at `list` are held: the position itself, or
 * the one document a link at the position names. A link at that document
 * too is a chain, which spec §4.9.5 resolves to nothing.
 */
const entriesAddress = (
  tx: IExtendedStorageTransaction,
  list: CfcListPosition,
): NormalizedFullLink | undefined => {
  const position = linkOf(list);
  const held = tx.readValueOrThrow(position);
  if (!isPrimitiveCellLink(held)) return position;
  const target = parseLink(held, position);
  if (target === undefined) return undefined;
  return isPrimitiveCellLink(tx.readValueOrThrow(target)) ? undefined : target;
};

/**
 * The principal an entry pins. An object entry of a list is stored as its own
 * document with a link at the entry's index, so a link is followed one hop.
 */
const entryPrincipal = (
  tx: IExtendedStorageTransaction,
  entry: unknown,
  base: NormalizedFullLink,
): unknown => {
  const held = isPrimitiveCellLink(entry)
    ? readLinkTarget(tx, entry, base)
    : entry;
  return isObjectOrArray(held) && !Array.isArray(held)
    ? held.principal
    : undefined;
};

const readLinkTarget = (
  tx: IExtendedStorageTransaction,
  link: unknown,
  base: NormalizedFullLink,
): unknown => {
  const target = parseLink(link, base);
  return target === undefined ? undefined : tx.readValueOrThrow(target);
};

/**
 * The confidentiality an entry's stored label holds, ancestors included, and
 * the pointer's label where the entry is a link.
 */
const entryConfidentiality = (
  metadata: Parameters<typeof cfcLabelViewFromMetadata>[0],
  path: readonly string[],
): readonly CfcConfClause[] =>
  cfcLabelViewFromMetadata(metadata, [...path])?.entries.flatMap((entry) =>
    entry.label.confidentiality ?? []
  ) ?? [];

/**
 * Whether `principal` is listed at `list` in the local replica (spec
 * §4.9.5): the entries are read at the position or one link from it, their
 * position must declare its writers, and each entry is judged by
 * {@link listedInEntries} against its own stored label. Any read that fails,
 * or a document whose stored labels cannot be interpreted, lists nobody.
 */
export const listedInReplica = (
  tx: IExtendedStorageTransaction,
  principal: string,
  list: CfcListPosition,
): boolean => {
  const address = entriesAddress(tx, list);
  if (address === undefined) return false;
  const envelope = loadStoredCfcEnvelope(tx, address);
  if (envelope.status !== "loaded") return false;
  const schema = ContextualFlowControl.getSchemaAtPath(envelope.schema, [
    ...address.path,
  ]);
  const ifc = isObjectOrArray(schema) ? schema.ifc : undefined;
  if (ifc?.writeAuthorizedBy === undefined) return false;
  const value = tx.readValueOrThrow(address);
  if (!Array.isArray(value)) return false;
  return listedInEntries(
    principal,
    value.map((entry, index) => ({
      principal: entryPrincipal(tx, entry, address),
      label: entryConfidentiality(envelope.metadata, [
        ...address.path,
        String(index),
      ]),
    })),
  );
};

/**
 * A runtime-backed {@link ListMembershipProvider}: `listed` reads the list
 * from the local replica in a read transaction, and `subscribe` watches
 * the position and the document it links to. Deliberately not memoized, so a
 * removal re-blocks at the next evaluation.
 */
export const createRuntimeListMembershipProvider = (
  runtime: Pick<Runtime, "getCellFromLink" | "readTx">,
  actingPrincipal: string,
): ListMembershipProvider => ({
  listed(list) {
    try {
      return listedInReplica(runtime.readTx(), actingPrincipal, list);
    } catch {
      return false;
    }
  },
  subscribe(list, onChange) {
    // `Cell.sink` runs once synchronously at subscribe time; that fire is
    // the snapshot `listed` already gave, so only later fires signal change.
    // Reading through the cell follows the position's link, so a write to
    // the linked document fires too.
    let primed = false;
    const cell: Cell<unknown> = runtime.getCellFromLink<unknown>(linkOf(list));
    const cancel: Cancel = cell.sink(() => {
      if (!primed) {
        primed = true;
        return;
      }
      onChange();
    });
    return cancel;
  },
});
