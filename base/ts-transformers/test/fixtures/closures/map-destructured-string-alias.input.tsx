import { pattern, UI } from "commonfabric";

interface State {
  items: Array<{ couponCode: string }>;
}

// FIXTURE: map-destructured-string-alias
// Verifies: object destructuring with string-property alias in .map() param is lowered to key()
//   .map(({ couponCode: code }) => ...) → key("element", "couponCode") assigned to code
//   .map(fn) → .mapWithPattern(pattern(...), {})
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map(({ couponCode: code }) => (
          <span>{code}</span>
        ))}
      </div>
    ),
  };
});
