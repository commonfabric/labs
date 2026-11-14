import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import PersonList, { PersonListView } from "./people-list.tsx";

export default pattern(() => {
  // In a space that mentions no people, the list is empty.
  const empty = PersonList({});
  const list = PersonListView({
    people: [
      { contact: { name: "Ada Lovelace", email: "ada@example.com" } },
      { contact: { name: "Alan Turing", email: "alan@example.com" } },
    ],
  });

  const assert_empty_space_lists_nothing = assert(() =>
    empty[NAME] === "People" && empty.people.length === 0 &&
    !hasText(empty[UI], "@")
  );
  const assert_counts_people = assert(() =>
    list[NAME] === "People: 2" && list.people.length === 2
  );
  const assert_renders_each_contact = assert(() =>
    hasText(list[UI], "Ada Lovelace") &&
    hasText(list[UI], "ada@example.com") &&
    hasText(list[UI], "Alan Turing") && hasText(list[UI], "alan@example.com")
  );

  return {
    [TESTS]: [
      { assertion: assert_empty_space_lists_nothing },
      { assertion: assert_counts_people },
      { assertion: assert_renders_each_contact },
    ],
    list,
  };
});
