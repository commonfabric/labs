/**
 * Reward Spinner pattern tests.
 *
 * The weighting, the reel strip and the spin lock are pure functions driven by
 * fixed rolls and times. Through the pattern, a spin's prize is random, so the
 * tests check what must hold for any prize: it is recorded with its
 * generosity, the reel ends on it, and the reel rests on it afterwards.
 *
 * Run: deno task cf test patterns/apps/reward-spinner/reward-spinner.test.tsx --verbose
 */
import { action, assert, FS, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import RewardSpinner, {
  buildReel,
  clampGenerosity,
  isReelTurning,
  pickPrize,
  prizePercents,
  PRIZES,
  prizeWeights,
  REEL_LENGTH,
  SPIN_MS,
  type SpinRecord,
} from "./reward-spinner.tsx";

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const emojis = PRIZES.map((p) => p.emoji);

export default pattern(() => {
  const generosity = new Writable(10);
  const spinHistory = new Writable<SpinRecord[]>([]);
  const spinner = RewardSpinner({ generosity, spinHistory });

  // --- Pure rules -----------------------------------------------------------

  const assert_weights_at_extremes = assert(() => {
    const stingy = prizePercents(0);
    const generous = prizePercents(10);
    return stingy[2] === 95 && sum(stingy.slice(0, 2)) === 5 &&
      generous[2] === 5 && sum(generous.slice(0, 2)) === 95;
  });
  const assert_even_at_five = assert(() => {
    const w = prizeWeights(5);
    return w[0] + w[1] === w[2];
  });
  const assert_three_beans_is_rare_candy = assert(() => {
    const [three, one] = prizeWeights(7);
    return Math.abs(three / (three + one) - 0.15) < 1e-9;
  });
  const assert_generosity_clamped = assert(() =>
    clampGenerosity(-3) === 0 && clampGenerosity(14) === 10 &&
    clampGenerosity(4.6) === 5
  );
  const assert_pick_by_roll = assert(() =>
    // At 10: three beans 3.15, one bean 17.85, hug 1 of 22.
    pickPrize(10, 0) === 0 &&
    pickPrize(10, 0.2) === 1 &&
    pickPrize(10, 0.94) === 1 &&
    pickPrize(10, 0.96) === 2 &&
    pickPrize(10, 0.999999) === 2 &&
    // At 0 a mid roll is a hug.
    pickPrize(0, 0.5) === 2
  );
  const assert_reel_shape = assert(() => {
    const reel = buildReel("🎁", "🤗", [0, 0.5, 0.99]);
    return reel.length === REEL_LENGTH &&
      reel[0] === "🎁" &&
      reel[REEL_LENGTH - 1] === "🤗" &&
      reel[1] === PRIZES[0].emoji &&
      reel[2] === PRIZES[1].emoji &&
      reel[3] === PRIZES[2].emoji &&
      reel.slice(1, -1).every((e) => emojis.includes(e));
  });
  const assert_spin_lock = assert(() =>
    !isReelTurning(undefined, 1_000_000) &&
    isReelTurning(1_000_000, 1_000_000) &&
    isReelTurning(1_000_000, 1_000_000 + SPIN_MS - 1) &&
    !isReelTurning(1_000_000, 1_000_000 + SPIN_MS) &&
    // A spin stamped ahead of this clock (another device's) does not lock it.
    !isReelTurning(1_000_000 + 1, 1_000_000) &&
    !isReelTurning(1_000_000 + 60 * SPIN_MS, 1_000_000)
  );

  // --- Through the pattern --------------------------------------------------

  const assert_starts_on_gift = assert(() =>
    spinner.lastPrize === "🎁" &&
    spinner.spinHistory.length === 0 &&
    spinner.reel.length === 0 &&
    spinner.odds[2].percent === 5 &&
    spinner[FS].content.includes("No spins yet.")
  );

  // The odds readout follows the generosity buttons, and stops at the ends.
  const action_more_at_max = action(() => clickButton(spinner[UI], "+"));
  const assert_still_ten = assert(() => spinner.generosity === 10);
  const action_less_twice = action(() => {
    clickButton(spinner[UI], "−");
    spinner.lessGenerous.send();
  });
  const assert_eight = assert(() =>
    spinner.generosity === 8 &&
    spinner.odds.map((o) => o.percent).join(",") ===
      prizePercents(8).join(",") &&
    spinner.odds[2].dots === "🔴".repeat(Math.round(prizePercents(8)[2] / 10))
  );

  const action_spin = action(() => spinner.spin.send());
  const assert_spin_recorded = assert(() => {
    const history = spinner.spinHistory;
    const last = history[history.length - 1];
    const emoji = PRIZES.find((p) => p.id === last?.prize)?.emoji;
    return history.length === 1 &&
      last.generosity === 8 &&
      last.timestamp > 0 &&
      emoji !== undefined &&
      spinner.lastPrize === emoji &&
      spinner.reel.length === REEL_LENGTH &&
      spinner.reel[0] === "🎁" &&
      spinner.reel[REEL_LENGTH - 1] === emoji &&
      spinner[FS].content.includes("generosity 8 ·");
  });

  // A tap while the reel is still turning records nothing.
  const action_spin_again_at_once = action(() => spinner.spin.send());
  const assert_still_one_spin = assert(() => spinner.spinHistory.length === 1);

  // A fresh session on the same history (a reload) shows the last prize at
  // rest, so its first tap spins even though that prize landed moments ago.
  const reloaded = RewardSpinner({ generosity, spinHistory });
  const action_tap_after_reload = action(() => reloaded.spin.send());
  const assert_reload_spins = assert(() =>
    spinner.spinHistory.length === 2 && reloaded.reel.length === REEL_LENGTH
  );
  const action_drop_reload_spin = action(() =>
    spinHistory.set(spinHistory.get().slice(0, 1))
  );

  // Once the last spin has landed (aged here), the next tap spins, and the
  // new strip starts where the reel came to rest.
  const action_age_and_spin = action(() => {
    const [only] = spinHistory.get();
    spinHistory.set([{ ...only, timestamp: only.timestamp - SPIN_MS }]);
    spinner.spin.send();
  });
  const assert_second_spin = assert(() => {
    const history = spinner.spinHistory;
    const first = PRIZES.find((p) => p.id === history[0]?.prize)?.emoji;
    return history.length === 2 && spinner.reel[0] === first;
  });

  // A spin recorded by a device whose clock runs a minute ahead does not lock
  // this one: the next tap spins.
  const action_future_spin_then_tap = action(() => {
    const history = spinHistory.get();
    const last = history[history.length - 1];
    spinHistory.set([
      ...history.slice(0, -1),
      { ...last, timestamp: last.timestamp + 60_000 },
    ]);
    spinner.spin.send();
  });
  const assert_not_locked = assert(() => spinner.spinHistory.length === 3);

  // The reel is mapped from a session-scoped list: the rendered strip is this
  // session's latest spin, ending on its prize.
  const assert_reel_rendered = assert(() => {
    const history = spinner.spinHistory;
    const prize = PRIZES.find((p) =>
      p.id === history[history.length - 1]?.prize
    );
    return spinner.reel.length === REEL_LENGTH &&
      spinner.reel[REEL_LENGTH - 1] === prize?.emoji &&
      hasText(spinner[UI], "🤗") === spinner.reel.includes("🤗");
  });

  return {
    [TESTS]: [
      { assertion: assert_weights_at_extremes },
      { assertion: assert_even_at_five },
      { assertion: assert_three_beans_is_rare_candy },
      { assertion: assert_generosity_clamped },
      { assertion: assert_pick_by_roll },
      { assertion: assert_reel_shape },
      { assertion: assert_spin_lock },
      { assertion: assert_starts_on_gift },
      { action: action_more_at_max },
      { assertion: assert_still_ten },
      { action: action_less_twice },
      { assertion: assert_eight },
      { action: action_spin },
      { assertion: assert_spin_recorded },
      { action: action_spin_again_at_once },
      { assertion: assert_still_one_spin },
      { action: action_tap_after_reload },
      { assertion: assert_reload_spins },
      { action: action_drop_reload_spin },
      { action: action_age_and_spin },
      { assertion: assert_second_spin },
      { action: action_future_spin_then_tap },
      { assertion: assert_not_locked },
      { assertion: assert_reel_rendered },
    ],
    spinner,
  };
});
