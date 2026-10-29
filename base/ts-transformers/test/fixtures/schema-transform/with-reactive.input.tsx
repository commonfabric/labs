import { Cell, pattern, toSchema, UI } from "commonfabric";

interface State {
  value: Cell<number>;
}

const model = toSchema<State>({
  "default": { value: 0 },
});

// FIXTURE: with-reactive
// Verifies: Cell<> fields generate asCell in schema and a reactive builder gets input/output schemas injected
//   Cell<number> → { type: "number", asCell: true }
//   toSchema<State>({default: ...}) → schema with "default" key preserved
//   bare `cell.value.get() * 2` → auto-wraps, capturing cell.key("value") into lift(inputSchema, outputSchema, fn)
export default pattern<State, State>((cell) => {
  const doubled = cell.value.get() * 2;

  return {
    [UI]: (
      <div>
        <p>Value: {cell.value}</p>
        <p>Doubled: {doubled}</p>
      </div>
    ),
    value: cell.value,
  };
}, model, model);
