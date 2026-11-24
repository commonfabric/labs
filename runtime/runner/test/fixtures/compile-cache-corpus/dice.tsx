import { Default, NAME, pattern, Stream, UI } from "commonfabric";
import { getValue, roll } from "./dice-handlers.ts";

interface PatternState {
  value: number | Default<1>;
}

export interface PatternOutput {
  value: number;
  something: {
    nested: string;
  };
  roll: Stream<{ sides?: number }>;
}

export default pattern<PatternState, PatternOutput>((state) => {
  return {
    [NAME]: `Dice Roller`,
    [UI]: (
      <div>
        <cf-button onClick={roll(state)}>
          Roll D6
        </cf-button>
        <cf-button onClick={roll(state)}>
          getValue(state), Roll D20
        </cf-button>
        <span id="dice-result">
          Current value: {state.value}
        </span>
        <cf-button onClick={getValue(state)}>
          Check value
        </cf-button>
      </div>
    ),
    value: state.value,
    roll: roll(state),
    something: {
      nested: "a secret surprise!",
    },
  };
});
