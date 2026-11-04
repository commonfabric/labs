/**
 * Regression test: action() referenced inside explicit computed() in JSX
 *
 * Variation where the pattern author uses computed() explicitly inside JSX
 * (not encouraged, but should still work). The action is referenced INSIDE
 * the computed expression, so it must be captured in the lift-applied wrapper.
 */

import { action, Cell, computed, pattern, UI } from "commonfabric";

interface Card {
  title: string;
  description: string;
}

interface Input {
  card: Card;
}

// FIXTURE: action-in-ternary-with-explicit-computed
// Verifies: action() referenced inside an explicit computed() in JSX is captured in the lift-applied wrapper
//   action(() => ...) → handler(...)({ isEditing })
//   computed(() => JSX with action ref) → lift(fn)({ card, startEditing })
// Context: Action referenced inside computed expression must appear in the lift-applied capture object
export default pattern<Input>(({ card }) => {
  const isEditing = new Cell(false);

  const startEditing = action(() => {
    isEditing.set(true);
  });

  return {
    [UI]: (
      <cf-card>
        {isEditing ? (
          <div>Editing</div>
        ) : (
          <div>
            <span>{card.title}</span>
            {/* Explicit computed() wrapping JSX that references the action */}
            {/* The action must be captured in the lift-applied computation created for this computed */}
            {computed(() => (
              <div>
                <span>{card.description}</span>
                <cf-button onClick={startEditing}>Edit</cf-button>
              </div>
            ))}
          </div>
        )}
      </cf-card>
    ),
    card,
  };
});
