import { cell, pattern, UI } from "commonfabric";

// FIXTURE: reactive-array-element-access-schema
// Verifies: reactive array element access preserves `string | undefined` in the
// emitted result schema.
export default pattern((_state) => {
  const items = cell(["apple", "banana", "cherry"]);
  const index = cell(1);

  return {
    [UI]: <div>{items.get()[index.get()]}</div>,
  };
});
