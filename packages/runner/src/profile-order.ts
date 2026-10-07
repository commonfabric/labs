/**
 * The order in which a user's profiles answer `#profile`: the default first,
 * then the most recently used, then the order of the home `profiles` list.
 * The `wish` builtin decides `#profile` by it, and the host decides by it which
 * profile's inbox pointer Home's private inbox follows. Loading what it reads
 * is the caller's: everything here reads what is already loaded.
 */

import { internSchema } from "@commonfabric/data-model-schema";
import { isObjectOrArray } from "@commonfabric/utils/types";
import type { Cell } from "./cell.ts";
import { isPrimitiveCellLink, parseLink } from "./link-utils.ts";
import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

/**
 * Schema for a list of profile links, the home `profiles` and `mru` lists, each
 * element read as a link to the profile rather than as its value.
 */
// Each element is read as a cell *reference* (`asCell`), NOT its inlined value,
// so the list can be enumerated without deep-resolving every profile's own
// space. A plain `.get()` inlines each element and returns `undefined` for the
// whole list whenever any element is a link into a space not yet loaded in the
// reading context — e.g. a shared piece resolving `#profile` right after a
// profile was created in its own (`inSpace`) space. That would collapse the
// list to length 0 and hide the just-created profile behind the "No profile" /
// create surface.
//
// The item type is `unknown` (not `object`) on purpose: with `asCell`, an
// `object` item schema would trigger a *deep* sync of each linked profile —
// fetching its entire object graph and everything it transitively links, across
// space boundaries — just to count the list. `unknown` keeps the sync shallow
// (we only need the links here).
export const profileLinkListSchema = internSchema(
  {
    type: "array",
    items: { type: "unknown", asCell: ["cell"] },
  },
);

/**
 * A profile link is valid when it resolves to a cell in another space (the
 * profile's own `inSpace` space) with an empty path. An unset link, or one that
 * still points into the home space, means the profile does not exist yet.
 */
export function profileCellIsValid(
  cell: Cell<unknown>,
  rawIsSet: boolean,
  homeSpace: Cell<unknown>["space"],
): boolean {
  if (!rawIsSet) return false;
  const link = cell.getAsNormalizedFullLink();
  return link.space !== homeSpace && link.path.length === 0;
}

/**
 * Whether home `defaultPattern` keeps its default in a slot: whether its
 * `defaultProfile` holds an object at its root, read in the cell the field
 * names rather than through it. A home without the slot keeps its default as a
 * link at the root of that cell, or has nothing there; one with the slot keeps
 * such a link, chosen before the slot, as `legacyDefaultProfile`.
 */
export function homeHasDefaultProfileSlot(
  runtime: Runtime,
  defaultPattern: Cell<unknown>,
  tx: IExtendedStorageTransaction | undefined,
): boolean {
  const field = defaultPattern.key("defaultProfile");
  const fieldRaw = field.getRaw();
  const root = isPrimitiveCellLink(fieldRaw)
    ? runtime.getCellFromLink(parseLink(fieldRaw, field), undefined, tx)
      .getRaw()
    : fieldRaw;
  return isObjectOrArray(root) && !Array.isArray(root) &&
    !isPrimitiveCellLink(root);
}

/**
 * Whether a `mru` / `defaultProfile` entry names the SAME profile as a candidate
 * from the home `profiles` list — compared by the profile's own SPACE, NOT by
 * `Cell.equals` or by entity id.
 *
 * CT-1842: the `#profile` ordering matches candidates (from `profiles`) against
 * the `defaultProfile` link and the `mru` list. Those name the same profiles but
 * reach them through DIFFERENT links. Two distinct differences defeat a naive
 * comparison, both observed on live data:
 *   - `scope` skew — `Cell.equals` (`areNormalizedLinksSame`) compares `scope`,
 *     which the two sides don't always agree on; and
 *   - DIFFERENT entity `id` — the `mru`/`defaultProfile` link and the `profiles`
 *     link for the SAME profile point at different cells WITHIN that profile's
 *     space (e.g. the picker stores the profile pattern's result cell while the
 *     list stores the pattern cell). So even id+space+path comparison fails.
 *
 * The stable per-profile identity is the profile's own SPACE. Each profile is a
 * distinct anonymous `ProfileHome.inSpace()` (see submitProfileCreation), whose
 * DID is unique per user AND per creation event, and `profileCellIsValid`
 * guarantees every valid candidate lives in its OWN non-home space. No two
 * distinct valid profiles ever share a space, so equal space ⇒ same profile.
 * Reading each cell's normalized link keeps the ordering reactive to
 * `mru`/`defaultProfile` changes.
 *
 * `homeSpace` guards the degenerate case: a `mru`/`defaultProfile` entry that
 * still resolves into the home space (an unmaterialized / invalid link) must
 * never match — candidates are never in the home space, but the guard makes the
 * intent explicit and defends against a future home-space candidate slipping in.
 */
