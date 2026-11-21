/**
 * Tests the favorites manager's row handlers: Remove drops a keyed favorite
 * by its id and clears its entity, drops a favorite stored before keyed
 * addressing by its piece cell, and does nothing when given neither; editing
 * a row's tags replaces its user tags.
 */
import {
  action,
  assert,
  handler,
  NAME,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import {
  type Favorite,
  onRemoveFavorite,
  onUpdateUserTags,
} from "./favorites-manager.tsx";

/** Adds a keyed favorite the way Home's `addFavorite` does. */
const addKeyed = handler<
  { id: string },
  { favorites: Writable<Favorite[]>; piece: Writable<{ [NAME]?: string }> }
>(({ id }, { favorites, piece }) => {
  const entry = favorites.elementById(id);
  entry.set({ cell: piece, userTags: [], id });
  favorites.addUnique(entry);
});

/** Adds a favorite as it was stored before keyed addressing, with no id. */
const addLegacy = handler<
  void,
  { favorites: Writable<Favorite[]>; piece: Writable<{ [NAME]?: string }> }
>((_, { favorites, piece }) => {
  favorites.push({ cell: piece, userTags: [] });
});

export default pattern(() => {
  const keyedPiece = new Writable<{ [NAME]?: string }>({ [NAME]: "Keyed" });
  const legacyPiece = new Writable<{ [NAME]?: string }>({ [NAME]: "Legacy" });
  const favorites = new Writable<Favorite[]>([]);
  const userTags = new Writable<string[]>(["old"]);

  const seedKeyed = addKeyed({ favorites, piece: keyedPiece });
  const seedLegacy = addLegacy({ favorites, piece: legacyPiece });
  const removeKeyed = onRemoveFavorite({ favorites, id: "fav-1" });
  const removeLegacy = onRemoveFavorite({ favorites, item: legacyPiece });
  const removeNothing = onRemoveFavorite({ favorites });
  const updateTags = onUpdateUserTags({ userTags });

  const action_seed = action(() => {
    seedKeyed.send({ id: "fav-1" });
    seedLegacy.send();
  });
  const action_remove_nothing = action(() => removeNothing.send({}));
  const action_remove_keyed = action(() => removeKeyed.send({}));
  const action_remove_legacy = action(() => removeLegacy.send({}));
  const action_update_tags = action(() =>
    updateTags.send({ detail: { tags: ["work", "daily"] } })
  );

  return {
    [TESTS]: [
      { action: action_seed },
      { assertion: assert(() => favorites.get().length === 2) },
      { action: action_remove_nothing },
      { assertion: assert(() => favorites.get().length === 2) },
      { action: action_remove_keyed },
      {
        assertion: assert(() =>
          favorites.get().length === 1 &&
          favorites.get()[0]?.cell.get()?.[NAME] === "Legacy" &&
          favorites.elementById("fav-1").get() === undefined
        ),
      },
      { action: action_remove_legacy },
      { assertion: assert(() => favorites.get().length === 0) },
      { action: action_update_tags },
      { assertion: assert(() => userTags.get().join(",") === "work,daily") },
    ],
  };
});
