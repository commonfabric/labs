/**
 * Test Pattern: family member, linked to another contact
 *
 * Family member can record that it is the same as another contact. Once it
 * is offered contacts to choose from, the form shows a link that opens a
 * picker listing them, leaving out any contact with the record's own name.
 * Picking one stores it and shows "Same as:" with its name, and the × beside
 * that clears it again.
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
import type {
  ContactPiece,
  FamilyMember as MemberRecord,
} from "./contact-types.tsx";
import FamilyMember from "./family-member.tsx";
import Person from "./person.tsx";

const bo = (): MemberRecord => ({
  firstName: "Bo",
  lastName: "Kim",
  relationship: "cousin",
  birthday: "",
  dietaryRestrictions: [],
  notes: "",
  tags: [],
  allergies: [],
  giftIdeas: [],
});

export default pattern(() => {
  const record = new Writable<MemberRecord>(bo());
  const candidates = new Writable<ContactPiece[]>([]);
  const member = FamilyMember({ member: record, sameAs: candidates });

  // A person to offer, and a family member with the record's own name, which
  // the picker leaves out.
  const ada = Person({
    person: {
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
    },
  });
  const twin = FamilyMember({ member: bo() });
  const offered: ContactPiece[] = [ada, twin];

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_offer_candidates = action(() => {
    candidates.set(offered);
  });
  const action_open_picker = action(() => {
    clickButton(member[UI], "Link to another contact...");
  });
  const action_select_nothing = action(() => {
    fireEvent(findElement(member[UI], "cf-autocomplete"), "oncf-select", {
      detail: {},
    });
  });
  const action_select_ada = action(() => {
    fireEvent(findElement(member[UI], "cf-autocomplete"), "oncf-select", {
      detail: { data: { firstName: "Ada", lastName: "Lovelace" } },
    });
  });
  const action_clear_link = action(() => {
    clickInRow(member[UI], "Same as:", "×");
  });
  const action_link_first_name_only = action(() => {
    record.key("sameAs").set({ firstName: "Ada", lastName: "" });
  });
  const action_link_last_name_only = action(() => {
    record.key("sameAs").set({ firstName: "", lastName: "Lovelace" });
  });
  const action_link_no_name = action(() => {
    record.key("sameAs").set({ firstName: "", lastName: "" });
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_no_link_offered = assert(() =>
    !textContent(member[UI]).includes("Link to another contact...")
  );
  const assert_link_offered = assert(() =>
    candidates.get().length === 2 &&
    textContent(member[UI]).includes("Link to another contact...")
  );
  // The record's namesake is left out of what the picker offers.
  const assert_picker_offers_ada_only = assert(() =>
    pickerLabels(findElement(member[UI], "cf-autocomplete")).join("|") ===
      "Ada Lovelace"
  );
  // A pick that carries no contact changes nothing and leaves the picker up.
  const assert_picker_still_open = assert(() =>
    record.get().sameAs === undefined &&
    pickerLabels(findElement(member[UI], "cf-autocomplete")).join("|") ===
      "Ada Lovelace"
  );
  const assert_linked_ada = assert(() =>
    record.get().sameAs?.lastName === "Lovelace" &&
    textContent(member[UI]).includes("Same as: Ada Lovelace") &&
    pickerLabels(findElement(member[UI], "cf-autocomplete")).length === 0
  );
  const assert_link_cleared = assert(() =>
    record.get().sameAs === undefined &&
    textContent(member[UI]).includes("Link to another contact...")
  );
  const assert_linked_first_name = assert(() => {
    const text = textContent(member[UI]);
    return text.includes("Same as: Ada") &&
      !text.includes("Same as: Ada Lovelace");
  });
  const assert_linked_last_name = assert(() =>
    textContent(member[UI]).includes("Same as: Lovelace")
  );
  const assert_linked_unknown = assert(() =>
    textContent(member[UI]).includes("Same as: Unknown")
  );

  return {
    [TESTS]: [
      { assertion: assert_no_link_offered },
      { action: action_offer_candidates },
      { assertion: assert_link_offered },
      { action: action_open_picker },
      { assertion: assert_picker_offers_ada_only },
      { action: action_select_nothing },
      { assertion: assert_picker_still_open },
      { action: action_select_ada },
      { assertion: assert_linked_ada },
      { action: action_clear_link },
      { assertion: assert_link_cleared },
      { action: action_link_first_name_only },
      { assertion: assert_linked_first_name },
      { action: action_link_last_name_only },
      { assertion: assert_linked_last_name },
      { action: action_link_no_name },
      { assertion: assert_linked_unknown },
    ],
    member,
  };
});
