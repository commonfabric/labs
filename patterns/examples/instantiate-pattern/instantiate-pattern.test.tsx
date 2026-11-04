import { assert, NAME, pattern, TESTS } from "commonfabric";
import Factory, { Counter } from "./instantiate-pattern.tsx";

// Covers both patterns this example file defines: the Counter it hands to
// navigateTo, and the factory that creates them. The factory's own `newCounter`
// handler is reachable only through the message input's event binding, so a
// headless test cannot fire it; what it does — draw Math.random() and hand the
// result to Counter — is exercised here by constructing a Counter directly.
export default pattern(() => {
  const counter = Counter({ value: 3 });
  const factory = Factory({ pieceRegistry: [] });

  const assert_counter_reports_its_value = assert(() => counter.value === 3);
  // The name is a computed over the same cell, so it tracks the value.
  const assert_counter_name_tracks_the_value = assert(() =>
    counter[NAME] === "Simple counter: 3"
  );
  const assert_factory_instantiates = assert(() =>
    factory[NAME] === "Counter Factory"
  );

  return {
    [TESTS]: [
      { assertion: assert_counter_reports_its_value },
      { assertion: assert_counter_name_tracks_the_value },
      { assertion: assert_factory_instantiates },
    ],
    counter,
    factory,
  };
});
