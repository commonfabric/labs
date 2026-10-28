import { computed, lift, pattern } from "commonfabric";

// FIXTURE: computed-mutable-lift-binding
// Verifies: a call through a `let` or `var` binding of a `lift()` call inside a computed() callback lowers as the `const` spelling does
//   computed(() => { let double = lift(fn); return double(value); }) → lift(schema, schema)({ value }) with the callback body kept as written
// Context: `let` and `var` are ordinary code inside a compute callback; a call through such a binding is not the lift-applied shape, whose callee is the inner lift() call itself
export default pattern<{ value: number }>(({ value }) => {
  const viaConst = computed(() => {
    const double = lift((n: number) => n * 2);
    return double(value);
  });

  const viaLet = computed(() => {
    // deno-lint-ignore prefer-const -- the fixture covers a `let` binding
    let double = lift((n: number) => n * 2);
    return double(value);
  });

  const viaVar = computed(() => {
    // deno-lint-ignore no-var -- the fixture covers a `var` binding
    var double = lift((n: number) => n * 2);
    return double(value);
  });

  return { viaConst, viaLet, viaVar };
});
