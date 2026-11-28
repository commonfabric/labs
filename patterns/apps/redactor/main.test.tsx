/**
 * PII Vault tests, driven through its rendered controls: the placeholder
 * follows the chosen category, "Add" stores a trimmed value and clears the
 * input, a blank value is not stored, the summary counts the entries, and a
 * row's "Remove" drops only that row.
 *
 * Run: deno task cf test patterns/apps/redactor/main.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  clickInRow,
  findElement,
  findNodeByProp,
  propValue,
  readValue,
  setBound,
  textContent,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";
import type { PIIEntry } from "./redaction.ts";
import PIIVault from "./main.tsx";

const hasPlaceholder = (ui: unknown, placeholder: string): boolean =>
  findNodeByProp(ui, "placeholder", placeholder) !== undefined;

/** The stored entries as `category:value`, joined in order. */
const entryList = (entries: readonly PIIEntry[]): string =>
  entries.map((entry) => `${entry.category}:${entry.value}`).join("|");

export default pattern(() => {
  const vault = PIIVault({});

  const assert_starts_empty = assert(() =>
    textContent(readValue(vault[UI])).includes("Nothing stored yet.") &&
    vault.entries.length === 0
  );
  const assert_name_placeholder = assert(() =>
    hasPlaceholder(readValue(vault[UI]), "Jordan Rivera") &&
    !hasPlaceholder(readValue(vault[UI]), "jordan@example.com")
  );

  const action_choose_email = action(() =>
    setBound(
      findElement(readValue(vault[UI]), "cf-select"),
      "$value",
      "email",
      "cf-select",
    )
  );
  const assert_email_placeholder = assert(() =>
    hasPlaceholder(readValue(vault[UI]), "jordan@example.com") &&
    !hasPlaceholder(readValue(vault[UI]), "Jordan Rivera")
  );

  const action_add_email = action(() => {
    typeInto(
      readValue(vault[UI]),
      "jordan@example.com",
      "  jordan.r@rivera-props.com  ",
    );
    clickButton(readValue(vault[UI]), "Add");
  });
  const assert_email_stored = assert(() => {
    const text = textContent(readValue(vault[UI]));
    return entryList(vault.entries) === "email:jordan.r@rivera-props.com" &&
      text.includes("1 protected value.") &&
      text.includes("jordan.r@rivera-props.com") &&
      !text.includes("Nothing stored yet.") &&
      propValue(findElement(readValue(vault[UI]), "cf-chip"), "label") ===
        "Email";
  });
  const assert_input_cleared = assert(() =>
    propValue(findElement(readValue(vault[UI]), "cf-input"), "$value") === ""
  );

  const action_add_blank = action(() => {
    typeInto(readValue(vault[UI]), "jordan@example.com", "   ");
    clickButton(readValue(vault[UI]), "Add");
  });
  const assert_blank_ignored = assert(() =>
    entryList(vault.entries) === "email:jordan.r@rivera-props.com"
  );

  const assert_two_stored = assert(() =>
    entryList(vault.entries) ===
      "email:jordan.r@rivera-props.com|name:Jordan Rivera" &&
    textContent(readValue(vault[UI])).includes("2 protected values.")
  );

  const action_remove_email = action(() =>
    clickInRow(readValue(vault[UI]), "jordan.r@rivera-props.com", "Remove")
  );
  const assert_email_removed = assert(() =>
    entryList(vault.entries) === "name:Jordan Rivera" &&
    !textContent(readValue(vault[UI])).includes("jordan.r@rivera-props.com") &&
    textContent(readValue(vault[UI])).includes("1 protected value.")
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { assertion: assert_name_placeholder },
      { action: action_choose_email },
      { assertion: assert_email_placeholder },
      { action: action_add_email },
      { assertion: assert_email_stored },
      { assertion: assert_input_cleared },
      { action: action_add_blank },
      { assertion: assert_blank_ignored },
      {
        action: vault.addEntry,
        event: { category: "name", value: "Jordan Rivera" },
      },
      { assertion: assert_two_stored },
      { action: action_remove_email },
      { assertion: assert_email_removed },
    ],
    vault,
  };
});
