/**
 * Regression test: computed() inside ifElse branch should not double-wrap .get()
 *
 * When a computed() callback is inside an ifElse branch, the ReactiveJSX
 * transformer's rewriteChildExpressions should NOT wrap expressions like
 * `toggle.get()` in an extra lift-applied computation, since the computed callback is already
 * a safe reactive context.
 *
 * Bug: secondToggle.get() was returning CellImpl instead of boolean
 * Fix: Added isInsideSafeCallbackWrapper check in rewriteChildExpressions
 */

import { computed, ifElse, pattern, UI, Writable } from "commonfabric";

// FIXTURE: nested-computed-in-ifelse
// Verifies: computed() inside ifElse branches transforms to the lift-applied form without double-wrapping .get()
//   computed(() => { secondToggle.get(); ... }) → lift(({ secondToggle }) => { secondToggle.get(); ... })({ secondToggle })
//   ternary (showOuter ? ... : ...) → ifElse(showOuter, ..., ...)
// Context: Regression test — .get() inside a computed() that is nested within
//   an ifElse branch must NOT get an extra lift-applied wrapper, since computed is
//   already a safe reactive context.
export default pattern<Record<PropertyKey, never>>(() => {
  const showOuter = new Writable(false);
  const secondToggle = new Writable(false);

  return {
    [UI]: (
      <div>
        {/* Case A: Top-level computed - always worked */}
        <div style={computed(() => {
          const val = secondToggle.get();
          return { background: val ? "green" : "red" };
        })}>Case A</div>

        {/* Case B: Computed inside ifElse - this was the bug */}
        {ifElse(
          showOuter,
          <div style={computed(() => {
            // This .get() should NOT be wrapped in an extra lift-applied computation
            const val = secondToggle.get();
            return { background: val ? "green" : "red" };
          })}>Case B</div>,
          <div>Hidden</div>
        )}
      </div>
    ),
  };
});
