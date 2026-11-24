import { computed, pattern } from "commonfabric";

const config = { bar: "module-level" };

// FIXTURE: computed-in-computed-scoped-no-false-rewrite
// Verifies: a block-scoped computed() result named `config` does NOT cause
//   the module-level `config.bar` to be rewritten to `config.key("bar")`.
//   The inner `config.bar` (block-scoped Reactive) should be rewritten,
//   but the outer `config.bar` (plain object) must remain untouched.
// Context: The pre-scan collects opaque roots by name; it must not leak
//   across lexical scopes and incorrectly rewrite unrelated same-named accesses.
export default pattern(() => {
  const outer = computed(() => {
    const condition = 1 > 0;
    if (condition) {
      const config = computed(() => ({ bar: 1 }));
      return config.bar;
    }
    return config.bar;
  });
  return outer;
});
