import { pattern, UI } from "commonfabric";

interface Point {
  x: number;
  y: number;
}

interface State {
  points: Point[];
  scale: number;
}

// FIXTURE: map-destructured-param
// Verifies: object destructuring in .map() param is lowered to key() calls on each property
//   .map(({ x, y }) => ...) → key("element", "x"), key("element", "y")
//   x * state.scale, y * state.scale → lift(...)(...) calls with captured state
// Context: Captures state.scale from outer scope; destructured element properties used in expressions
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Map with destructured parameter and capture */}
        {state.points.map(({ x, y }) => (
          <div>
            Point: ({x * state.scale}, {y * state.scale})
          </div>
        ))}
      </div>
    ),
  };
});
