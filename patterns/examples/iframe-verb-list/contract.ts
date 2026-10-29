/**
 * The data contract of the verb list's frame. The items belong to the pattern
 * in `main.tsx`, which hands them to the guest as input and changes them only
 * through its `addItem` verb; the frame takes that verb as the stream the
 * guest sends to. What the guest owns is which items are checked off, and
 * whether the list hides them.
 */

/** One entry on the list. */
export interface ListItem {
  /** Stable id, minted by whoever asked for the item. */
  id: string;

  /** What the entry says. */
  text: string;
}

/** What the guest is handed: the pattern's items, which it cannot write. */
export interface IframeInputData {
  /** Every item on the list, in the order they were added. */
  items: ListItem[];
}

/** What the guest stores, shared by everyone on the piece. */
export interface IframeStateData {
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

/** The event each stream the frame takes carries, by stream name. */
export interface IframeStreamEvents {
  addItem: AddItemEvent;
}

export const DEFAULT_INPUT: IframeInputData = {
  items: [],
};

export const DEFAULT_STATE: IframeStateData = {
  checked: {},
};

export const DEFAULT_OUTPUT: IframeOutputData = {
  hideChecked: false,
};

export const IFRAME_PATTERN = {
  name: "VerbListFrame",
  displayName: "Verb list",
  stateScope: "space",
  outputScope: "space",
  frameHeight: "100vh",
  databases: {},
  streams: ["addItem"],
} as const;
