import { computed, pattern, Writable } from "commonfabric";

interface Item {
  title: string;
}

// FIXTURE: computed-write-capability-materializer
// Verifies: a computed() that WRITES to a captured cell (`.set(...)`) produces a
//   write-capability capture, which the lift-applied strategy emits with a
//   trailing `{ materializerWriteInputPaths: [...] }` options object.
//   The schema injection must keep function-first order:
//     lift(cb, argumentSchema, resultSchema, { materializerWriteInputPaths })
//   i.e. the options object stays LAST, after both schemas — NOT scrambled into
//   the argumentSchema slot. (CT-1625 regression: the function-first reorder
//   originally appended schemas after the options, corrupting the call.)
export default pattern(() => {
  const items = new Writable<Item[]>([{ title: "a" }]);
  const processed = new Writable<string[]>([]);

  computed(() => {
    processed.set(items.get().map((i) => i.title));
  });

  return { items, processed };
});
