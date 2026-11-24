// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * TEST PATTERN: ifElse with Simple Cell - WORKING (with caveats)
 *
 * CLAIM: ifElse with simple cell WORKS for conditional buttons (but has limitations)
 * SOURCE: folk_wisdom/onclick-handlers-conditional-rendering.md
 * CONFIRMED: 2025-12-03 session
 *
 * WHAT THIS TESTS:
 * Demonstrates that ifElse with a PLAIN CELL (not derived parameter) can work
 * for conditional button rendering without ReadOnlyAddressError.
 *
 * KEY INSIGHT: ifElse with plain LOCAL cell works, but may fail when the cell
 * comes from a composed sub-pattern (see caveat pattern).
 *
 * EXPECTED BEHAVIOR:
 * - Pattern deploys successfully
 * - When showButton=true, button is visible and clickable
 * - When showButton=false, button is hidden
 * - Clicking button increments count without errors
 * - No ReadOnlyAddressError (unlike derive approach)
 * - Works because ifElse with plain cell doesn't create read-only context
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Deploy this pattern to a test space
 * 2. Initially showButton=true, button should be visible
 * 3. Click "Increment" - count should increase without errors
 * 4. Uncheck "Show button" - button should disappear
 * 5. Check "Show button" again - button reappears
 * 6. Click button again - still works
 * 7. Verify no errors in browser console
 *
 * FRAMEWORK MECHANISM:
 * - ifElse with plain cell (not wrapped in derive) is evaluated directly
 * - Does not create inline data URI context like derive() does
 * - Cell references remain writable
 * - Handler can successfully call .set()
 *
 * CAVEAT: This works for LOCAL cells. If the cell comes from a composed
 * pattern, it may create reactive loops. See folk wisdom for details.
 */
import {
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface State {
  count: number | Default<0>;
  showButton: boolean | Default<true>;
}

const incrementHandler = handler<unknown, { count: Writable<number> }>(
  (_event, { count }) => {
    count.set(count.get() + 1);
  },
);

export default pattern<State>(({ count, showButton }) => {
  return {
    [NAME]: "TEST: ifElse with simple cell - WORKING",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <h3>WORKING Pattern: ifElse with simple (local) cell</h3>
        <p>Current count: {count}</p>

        <div style={{ marginBottom: "1rem" }}>
          <cf-checkbox $checked={showButton}>Show button</cf-checkbox>
        </div>

        {/* WORKING: ifElse with plain cell (not derived) */}
        {ifElse(
          showButton,
          <cf-button onClick={incrementHandler({ count })}>
            Increment (WORKING with ifElse)
          </cf-button>,
          <p style={{ color: "gray" }}>Button hidden by ifElse condition</p>,
        )}

        <p style={{ color: "green", marginTop: "16px" }}>
          This works! ifElse with PLAIN CELL doesn't create read-only context.
        </p>

        <p style={{ color: "orange", marginTop: "8px" }}>
          CAVEAT: This works for LOCAL cells. Cells from composed patterns may
          still fail.
        </p>
      </div>
    ),
    count,
    showButton,
  };
});
