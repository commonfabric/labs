import { pattern } from "commonfabric";

// FIXTURE: top-level-h-binding
// Verifies: a module binding `h` at top level gets a `__cfHelpersShim()` trailer
//   forwarding to `__cfHelpers.h()` to keep the import live without duplicating
//   the authored `h` binding; JSX still dispatches through `__cfHelpers.h()`.
const h = ["a", "b"];
export default pattern<{ title: string }>(({ title }) => (
  <ul title={title}>{h.map((item) => <li>{item}</li>)}</ul>
));
