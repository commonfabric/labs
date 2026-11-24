/**
 * computed() result property access in lift-applied captures should use
 * .key("length"). The computed() return is a Reactive, so
 * rewritePatternBody correctly rewrites summary.length to
 * summary.key("length").
 */

import { computed, pattern } from "commonfabric";

interface State {
  items: string[];
}

// FIXTURE: computed-result-property-in-return
// Verifies: .length on a computed() string result is captured via .key("length") in a subsequent lift-applied computation
//   computed(() => summary.length) → lift(({ summary }) => summary.length)({ summary: { length: summary.key("length") } })
// Context: The first computed() returns a string Reactive (from .join()).
//   When the second computed() accesses summary.length, the capture is rewritten
//   to summary.key("length") because summary is a Reactive, not a plain value.
export default pattern<State>((state) => {
  const summary = computed(() =>
    state.items.join(", ")
  );

  return {
    summary,
    charCount: computed(() => summary.length),
  };
});
