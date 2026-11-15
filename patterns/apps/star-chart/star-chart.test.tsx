/**
 * Star Chart pattern tests.
 *
 * "Today" is pinned through `todayOverride`, so the streak, protection and
 * milestone rules run against fixed dates rather than the live clock.
 *
 * Run: deno task cf test patterns/apps/star-chart/star-chart.test.tsx --verbose
 */
import { action, assert, FS, pattern, TESTS, UI, Writable } from "commonfabric";
import { clickButton } from "../../tools/test-support/vnode-helpers.ts";
import StarChart, {
  type DayRecord,
  longestStreak,
  streakEndingAt,
  withDayToggled,
  withStarEarned,
} from "./star-chart.tsx";

const earned = (date: string): DayRecord => ({
  date,
  earned: true,
  protected: false,
  rotation: 0,
});

export default pattern(() => {
  const today = new Writable("2026-03-10");
  const days = new Writable<DayRecord[]>([]);
  const chart = StarChart({ days, todayOverride: today });

  // --- Pure rules -----------------------------------------------------------

  const assert_streak_crosses_month = assert(() =>
    streakEndingAt(
      [earned("2026-02-28"), earned("2026-03-01"), earned("2026-03-02")],
      "2026-03-02",
    ) === 3
  );
  const assert_longest_streak_anywhere = assert(() =>
    longestStreak([
      earned("2026-01-01"),
      earned("2026-01-02"),
      earned("2026-01-03"),
      earned("2026-01-05"),
    ]) === 3
  );
  const assert_earning_twice_is_noop = assert(() =>
    withStarEarned([earned("2026-01-01")], "2026-01-01", 5).length === 1
  );
  const assert_short_streak_not_protected = assert(() =>
    !withStarEarned(
      [earned("2026-01-01"), earned("2026-01-02")],
      "2026-01-04",
      0,
    ).some((d) => d.protected)
  );
  const assert_toggle_clears_earned = assert(() =>
    withDayToggled([earned("2026-01-01")], "2026-01-01", 0).length === 0
  );

  // --- Through the pattern --------------------------------------------------

  const assert_starts_empty = assert(() =>
    chart.today === "2026-03-10" &&
    chart.currentStreak === 0 &&
    !chart.todayHasStar &&
    chart.goalName === "Gold Star Goal"
  );

  const action_click_star = action(() => clickButton(chart[UI], "⭐"));
  const assert_star_earned = assert(() =>
    chart.todayHasStar && chart.currentStreak === 1 && chart.bestStreak === 1
  );

  // Two more days: a three-day streak hits the first milestone.
  const action_day_two = action(() => {
    today.set("2026-03-11");
    chart.earnStar.send();
  });
  const action_day_three = action(() => {
    today.set("2026-03-12");
    chart.earnStar.send();
  });
  const assert_three_day_milestone = assert(() =>
    chart.currentStreak === 3 && chart.milestone.startsWith("3 days")
  );

  // Skip the 13th; earning on the 14th protects it and keeps the streak.
  const action_skip_a_day = action(() => {
    today.set("2026-03-14");
    chart.earnStar.send();
  });
  const assert_missed_day_protected = assert(() =>
    chart.days.some((d) => d.date === "2026-03-13" && d.protected) &&
    chart.currentStreak === 5 &&
    chart.milestone === ""
  );

  // A parent clears the 12th: the streak breaks, and best is re-derived.
  const action_clear_twelfth = action(() =>
    chart.toggleDay.send({ date: "2026-03-12" })
  );
  const assert_streak_broken = assert(() =>
    chart.currentStreak === 2 && chart.bestStreak === 2
  );

  // And puts it back.
  const action_restore_twelfth = action(() =>
    chart.toggleDay.send({ date: "2026-03-12" })
  );
  const assert_streak_restored = assert(() =>
    chart.currentStreak === 5 && chart.bestStreak === 5
  );

  const assert_fs_projection = assert(() =>
    chart[FS].content.includes("Current streak: 5") &&
    chart[FS].content.includes("2026-03-13: protected")
  );

  return {
    [TESTS]: [
      { assertion: assert_streak_crosses_month },
      { assertion: assert_longest_streak_anywhere },
      { assertion: assert_earning_twice_is_noop },
      { assertion: assert_short_streak_not_protected },
      { assertion: assert_toggle_clears_earned },
      { assertion: assert_starts_empty },
      { action: action_click_star },
      { assertion: assert_star_earned },
      { action: action_day_two },
      { action: action_day_three },
      { assertion: assert_three_day_milestone },
      { action: action_skip_a_day },
      { assertion: assert_missed_day_protected },
      { action: action_clear_twelfth },
      { assertion: assert_streak_broken },
      { action: action_restore_twelfth },
      { assertion: assert_streak_restored },
      { assertion: assert_fs_projection },
    ],
    chart,
  };
});
