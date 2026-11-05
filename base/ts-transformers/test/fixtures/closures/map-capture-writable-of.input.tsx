import { pattern, Writable, UI } from "commonfabric";

interface State {
  items: Array<{ name: string }>;
}

// FIXTURE: map-capture-writable-of
// Verifies: new Writable() variable closed over in .map() is captured with asCell annotation
//   .map(fn) → .mapWithPattern(pattern(...).curry({ selected: selected }))
//   new Writable<string | null>(null) → params.selected with { anyOf: [string, null], asCell: true }
export default pattern<State>((state) => {
  const selected = new Writable<string | null>(null);
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{item.name} {selected}</span>
        ))}
      </div>
    ),
  };
});
