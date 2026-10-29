// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Test Pattern: ifElse Evaluates BOTH Branches
 *
 * CLAIM TO VERIFY (from blessed/reactivity.md):
 * "ifElse evaluates BOTH branches, not just the 'true' one."
 *
 * HOW THIS TEST WORKS:
 * Each branch contains a computed() that increments a counter every time it runs.
 * If the claim is TRUE: Both counters increment on every re-render, regardless of condition.
 * If the claim is FALSE: Only the visible branch's counter would increment.
 *
 * MANUAL TESTING:
 * 1. Note initial values of "True Branch Eval Count" and "False Branch Eval Count"
 * 2. Click "Toggle Condition" button
 * 3. Observe BOTH counters - do they BOTH increment, or just the newly-visible one?
 * 4. Toggle several more times
 *
 * EXPECTED IF CLAIM IS TRUE:
 * - Both eval counts increment together on each toggle
 * - The hidden branch's counter still goes up even though it's not displayed
 *
 * EXPECTED IF CLAIM IS FALSE:
 * - Only the visible branch's counter increments
 * - The hidden branch's counter stays frozen until it becomes visible
 */
import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

interface Input {
  condition: boolean | Default<true>;
  toggleCount: number | Default<0>;
}

export interface Output {
  condition: boolean;
  trueBranchEvalCount: number;
  falseBranchEvalCount: number;
  toggleCount: number;
}

const toggle = handler<
  unknown,
  { condition: Writable<boolean>; toggleCount: Writable<number> }
>((_event, { condition, toggleCount }) => {
  condition.set(!condition.get());
  toggleCount.set(toggleCount.get() + 1);
});

export default pattern<Input, Output>(({ condition, toggleCount }) => {
  // Internal cells for tracking eval counts - NOT pattern inputs
  const trueBranchEvalCount = new Writable(0);
  const falseBranchEvalCount = new Writable(0);

  // TRUE BRANCH: Increment internal counter each time this computed runs
  // Close over condition to create reactive dependency
  const trueBranchContent = computed(() => (
    void condition,
      trueBranchEvalCount.set(trueBranchEvalCount.get() + 1),
      (
        <div
          style={{
            padding: "16px",
            backgroundColor: "#e8f5e9",
            borderRadius: "8px",
            border: "2px solid #4caf50",
          }}
        >
          <h3 style={{ color: "#2e7d32", margin: "0 0 8px 0" }}>
            TRUE Branch (Currently Visible)
          </h3>
          <p>This branch is shown when condition = true</p>
          <p>
            <strong>True Branch Eval Count:</strong> {trueBranchEvalCount}
          </p>
        </div>
      )
  ));

  // FALSE BRANCH: Increment internal counter each time this computed runs
  // Close over condition to create reactive dependency
  const falseBranchContent = computed(() => (
    void condition,
      falseBranchEvalCount.set(falseBranchEvalCount.get() + 1),
      (
        <div
          style={{
            padding: "16px",
            backgroundColor: "#ffebee",
            borderRadius: "8px",
            border: "2px solid #f44336",
          }}
        >
          <h3 style={{ color: "#c62828", margin: "0 0 8px 0" }}>
            FALSE Branch (Currently Visible)
          </h3>
          <p>This branch is shown when condition = false</p>
          <p>
            <strong>False Branch Eval Count:</strong> {falseBranchEvalCount}
          </p>
        </div>
      )
  ));

  return {
    [NAME]: "Test: ifElse Both Branches",
    [UI]: (
      <div style={{ padding: "20px", fontFamily: "system-ui, sans-serif" }}>
        <h2>ifElse Both Branches Test</h2>

        <div
          style={{
            marginBottom: "20px",
            padding: "12px",
            backgroundColor: "#f5f5f5",
            borderRadius: "8px",
          }}
        >
          <p>
            <strong>Condition:</strong> {condition ? "TRUE" : "FALSE"}
          </p>
          <p>
            <strong>Toggle Count:</strong> {toggleCount}
          </p>
          <cf-button onClick={toggle({ condition, toggleCount })}>
            Toggle Condition
          </cf-button>
        </div>

        {/* The ifElse - if BOTH branches are evaluated, both counters increment */}
        {ifElse(condition, trueBranchContent, falseBranchContent)}

        {/* Always-visible summary showing BOTH counters */}
        <div
          style={{
            marginTop: "20px",
            padding: "16px",
            backgroundColor: "#e3f2fd",
            borderRadius: "8px",
            border: "2px solid #2196f3",
          }}
        >
          <h3 style={{ margin: "0 0 12px 0" }}>Evaluation Summary</h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th
                  style={{
                    textAlign: "left",
                    padding: "8px",
                    borderBottom: "1px solid #ccc",
                  }}
                >
                  Branch
                </th>
                <th
                  style={{
                    textAlign: "center",
                    padding: "8px",
                    borderBottom: "1px solid #ccc",
                  }}
                >
                  Eval Count
                </th>
                <th
                  style={{
                    textAlign: "center",
                    padding: "8px",
                    borderBottom: "1px solid #ccc",
                  }}
                >
                  Currently Visible?
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ padding: "8px" }}>True Branch</td>
                <td
                  style={{
                    textAlign: "center",
                    padding: "8px",
                    fontWeight: "bold",
                  }}
                >
                  {trueBranchEvalCount}
                </td>
                <td style={{ textAlign: "center", padding: "8px" }}>
                  {condition ? "YES" : "no"}
                </td>
              </tr>
              <tr>
                <td style={{ padding: "8px" }}>False Branch</td>
                <td
                  style={{
                    textAlign: "center",
                    padding: "8px",
                    fontWeight: "bold",
                  }}
                >
                  {falseBranchEvalCount}
                </td>
                <td style={{ textAlign: "center", padding: "8px" }}>
                  {condition ? "no" : "YES"}
                </td>
              </tr>
            </tbody>
          </table>

          <div
            style={{
              marginTop: "16px",
              padding: "12px",
              backgroundColor: "#fff3e0",
              borderRadius: "4px",
            }}
          >
            <strong>How to interpret:</strong>
            <ul style={{ margin: "8px 0 0 0", paddingLeft: "20px" }}>
              <li>
                If BOTH eval counts increment together → Claim VERIFIED (both
                branches evaluated)
              </li>
              <li>
                If only visible branch increments → Claim REFUTED (lazy
                evaluation)
              </li>
            </ul>
          </div>
        </div>
      </div>
    ),
    condition,
    trueBranchEvalCount,
    falseBranchEvalCount,
    toggleCount,
  };
});
