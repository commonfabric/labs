/**
 * Drives the verb list's `addItem` verb, the one the guest sends to, and reads
 * the list back through `state.items`.
 */

import { action, assert, FS, pattern, TESTS } from "commonfabric";
import VerbList from "./main.tsx";

export default pattern(() => {
  const list = VerbList({});

  // The verb declares a result and a step takes a stream that declares none,
  // so each event is sent from an action of the test's own.
  const action_add_milk = action(() => {
    list.addItem.send({ id: "milk", text: "Milk" });
  });
  const action_send_milk_again = action(() => {
    list.addItem.send({ id: "milk", text: "Oat milk" });
  });
  const action_add_padded_eggs = action(() => {
    list.addItem.send({ id: "eggs", text: "  Eggs  " });
  });
  const action_add_two_line_bread = action(() => {
    list.addItem.send({ id: "bread", text: "Bread\nand butter" });
  });

  const assert_starts_empty = assert(() => list.state.items.length === 0);
  const assert_holds_milk = assert(() =>
    list.state.items.length === 1 && list.state.items[0].id === "milk" &&
    list.state.items[0].text === "Milk"
  );
  const assert_milk_is_unchanged = assert(() =>
    list.state.items.length === 1 && list.state.items[0].text === "Milk"
  );
  const assert_eggs_follow_milk_trimmed = assert(() =>
    list.state.items.length === 2 && list.state.items[1].id === "eggs" &&
    list.state.items[1].text === "Eggs"
  );
  const assert_text_is_empty = assert(() =>
    list[FS].type === "text/markdown" &&
    list[FS].frontmatter.title === "Verb list" && list[FS].content === ""
  );
  const assert_text_lists_both = assert(() =>
    list[FS].content === "- [ ] Milk\n- [ ] Eggs"
  );
  const assert_text_keeps_bread_on_one_line = assert(() =>
    list[FS].content === "- [ ] Milk\n- [ ] Eggs\n- [ ] Bread and butter"
  );
  const assert_nothing_is_checked_or_hidden = assert(() =>
    Object.keys(list.state.checked).length === 0 &&
    list.output.hideChecked === false
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { assertion: assert_nothing_is_checked_or_hidden },
      { assertion: assert_text_is_empty },

      { action: action_add_milk },
      { assertion: assert_holds_milk },

      { action: action_send_milk_again },
      { assertion: assert_milk_is_unchanged },

      { action: action_add_padded_eggs },
      { assertion: assert_eggs_follow_milk_trimmed },
      { assertion: assert_text_lists_both },

      { action: action_add_two_line_bread },
      { assertion: assert_text_keeps_bread_on_one_line },
    ],
    list,
  };
});
