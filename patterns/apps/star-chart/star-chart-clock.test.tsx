/**
 * Star Chart's "today" when nothing pins it: the viewer's local date, read
 * from the `#now` clock.
 *
 * The test reads the same five-minute `#now` clock the chart does, which
 * every wish for that interval shares, and checks that today is that
 * instant's local calendar date.
 *
 * Run: deno task cf test patterns/apps/star-chart/star-chart-clock.test.tsx
 */
import {
  action,
  assert,
  computed,
  pattern,
  TESTS,
  wish,
  Writable,
} from "commonfabric";
import StarChart from "./main.tsx";

export default pattern(() => {
  const override = new Writable("");
  const chart = StarChart({ todayOverride: override });
  const nowCell = wish<number>({ query: "#now/300" });

  /** The local calendar date of the clock's instant, or "" until it reads. */
  const clockDate = computed(() => {
    const now = nowCell.result;
    if (now == null) return "";
    const date = new Date(now);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  });

  const assert_today_from_clock = assert(() =>
    clockDate !== "" && chart.today === clockDate
  );

  const action_pin_today = action(() => override.set("2001-03-10"));
  const assert_today_pinned = assert(() =>
    chart.today === "2001-03-10" && chart.today !== clockDate
  );

  const action_unpin_today = action(() => override.set(""));

  return {
    [TESTS]: [
      { assertion: assert_today_from_clock },
      { action: action_pin_today },
      { assertion: assert_today_pinned },
      { action: action_unpin_today },
      { assertion: assert_today_from_clock },
    ],
    chart,
  };
});
