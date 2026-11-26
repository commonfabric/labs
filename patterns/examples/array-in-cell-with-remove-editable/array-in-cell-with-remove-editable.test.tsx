import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findNode,
  findNodeByProp,
  fireClick,
  fireEvent,
  hasText,
  innermostNode,
  isButton,
  sendMessage,
} from "../../tools/test-support/vnode-helpers.ts";
import EditableList from "./array-in-cell-with-remove-editable.tsx";

/** The texts of `items`, in order, comma-separated. The pattern declares no
 * output type and its inferred one is `any`, so this parameter is what gives
 * the `items` output the shape the input schema promises. */
const textsOf = (items: readonly { text: string }[]): string =>
  items.map((item) => item.text).join(",");

// The rendered row whose text field holds `text`.
const rowOf = (root: unknown, text: string): unknown =>
  innermostNode(
    root,
    (node) =>
      findNodeByProp(node, "value", text) !== undefined &&
      findNode(node, isButton("Remove")) !== undefined,
  );

export default pattern(() => {
  const list = EditableList({
    title: "Groceries",
    items: [{ text: "milk" }, { text: "eggs" }],
  });

  const action_send_bread = action(() => sendMessage(list[UI], "bread"));
  const action_edit_milk = action(() =>
    fireEvent(
      findNodeByProp(list[UI], "value", "milk"),
      "oncf-change",
      { detail: { value: "oat milk" } },
      "the milk field",
    )
  );
  // Other pieces add items through the exported stream.
  const action_add_jam = action(() =>
    list.addItem.send({ detail: { message: "jam" } })
  );
  const action_remove_eggs = action(() =>
    fireClick(
      findNode(rowOf(list[UI], "eggs"), isButton("Remove")),
      "the Remove button in the eggs row",
    )
  );

  const assert_titled = assert(() =>
    list[NAME] === "Groceries" && hasText(list[UI], "Groceries")
  );
  const assert_starts_with_two = assert(() =>
    textsOf(list.items) === "milk,eggs"
  );
  const assert_bread_added = assert(() =>
    textsOf(list.items) === "milk,eggs,bread" &&
    findNodeByProp(list[UI], "value", "bread") !== undefined
  );
  const assert_milk_edited = assert(() =>
    textsOf(list.items) === "oat milk,eggs,bread"
  );
  const assert_jam_added = assert(() =>
    textsOf(list.items) === "oat milk,eggs,bread,jam" &&
    findNodeByProp(list[UI], "value", "jam") !== undefined
  );
  const assert_eggs_removed = assert(() =>
    textsOf(list.items) === "oat milk,bread,jam" &&
    findNodeByProp(list[UI], "value", "eggs") === undefined &&
    findNodeByProp(list[UI], "value", "bread") !== undefined
  );

  return {
    [TESTS]: [
      { assertion: assert_titled },
      { assertion: assert_starts_with_two },
      { action: action_send_bread },
      { assertion: assert_bread_added },
      { action: action_edit_milk },
      { assertion: assert_milk_edited },
      { action: action_add_jam },
      { assertion: assert_jam_added },
      { action: action_remove_eggs },
      { assertion: assert_eggs_removed },
    ],
    list,
  };
});
