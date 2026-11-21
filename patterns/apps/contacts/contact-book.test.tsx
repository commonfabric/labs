/**
 * Test Pattern: contact book
 *
 * A contact book lists contacts as cards, filters them by a search query over
 * name, email, and company, links two of them with a labeled relationship,
 * and deletes a contact from its card. It summarizes the book as its
 * contacts' names, and shows a placeholder while it has none.
 *
 * This checks the search on its own, then drives an empty book through adding
 * a contact, and a seeded book through searching, linking, and deleting,
 * reading the cards after each step.
 *
 * Run: deno task cf test patterns/apps/contacts/contact-book.test.tsx
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  findElements,
  findNode,
  findNodeByProp,
  fireClick,
  hasText,
  isButton,
  isElement,
  pickerLabels,
  propValue,
  textContent,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";
import { default as ContactBook, matchesSearch } from "./contact-book.tsx";
import { type Contact } from "./contact-detail.tsx";

// Helper to get array length with proper reactivity tracking
const len = <T,>(arr: T[]): number => arr.filter(() => true).length;

const testContact: Contact = {
  name: "Conrad Common",
  email: "conrad@testmail.io",
  company: "Widgets Inc",
  notes: "Common",
  tags: [
    "common",
  ],
  phone: "0",
  createdAt: 0,
};

const dana: Contact = {
  name: "Dana",
  email: "",
  company: "",
  notes: "",
  tags: [],
  phone: "",
  createdAt: 0,
};

// The visible contact cards' text, in order.
function cardTexts(root: unknown): string[] {
  return findElements(root, "cf-card").map(textContent);
}

// The value of the field with this placeholder.
function fieldValue(root: unknown, placeholder: string): unknown {
  return propValue(findNodeByProp(root, "placeholder", placeholder), "$value");
}

// The × on the card for `name`, the one whose text starts with it: another
// card names it too once the two are linked.
function deleteCard(root: unknown, name: string): void {
  const card = findNode(
    root,
    (node) => isElement(node, "cf-card") && textContent(node).startsWith(name),
  );
  fireClick(findNode(card, isButton("×")), `the × on ${name}'s card`);
}

export default pattern(() => {
  // Initial state assertions
  const assert_empty_query_matches_all = assert(() =>
    matchesSearch(testContact, "")
  );

  const assert_name_query_matches = assert(() =>
    matchesSearch(testContact, "conrad")
  );

  const assert_email_query_matches = assert(() =>
    matchesSearch(testContact, "testmail")
  );

  const assert_company_query_matches = assert(() =>
    matchesSearch(testContact, "widgets")
  );

  const assert_other_query_misses = assert(() =>
    !matchesSearch(testContact, "gadgets")
  );

  // ==========================================================================
  // An empty book
  // ==========================================================================

  const contactBook = ContactBook({ contacts: [], relationships: [] });

  const action_add_contact = action(() => {
    contactBook.onAddContact.send();
  });

  const assert_empty_placeholder = assert(() =>
    hasText(contactBook[UI], "No contacts yet") && contactBook.summary === ""
  );

  const assert_one_contact = assert(
    () => len(contactBook.contacts) == 1,
  );

  // A contact with no name is listed and summarized as unnamed.
  const assert_unnamed_listed = assert(() =>
    contactBook.summary === "(unnamed)" &&
    cardTexts(contactBook[UI]).join("|") === "(unnamed)×" &&
    !hasText(contactBook[UI], "No contacts yet")
  );

  // ==========================================================================
  // A seeded book
  // ==========================================================================

  const book = ContactBook({
    contacts: [testContact, dana],
    relationships: [],
  });

  const action_search_widgets = action(() => {
    typeInto(book[UI], "Search contacts...", "widgets");
  });
  const action_clear_search = action(() => {
    typeInto(book[UI], "Search contacts...", "");
  });

  const action_pick_same_contact_twice = action(() => {
    typeInto(book[UI], "From...", "Dana");
    typeInto(book[UI], "To...", "Dana");
  });
  const action_pick_pair = action(() => {
    typeInto(book[UI], "From...", "Conrad Common");
    typeInto(book[UI], "To...", "Dana");
    typeInto(book[UI], "Label...", "colleague");
  });
  const action_link = action(() => {
    clickButton(book[UI], "Link");
  });

  const action_delete_conrad = action(() => {
    deleteCard(book[UI], "Conrad Common");
  });

  const assert_seeded_summary = assert(() =>
    book.summary === "Conrad Common, Dana"
  );

  // Both relationship pickers offer every contact by name.
  const assert_pickers_offer_contacts = assert(() =>
    pickerLabels(findNodeByProp(book[UI], "placeholder", "From...")).join(
        "|",
      ) === "Conrad Common|Dana" &&
    pickerLabels(findNodeByProp(book[UI], "placeholder", "To...")).join("|") ===
      "Conrad Common|Dana"
  );

  const assert_both_cards = assert(() =>
    cardTexts(book[UI]).join("|") ===
      "Conrad Commonconrad@testmail.ioWidgets Inc×|Dana×"
  );

  const assert_search_narrows = assert(() =>
    cardTexts(book[UI]).join("|") ===
      "Conrad Commonconrad@testmail.ioWidgets Inc×"
  );

  const assert_picked_same_contact = assert(() =>
    fieldValue(book[UI], "From...") === "Dana" &&
    fieldValue(book[UI], "To...") === "Dana"
  );
  const assert_picked_pair = assert(() =>
    fieldValue(book[UI], "From...") === "Conrad Common" &&
    fieldValue(book[UI], "To...") === "Dana" &&
    fieldValue(book[UI], "Label...") === "colleague"
  );

  // Linking a contact to itself does nothing.
  const assert_self_link_refused = assert(() =>
    book.relationships.length === 0
  );

  // A link shows on both cards, naming the other contact and the label, and
  // the pickers reset.
  const assert_linked = assert(() =>
    book.relationships.length === 1 &&
    book.relationships[0].fromName === "Conrad Common" &&
    book.relationships[0].toName === "Dana" &&
    book.relationships[0].label === "colleague" &&
    cardTexts(book[UI]).join("|") ===
      "Conrad Commonconrad@testmail.ioWidgets Inc↔ Dana(colleague)×|Dana↔ Conrad Common(colleague)×" &&
    fieldValue(book[UI], "From...") === ""
  );

  // Deleting the first contact keeps the one after it whole.
  const assert_conrad_deleted = assert(() =>
    len(book.contacts) === 1 && book.contacts[0]?.name === "Dana" &&
    book.summary === "Dana" &&
    cardTexts(book[UI]).join("|") === "Dana↔ Conrad Common(colleague)×"
  );

  return {
    [TESTS]: [
      { assertion: assert_empty_query_matches_all },
      { assertion: assert_name_query_matches },
      { assertion: assert_email_query_matches },
      { assertion: assert_company_query_matches },
      { assertion: assert_other_query_misses },

      { assertion: assert_empty_placeholder },
      { action: action_add_contact },
      { assertion: assert_one_contact },
      { assertion: assert_unnamed_listed },

      { assertion: assert_seeded_summary },
      { assertion: assert_pickers_offer_contacts },
      { assertion: assert_both_cards },
      { action: action_search_widgets },
      { assertion: assert_search_narrows },
      { action: action_clear_search },
      { assertion: assert_both_cards },

      { action: action_pick_same_contact_twice },
      { assertion: assert_picked_same_contact },
      { action: action_link },
      { assertion: assert_self_link_refused },
      { action: action_pick_pair },
      { assertion: assert_picked_pair },
      { action: action_link },
      { assertion: assert_linked },

      { action: action_delete_conrad },
      { assertion: assert_conrad_deleted },
    ],
    contactBook,
    book,
  };
});
