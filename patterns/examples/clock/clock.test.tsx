import { assert, NAME, pattern, TESTS } from "commonfabric";
import Clock from "./clock.tsx";

// The clock's labels derive from the reactive #now clock. They read the
// load-window placeholders until #now resolves, and the harness re-runs the
// assertions once it does — so these assert the resolved shape (HH:MM:SS and a
// non-empty date), not a specific wall-clock value.
export default pattern(() => {
  const clock = Clock();

  const assert_time_is_clock_shaped = assert(() =>
    /^\d{2}:\d{2}:\d{2}$/.test(clock.time)
  );
  const assert_date_is_non_empty = assert(() => clock.date.length > 0);
  const assert_named_after_time = assert(() =>
    clock[NAME] === `Clock — ${clock.time}`
  );

  return {
    [TESTS]: [
      { assertion: assert_time_is_clock_shaped },
      { assertion: assert_date_is_non_empty },
      { assertion: assert_named_after_time },
    ],
    clock,
  };
});
