/**
 * Reward Spinner — a slot-machine prize spinner for kids.
 *
 * The child taps the reel; it whirs through prizes for six seconds and lands
 * on three jelly beans, one jelly bean or a big hug, then bursts into stars.
 * A parent sets the odds with a small, deliberately unobtrusive "generosity"
 * control at the bottom (0 = mostly hugs, 10 = mostly candy); each change
 * briefly shows the resulting odds. Every spin is recorded with its time and
 * the generosity it was spun at.
 *
 * Ported from jkomoros/community-patterns (`reward-spinner.tsx`). The outcome
 * is decided once, in the spin action, together with the whole reel strip;
 * the reel is then a pure CSS animation that scrolls to that strip's last
 * cell, so no timers are needed. The reel animates only for spins made in this
 * session (a page load starts a new session), so returning to the page shows
 * the last prize rather than replaying a spin. Taps while this session's reel
 * is still turning are ignored, so every recorded spin is one the child saw
 * land; a reload, whose reel is at rest, spins on the first tap.
 */
import {
  action,
  computed,
  Default,
  FS,
  NAME,
  pattern,
  type PerSession,
  type PerSpace,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ---------------------------------------------------------------------------
// Prizes and odds. Pure functions, so the spin action, the odds readout and
// the tests all share one definition of the weighting.
// ---------------------------------------------------------------------------

export type PrizeId = "three-beans" | "one-bean" | "hug";

export interface Prize {
  id: PrizeId;
  emoji: string;
  label: string;
}

/** In weight order: `prizeWeights` returns one weight per entry. */
export const PRIZES: readonly Prize[] = [
  { id: "three-beans", emoji: "🍬🍬🍬", label: "Three Jelly Beans!" },
  { id: "one-bean", emoji: "🍬", label: "One Jelly Bean!" },
  { id: "hug", emoji: "🤗", label: "Big Hug!" },
];

export const MIN_GENEROSITY = 0;
export const MAX_GENEROSITY = 10;

/** Shown on the reel before the first spin. */
const GIFT = "🎁";

/** How long the reel turns, in ms; taps during it are ignored. */
export const SPIN_MS = 6000;

/** Cells on the reel strip: the previous prize, filler, then the outcome. */
export const REEL_LENGTH = 31;

/** One reel cell's height in px; the strip scrolls by (length - 1) cells. */
const CELL_PX = 200;

export const clampGenerosity = (generosity: number): number =>
  Math.min(
    MAX_GENEROSITY,
    Math.max(MIN_GENEROSITY, Math.round(Number(generosity) || 0)),
  );

/**
 * Relative weights for [three beans, one bean, hug]. Hugs and candy trade
 * linearly: at 0 a hug is 21:1 against candy (about 95% hugs), at 5 they are
 * even, at 10 candy is 21:1. Three beans is always 15% of the candy share.
 */
export const prizeWeights = (generosity: number): number[] => {
  const g = clampGenerosity(generosity);
  const hug = 1 + (MAX_GENEROSITY - g) * 2;
  const candy = 1 + g * 2;
  return [candy * 0.15, candy * 0.85, hug];
};

/**
 * The prize index a roll in [0, 1) selects at this generosity: the first
 * prize whose cumulative weight share exceeds the roll.
 */
export const pickPrize = (generosity: number, roll: number): number => {
  const weights = prizeWeights(generosity);
  const total = weights.reduce((sum, w) => sum + w, 0);
  const target = Math.min(Math.max(roll, 0), 1) * total;
  const cumulative = weights.map((_, i) =>
    weights.slice(0, i + 1).reduce((sum, w) => sum + w, 0)
  );
  const index = cumulative.findIndex((edge) => target < edge);
  return index === -1 ? weights.length - 1 : index;
};

/** Each prize's chance at this generosity, as a whole percentage. */
export const prizePercents = (generosity: number): number[] => {
  const weights = prizeWeights(generosity);
  const total = weights.reduce((sum, w) => sum + w, 0);
  return weights.map((w) => Math.round((w / total) * 100));
};

/**
 * The reel strip for one spin: it starts on the previous prize, so the reel
 * does not jump when it starts, runs through filler prizes picked uniformly by
 * `fillerRolls`, and ends on the outcome, where the animation stops.
 */
export const buildReel = (
  previous: string,
  outcome: string,
  fillerRolls: readonly number[],
): string[] => {
  const filler = Array.from({ length: REEL_LENGTH - 2 }, (_, i) => {
    const roll = fillerRolls[i] ?? 0;
    const index = Math.min(
      PRIZES.length - 1,
      Math.floor(Math.max(roll, 0) * PRIZES.length),
    );
    return PRIZES[index].emoji;
  });
  return [previous, ...filler, outcome];
};

const prizeById = (id: string): Prize | undefined =>
  PRIZES.find((p) => p.id === id);

export interface SpinRecord {
  /** When the spin was made, ms since the epoch. */
  timestamp: number;
  /** The generosity the spin was made at, 0-10. */
  generosity: number;
  prize: PrizeId;
}

const lastSpinEmoji = (history: readonly SpinRecord[]): string =>
  history.length === 0
    ? GIFT
    : prizeById(history[history.length - 1].prize)?.emoji ?? GIFT;

/** Whether a reel started at `lastTimestamp` is still turning at `now`. A
 * spin stamped in the future (by a device whose clock runs ahead) is not
 * turning here, so it cannot lock this device's spinner. */
export const isReelTurning = (
  lastTimestamp: number | undefined,
  now: number,
): boolean => {
  if (lastTimestamp === undefined) return false;
  const elapsed = now - lastTimestamp;
  return elapsed >= 0 && elapsed < SPIN_MS;
};

// Viewer-local timestamp for the [FS] projection; `toLocale*` would be UTC.
const pad2 = (n: number): string => String(n).padStart(2, "0");
const formatLocalTime = (timestamp: number): string => {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${
    pad2(d.getHours())
  }:${pad2(d.getMinutes())}`;
};

// ---------------------------------------------------------------------------
// Styles. The stars are one keyframe driven by per-star custom properties.
// Each animation exists under two identical names (…A / …B); a spin flips the
// name, which is what makes the browser restart the animation.
// ---------------------------------------------------------------------------

/** [x px, y px, turn deg, end scale, size px, duration s, peak opacity, hold %] */
const SPARKLES: readonly (readonly number[])[] = [
  [320, -15, 840, 1.8, 42, 1.2, 1, 45],
  [265, 110, 620, 2.5, 75, 3.5, 0.6, 25],
  [195, 215, 920, 2.1, 45, 0.9, 1, 35],
  [115, 280, 710, 1.5, 38, 2.8, 1, 52],
  [25, 315, 865, 3.2, 90, 1.4, 0.5, 20],
  [-85, 285, 590, 1.2, 35, 3.2, 1, 47],
  [-195, 235, 780, 1.7, 52, 1.1, 1, 38],
  [-270, 155, 650, 2.8, 68, 2.6, 0.65, 28],
  [-310, 55, 890, 2.0, 40, 0.8, 1, 40],
  [-295, -40, 735, 3.0, 80, 3.0, 0.55, 22],
  [-265, -135, 810, 1.3, 36, 2.4, 1, 54],
  [-205, -220, 670, 1.8, 48, 1.3, 1, 42],
  [-120, -285, 940, 3.4, 95, 1.6, 0.6, 24],
  [-20, -320, 690, 2.2, 32, 0.95, 1, 36],
  [95, -310, 820, 2.6, 62, 3.3, 0.7, 30],
  [185, -265, 610, 1.6, 44, 1.5, 1, 48],
  [275, -190, 880, 3.1, 85, 2.2, 0.55, 26],
  [310, -105, 640, 1.3, 38, 3.6, 1, 51],
  [315, 35, 760, 2.9, 70, 1.0, 0.6, 32],
  [280, 125, 900, 2.0, 40, 2.9, 1, 50],
];

// A keyframe selector cannot be a custom property, so each star's hold point
// gets its own pair of keyframes.
const sparkleKeyframes = (name: string, hold: number): string =>
  `@keyframes ${name} {
  0% { transform: translate(0, 0) rotate(0deg) scale(0.2); opacity: 0; }
  1% { opacity: var(--peak); }
  ${hold}% { opacity: var(--peak); }
  100% { transform: translate(var(--tx), var(--ty)) rotate(var(--turn)) scale(var(--grow)); opacity: 0; }
}`;

const sparkleRules = (): string =>
  SPARKLES.map(
    ([tx, ty, turn, grow, size, seconds, peak], i) =>
      `.sparkle-${i} { --tx: ${tx}px; --ty: ${ty}px; --turn: ${turn}deg; --grow: ${grow}; --peak: ${peak}; font-size: ${size}px; animation-duration: ${seconds}s; }`,
  ).join("\n");

const sparkleHoldKeyframes = (): string =>
  SPARKLES.map(([, , , , , , , hold], i) =>
    sparkleKeyframes(`sparkleA${i}`, hold) + "\n" +
    sparkleKeyframes(`sparkleB${i}`, hold) +
    `\n.burst-a .sparkle-${i} { animation-name: sparkleA${i}; }` +
    `\n.burst-b .sparkle-${i} { animation-name: sparkleB${i}; }`
  ).join("\n");

// Module scope holds only plain data under SES, so the stylesheet is built by
// a function the pattern calls once.
const animationsCss = (): string => {
  const reelEnd = `translateY(-${(REEL_LENGTH - 1) * CELL_PX}px)`;
  return `
@keyframes tapToSpinFade {
  0% { opacity: 0; }
  10% { opacity: 1; }
  50% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes reelA { from { transform: translateY(0); } to { transform: ${reelEnd}; } }
@keyframes reelB { from { transform: translateY(0); } to { transform: ${reelEnd}; } }
@keyframes payoutFadeA {
  0%, 85% { transform: translateY(0); opacity: 1; }
  100% { transform: translateY(-10px); opacity: 0; }
}
@keyframes payoutFadeB {
  0%, 85% { transform: translateY(0); opacity: 1; }
  100% { transform: translateY(-10px); opacity: 0; }
}
.tap-hint {
  position: absolute; top: 20%; left: 50%;
  transform: translate(-50%, -50%);
  font-size: 16px; color: #64748b; letter-spacing: 0.5px;
  opacity: 0; pointer-events: none; z-index: 10;
  animation: tapToSpinFade 3s ease-in-out forwards;
}
.reel {
  display: flex; flex-direction: column; align-items: center;
  position: absolute; top: 0; left: 0; width: 100%;
  animation-duration: ${SPIN_MS / 1000}s;
  animation-timing-function: cubic-bezier(0.05, 0.7, 0.3, 1);
  animation-fill-mode: forwards;
}
.reel-a { animation-name: reelA; }
.reel-b { animation-name: reelB; }
.cell {
  font-size: 105px; line-height: ${CELL_PX}px; height: ${CELL_PX}px;
  width: 100%; flex-shrink: 0; position: relative;
}
.cell span { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); }
.cell .bean-left { left: calc(50% - 40px); top: calc(50% - 15px); z-index: 1; }
.cell .bean-right { left: calc(50% + 40px); top: calc(50% - 15px); z-index: 1; }
.cell .bean-front { z-index: 2; }
.burst {
  position: absolute; top: 50%; left: 50%; width: 0; height: 0;
  pointer-events: none; z-index: 1000;
}
.sparkle {
  position: absolute; left: 0; top: 0; opacity: 0;
  animation-timing-function: ease-out;
  animation-delay: ${SPIN_MS / 1000}s;
}
${sparkleRules()}
${sparkleHoldKeyframes()}
.payout {
  display: flex; flex-direction: column; gap: 3px; margin-bottom: 6px;
  background-color: rgba(255, 255, 255, 0.6); padding: 6px 10px;
  border-radius: 3px; backdrop-filter: blur(4px);
  animation-duration: 3.5s; animation-timing-function: ease-out;
  animation-fill-mode: forwards;
}
.payout-a { animation-name: payoutFadeA; }
.stepper:disabled { opacity: 0.5; cursor: not-allowed; }
.payout-b { animation-name: payoutFadeB; }
`;
};

const styles = {
  screen:
    "background-color: white; font-family: system-ui, sans-serif; overflow: hidden;",
  page: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100dvh",
    maxHeight: "100%",
    overflow: "hidden",
    touchAction: "manipulation",
  },
  stage: {
    position: "relative",
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  window: {
    position: "relative",
    width: "300px",
    height: "200px",
    overflow: "hidden",
    maskImage:
      "linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%)",
    cursor: "pointer",
    transform: "scale(2.0)",
    background: "none",
    border: "none",
    padding: "0",
    font: "inherit",
  },
  controls: {
    position: "fixed",
    bottom: "10px",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "4px",
    fontSize: "9px",
    color: "#94a3b8",
    padding: "6px 10px",
  },
  oddsRow: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "10px",
    whiteSpace: "nowrap",
  },
  oddsEmoji: {
    fontSize: "12px",
    minWidth: "36px",
    textAlign: "right",
    flexShrink: "0",
  },
  oddsDots: { fontSize: "10px", flexShrink: "0" },
  oddsPercent: { fontSize: "9px", minWidth: "28px", flexShrink: "0" },
  tada: { fontSize: "12px", minHeight: "16px", lineHeight: "1" },
  buttons: { display: "flex", alignItems: "center", gap: "6px" },
  stepper: {
    fontSize: "14px",
    padding: "2px 8px",
    border: "1px solid #e2e8f0",
    borderRadius: "2px",
    background: "white",
    // Explicit, or the − and + take the UA's `buttontext`, which is white
    // under a dark color scheme and vanishes on the white button.
    color: "#64748b",
    cursor: "pointer",
  },
} as const;

// ---------------------------------------------------------------------------
// Pattern
// ---------------------------------------------------------------------------

interface ReelCell {
  emoji: string;
  /** Three beans are drawn as a little pile rather than a row. */
  isPile: boolean;
}

export interface PrizeOdds {
  emoji: string;
  /** One dot per ten percent: green for candy, red for a hug. */
  dots: string;
  percent: number;
}

/** This session's latest spin: the strip to animate, and a spin counter whose
 * parity picks the animation name. */
interface SessionSpin {
  reel: string[];
  count: number;
}

interface RewardSpinnerInput {
  /** 0 = mostly hugs, 10 = mostly candy. */
  generosity?: PerSpace<Writable<number | Default<10>>>;
  spinHistory?: PerSpace<Writable<SpinRecord[] | Default<[]>>>;
}

export interface RewardSpinnerOutput {
  [NAME]: string;
  [UI]: VNode;
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };
  generosity: number;
  spinHistory: SpinRecord[];
  /** The prize the reel shows at rest: the last spin's, or 🎁 before any. */
  lastPrize: string;
  /** Each prize's chance at the current generosity. */
  odds: PrizeOdds[];
  /** The strip this session's latest spin scrolls through; empty before one. */
  reel: PerSession<string[]>;
  /** Spin the reel: picks the prize and records the spin. */
  spin: Stream<void>;
  moreGenerous: Stream<void>;
  lessGenerous: Stream<void>;
}

const RewardSpinner = pattern<RewardSpinnerInput, RewardSpinnerOutput>(
  ({ generosity, spinHistory }) => {
    const animations = animationsCss();
    const sessionSpin = new Writable.perSession<SessionSpin>({
      reel: [],
      count: 0,
    });
    // Bumped by the generosity buttons to replay the odds readout's fade.
    const oddsShown = new Writable.perSession<number>(0);

    const lastPrize = computed(() => lastSpinEmoji(spinHistory.get()));

    const reel = computed((): PerSession<string[]> => sessionSpin.get().reel);

    // At rest (no spin yet this session) the reel is the single last prize.
    const reelCells = computed((): PerSession<ReelCell[]> => {
      const strip = sessionSpin.get().reel;
      const cells = strip.length > 0
        ? strip
        : [lastSpinEmoji(spinHistory.get())];
      return cells.map((emoji) => ({
        emoji,
        isPile: emoji === PRIZES[0].emoji,
      }));
    });

    const spunThisSession = computed((): PerSession<boolean> =>
      sessionSpin.get().count > 0
    );
    const reelClass = computed((): PerSession<string> => {
      const count = sessionSpin.get().count;
      return count === 0
        ? "reel"
        : count % 2 === 0
        ? "reel reel-a"
        : "reel reel-b";
    });
    const burstClass = computed((): PerSession<string> =>
      sessionSpin.get().count % 2 === 0 ? "burst burst-a" : "burst burst-b"
    );
    const payoutClass = computed((): PerSession<string> =>
      oddsShown.get() % 2 === 0 ? "payout payout-a" : "payout payout-b"
    );

    const odds = computed((): PrizeOdds[] => {
      const percents = prizePercents(generosity.get());
      return PRIZES.map((prize, i) => ({
        emoji: prize.emoji,
        dots: (prize.id === "hug" ? "🔴" : "🟢").repeat(
          Math.round(percents[i] / 10),
        ),
        percent: percents[i],
      }));
    });

    const tada = computed(() => "🎉".repeat(clampGenerosity(generosity.get())));
    const atMin = computed(() =>
      clampGenerosity(generosity.get()) <= MIN_GENEROSITY
    );
    const atMax = computed(() =>
      clampGenerosity(generosity.get()) >= MAX_GENEROSITY
    );

    const spin = action(() => {
      const history = spinHistory.get();
      const now = Date.now();
      // Only a reel this session set turning can be turning: a fresh session
      // (a reload) shows the last prize at rest, so its first tap spins.
      if (
        sessionSpin.get().count > 0 &&
        isReelTurning(history[history.length - 1]?.timestamp, now)
      ) return;
      const gen = clampGenerosity(generosity.get());
      const prize = PRIZES[pickPrize(gen, Math.random())];
      const fillerRolls = Array.from(
        { length: REEL_LENGTH - 2 },
        () => Math.random(),
      );
      // The strip starts where the reel rests now, so the reel does not jump.
      const start = sessionSpin.get().reel;
      const previous = start.length > 0
        ? start[start.length - 1]
        : lastSpinEmoji(history);
      sessionSpin.set({
        reel: buildReel(previous, prize.emoji, fillerRolls),
        count: sessionSpin.get().count + 1,
      });
      spinHistory.push({ timestamp: now, generosity: gen, prize: prize.id });
    });

    const moreGenerous = action(() => {
      const current = clampGenerosity(generosity.get());
      if (current >= MAX_GENEROSITY) return;
      generosity.set(current + 1);
      oddsShown.set(oddsShown.get() + 1);
    });
    const lessGenerous = action(() => {
      const current = clampGenerosity(generosity.get());
      if (current <= MIN_GENEROSITY) return;
      generosity.set(current - 1);
      oddsShown.set(oddsShown.get() + 1);
    });

    const fsContent = computed(() => {
      const gen = clampGenerosity(generosity.get());
      const percents = prizePercents(gen);
      const oddsLine = PRIZES.map((p, i) => `${p.emoji} ${percents[i]}%`).join(
        " · ",
      );
      const spins = [...spinHistory.get()].reverse().map((s) =>
        `- ${formatLocalTime(s.timestamp)} · generosity ${s.generosity} · ${
          prizeById(s.prize)?.emoji ?? "?"
        } ${prizeById(s.prize)?.label ?? s.prize}`
      );
      return [
        "# Reward Spinner",
        "",
        `Generosity: ${gen}/${MAX_GENEROSITY} (${oddsLine})`,
        "",
        "## Spins",
        "",
        ...(spins.length > 0 ? spins : ["No spins yet."]),
      ].join("\n");
    });

    return {
      [NAME]: "Reward Spinner",
      [UI]: (
        <cf-screen style={styles.screen}>
          <div style={styles.page}>
            <div style={styles.stage}>
              <div className="tap-hint">Tap to spin</div>
              <button
                type="button"
                aria-label="Spin"
                onClick={spin}
                style={styles.window}
              >
                <div className={reelClass}>
                  {reelCells.map((cell) => (
                    <div className="cell">
                      {cell.isPile
                        ? (
                          <>
                            <span className="bean-left">🍬</span>
                            <span className="bean-right">🍬</span>
                            <span className="bean-front">🍬</span>
                          </>
                        )
                        : <span>{cell.emoji}</span>}
                    </div>
                  ))}
                </div>
              </button>

              {spunThisSession
                ? (
                  <div className={burstClass}>
                    {SPARKLES.map((_, i) => (
                      <div className={`sparkle sparkle-${i}`}>⭐</div>
                    ))}
                  </div>
                )
                : null}
            </div>

            {/* Parent controls: small and quiet, so kids don't notice them. */}
            <div style={styles.controls}>
              <div className={payoutClass}>
                {odds.map((row) => (
                  <div style={styles.oddsRow}>
                    <span style={styles.oddsEmoji}>{row.emoji}</span>
                    <span style={styles.oddsDots}>{row.dots}</span>
                    <span style={styles.oddsPercent}>{row.percent}%</span>
                  </div>
                ))}
              </div>
              <div style={styles.tada}>{tada}</div>
              <div style={styles.buttons}>
                <button
                  type="button"
                  aria-label="Fewer treats"
                  onClick={lessGenerous}
                  disabled={atMin}
                  className="stepper"
                  style={styles.stepper}
                >
                  −
                </button>
                <button
                  type="button"
                  aria-label="More treats"
                  onClick={moreGenerous}
                  disabled={atMax}
                  className="stepper"
                  style={styles.stepper}
                >
                  +
                </button>
              </div>
            </div>
            <style>{animations}</style>
          </div>
        </cf-screen>
      ),
      [FS]: {
        type: "text/markdown",
        frontmatter: { title: "Reward Spinner" },
        content: fsContent,
      },
      generosity,
      spinHistory,
      lastPrize,
      odds,
      reel,
      spin,
      moreGenerous,
      lessGenerous,
    };
  },
);

export default RewardSpinner;
