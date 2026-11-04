import { computed, pattern } from "commonfabric";

// FIXTURE: computed-in-computed-property-access
// Verifies: property access on a computed() result declared INSIDE another computed()
//   gets transformed to .key() access
//   foo.bar → foo.key("bar") where foo = computed(() => ({ bar: 1 }))
// Context: Local variables holding Reactive values (from compute/lift-applied calls)
//   inside a lift-applied callback need .key() rewriting even though they are not
//   captured from an outer scope.
export default pattern(() => {
  const outer = computed(() => {
    const foo = computed(() => ({ bar: 1 }));
    return foo.bar;
  });

  return outer;
});
