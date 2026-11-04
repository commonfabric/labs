import { pattern, UI } from "commonfabric";

// FIXTURE: jsx-direct-branch-roots
// Verifies: direct JSX branch roots lower structurally without leaving raw
//   child expressions in place.
//   showCompleted || !task.done ? "Visible" : "" -> nested unless/ifElse path
//   primary ? "A" : secondary ? "B" : "C"        -> nested ternary lowering
//   primary ? "A" : fallbackLabel || "C"         -> nested logical branch lowering
//   label ?? "Pending"                           -> top-level JSX nullish lowering
export default pattern<{
  showCompleted: boolean;
  task: { done: boolean };
  primary: boolean;
  secondary: boolean;
  fallbackLabel?: string;
  label?: string | null;
}>((state) => ({
  [UI]: (
    <div>
      <p>{state.showCompleted || !state.task.done ? "Visible" : ""}</p>
      <p>{state.primary ? "A" : state.secondary ? "B" : "C"}</p>
      <p>{state.primary ? "A" : state.fallbackLabel || "C"}</p>
      <p>{state.label ?? "Pending"}</p>
    </div>
  ),
}));
