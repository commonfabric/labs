import { action, computed, pattern, UI, VNode, Writable } from "commonfabric";

interface View {
  value: unknown;
  label: string;
}

interface Item {
  name: string;
  value: Record<string, unknown> | null;
}

interface State {
  view: View;
  items: Item[];
  log: Writable<string>;
}

function propOf(view: View): unknown {
  return view.value;
}

// FIXTURE: captures-skip-type-positions
// Verifies: a name that appears only inside a type is not captured
//   (value as { set: (next: string) => void })  → no `next` capture
//   (stream as { send: (event: …) => void })    → no `event` capture
//   const copy: typeof view = view              → `view` captured for the
//                                                 value, not for the type
// Context: the same capture collector serves actions, computeds and array
//   callbacks, and none of them may bind a type's parameter names as inputs:
//   with no such binding in scope, an unshrunk state would require them and
//   the callback would never run.
export default pattern<State, { [UI]: VNode }>(({ view, items, log }) => {
  const setIt = action(() => {
    const value = propOf(view);
    if (typeof value === "object" && value !== null && "set" in value) {
      (value as { set: (next: string) => void }).set("x");
    }
    log.set(view.label);
  });

  const summary = computed(() => {
    const copy: typeof view = view;
    const value = copy.value;
    return typeof value === "object" && value !== null && "send" in value
      ? String((value as { send: (event: Record<string, never>) => void }))
      : copy.label;
  });

  return {
    [UI]: (
      <div>
        <button type="button" onClick={setIt}>{summary}</button>
        {items.map((item) => (
          <span>
            {typeof item.value === "object" && item.value !== null
              ? String((item.value as { get: (key: string) => unknown }))
              : item.name}
          </span>
        ))}
      </div>
    ),
  };
});
