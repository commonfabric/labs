// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * TEST PATTERN: Top-Level Button with Disabled Attribute - WORKING
 *
 * CLAIM: Always render buttons at top level, use disabled attribute for conditional state
 * SOURCE: folk_wisdom/onclick-handlers-conditional-rendering.md
 *
 * WHAT THIS TESTS:
 * Demonstrates the RECOMMENDED approach: render buttons at top level (not inside
 * conditional blocks), use disabled attribute for conditional states, and handle
 * conditions inside the handler with early returns.
 *
 * EXPECTED BEHAVIOR:
 * - Pattern deploys successfully
 * - Button always rendered, never hidden
 * - Button disabled when pending=true
 * - Button enabled when pending=false
 * - Clicking enabled button increments count successfully
 * - No ReadOnlyAddressError
 * - No infinite loops
 * - derive() used ONLY for button content and disabled state (not wrapping button)
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Deploy this pattern to a test space
 * 2. Verify button is always visible
 * 3. Check "Simulate pending" checkbox - button should become disabled
 * 4. Uncheck "Simulate pending" - button should become enabled
 * 5. Click "Increment" button - count should increase
 * 6. Verify no errors in browser console
 * 7. Verify smooth, reactive behavior
 *
 * FRAMEWORK MECHANISM:
 * - Button exists at top-level JSX (not inside derive/ifElse)
 * - derive() used only for attribute values (disabled) and content
 * - Handler receives real cell references, not read-only proxies
 * - .set() operations succeed because cells are writable
 */
import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface State {
  count: number | Default<0>;
  pending: boolean | Default<false>;
  isProcessing: boolean | Default<false>;
}

const incrementHandler = handler<
  unknown,
  {
    count: Writable<number>;
    pending: Writable<boolean>;
    isProcessing: Writable<boolean>;
  }
>((_event, { count, pending, isProcessing }) => {
  // Handler handles conditions internally with early return
  if (pending.get() || isProcessing.get()) {
    console.log("Handler skipped: disabled state");
    return; // Early return if not ready
  }

  // Do the actual work
  count.set(count.get() + 1);
});

export default pattern<State>(({ count, pending, isProcessing }) => {
  // computed() unwraps captured values - no .get() needed
  const isDisabled = computed(() => pending || isProcessing);
  const buttonText = computed(() =>
    pending ? "Processing..." : "Increment (WORKING)"
  );

  return {
    [NAME]: "TEST: Top-level button - WORKING",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <h3>WORKING Pattern: Top-level button with disabled attribute</h3>
        <p>Current count: {count}</p>

        <div style={{ marginBottom: "1rem" }}>
          <cf-checkbox $checked={pending}>Simulate pending state</cf-checkbox>
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <cf-checkbox $checked={isProcessing}>
            Simulate processing state
          </cf-checkbox>
        </div>

        {/* WORKING: Button always rendered at top level */}
        <cf-button
          onClick={incrementHandler({ count, pending, isProcessing })}
          disabled={isDisabled}
        >
          {buttonText}
        </cf-button>

        <p style={{ color: "green", marginTop: "16px" }}>
          This pattern works correctly! Button always rendered, uses disabled
          for state.
        </p>
      </div>
    ),
    count,
    pending,
    isProcessing,
  };
});
