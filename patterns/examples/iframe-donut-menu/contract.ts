/**
 * The data the donut menu's pattern and its guest share: which donut is the
 * favorite. The menu itself is fixed, and each donut names its picture by the
 * name of an asset in the pattern's `assets/` directory.
 */

/** One donut on the menu. */
export interface Donut {
  /** Stable id, which `favorite` names. */
  id: string;

  /** What the menu calls it. */
  name: string;

  /** The asset its picture is, by name. */
  picture: string;
}

/** What the pattern stores, shared by everyone on the piece. */
export interface IframeStateData {
  /** The id of the favorite donut, or `null` before one is chosen. */
  favorite: string | null;
}

/** The donuts on the menu, in the order the menu shows them. */
export const MENU: readonly Donut[] = [
  { id: "glazed", name: "Glazed", picture: "glazed" },
  { id: "chocolate", name: "Chocolate", picture: "chocolate" },
];

export const DEFAULT_STATE: IframeStateData = { favorite: null };
