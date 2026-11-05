/**
 * Regression test: action() result used in same ternary branch as computed()
 *
 * When a ternary branch contains both a computed() value and an action() reference,
 * the nested computed expression should still lower locally in JSX without forcing
 * the whole JSX branch through an extra lift-applied wrapper.
 */

import { action, Cell, computed, pattern, UI } from "commonfabric";

interface Card {
  title: string;
  description: string;
}

interface Input {
  card: Card;
}

// FIXTURE: action-in-ternary-branch
// Verifies: action() result used in a ternary branch alongside computed() keeps
//   local JSX rewrites instead of forcing a whole-branch lift-applied computation
//   action(() => ...) → handler(eventSchema, captureSchema, (_, { isEditing }) => ...)({ isEditing })
//   nested hasDescription ternary → local ifElse(...) inside the JSX branch
// Context: Regression coverage for JSX-local rewriting with action references in the same branch
export default pattern<Input>(({ card }) => {
  const isEditing = new Cell(false);

  const startEditing = action(() => {
    isEditing.set(true);
  });

  const hasDescription = computed(() => {
    const desc = card.description;
    return desc && desc.length > 0;
  });

  return {
    [UI]: (
      <cf-card>
        {isEditing ? (
          <div>Editing</div>
        ) : (
          <div>
            <span>{card.title}</span>
            {/* Nested ternary with computed - lowers locally inside JSX */}
            {hasDescription ? <span>{card.description}</span> : null}
            {/* Action in SAME branch stays direct while JSX-local rewrites handle the computed value */}
            <cf-button onClick={startEditing}>Edit</cf-button>
          </div>
        )}
      </cf-card>
    ),
    card,
  };
});
