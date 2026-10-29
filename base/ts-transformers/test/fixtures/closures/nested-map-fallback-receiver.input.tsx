import { action, Default, pattern, UI, Writable } from "commonfabric";

interface Person {
  name: string;
}
interface State {
  rows: Default<Array<{ id: string; label: string }>, []>;
}

// FIXTURE: nested-map-fallback-receiver
// Verifies: a fallback-receiver array method — (reactiveCall() ?? []).map(...) —
//   nested INSIDE another .map() callback is lowered to mapWithPattern, so its
//   inner closure (which captures a sibling pattern cell) is threaded through
//   params instead of being illegally accessed across frames.
//     rows.map((row) => (people.get() ?? []).map((p) => ... setAssign ...))
//       → rows.mapWithPattern(pattern(... (lift(...)(...) ?? []).mapWithPattern(...) ...))
// Context: This is CT-1626. Before the fix, the inner `(people.get() ?? [])`
//   receiver — a `??` binary whose LHS is a reactive (lift-applied) call —
//   was classified as a plain `T[]` receiver, so the inner `.map` stayed a raw
//   CellImpl.map and threw at construction ("Reactive reference from outer
//   scope cannot be accessed via closure"). The `?? []` guard (correct for the
//   scoped-cell-undefined-before-sync race) is exactly what hid the reactive
//   receiver from the transformer.
export default pattern<State>(({ rows }) => {
  const people = Writable.perSpace.of<Person[]>([]);
  const assignName = Writable.perSpace.of<string>("");
  const setAssign = action((p: { name: string }) => assignName.set(p.name));
  return {
    [UI]: (
      <div>
        {rows.map((row) => (
          <div>
            <span>{row.label}</span>
            {(people.get() ?? []).map((p) => (
              <button
                type="button"
                onClick={() => setAssign.send({ name: p.name })}
              >
                {p.name}
              </button>
            ))}
          </div>
        ))}
      </div>
    ),
  };
});
