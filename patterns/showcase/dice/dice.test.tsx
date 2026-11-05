import { action, assert, pattern, TESTS } from "commonfabric";
import Dice from "./dice.tsx";

// The roll handler draws from Math.random(), which the capability gate allows in
// a handler and denies in a lift/computed. The draw is unpredictable by design,
// so each assertion checks the bound the handler promises rather than a value:
// a roll lands in [1, sides], and a nonsensical `sides` falls back to a d6.
export default pattern(() => {
  const dice = Dice({ value: 1 });

  // No `sides` on the event: the handler defaults to a d6.
  const action_roll_default = action(() => {
    dice.roll.send({});
  });
  const assert_default_roll_is_a_d6 = assert(() =>
    Number.isInteger(dice.value) && dice.value >= 1 && dice.value <= 6
  );

  const action_roll_d20 = action(() => {
    dice.roll.send({ sides: 20 });
  });
  const assert_d20_roll_is_in_range = assert(() =>
    Number.isInteger(dice.value) && dice.value >= 1 && dice.value <= 20
  );

  // A non-positive `sides` is rejected by the handler's guard, which rolls a d6.
  const action_roll_invalid_sides = action(() => {
    dice.roll.send({ sides: -3 });
  });
  const assert_invalid_sides_falls_back_to_a_d6 = assert(() =>
    Number.isInteger(dice.value) && dice.value >= 1 && dice.value <= 6
  );

  const assert_nested_output_is_readable = assert(() =>
    dice.something.nested === "a secret surprise!"
  );

  return {
    [TESTS]: [
      { action: action_roll_default },
      { assertion: assert_default_roll_is_a_d6 },
      { action: action_roll_d20 },
      { assertion: assert_d20_roll_is_in_range },
      { action: action_roll_invalid_sides },
      { assertion: assert_invalid_sides_falls_back_to_a_d6 },
      { assertion: assert_nested_output_is_readable },
    ],
    dice,
  };
});
