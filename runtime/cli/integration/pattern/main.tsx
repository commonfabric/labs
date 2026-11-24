import { NAME, pattern, str, UI } from "commonfabric";
import "commonfabric/schema";
import { decrement, increment, model } from "./utils.ts";

export const customPatternExport = pattern(
  (cell) => {
    return {
      [NAME]: str`Simple counter: ${cell.value}`,
      [UI]: (
        <div>
          <cf-button onClick={decrement(cell)}>-</cf-button>
          {/* use html fragment to test that it works  */}
          <>
            <b>{cell.value}</b>
          </>
          <cf-button onClick={increment(cell)}>+</cf-button>
        </div>
      ),
      increment: increment(cell),
      decrement: decrement(cell),
      value: cell.value,
      stringField: cell.stringField,
      numberField: cell.numberField,
      booleanField: cell.booleanField,
      arrayField: cell.arrayField,
      userData: cell.userData,
      listField: cell.listField,
    };
  },
  model,
  model,
);
