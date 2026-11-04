import { pattern, UI } from "commonfabric";

interface State {
  entries: Array<{ 0: number }>;
}

// FIXTURE: map-destructured-numeric-alias
// Verifies: numeric property key destructuring in .map() param is lowered to key() with string index
//   .map(({ 0: first }) => ...) → key("element", "0") assigned to first
//   .map(fn) → .mapWithPattern(pattern(...), {})
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.entries.map(({ 0: first }) => (
          <span>{first}</span>
        ))}
      </div>
    ),
  };
});
