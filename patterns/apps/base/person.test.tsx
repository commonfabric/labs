/**
 * Test Pattern: person
 *
 * Person is a form over one person record. Its sections fold open and shut
 * from their headers, the birthday shows a readable date once month and day
 * are set, and the title follows whatever part of the name is set.
 *
 * This folds the plain sections open and shut, clears the birthday a part at
 * a time, and clears the name a part at a time, checking the rendered form or
 * the title after each step. `person-lists.test.tsx` covers the addresses and
 * social profiles, and `person-same-as.test.tsx` the link to another contact.
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
  clickButton,
  findNodeByProp,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import type { Person as PersonRecord } from "./contact-types.tsx";
import Person from "./person.tsx";

export default pattern(() => {
  const record = new Writable<PersonRecord>({
    firstName: "Ada",
    lastName: "Lovelace",
    middleName: "",
    nickname: "",
    prefix: "",
    suffix: "",
    pronouns: "",
    birthday: { month: 12, day: 10, year: 1815 },
    photo: "",
    email: "ada@example.com",
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

  const action_clear_birth_year = action(() => {
    record.key("birthday").key("year").set(0);
  });
  const action_clear_birth_month = action(() => {
    record.key("birthday").key("month").set(0);
  });

  const action_open_name_details = action(() => {
    clickButton(person[UI], "▸ Name Details");
  });
  const action_close_contact_info = action(() => {
    clickButton(person[UI], "▾ Contact Info");
  });
  const action_open_notes = action(() => {
    clickButton(person[UI], "▸ Notes");
  });

  const action_clear_first_name = action(() => {
    record.key("firstName").set("");
  });
  const action_clear_last_name = action(() => {
    record.key("lastName").set("");
  });
  const action_set_first_name_only = action(() => {
    record.key("firstName").set("Ada");
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  // Contact info starts open and the other sections shut.
  const assert_initial_form = assert(() => {
    const text = textContent(person[UI]);
    return text.includes("Dec 10, 1815") &&
      text.includes("▸ Name Details") && !text.includes("Middle Name") &&
      text.includes("▾ Contact Info") && text.includes("Phone") &&
      text.includes("▸ Notes");
  });

  const assert_birthday_without_year = assert(() => {
    const text = textContent(person[UI]);
    return text.includes("Dec 10") && !text.includes("Dec 10,");
  });
  const assert_no_birthday = assert(() =>
    !textContent(person[UI]).includes("Dec 10")
  );

  const assert_name_details_open = assert(() => {
    const text = textContent(person[UI]);
    return text.includes("▾ Name Details") && text.includes("Middle Name") &&
      text.includes("Nickname");
  });
  const assert_contact_info_shut = assert(() => {
    const text = textContent(person[UI]);
    return text.includes("▸ Contact Info") && !text.includes("Phone");
  });
  const assert_notes_open = assert(() =>
    findNodeByProp(person[UI], "placeholder", "Notes about this person...") !==
      undefined
  );

  const assert_titled_full_name = assert(() => person[NAME] === "Ada Lovelace");
  const assert_titled_last_name = assert(() => person[NAME] === "Lovelace");
  const assert_titled_default = assert(() => person[NAME] === "Person");
  const assert_titled_first_name = assert(() => person[NAME] === "Ada");

  return {
    [TESTS]: [
      { assertion: assert_titled_full_name },
      { assertion: assert_initial_form },

      { action: action_clear_birth_year },
      { assertion: assert_birthday_without_year },
      { action: action_clear_birth_month },
      { assertion: assert_no_birthday },

      { action: action_open_name_details },
      { assertion: assert_name_details_open },
      { action: action_close_contact_info },
      { assertion: assert_contact_info_shut },
      { action: action_open_notes },
      { assertion: assert_notes_open },

      { action: action_clear_first_name },
      { assertion: assert_titled_last_name },
      { action: action_clear_last_name },
      { assertion: assert_titled_default },
      { action: action_set_first_name_only },
      { assertion: assert_titled_first_name },
    ],
    person,
  };
});
