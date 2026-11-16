/**
 * Test Pattern: Text Swapper
 *
 * Drives the swap button and the rename modal through the rendered view:
 * swapping exchanges the two labels, clicking a label opens the modal with
 * that label's text, Save writes the edited text back to that side, and
 * Cancel leaves it alone.
 *
 * Run: deno task cf test patterns/examples/text-swapper/text-swapper.test.tsx
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  findElement,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import TextSwapper from "./text-swapper.tsx";

const modalOpen = (root: unknown): unknown =>
  propValue(findElement(root, "cf-modal"), "$open");

const editField = (root: unknown): unknown =>
  propValue(findElement(root, "cf-input"), "$value");

export default pattern(() => {
  const leftText = Writable.of("Hello");
  const rightText = Writable.of("World");
  const swapper = TextSwapper({ leftText, rightText });

  const assert_initial_labels = assert(() =>
    swapper.leftText === "Hello" && swapper.rightText === "World"
  );
  const assert_modal_closed = assert(() =>
    modalOpen(swapper[UI]) === false && editField(swapper[UI]) === ""
  );

  const action_swap = action(() => clickButton(swapper[UI], "⇄ Swap"));
  const assert_swapped = assert(() =>
    swapper.leftText === "World" && swapper.rightText === "Hello"
  );

  // Clicking the left label, which now reads "World", opens the modal with
  // that text in the field and the header naming the left side.
  const action_open_left = action(() => clickButton(swapper[UI], "World"));
  const assert_editing_left = assert(() =>
    modalOpen(swapper[UI]) === true &&
    editField(swapper[UI]) === "World" &&
    hasText(swapper[UI], "Edit Left Text")
  );

  // The label changes underneath the open modal; Save writes the field's
  // text, so the left side goes back to what the modal was opened with.
  const action_change_left = action(() => leftText.set("Changed"));
  const action_save = action(() => clickButton(swapper[UI], "Save"));
  const assert_saved_left = assert(() =>
    swapper.leftText === "World" && swapper.rightText === "Hello" &&
    modalOpen(swapper[UI]) === false && editField(swapper[UI]) === ""
  );

  const action_open_right = action(() => clickButton(swapper[UI], "Hello"));
  const assert_editing_right = assert(() =>
    modalOpen(swapper[UI]) === true &&
    editField(swapper[UI]) === "Hello" &&
    hasText(swapper[UI], "Edit Right Text")
  );

  const action_change_right = action(() => rightText.set("Changed"));
  const assert_saved_right = assert(() =>
    swapper.rightText === "Hello" && swapper.leftText === "World" &&
    modalOpen(swapper[UI]) === false
  );

  // Cancel closes the modal without writing, so a change made while it was
  // open survives.
  const action_cancel = action(() => clickButton(swapper[UI], "Cancel"));
  const assert_cancel_kept_change = assert(() =>
    swapper.rightText === "Changed" && modalOpen(swapper[UI]) === false &&
    editField(swapper[UI]) === ""
  );

  return {
    [TESTS]: [
      { assertion: assert_initial_labels },
      { assertion: assert_modal_closed },
      { action: action_swap },
      { assertion: assert_swapped },
      { action: action_open_left },
      { assertion: assert_editing_left },
      { action: action_change_left },
      { action: action_save },
      { assertion: assert_saved_left },
      { action: action_open_right },
      { assertion: assert_editing_right },
      { action: action_change_right },
      { action: action_save },
      { assertion: assert_saved_right },
      { action: action_open_right },
      { action: action_change_right },
      { action: action_cancel },
      { assertion: assert_cancel_kept_change },
    ],
    swapper,
  };
});