export function sameProfileCell(
  a: Cell<unknown>,
  b: Cell<unknown>,
  homeSpace: Cell<unknown>["space"],
): boolean {
  const spaceA = a.getAsNormalizedFullLink().space;
  const spaceB = b.getAsNormalizedFullLink().space;
  if (spaceA === homeSpace || spaceB === homeSpace) return false;
  return spaceA === spaceB;
}

/** The candidates in `#profile` order, and what decided it. */
export type ProfileOrder = {
  /** The candidates, default first, then by MRU rank, then in list order. */
  ordered: Cell<unknown>[];

  /** Whether the home names a default profile that is a valid link. */
  defaultValid: boolean;

  /** The default profile's cell, meaningful only while `defaultValid`. */
  defaultCell: Cell<unknown>;

  /** The MRU list's entries, most recent first. */
  mruCells: Cell<unknown>[];
};

/**
 * Orders `candidates`, the valid profiles of the home `defaultPattern` in list
 * order, as `#profile` answers: the default first, then by rank in the MRU
 * list, then in list order. The default is the link under `profile` in the
 * home's slot, or, while the slot holds none, the link a home keeps an earlier
 * default in: `legacyDefaultProfile`, or `defaultProfile` itself for a home
 * without the slot. Profiles are matched by their own space, as
 * {@link sameProfileCell} says. `homeSpace` is the home space's DID.
 */
export function orderProfileCandidates(
  runtime: Runtime,
  defaultPattern: Cell<unknown>,
  homeSpace: Cell<unknown>["space"],
  candidates: readonly Cell<unknown>[],
  tx?: IExtendedStorageTransaction,
): ProfileOrder {
  const hasSlot = homeHasDefaultProfileSlot(runtime, defaultPattern, tx);
  const slotEntry = defaultPattern.key("defaultProfile").key("profile");
  const slotCell = slotEntry.resolveAsCell();
  const slotValid = hasSlot &&
    profileCellIsValid(slotCell, slotEntry.getRaw() !== undefined, homeSpace);
  const legacyEntry = defaultPattern.key(
    hasSlot ? "legacyDefaultProfile" : "defaultProfile",
  );
  const defaultCell = slotValid ? slotCell : legacyEntry.resolveAsCell();
  const defaultValid = slotValid ||
    profileCellIsValid(
      defaultCell,
      legacyEntry.getRaw() !== undefined,
      homeSpace,
    );

  const mruCell = defaultPattern.key("mru");
  const mruRaw = mruCell.asSchema(profileLinkListSchema).get();
  const mruLength = Array.isArray(mruRaw) ? mruRaw.length : 0;
  const mruCells: Cell<unknown>[] = [];
  for (let j = 0; j < mruLength; j++) {
    mruCells.push(mruCell.key(j).resolveAsCell());
  }
  const mruRank = (cell: Cell<unknown>): number => {
    const idx = mruCells.findIndex((m) => sameProfileCell(m, cell, homeSpace));
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };

  const ordered = [...candidates];
  ordered.sort((a, b) => {
    if (defaultValid) {
      const aDef = sameProfileCell(defaultCell, a, homeSpace);
      const bDef = sameProfileCell(defaultCell, b, homeSpace);
      if (aDef && !bDef) return -1;
      if (bDef && !aDef) return 1;
    }
    return mruRank(a) - mruRank(b);
  });
  return { ordered, defaultValid, defaultCell, mruCells };
}
