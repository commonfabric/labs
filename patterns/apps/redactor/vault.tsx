/**
 * PII Vault — the names, emails, phone numbers, ID numbers and addresses you
 * never want sent anywhere as written.
 *
 * Every entry is `Secret` under the redaction policy (`policy.tsx`): the
 * runtime refuses to write an entry, or anything computed from one, to any
 * store that admits only public values. Readers of the space that holds the
 * vault may read its entries (`releaseToSpaceReader`); the only thing released
 * to a public store, such as the model's prompt, is the redactor's redacted
 * draft. The vault runs standalone, and the redactor embeds it.
 */
import {
  action,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import type { Secret } from "./policy.tsx";
import {
  CATEGORY_LABELS,
  type PIICategory,
  type PIIEntry,
} from "./redaction.ts";

const PLACEHOLDERS: Record<PIICategory, string> = {
  name: "Jordan Rivera",
  email: "jordan@example.com",
  phone: "415-555-0123",
  ssn: "123-45-6789",
  address: "12 Elm St, Springfield",
  custom: "Any sensitive text",
};

const CATEGORY_ITEMS = (Object.keys(CATEGORY_LABELS) as PIICategory[]).map(
  (value) => ({ label: CATEGORY_LABELS[value], value }),
);

export type SecretEntry = Secret<PIIEntry>;

interface VaultInput {
  entries?: Writable<Default<SecretEntry[], []>>;
}

export interface VaultOutput {
  [NAME]: string;
  [UI]: VNode;
  entries: SecretEntry[];
  addEntry: Stream<PIIEntry>;
  removeEntry: Stream<{ index: number }>;
}

const addEntryHandler = handler<
  PIIEntry,
  { entries: Writable<SecretEntry[]> }
>((entry, { entries }) => {
  const value = entry.value?.trim() ?? "";
  if (value === "") return;
  entries.push({ category: entry.category, value } as SecretEntry);
});

const removeEntryHandler = handler<
  { index: number },
  { entries: Writable<SecretEntry[]> }
>(({ index }, { entries }) => {
  entries.set(entries.get().toSpliced(index, 1));
});

const PIIVault = pattern<VaultInput, VaultOutput>(({ entries }) => {
  const newCategory = new Writable.perSession<PIICategory>("name");
  // Holds a value before it is added. It should be as secret as the vault,
  // but a scalar Secret with a value trips the piece-start ceiling-gate bug
  // (README, CFC debt 3), so it is a plain per-session cell for now.
  const newValue = new Writable.perSession("");

  const addEntry = addEntryHandler({ entries });
  const removeEntry = removeEntryHandler({ entries });

  const submit = action(() => {
    addEntry.send({
      category: newCategory.get(),
      value: newValue.get(),
    });
    newValue.set("");
  });

  const summary = computed(() => {
    const n = entries.get().length;
    return n === 0
      ? "Nothing stored yet."
      : `${n} protected value${n === 1 ? "" : "s"}.`;
  });

  return {
    [NAME]: "🔒 PII Vault",
    [UI]: (
      <cf-vstack gap="2">
        <cf-label>{summary}</cf-label>
        {entries.map((entry, index) => (
          <cf-hstack gap="2" align="center">
            <cf-chip label={CATEGORY_LABELS[entry.category]} />
            <span style={{ flex: "1", fontFamily: "monospace" }}>
              {entry.value}
            </span>
            <cf-button
              variant="ghost"
              size="sm"
              onClick={() => removeEntry.send({ index })}
            >
              Remove
            </cf-button>
          </cf-hstack>
        ))}
        <cf-hstack gap="2" align="center">
          <cf-select $value={newCategory} items={CATEGORY_ITEMS} />
          <cf-input
            $value={newValue}
            placeholder={computed(() => PLACEHOLDERS[newCategory.get()])}
            style={{ flex: "1" }}
          />
          <cf-button onClick={submit}>Add</cf-button>
        </cf-hstack>
      </cf-vstack>
    ),
    entries,
    addEntry,
    removeEntry,
  };
});

export default PIIVault;
