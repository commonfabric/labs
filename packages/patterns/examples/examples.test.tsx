/**
 * Test Pattern: the example patterns
 *
 * Each of these is a worked example of one idea: reading a cell into a
 * checkbox, editing an array in place, rendering a sub-path of another
 * pattern's tree, picking one of several options, nesting one counter inside
 * another. They are what someone reads to learn an idiom, so an example that
 * stopped building is worse than no example.
 *
 * This builds each one with real inputs, checks what it publishes, and where
 * an example turns on a value moving — the nested counter, the option picker,
 * the editable array — moves it and checks the result.
 */
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
  findElement,
  findNodeByProp,
  hasText,
  textContent,
} from "../test/vnode-helpers.ts";
import ArbitraryWishExample from "./arbitrary-wish-example.tsx";
import ArrayInCell from "./array-in-cell-with-remove-editable.tsx";
import CfChartDemo from "./cf-chart-demo.tsx";
import CheckboxCell from "./cf-checkbox-cell.tsx";
import CodeEditorCell from "./cf-code-editor-cell.tsx";
import CfRenderSubpath from "./cf-render-subpath.tsx";
import CfRender from "./cf-render.tsx";
import CfTags from "./cf-tags.tsx";
import DragDropDemo from "./drag-drop-demo.tsx";
import MultiOptionSelection from "./multi-option-selection.tsx";
import NestedCounter from "./nested-counter.tsx";
import NestedMentionables from "./nested-mentionables.tsx";
import OutputSchema from "./output_schema.tsx";
import ProfileAwareWriter from "./profile-aware-writer.tsx";
import UiVariantsDemo from "./ui-variants-demo.tsx";
import UiVariantsHost from "./ui-variants-host.tsx";
import WishNoteExample from "./wish-note-example.tsx";

export default pattern(() => {
  const arrayItems = new Writable<{ text: string }[]>([
    { text: "first" },
    { text: "second" },
  ]);
  const arrayInCell = ArrayInCell({ title: "List", items: arrayItems });

  const simpleEnabled = new Writable(false);
  const trackedEnabled = new Writable(false);
  const checkboxCell = CheckboxCell({ simpleEnabled, trackedEnabled });

  const codeEditorCell = CodeEditorCell({ content: "const x = 1;" });

  const counterValue = new Writable(0);
  const cfRender = CfRender({ value: counterValue });
  const cfRenderSubpath = CfRenderSubpath({ title: "Subpath" });

  const tags = new Writable<string[]>(["alpha", "beta"]);
  const cfTags = CfTags({ tags });

  const chartDemo = CfChartDemo({});

  const dragDrop = DragDropDemo({
    availableItems: [{ title: "one" }, { title: "two" }],
    droppedItems: [],
  });

  const selected = new Writable("opt_1");
  const numericChoice = new Writable(1);
  const category = new Writable("Other");
  const activeTab = new Writable("tab1");
  const multiOption = MultiOptionSelection({
    selected,
    numericChoice,
    category,
    activeTab,
  });

  const nestedValue = new Writable(3);
  const nestedCounter = NestedCounter({ value: nestedValue });

  const outputSchema = OutputSchema({ value: 7 });
  const uiVariants = UiVariantsDemo({ title: "UI Variants Demo" });
  const uiVariantsHost = UiVariantsHost({});
  const nestedMentionables = NestedMentionables({});
  const profileAwareWriter = ProfileAwareWriter({});
  const arbitraryWish = ArbitraryWishExample({});
  const wishNote = WishNoteExample({});

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_remove_first_item = action(() => {
    arrayItems.set(arrayItems.get().slice(1));
  });

  const action_check_both_boxes = action(() => {
    simpleEnabled.set(true);
    trackedEnabled.set(true);
  });

  const action_pick_second_option = action(() => {
    selected.set("opt_2");
    numericChoice.set(2);
  });

  const action_bump_counter = action(() => {
    nestedValue.set(nestedValue.get() + 1);
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  // The editable array puts each item's text in an input's value rather than
  // as a text child, so the search is over that prop.
  const assert_array_lists_items = assert(() =>
    findNodeByProp(arrayInCell[UI], "value", "first") != null &&
    findNodeByProp(arrayInCell[UI], "value", "second") != null
  );

  const assert_array_lost_first = assert(() =>
    findNodeByProp(arrayInCell[UI], "value", "first") == null &&
    findNodeByProp(arrayInCell[UI], "value", "second") != null
  );

  const assert_boxes_start_unchecked = assert(() =>
    simpleEnabled.get() === false && trackedEnabled.get() === false &&
    textContent(checkboxCell[UI]).length > 0
  );

  const assert_boxes_checked = assert(() =>
    simpleEnabled.get() === true && trackedEnabled.get() === true
  );

  const assert_option_starts_first = assert(() =>
    selected.get() === "opt_1" && numericChoice.get() === 1 &&
    textContent(multiOption[UI]).length > 0
  );

  const assert_option_moved = assert(() =>
    selected.get() === "opt_2" && numericChoice.get() === 2
  );

  // The nested counter passes its value down to an inner counter, so the
  // inner one has to show what the outer one holds.
  const assert_counter_starts_at_3 = assert(() =>
    hasText(nestedCounter[UI], "3")
  );

  const assert_counter_bumped = assert(() => hasText(nestedCounter[UI], "4"));

  const assert_render_examples_build = assert(() =>
    textContent(cfRender[UI]).length > 0 &&
    cfRenderSubpath[NAME] === "Subpath Test: Subpath" &&
    textContent(cfRenderSubpath[UI]).length > 0
  );

  // The tags example hands its list to cf-tags through a bound prop, so the
  // tags are behind the binding rather than in the tree's text. What the tree
  // shows is that the component is there; the cell holds the tags themselves.
  const assert_tags_bound = assert(() =>
    findElement(cfTags[UI], "cf-tags") != null &&
    tags.get().length === 2 && tags.get()[0] === "alpha"
  );

  const assert_drag_drop_lists_items = assert(() =>
    hasText(dragDrop[UI], "one") && hasText(dragDrop[UI], "two")
  );

  // The rest are read for the tree they build, which is what running their
  // derived expressions takes. The wish note starts with nothing to show and no
  // text of its own, so it is checked for a tree rather than for text.
  const assert_remaining_examples_build = assert(() =>
    textContent(codeEditorCell[UI]).length > 0 &&
    textContent(chartDemo[UI]).length > 0 &&
    textContent(outputSchema[UI]).length > 0 &&
    textContent(uiVariants[UI]).length > 0 &&
    textContent(uiVariantsHost[UI]).length > 0 &&
    textContent(nestedMentionables[UI]).length > 0 &&
    textContent(profileAwareWriter[UI]).length > 0 &&
    textContent(arbitraryWish[UI]).length > 0 &&
    wishNote[UI] != null
  );

  return {
    [TESTS]: [
      { assertion: assert_array_lists_items },
      { assertion: assert_boxes_start_unchecked },
      { assertion: assert_option_starts_first },
      { assertion: assert_counter_starts_at_3 },
      { assertion: assert_render_examples_build },
      { assertion: assert_tags_bound },
      { assertion: assert_drag_drop_lists_items },
      { assertion: assert_remaining_examples_build },

      { action: action_remove_first_item },
      { assertion: assert_array_lost_first },

      { action: action_check_both_boxes },
      { assertion: assert_boxes_checked },

      { action: action_pick_second_option },
      { assertion: assert_option_moved },

      { action: action_bump_counter },
      { assertion: assert_counter_bumped },
    ],
  };
});
