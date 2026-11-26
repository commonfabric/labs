/**
 * Test Pattern: contacts, and the two record patterns it creates
 *
 * Contacts is a list of contact pieces with two buttons above it: one adds a
 * person, the other adds a family member. Each button instantiates the
 * matching record pattern and pushes the new piece onto the list. Person and
 * family member both title themselves from the name they hold.
 *
 * This drives the list through both buttons and checks the count and title
 * that come back. Person and family member are also instantiated on their own,
 * so their forms are built and read, and a person's name is edited through the
 * same cell the form writes to, to see the title follow.
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
  findElement,
  findNode,
  fireClick,
  fireEvent,
  hasText,
  isButton,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import type { ContactPiece, Person as PersonRecord } from "./contact-types.tsx";
import Contacts from "./contacts.tsx";
import FamilyMember from "./family-member.tsx";
import Person from "./person.tsx";

export default pattern(() => {
  const contactList = new Writable<ContactPiece[]>([]);
  const groups = new Writable<[]>([]);
  const contacts = Contacts({ contacts: contactList, groups });

  // Two records instantiated on their own, so their forms are built and read
  // outside the list's add path.
  const personCell = new Writable({
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
  const person = Person({ person: personCell });

  const memberCell = new Writable({
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
  const member = FamilyMember({ member: memberCell });
  const memberPiece: ContactPiece = member;

  // Person reads through the `Person` interface, which has no `relationship`.
  // This cell stores one anyway, standing in for the every-day case of a
  // record that carries more than the reader it is handed to declares.
  const widerCell = new Writable({
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
    // Typed, because `[]` alone infers `never[]`, whose schema admits no
    // element, and the tags written below are read back through this cell.
    tags: [] as string[],
    addresses: [],
    socialProfiles: [],
    relationship: "cousin",
  });
  const widerPerson = Person({ person: widerCell });

  // A wider record linked to another through `sameAs`. The link is shown once
  // there is a candidate, the family member above, offered below. Clearing the link writes `sameAs` alone, so the field
  // `Person` does not declare has to survive it.
  const linkedCell = new Writable<PersonRecord & { relationship: string }>({
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
    relationship: "cousin",
    sameAs: { firstName: "Augusta", lastName: "King" },
  });
  const linkCandidates = new Writable<ContactPiece[]>([]);
  const linkedPerson = Person({ person: linkedCell, sameAs: linkCandidates });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_add_person = action(() => {
    clickButton(contacts[UI], "+ Person");
  });

  const action_add_family_member = action(() => {
    clickButton(contacts[UI], "+ Family");
  });

  // Editing tags writes one field. Everything the writer cannot see has to
  // still be there afterwards.
  const action_edit_wider_tags = action(() => {
    fireEvent(findElement(widerPerson[UI], "cf-tags"), "oncf-change", {
      detail: { tags: ["colleague"] },
    });
  });

  const action_offer_candidate = action(() => {
    linkCandidates.push(memberPiece);
  });

  const action_clear_link = action(() => {
    fireClick(findNode(linkedPerson[UI], isButton("×")), "the link's ×");
  });

  const action_rename_person = action(() => {
    personCell.key("firstName").set("Grace");
    personCell.key("lastName").set("Hopper");
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_starts_empty = assert(() =>
    contacts.count === 0 && contacts.contacts.length === 0 &&
    contacts[NAME] === "Contacts (0)"
  );

  const assert_has_one_contact = assert(() =>
    contacts.count === 1 && contacts[NAME] === "Contacts (1)"
  );

  const assert_has_two_contacts = assert(() =>
    contacts.count === 2 && contacts[NAME] === "Contacts (2)"
  );

  // A record titles itself from the name it holds.
  const assert_person_named = assert(() =>
    person[NAME] === "Ada Lovelace" && person.person.email === "ada@example.com"
  );

  const assert_person_renamed = assert(() =>
    person[NAME] === "Grace Hopper" &&
    person.person.firstName === "Grace"
  );

  const assert_member_named = assert(() =>
    member[NAME] === "Bo Kim (cousin)" &&
    member.member.relationship === "cousin"
  );

  const assert_wider_intact = assert(() =>
    widerCell.get().relationship === "cousin"
  );

  const assert_tags_written_and_wider_intact = assert(() =>
    widerCell.get().tags.length === 1 &&
    widerCell.get().tags[0] === "colleague" &&
    widerCell.get().relationship === "cousin" &&
    widerCell.get().email === "ada@example.com"
  );

  const assert_linked = assert(() =>
    hasText(linkedPerson[UI], "Same as: Augusta King")
  );

  const assert_link_cleared_and_wider_intact = assert(() =>
    linkedCell.get().sameAs === undefined &&
    linkedCell.get().relationship === "cousin" &&
    linkedCell.get().email === "ada@example.com" &&
    !hasText(linkedPerson[UI], "Same as:")
  );

  // Each record builds a form with the fields it holds.
  const assert_forms_render = assert(() =>
    hasText(person[UI], "First Name") &&
    hasText(member[UI], "First Name") &&
    textContent(contacts[UI]).length > 0
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { assertion: assert_person_named },
      { assertion: assert_member_named },
      { assertion: assert_forms_render },

      { action: action_add_person },
      { assertion: assert_has_one_contact },

      { action: action_add_family_member },
      { assertion: assert_has_two_contacts },

      { action: action_rename_person },
      { assertion: assert_person_renamed },

      { assertion: assert_wider_intact },
      { action: action_edit_wider_tags },
      { assertion: assert_tags_written_and_wider_intact },

      { action: action_offer_candidate },
      { assertion: assert_linked },
      { action: action_clear_link },
      { assertion: assert_link_cleared_and_wider_intact },
    ],
    contacts,
    person,
    member,
    widerPerson,
    linkedPerson,
  };
});
