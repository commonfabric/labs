/**
 * Test Pattern: contact detail
 *
 * Contact detail is the form a contact book opens for one contact. It titles
 * itself from the contact's name and summarizes the contact as the name
 * followed by whichever of company, email, and notes are set.
 *
 * This checks the title, the form's fields, and the summary for a full contact
 * and for one with nothing but a name, and that the summary follows an edit.
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
  findNodeByProp,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import ContactDetail, { type Contact } from "./contact-detail.tsx";

export default pattern(() => {
  const contact = new Writable<Contact>({
    name: "Conrad Common",
    email: "conrad@testmail.io",
    phone: "555-0100",
    company: "Widgets Inc",
    tags: [],
    notes: "Met at the widget fair",
    createdAt: 0,
  });
  const detail = ContactDetail({ contact });

  const bare = ContactDetail({
    contact: {
      name: "Dana",
      email: "",
      phone: "",
      company: "",
      tags: [],
      notes: "",
      createdAt: 0,
    },
  });

  const action_change_company = action(() => {
    contact.key("company").set("Gadgets Ltd");
  });

  const assert_titled = assert(() => detail[NAME] === "Contact: Conrad Common");

  // The phone field is bound to the contact's phone.
  const assert_form_bound = assert(() =>
    propValue(
      findNodeByProp(detail[UI], "placeholder", "+1 (555) 123-4567"),
      "$value",
    ) === "555-0100"
  );

  const assert_full_summary = assert(() =>
    detail.summary ===
      "Conrad Common - Widgets Inc - conrad@testmail.io - Met at the widget fair"
  );

  const assert_bare_summary = assert(() =>
    bare.summary === "Dana" && bare[NAME] === "Contact: Dana"
  );

  const assert_summary_follows_edit = assert(() =>
    detail.summary ===
      "Conrad Common - Gadgets Ltd - conrad@testmail.io - Met at the widget fair"
  );

  return {
    [TESTS]: [
      { assertion: assert_titled },
      { assertion: assert_form_bound },
      { assertion: assert_full_summary },
      { assertion: assert_bare_summary },
      { action: action_change_company },
      { assertion: assert_summary_follows_edit },
    ],
    detail,
    bare,
  };
});
