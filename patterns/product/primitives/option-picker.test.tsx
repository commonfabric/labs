/**
 * Tests OptionPicker: that selecting works, that clearing empties, and that a
 * value nobody offered is refused.
 *
 * Run: deno task cf test patterns/product/primitives/option-picker.test.tsx
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import OptionPicker from "./option-picker.tsx";

export default pattern(() => {
  const picker = OptionPicker({ options: ["Food", "Travel", "Lodging"] });

  const pickTravel = action(() => picker.select.send({ option: "Travel" }));
  const pickAbsent = action(() => picker.select.send({ option: "Nonsense" }));
  const clear = action(() => picker.clear.send());

  return {
    [TESTS]: [
      { assertion: assert(() => picker.selected === "") },
      { assertion: assert(() => picker.hasSelection === false) },
      { assertion: assert(() => picker.options.length === 3) },

      { action: pickTravel },
      { assertion: assert(() => picker.selected === "Travel") },
      { assertion: assert(() => picker.hasSelection === true) },

      // A choice that is not on offer would leave the dropdown showing the
      // placeholder while `selected` said otherwise, so it is refused and the
      // previous selection stands.
      { action: pickAbsent },
      { assertion: assert(() => picker.selected === "Travel") },

      { action: clear },
      { assertion: assert(() => picker.selected === "") },
      { assertion: assert(() => picker.hasSelection === false) },

      // The dropdown offers the placeholder plus every option, in order.
      {
        assertion: assert(() =>
          findElement(picker[UI], "cf-select") !== undefined
        ),
      },
      // The placeholder stands for "nothing picked" and leads the list, so a
      // host reads one field rather than a value and a flag.
      {
        assertion: assert(() => {
          const items = propValue(
            findElement(picker[UI], "cf-select"),
            "items",
          ) as { label: string; value: string }[] | undefined;
          // The prop reads undefined until the computed settles, so this is a
          // guard rather than a cast: throwing would fail the assertion on its
          // first evaluation instead of letting it converge.
          return Array.isArray(items) && items.length === 4 &&
            items[0].value === "" && items[0].label === "None" &&
            items[1].label === "Food";
        }),
      },
      { assertion: assert(() => picker[NAME] === "Choose: none") },
    ],
  };
});
