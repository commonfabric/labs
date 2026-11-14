/**
 * Test Pattern: person, addresses and social profiles
 *
 * Person keeps a list of addresses and a list of social profiles, each in a
 * section that folds open from its header. An open section adds a blank row
 * from its add button and removes a row from the × on it, and the header
 * counts the rows whether the section is open or shut.
 *
 * This opens each section, adds two rows, fills them in, removes the first by
 * the × on its row, and checks the record or the form after each step.
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  findNode,
  findNodeByProp,
  fireClick,
  innermostNode,
  isButton,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import type { Person as PersonRecord } from "./contact-types.tsx";
import Person from "./person.tsx";

// Clicks the × on the row holding a field whose value is `value`.
function removeRow(ui: unknown, value: string): void {
  const row = innermostNode(
    ui,
    (node) =>
      findNodeByProp(node, "$value", value) !== undefined &&
      findNode(node, isButton("×")) !== undefined,
  );
  fireClick(findNode(row, isButton("×")), `the × on the row holding ${value}`);
}

export default pattern(() => {
  const record = new Writable<PersonRecord>({
    firstName: "Ada",
    lastName: "Lovelace",
    middleName: "",
    nickname: "",
    prefix: "",
    suffix: "",
    pronouns: "",
    birthday: { month: 0, day: 0, year: 0 },
    photo: "",
    email: "",
    phone: "",
    notes: "",
    tags: [],
    addresses: [],
    socialProfiles: [],
  });
  const person = Person({ person: record });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_open_addresses = action(() => {
    clickButton(person[UI], "▸ Addresses");
  });
  const action_add_address = action(() => {
    clickButton(person[UI], "+ Add Address");
  });
  const action_name_streets = action(() => {
    record.key("addresses").key(0).key("street").set("1 Oak St");
    record.key("addresses").key(1).key("street").set("2 Elm St");
  });
  const action_remove_oak = action(() => {
    removeRow(person[UI], "1 Oak St");
  });
  const action_close_addresses = action(() => {
    clickButton(person[UI], "▾ Addresses (1)");
  });

  const action_open_social = action(() => {
    clickButton(person[UI], "▸ Social Profiles");
  });
  const action_add_profile = action(() => {
    clickButton(person[UI], "+ Add Profile");
  });
  const action_name_profiles = action(() => {
    record.key("socialProfiles").key(0).key("url").set("https://old.example");
    record.key("socialProfiles").key(1).key("url").set("https://ada.dev");
  });
  const action_remove_old_profile = action(() => {
    removeRow(person[UI], "https://old.example");
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_lists_shut_and_empty = assert(() => {
    const text = textContent(person[UI]);
    return text.includes("▸ Addresses") && !text.includes("Addresses (") &&
      text.includes("▸ Social Profiles") && !text.includes("+ Add Address");
  });

  const assert_addresses_open = assert(() => {
    const text = textContent(person[UI]);
    return text.includes("▾ Addresses") && text.includes("+ Add Address");
  });
  const assert_one_blank_address = assert(() =>
    record.get().addresses.length === 1 &&
    record.get().addresses[0].street === ""
  );
  const assert_two_blank_addresses = assert(() =>
    record.get().addresses.length === 2 &&
    record.get().addresses[1].street === "" &&
    textContent(person[UI]).includes("▾ Addresses (2)")
  );
  const assert_streets_named = assert(() =>
    record.get().addresses.map((address) => address.street).join("|") ===
      "1 Oak St|2 Elm St"
  );
  const assert_oak_removed = assert(() =>
    record.get().addresses.map((address) => address.street).join("|") ===
      "2 Elm St"
  );
  // A shut section still counts its rows.
  const assert_addresses_shut_with_count = assert(() => {
    const text = textContent(person[UI]);
    return text.includes("▸ Addresses (1)") && !text.includes("+ Add Address");
  });

  const assert_social_open = assert(() => {
    const text = textContent(person[UI]);
    return text.includes("▾ Social Profiles") && text.includes("+ Add Profile");
  });
  const assert_one_blank_profile = assert(() =>
    record.get().socialProfiles.length === 1 &&
    record.get().socialProfiles[0].url === ""
  );
  const assert_two_blank_profiles = assert(() =>
    record.get().socialProfiles.length === 2 &&
    record.get().socialProfiles[1].url === ""
  );
  const assert_profiles_named = assert(() =>
    record.get().socialProfiles.map((profile) => profile.url).join("|") ===
      "https://old.example|https://ada.dev"
  );
  const assert_old_profile_removed = assert(() =>
    record.get().socialProfiles.map((profile) => profile.url).join("|") ===
      "https://ada.dev" &&
    textContent(person[UI]).includes("▾ Social Profiles (1)")
  );

  return {
    [TESTS]: [
      { assertion: assert_lists_shut_and_empty },

      { action: action_open_addresses },
      { assertion: assert_addresses_open },
      { action: action_add_address },
      { assertion: assert_one_blank_address },
      { action: action_add_address },
      { assertion: assert_two_blank_addresses },
      { action: action_name_streets },
      { assertion: assert_streets_named },
      { action: action_remove_oak },
      { assertion: assert_oak_removed },
      { action: action_close_addresses },
      { assertion: assert_addresses_shut_with_count },

      { action: action_open_social },
      { assertion: assert_social_open },
      { action: action_add_profile },
      { assertion: assert_one_blank_profile },
      { action: action_add_profile },
      { assertion: assert_two_blank_profiles },
      { action: action_name_profiles },
      { assertion: assert_profiles_named },
      { action: action_remove_old_profile },
      { assertion: assert_old_profile_removed },
    ],
    person,
  };
});
