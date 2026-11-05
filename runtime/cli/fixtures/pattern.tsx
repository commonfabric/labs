import { handler, NAME, pattern, str, UI } from "commonfabric";
import "commonfabric/schema";

// Factory contracts use the static schema binding directly so the transformer
// can embed the exact public contract without executing authored code.
const modelSchema = {
  type: "object",
  properties: {
    value: { type: "number", default: 0, asCell: ["cell"] },
  },
  default: { value: 0 },
} as const;
const increment = handler({}, modelSchema, (_, state) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler({}, modelSchema, (_, state) => {
  state.value.set(state.value.get() - 1);
});

export default pattern(
  (cell) => {
    return {
      [NAME]: str`Simple counter: ${String(cell.value)}`,
      [UI]: (
        <div>
          <button type="button" onClick={increment(cell)}>+</button>
          {/* use html fragment to test that it works  */}
          <>
            <b>{cell.value}</b>
          </>
          <button type="button" onClick={decrement(cell)}>-</button>
        </div>
      ),
      value: cell.value,
    };
  },
  modelSchema,
  modelSchema,
);
