/**
 * A list shown in a sandboxed iframe, whose items belong to this pattern and
 * change only through its `addItem` verb. The guest is granted the items to
 * read and the check marks to write, and adds an item by sending the verb an
 * event. A caller with no browser sends the same verb, so an item added either
 * way appears in every open frame.
 */

import {
  action,
  dataFile,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  type AddItemEvent,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeOutputData,
  type IframeStateData,
  type ListItem,
} from "./contract.ts";

/** The guest's document. */
const GUEST_HTML = dataFile("./guest.html");

/** The module the guest runs, which `deno bundle` writes from `guest.ts`. */
const GUEST_SCRIPT = dataFile("./guest.js");

/** What `addItem` added, or found there already. */
export interface AddItemResult {
  /** The item as the list holds it. */
  item: ListItem;

  /** Whether this call added it: `false` when the list held its id already. */
  added: boolean;
}

/**
 * A list of items, each of which can be checked off. Read `state.items` for
 * what is on it, and add to it with `addItem`.
 */
export interface VerbListOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The items, and which of them are checked off, by item id. */
  state: IframeStateData;

  /** Whether the frame hides checked-off items, for everyone on the piece. */
  output: IframeOutputData;

  /**
   * Add one item. Mint a fresh `id` for each item; sending an id the list
   * holds already adds nothing, so sending the same event again is safe.
   */
  addItem: Stream<AddItemEvent, AddItemResult>;
}

export default pattern<Record<string, never>, VerbListOutput>(() => {
  const state = new Writable<IframeStateData>(DEFAULT_STATE);
  const output = new Writable<IframeOutputData>(DEFAULT_OUTPUT);

  const addItem = action<AddItemEvent, AddItemResult>(({ id, text }) => {
    if (typeof id !== "string" || id === "") {
      throw new Error("An item needs an id.");
    }
    // The guest keys check marks by item id, and the runtime refuses these
    // two names as record keys, so an item under one could never be checked.
    if (id === "__proto__" || id === "constructor") {
      throw new Error(`An item id cannot be "${id}".`);
    }
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed === "") throw new Error("An item needs text.");
    const items = state.key("items");
    const existing = items.get().find((item) => item.id === id);
    if (existing !== undefined) return { item: existing, added: false };
    const item = { id, text: trimmed };
    items.push(item);
    return { item, added: true };
  });

  return {
    [NAME]: "Verb list",
    [UI]: (
      <div style={{ width: "100%", height: "100vh" }}>
        <cf-iframe
          src={GUEST_HTML}
          script={GUEST_SCRIPT}
          $context={{
            items: state.key("items"),
            checked: state.key("checked"),
            output,
            addItem,
          }}
          resourceKinds={{ items: "readonly", addItem: "stream" }}
        />
      </div>
    ),
    state,
    output,
    addItem,
  };
});
