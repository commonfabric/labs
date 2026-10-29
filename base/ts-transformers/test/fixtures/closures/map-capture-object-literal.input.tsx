import { pattern, UI } from "commonfabric";

interface State {
  items: Array<{ name: string }>;
}

// FIXTURE: map-capture-object-literal
// Verifies: plain object literal closed over in .map() is captured as a non-reactive param
//   .map(fn) → .mapWithPattern(pattern(...), { style: style })
//   style (object literal) → params.style accessed via .params (not .key) since it is non-reactive
export default pattern<State>((state) => {
  const style = { color: "red", fontSize: 14 };
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span style={style}>{item.name}</span>
        ))}
      </div>
    ),
  };
});
