import { pattern, UI } from "commonfabric";

interface Spot {
  spotNumber: string;
}

interface State {
  spots: Spot[];
}

// FIXTURE: map-destructure-alias-action-collision
// Verifies: destructured alias inside map callback body is lowered to explicit key() access
//   const { spotNumber: sn } = spot → const sn = spot.key("spotNumber")
//   .map(fn) → .mapWithPattern(pattern(...), {})
// Context: Body destructuring from opaque map elements becomes explicit key() bindings
export default pattern<State>((state) => {
  return {
    [UI]: (
      <ul>
        {state.spots.map((spot) => {
          const { spotNumber: sn } = spot;
          return <li>{sn}</li>;
        })}
      </ul>
    ),
  };
});
