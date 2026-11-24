/**
 * A single button that shows a number and increments it on each click. It
 * is a minimal pattern with explicit `Input` and `Output` types, used to
 * exercise how a pattern's output schema is declared.
 */
import {
  Default,
  handler,
  NAME,
  pattern,
  UI,
  VNode,
  Writable,
} from "commonfabric";

const increment = handler<unknown, { value: Writable<number> }>((_, state) => {
  state.value.set(state.value.get() + 1);
});

interface Input {
  value: number | Default<0>;
}
export interface Output {
  value: number;
  [UI]: VNode;
}

export default pattern<Input, Output>(({ value }) => {
  return {
    [NAME]: "pattern output issue",
    [UI]: (
      <cf-button onClick={increment({ value: value })}>
        {value}
      </cf-button>
    ),
    value,
  };
});
