/**
 * Star Chart pattern tests.
 *
 * "Today" is pinned through `todayOverride`, so the streak, protection and
 * milestone rules run against fixed dates rather than the live clock.
 *
 * Run: deno task cf test patterns/apps/star-chart/star-chart.test.tsx --verbose
 */
import { action, assert, FS, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import StarChart, {
  type DayRecord,
  liveStreak,
  longestStreak,
  protectedDates,
  streakEndingAt,
  withDayToggled,
  withStarEarned,
} from "./main.tsx";

const earned = (date: string): DayRecord => ({
  date,
  earned: true,
  protected: false,
  rotation: 0,
});

/** Earned days of March 2026, by day of the month. */
const march = (...dates: number[]): DayRecord[] =>
  dates.map((d) => earned(`2026-03-${String(d).padStart(2, "0")}`));

/** How many days the [FS] projection lists. */
const listedDays = (content: string): number =>
  content.split("\n").filter((line) => /^- \d{4}-\d{2}-\d{2}:/.test(line))
    .length;

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
      // Two missed days: not forgiven.
      earned("2026-01-06"),
    ]) === 3
  );
  const assert_earning_twice_is_noop = assert(() =>
    withStarEarned([earned("2026-01-01")], "2026-01-01", 5).length === 1
  );
  const assert_short_streak_not_protected = assert(() =>
    protectedDates(march(1, 2, 4)).size === 0 &&
    protectedDates(march(1, 2, 3, 5)).has("2026-03-04")
  );
  // A forgiven day does not count toward the run the next forgiveness needs:
  // after the 4th is forgiven, the 6th is not, so the streak breaks there.
  const assert_forgiveness_does_not_chain = assert(() => {
    const days = march(1, 2, 3, 5, 7);
    const forgiven = protectedDates(days);
    return forgiven.size === 1 && forgiven.has("2026-03-04") &&
      streakEndingAt(days, "2026-03-07") === 1 &&
      longestStreak(days) === 5;
  });
  // Before today's star: the streak today's star would continue.
  const assert_live_streak_before_earning = assert(() =>
    liveStreak(march(1, 2, 3), "2026-03-04") === 3 &&
    // Yesterday missed after three earned: today's star would forgive it.
    liveStreak(march(1, 2, 3), "2026-03-05") === 3 &&
    // Yesterday missed after only two: the streak is gone.
    liveStreak(march(1, 2), "2026-03-04") === 0 &&
    liveStreak(march(1, 2, 3, 4), "2026-03-04") === 4
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

  // The next morning, before the star: the streak still shows, with a nudge,
  // and the milestone waits for the star that reaches one.
  const action_next_morning = action(() => today.set("2026-03-13"));
  const assert_streak_kept_overnight = assert(() =>
    !chart.todayHasStar && chart.currentStreak === 3 &&
    chart.milestone === "" &&
    hasText(chart[UI], "🔥 3 days!") && hasText(chart[UI], "Keep it going!")
  );

  // Skip the 13th. On the 14th the streak is still alive, since today's star
  // would forgive the miss; earning it protects the 13th.
  const action_skip_a_day = action(() => today.set("2026-03-14"));
  const assert_alive_after_a_miss = assert(() => chart.currentStreak === 3);
  const action_earn_after_miss = action(() => chart.earnStar.send());
  const assert_missed_day_protected = assert(() =>
    chart.protectedDays.join() === "2026-03-13" &&
    chart.currentStreak === 5 &&
    chart.milestone === ""
  );

  // A parent clears the 12th: the 13th loses the run that justified forgiving
  // it, so the streak breaks there and best is re-derived.
  const action_clear_twelfth = action(() =>
    chart.toggleDay.send({ date: "2026-03-12" })
  );
  const assert_streak_broken = assert(() =>
    chart.protectedDays.length === 0 &&
    chart.currentStreak === 1 && chart.bestStreak === 2
  );

  // Putting it back restores the forgiveness along with the streak.
  const action_restore_twelfth = action(() =>
    chart.toggleDay.send({ date: "2026-03-12" })
  );
  const assert_streak_restored = assert(() =>
    chart.protectedDays.join() === "2026-03-13" &&
    chart.currentStreak === 5 && chart.bestStreak === 5
  );

  const assert_fs_projection = assert(() =>
    chart[FS].content.includes("Current streak: 5") &&
    chart[FS].content.includes("Stars earned: 4") &&
    chart[FS].content.includes("2026-03-13: protected") &&
    listedDays(chart[FS].content) === 5
  );

  // Months later the timeline and the [FS] list reach back 30 days, not to
  // the first star.
  const action_months_later = action(() => today.set("2026-06-01"));
  const assert_recent_days_capped = assert(() =>
    listedDays(chart[FS].content) === 30 &&
    chart[FS].content.includes("2026-05-03: missed") &&
    !chart[FS].content.includes("2026-05-02") &&
    chart.currentStreak === 0 && chart.bestStreak === 5
  );

  return {
    [TESTS]: [
      { assertion: assert_streak_crosses_month },
      { assertion: assert_longest_streak_anywhere },
      { assertion: assert_earning_twice_is_noop },
      { assertion: assert_short_streak_not_protected },
      { assertion: assert_forgiveness_does_not_chain },
      { assertion: assert_live_streak_before_earning },
      { assertion: assert_toggle_clears_earned },
      { assertion: assert_starts_empty },
      { action: action_click_star },
      { assertion: assert_star_earned },
      { action: action_day_two },
      { action: action_day_three },
      { assertion: assert_three_day_milestone },
      { action: action_next_morning },
      { assertion: assert_streak_kept_overnight },
      { action: action_skip_a_day },
      { assertion: assert_alive_after_a_miss },
      { action: action_earn_after_miss },
      { assertion: assert_missed_day_protected },
      { action: action_clear_twelfth },
      { assertion: assert_streak_broken },
      { action: action_restore_twelfth },
      { assertion: assert_streak_restored },
      { assertion: assert_fs_projection },
      { action: action_months_later },
      { assertion: assert_recent_days_capped },
    ],
    chart,
  };
});
