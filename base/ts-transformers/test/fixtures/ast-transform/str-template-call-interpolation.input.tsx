import { NAME, pattern, str } from "commonfabric";

interface PatternState {
  value: number;
}

function format(n: number): string {
  return `#${n}`;
}

// FIXTURE: str-template-call-interpolation
// Verifies: reactive lowering of expressions interpolated into a str`` tagged template.
//   The str runtime lifts its interpolation over the values it receives, so any value
//   that is a bare reactive READ stays reactive (str re-reads the cell). But a value
//   produced by a COMPUTED expression (a call, a binary op) must be lifted per-span,
//   or it freezes at construction. This mirrors how JSX `{expr}` is handled.
//     ${cell.value}          → ${cell.key("value")}              (bare read, not lifted)
//     ${format(cell.value)}  → ${__cfHelpers.lift(...)(...)}      (call lifted)
//     ${cell.value + 1}      → ${__cfHelpers.lift(...)(...)}      (binary lifted)
// Context: Regression for CT-1621 — derive(cell.value, String) migrated to bare
//   String(cell.value) inside str`` silently dropped reactivity because interpolation
//   call-expressions were never classified as lowerable expression sites.
export default pattern<PatternState>((cell) => {
  return {
    [NAME]: str`bare ${cell.value} call ${format(cell.value)} math ${
      cell.value + 1
    }`,
    value: cell.value,
  };
});
