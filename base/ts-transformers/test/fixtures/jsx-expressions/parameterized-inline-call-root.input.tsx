import { pattern, UI } from "commonfabric";

// FIXTURE: parameterized-inline-call-root
// Verifies: helper-owned parameterized inline-function call roots lower as a
// shared post-closure lift-applied computation around the whole call, not as a lift-applied computation inside the
// inline function body that leaves the reactive argument outside.
//   ((value) => prefix + value)(count)
//     -> lift(({ prefix, count }) => ((value) => prefix + value)(count))({ prefix, count })
export default pattern<{ prefix: string; count: number }>(({ prefix, count }) => ({
  [UI]: <div>{((value: number) => prefix + value)(count)}</div>,
}));
