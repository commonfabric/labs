/**
 * Test Pattern: family member
 *
 * Family member is a form over one family record. Its sections fold open and
 * shut from their headers, its tag lists (tags, dietary restrictions,
 * allergies, gift ideas) each write their own field, and the section headers
 * count what the lists hold. The title is the name with the relationship
 * after it, falling back as parts are cleared.
 *
 * This opens every section, edits every list, and clears the name a part at a
 * time, checking the record, the form, or the title after each step.
 * `family-member-same-as.test.tsx` covers the link to another contact.
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
  findElements,
  findNodeByProp,
  fireEvent,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import type { FamilyMember as MemberRecord } from "./contact-types.tsx";
import FamilyMember from "./family-member.tsx";

// Sends a tag list its change event. The lists sit in document order: tags,
// then dietary restrictions and allergies, then gift ideas, as far as the
// sections holding them are open.
const sendTags = (ui: unknown, index: number, tags: string[]): void =>
  fireEvent(
    findElements(ui, "cf-tags")[index],
    "oncf-change",
    { detail: { tags } },
    `tag list ${index}`,
  );

export default pattern(() => {
  const record = new Writable<MemberRecord>({
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
  const member = FamilyMember({ member: record });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_tag_family = action(() => {
    sendTags(member[UI], 0, ["family"]);
  });

  const action_close_family_info = action(() => {
    clickButton(member[UI], "▾ Family Info");
  });

  const action_open_health = action(() => {
    clickButton(member[UI], "▸ Health & Diet");
  });
  const action_set_diet = action(() => {
    sendTags(member[UI], 1, ["vegetarian"]);
  });
  const action_set_allergies = action(() => {
    sendTags(member[UI], 2, ["peanuts", "shellfish"]);
  });

  const action_open_gifts = action(() => {
    clickButton(member[UI], "▸ Gift Ideas");
  });
  const action_set_gifts = action(() => {
    sendTags(member[UI], 3, ["kite"]);
  });

  const action_open_notes = action(() => {
    clickButton(member[UI], "▸ Notes");
  });

  const action_clear_last_name = action(() => {
    record.key("lastName").set("");
  });
  const action_clear_relationship = action(() => {
    record.key("relationship").set("");
  });
  const action_set_last_name_only = action(() => {
    record.key("firstName").set("");
    record.key("lastName").set("Kim");
  });
  const action_clear_name = action(() => {
    record.key("lastName").set("");
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  // Family info starts open and the other sections shut.
  const assert_initial_form = assert(() => {
    const text = textContent(member[UI]);
    return text.includes("▾ Family Info") && text.includes("Relationship") &&
      text.includes("▸ Health & Diet") &&
      !text.includes("Dietary Restrictions") && text.includes("▸ Gift Ideas") &&
      text.includes("▸ Notes");
  });

  const assert_tagged = assert(() => record.get().tags.join("|") === "family");

  const assert_family_info_shut = assert(() => {
    const text = textContent(member[UI]);
    return text.includes("▸ Family Info") && !text.includes("Relationship");
  });

  const assert_health_open = assert(() => {
    const text = textContent(member[UI]);
    return text.includes("▾ Health & Diet") &&
      text.includes("Dietary Restrictions") && text.includes("Allergies");
  });
  const assert_diet_set = assert(() =>
    record.get().dietaryRestrictions.join("|") === "vegetarian" &&
    record.get().allergies.length === 0
  );
  const assert_gifts_open = assert(() =>
    textContent(member[UI]).includes("▾ Gift Ideas") &&
    record.get().giftIdeas.length === 0
  );

  // The header counts dietary restrictions and allergies together.
  const assert_health_counted = assert(() =>
    record.get().dietaryRestrictions.join("|") === "vegetarian" &&
    record.get().allergies.join("|") === "peanuts|shellfish" &&
    textContent(member[UI]).includes("▾ Health & Diet (3)")
  );

  const assert_gifts_counted = assert(() =>
    record.get().giftIdeas.join("|") === "kite" &&
    textContent(member[UI]).includes("▾ Gift Ideas (1)")
  );

  const assert_notes_open = assert(() =>
    findNodeByProp(
      member[UI],
      "placeholder",
      "Notes about this family member...",
    ) !== undefined
  );

  const assert_titled_full = assert(() => member[NAME] === "Bo Kim (cousin)");
  const assert_titled_first_and_relationship = assert(() =>
    member[NAME] === "Bo (cousin)"
  );
  const assert_titled_first_name = assert(() => member[NAME] === "Bo");
  const assert_titled_last_name = assert(() => member[NAME] === "Kim");
  const assert_titled_default = assert(() => member[NAME] === "Family Member");

  return {
    [TESTS]: [
      { assertion: assert_titled_full },
      { assertion: assert_initial_form },

      { action: action_tag_family },
      { assertion: assert_tagged },

      { action: action_close_family_info },
      { assertion: assert_family_info_shut },

      { action: action_open_health },
      { assertion: assert_health_open },
      { action: action_set_diet },
      { assertion: assert_diet_set },
      { action: action_set_allergies },
      { assertion: assert_health_counted },

      { action: action_open_gifts },
      { assertion: assert_gifts_open },
      { action: action_set_gifts },
      { assertion: assert_gifts_counted },

      { action: action_open_notes },
      { assertion: assert_notes_open },

      { action: action_clear_last_name },
      { assertion: assert_titled_first_and_relationship },
      { action: action_clear_relationship },
      { assertion: assert_titled_first_name },
      { action: action_set_last_name_only },
      { assertion: assert_titled_last_name },
      { action: action_clear_name },
      { assertion: assert_titled_default },
    ],
    member,
  };
});
