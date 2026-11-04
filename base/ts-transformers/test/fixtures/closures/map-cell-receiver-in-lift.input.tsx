import { Cell, lift } from "commonfabric";

// FIXTURE: map-cell-receiver-in-lift
// Verifies: compute-owned map roots on Cell receivers still lower to mapWithPattern
//   lift(() => items.map((item) => item)) -> lift(() => items.mapWithPattern(...))
// Context: No JSX here; the map rewrite happens inside a builder-owned compute context
const items = new Cell<string[]>([]);

export const fn = lift(() => items.map((item) => item));
