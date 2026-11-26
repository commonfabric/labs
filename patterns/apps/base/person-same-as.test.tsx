/**
 * Test Pattern: person, linked to another contact
 *
 * Person can record that it is the same as another contact. Once it is
 * offered contacts to choose from, the form shows a link that opens a picker
 * listing them, leaving out any contact with the record's own name. Picking
 * one stores it and shows "Same as:" with its name, and the × beside that
 * clears it again.
 *
 * This offers two contacts, opens the picker, picks one, clears it, and then
 * stores links naming less and less, checking the record and the form after
 * each step.
 */
import { action, assert, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  clickInRow,
  findElement,
  fireEvent,
  pickerLabels,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import type { ContactPiece, Person as PersonRecord } from "./contact-types.tsx";
import FamilyMember from "./family-member.tsx";
import Person from "./person.tsx";

const ada = (): PersonRecord => ({
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

export default pattern(() => {
  const record = new Writable<PersonRecord>(ada());
  const candidates = new Writable<ContactPiece[]>([]);
  const person = Person({ person: record, sameAs: candidates });

  // A family member to offer, and a person with the record's own name, which
  // the picker leaves out.
  const cousin = FamilyMember({
    member: {
      firstName: "Bo",
      lastName: "Kim",
      relationship: "cousin",
      birthday: "",
      dietaryRestrictions: [],
      notes: "",
      tags: [],
      allergies: [],
      giftIdeas: [],
    },
  });
  const twin = Person({ person: ada() });
  const offered: ContactPiece[] = [cousin, twin];

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_offer_candidates = action(() => {
    candidates.set(offered);
  });
  const action_open_picker = action(() => {
    clickButton(person[UI], "Link to another contact...");
  });
  const action_select_nothing = action(() => {
    fireEvent(findElement(person[UI], "cf-autocomplete"), "oncf-select", {
      detail: {},
    });
  });
  const action_select_first_name_only = action(() => {
    fireEvent(findElement(person[UI], "cf-autocomplete"), "oncf-select", {
      detail: { data: { firstName: "Bo", lastName: "" } },
    });
  });
  const action_clear_link = action(() => {
    clickInRow(person[UI], "Same as:", "×");
  });
  const action_link_last_name_only = action(() => {
    record.key("sameAs").set({ firstName: "", lastName: "Kim" });
  });
  const action_link_no_name = action(() => {
    record.key("sameAs").set({ firstName: "", lastName: "" });
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_no_link_offered = assert(() =>
    !textContent(person[UI]).includes("Link to another contact...")
  );
  const assert_link_offered = assert(() =>
    candidates.get().length === 2 &&
    textContent(person[UI]).includes("Link to another contact...")
  );
  // The record's namesake is left out of what the picker offers.
  const assert_picker_offers_cousin_only = assert(() =>
    pickerLabels(findElement(person[UI], "cf-autocomplete")).join("|") ===
      "Bo Kim"
  );
  // A pick that carries no contact changes nothing and leaves the picker up.
  const assert_picker_still_open = assert(() =>
    record.get().sameAs === undefined &&
    pickerLabels(findElement(person[UI], "cf-autocomplete")).join("|") ===
      "Bo Kim"
  );
  const assert_linked_first_name = assert(() => {
    const text = textContent(person[UI]);
    return record.get().sameAs?.firstName === "Bo" &&
      text.includes("Same as: Bo") &&
      pickerLabels(findElement(person[UI], "cf-autocomplete")).length === 0;
  });
  const assert_link_cleared = assert(() =>
    record.get().sameAs === undefined &&
    textContent(person[UI]).includes("Link to another contact...")
  );
  const assert_linked_last_name = assert(() =>
    textContent(person[UI]).includes("Same as: Kim")
  );
  const assert_linked_unknown = assert(() =>
    textContent(person[UI]).includes("Same as: Unknown")
  );

  return {
    [TESTS]: [
      { assertion: assert_no_link_offered },
      { action: action_offer_candidates },
      { assertion: assert_link_offered },
      { action: action_open_picker },
      { assertion: assert_picker_offers_cousin_only },
      { action: action_select_nothing },
      { assertion: assert_picker_still_open },
      { action: action_select_first_name_only },
      { assertion: assert_linked_first_name },
      { action: action_clear_link },
      { assertion: assert_link_cleared },
      { action: action_link_last_name_only },
      { assertion: assert_linked_last_name },
      { action: action_link_no_name },
      { assertion: assert_linked_unknown },
    ],
    person,
  };
});
