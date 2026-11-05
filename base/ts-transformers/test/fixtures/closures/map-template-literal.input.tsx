import { pattern, UI } from "commonfabric";

interface Item {
  id: number;
  name: string;
}

interface State {
  items: Item[];
  prefix: string;
  suffix: string;
}

// FIXTURE: map-template-literal
// Verifies: .map() on reactive array is transformed when callback uses a template literal with captures
//   .map(fn) → .mapWithPattern(pattern(...).curry({state: {prefix, suffix}}))
//   `${state.prefix} ${item.name} ${state.suffix}` → lift-applied computation wrapping the template
// Context: Template literal interpolations reference both element and captured state properties
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Template literal with captures */}
        {state.items.map((item) => (
          <div>{`${state.prefix} ${item.name} ${state.suffix}`}</div>
        ))}
      </div>
    ),
  };
});
