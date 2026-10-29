import { cell, pattern, UI } from "commonfabric";

interface State {
  items: Array<{ value: number }>;
  threshold: number;
}

// FIXTURE: map-capture-mixed-reactivity
// Verifies: captures of different reactivity kinds are annotated distinctly in the schema
//   label (plain string) → params.label (type: "string", accessed via .params)
//   limit (cell, READ-only in this callback) → params.limit (asCell: ["readonly"])
//     — read-only usage yields the precise `readonly` capability, not the broader
//       `cell`. (The capture is created with cell(100) but never written here.)
//   derived (state.threshold) → params.derived (asOpaque: true)
// Context: Three capture kinds — plain value, cell, and state-derived — in one map callback
export default pattern<State>((state) => {
  const label = "Result";
  const limit = cell(100);
  const derived = state.threshold;
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{label}: {item.value} / {derived} / {limit}</span>
        ))}
      </div>
    ),
  };
});
