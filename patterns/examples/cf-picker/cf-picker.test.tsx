import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  findElementByExactText,
  findNodeByProp,
  propsOf,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import CfPickerDemo from "./cf-picker.tsx";

const pressButton = (ui: unknown, label: string) => {
  const onClick = propsOf(findElementByExactText(ui, "cf-button", label))
    ?.onClick;
  if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
    (onClick as { send: (event: Record<string, never>) => void }).send({});
  }
};

const selectedIndexOf = (ui: unknown): unknown =>
  propValue(findElement(ui, "cf-picker"), "$selectedIndex");

// The Note renders its body through a bound `$value` prop rather than as text
// children, so the preview above the picker is found by that prop.
const notePreviewed = (ui: unknown): boolean =>
  findNodeByProp(ui, "$value", "This is item B (a Note)") !== undefined;

// The picker's bound item list, or an empty list while the tree is between
// renders and the node has not been placed yet.
const itemsOf = (ui: unknown): unknown[] => {
  const items = propValue(findElement(ui, "cf-picker"), "$items");
  return Array.isArray(items) ? items : [];
};

export default pattern(() => {
  const subject = CfPickerDemo({});

  const action_next = action(() => pressButton(subject[UI], "Next"));
  const action_prev = action(() => pressButton(subject[UI], "Prev"));

  const assert_built = assert(() => subject != null);
  const assert_counters_seeded = assert(() =>
    subject.counterAValue === 10 && subject.counterCValue === 30
  );
  const assert_three_items = assert(() => itemsOf(subject[UI]).length === 3);
  const assert_first_selected = assert(() =>
    selectedIndexOf(subject[UI]) === 0
  );
  const assert_second_selected = assert(() =>
    selectedIndexOf(subject[UI]) === 1
  );
  const assert_last_selected = assert(() => selectedIndexOf(subject[UI]) === 2);
  // Only the second item is a Note, so the preview naming it is the proof that
  // the selection followed the index.
  const assert_note_previewed = assert(() => notePreviewed(subject[UI]));
  const assert_note_not_previewed = assert(() => !notePreviewed(subject[UI]));

  return {
    [TESTS]: [
      { assertion: assert_built },
      { assertion: assert_counters_seeded },
      { assertion: assert_three_items },
      { assertion: assert_first_selected },
      { assertion: assert_note_not_previewed },

      { action: action_next },
      { assertion: assert_second_selected },
      { assertion: assert_note_previewed },

      // Two more presses against a three-item list: the second one has nowhere
      // to go, so the index stays on the last item.
      { action: action_next },
      { action: action_next },
      { assertion: assert_last_selected },

      { action: action_prev },
      { assertion: assert_second_selected },

      // Likewise at the front of the list.
      { action: action_prev },
      { action: action_prev },
      { assertion: assert_first_selected },
      { assertion: assert_note_not_previewed },
    ],
    subject,
  };
});
