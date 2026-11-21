import {
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import { getValue, roll } from "./dice-handlers.ts";

interface PatternState {
  value: number | Default<1>;
}

export interface PatternOutput {
  [UI]: VNode;
  value: number;
  something: {
    nested: string;
  };
  roll: Stream<{ sides?: number }>;
}

export default pattern<PatternState, PatternOutput>((state) => {
  const report = new Writable("");
  return {
    [NAME]: `Dice Roller`,
    [UI]: (
      <div>
        <cf-button onClick={roll(state)}>
          Roll D6
        </cf-button>
        <cf-button onClick={roll({ value: state.value, sides: 20 })}>
          Roll D20
        </cf-button>
        <span id="dice-result">
          Current value: {state.value}
        </span>
        <cf-button onClick={getValue({ value: state.value, report })}>
          Check value
        </cf-button>
        <span id="dice-report">{report}</span>
      </div>
    ),
    value: state.value,
    roll: roll(state),
    something: {
      nested: "a secret surprise!",
    },
  };
});
