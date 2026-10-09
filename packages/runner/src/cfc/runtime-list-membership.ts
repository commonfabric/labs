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
  type ListEntryView,
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

/** The confidentiality a stored label holds at `path`, ancestors included. */
const confidentialityAt = (
  metadata: Parameters<typeof cfcLabelViewFromMetadata>[0],
  path: readonly string[],
): readonly CfcConfClause[] =>
  cfcLabelViewFromMetadata(metadata, [...path])?.entries.flatMap((entry) =>
    entry.label.confidentiality ?? []
  ) ?? [];

/** Whether the stored schema at `path` declares who may write it. */
const declaresWriterAt = (
  schema: Parameters<typeof ContextualFlowControl.getSchemaAtPath>[0],
  path: readonly string[],
): boolean => {
  const atPath = ContextualFlowControl.getSchemaAtPath(schema, [...path]);
  const ifc = isObjectOrArray(atPath) ? atPath.ifc : undefined;
  return ifc?.writeAuthorizedBy !== undefined;
};

/**
 * One entry of the list held at `address`, as resolution judges it, or
 * `undefined` for an entry that names nobody.
 *
 * A string entry, or an object held inline, is governed by the list
 * position's writers. An object entry the runtime stored as its own document
 * is reached through a link at the entry's index; that document answers to
 * its own schema, not the list's, so it counts only when it sits in the
 * list's space and declares its writers, and its label is the pointer's
 * joined with its own.
 */
const entryView = (
  tx: IExtendedStorageTransaction,
  entry: unknown,
  pointerLabel: readonly CfcConfClause[],
  address: NormalizedFullLink,
): ListEntryView | undefined => {
  if (typeof entry === "string") return { principal: entry, label: pointerLabel };
  if (!isPrimitiveCellLink(entry)) {
    return isObjectOrArray(entry) && !Array.isArray(entry)
      ? { principal: entry.principal, label: pointerLabel }
      : undefined;
  }
  const target = parseLink(entry, address);
  if (target === undefined || target.space !== address.space) return undefined;
  const envelope = loadStoredCfcEnvelope(tx, target);
  if (
    envelope.status !== "loaded" ||
    !declaresWriterAt(envelope.schema, target.path)
  ) {
    return undefined;
  }
  const held = tx.readValueOrThrow(target);
  return isObjectOrArray(held) && !Array.isArray(held)
    ? {
      principal: held.principal,
      label: [
        ...pointerLabel,
        ...confidentialityAt(envelope.metadata, target.path),
      ],
    }
    : undefined;
};

/**
 * Whether `principal` is listed at `list` in the local replica (spec
 * §4.9.5): the entries are read at the position or one link from it, their
 * position must declare its writers, and each entry (see `entryView`) is
 * judged by {@link listedInEntries} against its own stored label. Any read that fails,
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
  if (!declaresWriterAt(envelope.schema, address.path)) return false;
  const value = tx.readValueOrThrow(address);
  if (!Array.isArray(value)) return false;
  return listedInEntries(
    principal,
    value.flatMap((entry, index) => {
      const view = entryView(
        tx,
        entry,
        confidentialityAt(envelope.metadata, [...address.path, String(index)]),
        address,
      );
      return view === undefined ? [] : [view];
    }),
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
    // Each `sink` runs once synchronously at subscribe time; that fire is the
    // snapshot `listed` already gave, so only later fires signal change.
    // Reading through the cell follows the position's link, so a write to the
    // linked document fires too. `listed` also consults the stored labels and
    // schema, so a change to either alone fires as well.
    const cell: Cell<unknown> = runtime.getCellFromLink<unknown>(linkOf(list));
    const onLaterFires = () => {
      let primed = false;
      return () => {
        if (!primed) {
          primed = true;
          return;
        }
        onChange();
      };
    };
    const cancels: Cancel[] = [
      cell.sink(onLaterFires(), { includeCfcLabel: true }),
      cell.sinkMeta("schema", onLaterFires()),
    ];
    return () => {
      for (const cancel of cancels) cancel();
    };
  },
});
