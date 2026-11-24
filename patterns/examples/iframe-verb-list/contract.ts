/**
 * The data the verb list's pattern and its guest share. The pattern keeps the
 * items in its `state` and changes them only through its `addItem` verb, which
 * the guest sends an event to; the guest is granted the items to read, and
 * writes only which of them are checked off, and whether the list hides them.
 */

/** One entry on the list. */
export interface ListItem {
  /** Stable id, minted by whoever asked for the item. */
  id: string;

  /** What the entry says. */
  text: string;
}

/** What the pattern stores, shared by everyone on the piece. */
export interface IframeStateData {
  /** Every item on the list, in the order they were added. */
  items: ListItem[];

  /** Whether each item is checked off, by item id. */
  checked: Record<string, boolean>;
}

/** What the guest publishes, shared by everyone on the piece. */
export interface IframeOutputData {
  /** Whether the list hides the items that are checked off. */
  hideChecked: boolean;
}

/** The event the guest sends to `addItem`. */
export interface AddItemEvent {
  /** Id for the new item. An id the list already holds adds nothing. */
  id: string;

  /** Text of the new item. Whitespace around it is dropped. */
  text: string;
}

export const DEFAULT_STATE: IframeStateData = {
  items: [],
  checked: {},
};

export const DEFAULT_OUTPUT: IframeOutputData = {
  hideChecked: false,
};
