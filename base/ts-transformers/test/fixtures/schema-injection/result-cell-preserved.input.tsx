import { type Cell, lift, pattern, type Writable } from "commonfabric";

interface Item {
  title: string;
}

interface PassThroughInput {
  cell: Cell<Item[]>;
}

interface Input {
  items: Writable<Item[]>;
}

// FIXTURE: result-cell-preserved
// Pins the boundary principle (see PatternFunction in api/index.ts): factory
// RESULT types are not stripped, so a Cell-branded value forwarded through a
// lift return and a pattern result keeps `asCell: ["cell"]` in the generated
// result schemas. Consumers therefore rehydrate a live Cell (identity + write
// access preserved) instead of receiving a dereferenced copy. Before the
// unstripping, the inferred result schema silently dropped the asCell entry.
const passThrough = lift((input: PassThroughInput) => input.cell);

export default pattern<Input>(({ items }) => {
  return {
    items,
    forwarded: passThrough({ cell: items }),
  };
});
