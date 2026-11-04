import { pattern, Writable } from "commonfabric";

interface Item {
  title: string;
}

export interface SubOutput {
  label: string;
  store: Writable<Item>;
}

// FIXTURE: map-result-cell-preserved
// The .map() lowering injects a pattern whose RESULT schema is inferred from
// the element callback's return type. When the callback returns a sub-pattern
// result whose Output carries a Writable<>, the injected pattern's result
// schema (and the outer pattern's result schema) must keep `asCell: ["cell"]`
// on that field — consumers rehydrate the live per-element cell. Before
// factory result types stopped being StripCell'd, the brand was silently
// dropped here (the declared Sub schema kept it, but the inferred map-pattern
// result schema lost it).
const Sub = pattern<{ item: Item }, SubOutput>(({ item }) => {
  const store = new Writable<Item>({ title: "" });
  return { label: item.title, store };
});

export interface Input {
  items: Item[];
}

export default pattern<Input>(({ items }) => {
  const subs = items.map((item) => Sub({ item }));
  return { subs };
});
