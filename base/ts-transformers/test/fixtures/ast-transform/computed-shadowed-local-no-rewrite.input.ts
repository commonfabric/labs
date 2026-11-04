
// FIXTURE: computed-shadowed-local-no-rewrite
// Verifies: shadowed local helpers named `computed` are not rewritten.
function computed<T>(fn: () => T): T {
  return fn();
}

export default computed(() => 1);
