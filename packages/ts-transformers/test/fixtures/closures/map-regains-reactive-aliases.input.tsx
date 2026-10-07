import { Default, computed, lift, pattern, resultOf, wish } from "commonfabric";

const passthrough = lift((items: string[]) => items);

// FIXTURE: map-regains-reactive-aliases
// Verifies: compute-owned aliases that still resolve to reactive array roots
// are rewritten back to mapWithPattern/filterWithPattern when used in pattern
// lowering sites
//   const foo = computed(() => inner); foo.map(fn)        -> foo.mapWithPattern(...)
//   const foo = passthrough(inner); foo.map(fn)           -> foo.mapWithPattern(...)
//   const foo = resultOf(wish<Default<T[], []>>(...).result); map
//                                                   -> foo.mapWithPattern(...)
//   const filtered = foo.filter(fn); filtered.map(fn)     -> filterWithPattern(...).mapWithPattern(...)
//   const filtered = foo.filter(fn); filtered.map(item => item.toUpperCase())
//                                                   -> receiver-method body still lowers to a lift-applied computation
// Context: contrasts with the existing plain-array compute fixtures where the
// callback receiver really is compute-owned plain JS data.
export default pattern<{ items: string[] }>((state) => {
  const inner = computed(() => state.items);

  const fromComputed = computed(() => {
    const foo = computed(() => inner);
    return foo.map((item) => item + "!");
  });

  const fromLift = computed(() => {
    const foo = passthrough(inner);
    return foo.map((item) => item + "!");
  });

  const wishedState = wish<Default<string[], []>>({ query: "#items" });
  const wishedItems = resultOf(wishedState.result);
  const fromWish = computed(() => {
    const foo = wishedItems;
    return foo.map((item) => item + "!");
  });

  const fromFiltered = computed(() => {
    const foo = computed(() => inner);
    const filtered = foo.filter((item) => item.length > 1);
    return filtered.map((item) => item + "!");
  });

  const fromFilteredReceiverMethod = computed(() => {
    const foo = computed(() => inner);
    const filtered = foo.filter((item) => item.length > 1);
    return filtered.map((item) => item.toUpperCase());
  });

  return {
    fromComputed,
    fromLift,
    fromWish,
    fromFiltered,
    fromFilteredReceiverMethod,
  };
});
