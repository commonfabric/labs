/**
 * Where a piece's setup keeps the stored argument slots its new argument
 * schema refused, so that leaving a slot out of an update never destroys what
 * the slot held.
 *
 * A nested piece whose code changed is set up again over its existing argument
 * document, and a stored slot the new schema refuses is left out of that
 * argument and filled with its default. The value it held is copied first, in
 * the same transaction, into a store of the piece's own: a document minted
 * from the piece's result cell, in its space and at its scope. The copy keeps
 * the stored value as it was, so a later version or a person can read and
 * restore it. A link inside it that named its own document by leaving the
 * document out is written naming the argument document, so that it still
 * points where it did.
 */

import {
  type FabricValue,
  isFabricPlainObject,
  valueEqual,
} from "@commonfabric/data-model";
import { linkRefFrom, linkRefPayload } from "@commonfabric/data-model/cell-rep";

import { isSigilLink } from "./link-types.ts";
import { isCellLink, type NormalizedFullLink } from "./link-utils.ts";
import type { Runtime } from "./runtime.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

/** The address of a piece's result cell, which is all that names its store. */
export type PieceAddress = Pick<NormalizedFullLink, "space" | "id" | "scope">;

/** One refused value, as the setup that refused it left it. */
export interface RefusedArgumentSlot {
  /** The slot's stored value, with its links naming their documents. */
  value: FabricValue;

  /** Why the new argument schema refused it. */
  reason: string;
}

/**
 * The store's contents: by slot, then by the `identity#symbol` of the pattern
 * whose setup refused it (`keyless` for a pattern with no artifact identity),
 * then each value that setup refused there, oldest first. A value already
 * kept under the same slot and pattern is not kept again, so setting the same
 * pattern up again over the same value adds nothing, and nothing kept is ever
 * replaced.
 */
export type RefusedArgumentSlots = Record<
  string,
  Record<string, RefusedArgumentSlot[]>
>;

/**
 * The cause naming the refused-slot store of the piece whose result cell is
 * `piece`. Derived from that cell alone, so anything holding the piece can
 * find the store without its address having been written anywhere, and the
 * runtime can name it as a store it owns for that piece.
 */
export function refusedArgumentSlotsCause(piece: PieceAddress) {
  return { refusedArgumentSlots: piece.id };
}

/**
 * The refused-slot store of the piece whose result cell is `piece`, in its
 * space and at its scope, so that each scoped instance of a piece keeps the
 * values its own setup refused.
 */
export function refusedArgumentSlotsCell(
  runtime: Runtime,
  piece: PieceAddress,
  tx?: IExtendedStorageTransaction,
) {
  return runtime.getCell<RefusedArgumentSlots>(
    piece.space,
    refusedArgumentSlotsCause(piece),
    undefined,
    tx,
    piece.scope,
  );
}

/**
 * Copies each slot in `refused` out of `stored`, the raw value of the argument
 * document `argument` of the piece whose result cell is `piece`, into that
 * piece's store under `refusedBy`, through `tx`. A slot holding nothing has
 * nothing to keep and is skipped. Returns the store, or `undefined` when
 * nothing was copied.
 */
export function keepRefusedArgumentSlots(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  piece: PieceAddress,
  argument: NormalizedFullLink,
  stored: unknown,
  refused: ReadonlyMap<string, string>,
  refusedBy: string,
): NormalizedFullLink | undefined {
  if (!isFabricPlainObject(stored as FabricValue) || isCellLink(stored)) {
    return undefined;
  }
  const slots = stored as Record<string, FabricValue>;
  const kept = [...refused].filter(([slot]) =>
    Object.hasOwn(slots, slot) && slots[slot] !== undefined
  );
  if (kept.length === 0) return undefined;

  const store = refusedArgumentSlotsCell(runtime, piece, tx);
  const current = store.getRawUntyped({ meta: ignoreReadForScheduling });
  const next: Record<string, FabricValue> = isFabricPlainObject(current)
    ? { ...current }
    : {};
  for (const [slot, reason] of kept) {
    const value = anchoredTo(slots[slot], argument);
    const bySlot = isFabricPlainObject(next[slot]) ? next[slot] : {};
    const earlier = Array.isArray(bySlot[refusedBy]) ? bySlot[refusedBy] : [];
    if (
      earlier.some((entry) =>
        isFabricPlainObject(entry) && valueEqual(entry.value, value)
      )
    ) {
      continue;
    }
    next[slot] = {
      ...bySlot,
      [refusedBy]: [...earlier, { value, reason }],
    };
  }
  store.setRawUntyped(next);
  return store.getAsNormalizedFullLink();
}

/**
 * `value`, read from the document `base`, with each link in it that leaves its
 * document, space or scope to the document holding it naming `base`'s instead:
 * the reading it has in `base`, written so that it keeps that reading in any
 * document. A link's other members, its schema among them, are kept as they
 * are, and nothing inside a link is walked. The value is rebuilt only along
 * the paths that change.
 */
function anchoredTo(value: FabricValue, base: NormalizedFullLink): FabricValue {
  if (Array.isArray(value)) {
    let changed = false;
    const anchored = value.map((item) => {
      const next = anchoredTo(item, base);
      changed ||= !Object.is(next, item);
      return next;
    });
    return changed ? anchored : value;
  }
  if (isSigilLink(value)) {
    const payload = linkRefPayload(value);
    const inheritsScope = payload.scope === undefined ||
      payload.scope === "inherit";
    if (payload.id && payload.space && !inheritsScope) return value;
    return linkRefFrom({
      ...payload,
      id: payload.id || base.id,
      space: payload.space || base.space,
      scope: inheritsScope ? base.scope : payload.scope,
    });
  }
  if (!isFabricPlainObject(value)) return value;
  let changed = false;
  const anchored: Record<string, FabricValue> = {};
  for (const [key, child] of Object.entries(value)) {
    const next = anchoredTo(child, base);
    changed ||= !Object.is(next, child);
    anchored[key] = next;
  }
  return changed ? anchored : value;
}
