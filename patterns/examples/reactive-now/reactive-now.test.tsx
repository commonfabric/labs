import { action, assert, pattern, TESTS } from "commonfabric";
import ReactiveNow from "./reactive-now.tsx";

// The time labels derive from the reactive #now clock: they read "…" until #now
// resolves, and the harness re-runs the assertions once it does — so these assert
// the resolved shape, not a specific wall-clock value.
//
// The tap step only checks the handler's logic (a delivery increments the
// counter). The delivery SHAPING is not exercised here: shaping applies only to
// real renderer-trusted clicks, and a headless test send is delivered
// immediately — the shaping is a live-browser behavior.
export default pattern(() => {
  const demo = ReactiveNow();

  const assert_loaded_at_is_clock_shaped = assert(() =>
    /^\d{2}:\d{2}:\d{2}$/.test(demo.loadedAt)
  );
  const assert_now_is_clock_shaped = assert(() =>
    /^\d{2}:\d{2}:\d{2}$/.test(demo.now)
  );
  const assert_since_load_is_ago_shaped = assert(() =>
    /^\d+s ago$/.test(demo.sinceLoad)
  );

  const action_tap = action(() => {
    demo.tap.send({});
  });
  const assert_tap_delivered = assert(() => demo.taps >= 1);

  // Keystroke path: driving the text box updates the derived char count and echo.
  // Like the tap, the delivery SHAPING is not exercised here (a headless test
  // send is delivered immediately); this only checks the derivation.
  const action_type = action(() => {
    demo.type.send({ value: "hello" });
  });
  const assert_char_count = assert(() => demo.charCount === 5);
  const assert_echo = assert(() => demo.echo === "HELLO");

  return {
    [TESTS]: [
      { assertion: assert_loaded_at_is_clock_shaped },
      { assertion: assert_now_is_clock_shaped },
      { assertion: assert_since_load_is_ago_shaped },
      { action: action_tap },
      { assertion: assert_tap_delivered },
      { action: action_type },
      { assertion: assert_char_count },
      { assertion: assert_echo },
    ],
    demo,
  };
});
