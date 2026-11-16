/**
 * Test Pattern: contacts, selecting, removing, and grouping
 *
 * Contacts lists its contacts as cards, each showing the contact's initials
 * and title. A card is selected by clicking it and removed by its ×, and
 * removing one keeps the selection on the same contact where it can and keeps
 * the groups' indices pointing at the same contacts. A button adds an empty
 * group.
 *
 * This adds three contacts, selects and removes them in an order that moves
 * the selection both ways, and adds a group, reading the cards and the groups
 * after each step. `contacts.test.tsx` covers adding contacts and the records
 * they hold.
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  findElements,
  findNode,
  fireClick,
  isButton,
  propValue,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import type { ContactGroup, ContactPiece } from "./contact-types.tsx";
import Contacts from "./contacts.tsx";

// Each card's text, and a star after the selected one, which is tinted blue.
function listing(root: unknown): string {
  return findElements(root, "cf-card")
    .map((card) =>
      textContent(card).trim() +
      (String(propValue(card, "style")).includes("blue-50") ? "*" : "")
    )
    .join("|");
}

export default pattern(() => {
  const groups = new Writable<ContactGroup[]>([]);
  const contacts = Contacts({
    contacts: new Writable<ContactPiece[]>([]),
    groups,
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_add_person = action(() => {
    clickButton(contacts[UI], "+ Person");
  });
  const action_add_family_member = action(() => {
    clickButton(contacts[UI], "+ Family");
  });

  const action_select_second = action(() => {
    fireClick(findElements(contacts[UI], "cf-card")[1], "the second card");
  });
  const action_select_last = action(() => {
    fireClick(findElements(contacts[UI], "cf-card").at(-1), "the last card");
  });

  const action_group_everyone = action(() => {
    groups.set([{ name: "Everyone", contactIndices: [0, 1, 2] }]);
  });

  const action_remove_first = action(() => {
    fireClick(
      findNode(findElements(contacts[UI], "cf-card")[0], isButton("×")),
      "the first card's ×",
    );
  });
  const action_remove_last = action(() => {
    fireClick(
      findNode(findElements(contacts[UI], "cf-card").at(-1), isButton("×")),
      "the last card's ×",
    );
  });

  const action_add_group = action(() => {
    clickButton(contacts[UI], "+ Group");
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  // A one-word title shows one initial and a longer one two. Adding a contact
  // selects it.
  const assert_person_added = assert(() =>
    contacts.count === 1 && listing(contacts[UI]) === "PPerson×*"
  );
  const assert_family_member_added = assert(() =>
    contacts.count === 2 &&
    listing(contacts[UI]) === "PPerson×|FMFamily Member×*"
  );
  const assert_three_with_last_selected = assert(() =>
    contacts.count === 3 &&
    listing(contacts[UI]) === "PPerson×|FMFamily Member×|PPerson×*"
  );

  const assert_second_selected = assert(() =>
    listing(contacts[UI]) === "PPerson×|FMFamily Member×*|PPerson×"
  );

  const assert_grouped = assert(() =>
    contacts.groups[0]?.contactIndices.join(",") === "0,1,2"
  );

  // Removing a contact before the selected one keeps the same contact
  // selected, and the group drops the removed index and shifts the rest down.
  const assert_first_removed = assert(() =>
    contacts.count === 2 &&
    contacts.groups[0]?.contactIndices.join(",") === "0,1" &&
    listing(contacts[UI]) === "FMFamily Member×*|PPerson×"
  );

  const assert_last_selected = assert(() =>
    listing(contacts[UI]) === "FMFamily Member×|PPerson×*"
  );

  // Removing the selected last contact selects the one before it.
  const assert_last_removed = assert(() =>
    contacts.count === 1 &&
    contacts.groups[0]?.contactIndices.join(",") === "0" &&
    listing(contacts[UI]) === "FMFamily Member×*"
  );

  const assert_group_added = assert(() =>
    contacts.groups.length === 2 && contacts.groups[0]?.name === "Everyone" &&
    contacts.groups[1]?.name === "New Group" &&
    contacts.groups[1]?.contactIndices.length === 0
  );

  return {
    [TESTS]: [
      { action: action_add_person },
      { assertion: assert_person_added },
      { action: action_add_family_member },
      { assertion: assert_family_member_added },
      { action: action_add_person },
      { assertion: assert_three_with_last_selected },
      { action: action_select_second },
      { assertion: assert_second_selected },
      { action: action_group_everyone },
      { assertion: assert_grouped },
      { action: action_remove_first },
      { assertion: assert_first_removed },
      { action: action_select_last },
      { assertion: assert_last_selected },
      { action: action_remove_last },
      { assertion: assert_last_removed },
      { action: action_add_group },
      { assertion: assert_group_added },
    ],
    contacts,
  };
});
