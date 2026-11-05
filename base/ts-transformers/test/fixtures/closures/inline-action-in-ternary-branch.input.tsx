/**
 * Regression test: inline arrow function inside explicit computed() in JSX
 *
 * Variation where an inline arrow function handler is wrapped inside an
 * explicit computed() in JSX. The transformer will convert the arrow function
 * to a handler, and the Cell reference (state.isEditing) must be properly
 * captured in the lift-applied computation created for the computed.
 */

import { Cell, computed, pattern, UI } from "commonfabric";

interface Card {
  title: string;
  description: string;
}

interface State {
  card: Card;
  isEditing: Cell<boolean>;
}

// FIXTURE: inline-action-in-ternary-branch
// Verifies: inline arrow handler inside explicit computed() in a ternary branch is extracted and captured in a lift-applied computation
//   computed(() => <cf-button onClick={() => state.isEditing.set(true)} />) → lift(..., handler(...)(...))({ state: { isEditing: asCell } })
// Context: Regression -- inline handler inside computed() must have its Cell ref captured in the lift-applied computation
export default pattern<State>((state) => {
  return {
    [UI]: (
      <cf-card>
        {state.isEditing ? (
          <div>Editing</div>
        ) : (
          <div>
            <span>{state.card.title}</span>
            {/* Explicit computed() wrapping a button with inline handler */}
            {/* The Cell ref in the handler must be captured in the lift-applied computation */}
            {computed(() => (
              <cf-button onClick={() => state.isEditing.set(true)}>Edit</cf-button>
            ))}
          </div>
        )}
      </cf-card>
    ),
    card: state.card,
  };
});
