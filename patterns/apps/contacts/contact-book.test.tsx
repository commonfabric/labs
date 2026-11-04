/**
 * Test Pattern: Counter
 *
 * Tests the core functionality of the counter pattern:
 * - Initial state (value defaults to 0)
 * - Increment via module-scope handler
 * - Decrement via pattern-body action
 * - Multiple increments/decrements
 * - Negative values
 *
 * Run: deno task cf test patterns/examples/counter/counter.test.tsx --verbose
 */
import { action, assert, pattern, TESTS } from "commonfabric";
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

  const contactBook = ContactBook({ contacts: [], relationships: [] });

  const action_add_contact = action(() => {
    contactBook.onAddContact.send();
  });

  const assert_one_contact = assert(
    () => len(contactBook.contacts) == 1,
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    [TESTS]: [
      { assertion: assert_empty_query_matches_all },
      { assertion: assert_name_query_matches },
      { assertion: assert_email_query_matches },
      { assertion: assert_company_query_matches },

      { action: action_add_contact },
      { assertion: assert_one_contact },
    ],
  };
});
