import { handler, pattern, Writable } from "commonfabric";

const ANY_KEY: string = "k";

// FIXTURE: handler-element-access-dynamic-key
// Verifies: a handler state member read through an element access by a key that can name any member stays in the state schema
//   catalog.get().offers[ANY_KEY].space keeps catalog in the state schema, beside the write to n
// Context: Two state members, so a dropped read would shrink catalog out of the state schema
const touch = handler<
  void,
  { catalog: Writable<Record<string, any>>; n: Writable<number> }
>((_, { catalog, n }) => {
  if (catalog.get().offers[ANY_KEY].space === "room") n.set(n.get() + 1);
});

export default pattern(() => {
  const catalog = new Writable<Record<string, any>>({ offers: {} });
  const n = new Writable<number>(0);
  return { touch: touch({ catalog, n }) };
});
