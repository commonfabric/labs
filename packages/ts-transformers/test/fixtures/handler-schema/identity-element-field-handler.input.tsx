import { handler, Writable } from "commonfabric";

interface Item {
  name: string;
}

interface Entry {
  item: Writable<Item>;
  note: string;
}

const recordMatch = handler<
  { item: Writable<Item> },
  { entries: Writable<Entry[]>; found: Writable<string> }
>(({ item }, { entries, found }) => {
  const entry = entries.get().find((candidate) => candidate.item.equals(item));
  found.set(entry ? entry.note : "missing");
});

const holdsItem = handler<
  { item: Writable<Item> },
  { entries: Writable<Entry[]>; found: Writable<boolean> }
>(({ item }, { entries, found }) => {
  found.set(entries.get().some((entry) => entry.item.equals(item)));
});

// FIXTURE: identity-element-field-handler
// Verifies: a cell field of an array element compared with `equals` keeps the
// element's own schema, with the field as a comparable cell, rather than
// collapsing the element to unknown as an element compared whole does.
export { holdsItem, recordMatch };
