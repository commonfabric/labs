import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickInRow,
  findElement,
  fireEvent,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import DragDropDemo from "./drag-drop-demo.tsx";

interface Item {
  title: string;
}

export default pattern(() => {
  const availableItems = Writable.of<Item[]>([
    { title: "Alpha" },
    { title: "Beta" },
  ]);
  const demo = DragDropDemo({ availableItems, droppedItems: [] });
  const fallback = DragDropDemo({});
  const beta: Writable<Item> = availableItems.key(1);

  // What the drop zone reports when a drag source holding `beta` lands on it.
  const action_drop_beta = action(() =>
    fireEvent(
      findElement(demo[UI], "cf-drop-zone"),
      "oncf-drop",
      { detail: { sourceCell: beta } },
      "the drop zone",
    )
  );
  const action_remove_beta = action(() => clickInRow(demo[UI], "Beta", "×"));

  const assert_lists_given_items = assert(() =>
    demo[NAME] === "Drag Drop Demo" && hasText(demo[UI], "Alpha") &&
    hasText(demo[UI], "Beta") && hasText(demo[UI], "Drop items here")
  );
  const assert_falls_back_to_defaults = assert(() =>
    hasText(fallback[UI], "Item A") && hasText(fallback[UI], "Item C") &&
    !hasText(fallback[UI], "Alpha")
  );
  const assert_beta_dropped = assert(() =>
    demo.droppedItems.length === 1 && demo.droppedItems[0].title === "Beta" &&
    !hasText(demo[UI], "Drop items here")
  );
  const assert_beta_removed = assert(() =>
    demo.droppedItems.length === 0 && hasText(demo[UI], "Drop items here") &&
    demo.availableItems.length === 2
  );

  return {
    [TESTS]: [
      { assertion: assert_lists_given_items },
      { assertion: assert_falls_back_to_defaults },
      { action: action_drop_beta },
      { assertion: assert_beta_dropped },
      { action: action_remove_beta },
      { assertion: assert_beta_removed },
    ],
    demo,
    fallback,
  };
});
