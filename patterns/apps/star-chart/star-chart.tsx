/**
 * Star Chart — a reward calendar for a child learning one daily habit.
 *
 * Each day the child taps the big star to earn it. Earned days show as
 * stickers at a random tilt along a timeline back to the first recorded day,
 * with a streak counter and celebrations at 3, 7, 14 and 30 days. A parent can
 * correct past days, and a single missed day after a streak of three or more is
 * forgiven: it is recorded as a dimmed "protected" day that keeps the streak.
 *
 * Ported from jkomoros/community-patterns (`star-chart.tsx`). The best streak
 * is now derived from the recorded days rather than stored, so correcting a
 * past day can lower it as well as raise it, and a milestone is celebrated on
 * every streak that reaches it rather than only the first time.
 *
 * Today is the viewer's local calendar day, read from the reactive `#now`
 * clock. `todayOverride` (YYYY-MM-DD) pins it, for tests and for trying the
 * chart on another date.
 */
import {
  action,
  computed,
  Default,
  FS,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

export interface DayRecord {
  /** The local calendar day, YYYY-MM-DD. */
  date: string;
  /** The child earned the star that day. */
  earned: boolean;
  /** A forgiven missed day: shown dimmed, and it keeps the streak going. */
  protected: boolean;
  /** The sticker's tilt in degrees, -15 to 15, fixed when it was placed. */
  rotation: number;
}

const MILESTONES = [
  { days: 3, message: "3 days! Great start! 🌟" },
  { days: 7, message: "One whole week! Amazing! 🎉" },
  { days: 14, message: "Two weeks! You're on fire! 🔥" },
  { days: 30, message: "ONE MONTH! Incredible! 🏆" },
] as const;

/** A missed day is forgiven only after a streak at least this long. */
const PROTECT_AFTER_STREAK = 3;

/** How many days the parent's correction list reaches back. */
const CORRECTION_DAYS = 30;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------------------------------------------------------------------------
// Date helpers. Dates are local calendar days as YYYY-MM-DD strings. Arithmetic
// goes through a local-noon Date so a daylight-saving shift never moves a day,
// and display uses the local getters, since `toLocale*` defaults to UTC inside
// the sandbox.
// ---------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, "0");

const formatLocalDate = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const localNoon = (dateStr: string): Date => new Date(`${dateStr}T12:00:00`);

const addDays = (dateStr: string, delta: number): string => {
  const date = localNoon(dateStr);
  date.setDate(date.getDate() + delta);
  return formatLocalDate(date);
};

const shortLabel = (dateStr: string): string => {
  const date = localNoon(dateStr);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
};

const longLabel = (dateStr: string): string =>
  `${WEEKDAYS[localNoon(dateStr).getDay()]}, ${shortLabel(dateStr)}`;

/** `count` days ending at `last`, newest first. */
const daysBackFrom = (last: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => addDays(last, -i));

/** Every day from `last` back to `first` inclusive, newest first. */
const daysBetween = (first: string, last: string): string[] => {
  const span = Math.round(
    (localNoon(last).getTime() - localNoon(first).getTime()) / 86_400_000,
  );
  return span < 0 ? [] : daysBackFrom(last, span + 1);
};

// ---------------------------------------------------------------------------
// Streak logic. Pure functions of the recorded days, so the derived views and
// the handlers agree, and the tests can reach them.
// ---------------------------------------------------------------------------

const counts = (day: DayRecord | undefined): boolean =>
  !!day && (day.earned || day.protected);

const byDate = (days: readonly DayRecord[]): Map<string, DayRecord> =>
  new Map(days.map((d) => [d.date, d]));

/** Consecutive counting days ending at `end`, walking back. */
export const streakEndingAt = (
  days: readonly DayRecord[],
  end: string,
): number => {
  const index = byDate(days);
  let streak = 0;
  let cursor = end;
  while (counts(index.get(cursor))) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
};

/** The longest run of consecutive counting days anywhere in the record. */
export const longestStreak = (days: readonly DayRecord[]): number => {
  const index = byDate(days);
  return days
    .filter((d) => counts(d) && !counts(index.get(addDays(d.date, -1))))
    .reduce((best, start) => {
      let length = 0;
      let cursor = start.date;
      while (counts(index.get(cursor))) {
        length++;
        cursor = addDays(cursor, 1);
      }
      return Math.max(best, length);
    }, 0);
};

const milestoneMessage = (streak: number): string =>
  MILESTONES.find((m) => m.days === streak)?.message ?? "";

const randomTilt = (): number => Math.round(Math.random() * 30 - 15);

/**
 * The record after earning today's star: unchanged if today is already earned;
 * otherwise today is added, and yesterday is protected when it was missed right
 * after a long enough streak.
 */
export const withStarEarned = (
  days: readonly DayRecord[],
  today: string,
  rotation: number,
): DayRecord[] => {
  const index = byDate(days);
  if (index.get(today)?.earned) return [...days];
  const yesterday = addDays(today, -1);
  const protectYesterday = !index.has(yesterday) &&
    streakEndingAt(days, addDays(today, -2)) >= PROTECT_AFTER_STREAK;
  const rest = days.filter((d) => d.date !== today);
  return [
    ...rest,
    ...(protectYesterday
      ? [{ date: yesterday, earned: false, protected: true, rotation: 0 }]
      : []),
    { date: today, earned: true, protected: false, rotation },
  ];
};

/** The record after a parent toggles `date`: an earned day is cleared, any
 * other day becomes earned. Days that neither earned nor are protected are
 * dropped. */
export const withDayToggled = (
  days: readonly DayRecord[],
  date: string,
  rotation: number,
): DayRecord[] => {
  const existing = byDate(days).get(date);
  const next: DayRecord = existing?.earned
    ? { ...existing, earned: false, protected: false }
    : { date, earned: true, protected: false, rotation };
  return [...days.filter((d) => d.date !== date), next].filter(counts);
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const AMBER_DARK = "#78350f";
const AMBER = "#92400e";
const GOLD = "#fbbf24";

const styles = {
  screen:
    "background: linear-gradient(180deg, #fef3c7 0%, #fef9c3 100%); font-family: system-ui, sans-serif;",
  column: {
    display: "flex",
    flexDirection: "column",
    padding: "20px",
    gap: "16px",
  },
  back: {
    alignSelf: "flex-start",
    background: "none",
    border: "none",
    color: AMBER,
    fontSize: "16px",
    cursor: "pointer",
    padding: "0",
  },
  heading: {
    textAlign: "center",
    fontSize: "20px",
    fontWeight: "bold",
    color: AMBER_DARK,
  },
  panel: {
    background: "rgba(255,255,255,0.8)",
    borderRadius: "12px",
    padding: "16px",
  },
  fieldLabel: {
    fontSize: "13px",
    color: AMBER,
    marginBottom: "8px",
    fontWeight: "500",
  },
  hint: { fontSize: "12px", color: "#9ca3af", marginTop: "8px" },
  done: {
    padding: "16px",
    fontSize: "18px",
    fontWeight: "bold",
    background: `linear-gradient(135deg, ${GOLD} 0%, #f59e0b 100%)`,
    color: AMBER_DARK,
    border: "none",
    borderRadius: "12px",
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(251, 191, 36, 0.4)",
  },
  subtle: { fontSize: "13px", color: AMBER, marginTop: "4px" },
  correctionList: { display: "flex", flexDirection: "column", gap: "8px" },
  correctionRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    background: "rgba(255,255,255,0.8)",
    borderRadius: "12px",
  },
  correctionLabel: { fontSize: "15px", color: AMBER_DARK, fontWeight: "500" },
  toggle: {
    fontSize: "32px",
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: "8px",
  },
  glow: { filter: "drop-shadow(0 0 4px rgba(251, 191, 36, 0.5))" },
  dimStar: { opacity: "0.4", filter: "grayscale(50%)" },
  header: {
    textAlign: "center",
    paddingTop: "10px",
    background: "none",
    border: "none",
    cursor: "pointer",
    width: "100%",
  },
  eyebrow: {
    fontSize: "12px",
    color: AMBER,
    textTransform: "uppercase",
    letterSpacing: "1px",
    marginBottom: "8px",
  },
  goal: {
    fontSize: "24px",
    fontWeight: "bold",
    color: AMBER_DARK,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
  },
  description: {
    fontSize: "14px",
    color: AMBER,
    marginTop: "4px",
    fontStyle: "italic",
  },
  streak: {
    textAlign: "center",
    padding: "12px",
    background: "rgba(251, 191, 36, 0.2)",
    borderRadius: "12px",
    border: `2px solid ${GOLD}`,
  },
  streakCount: { fontSize: "32px", fontWeight: "bold", color: "#d97706" },
  todayCard: {
    background: "rgba(255,255,255,0.8)",
    borderRadius: "16px",
    padding: "20px",
    textAlign: "center",
    border: `3px dashed ${GOLD}`,
    position: "relative",
    overflow: "hidden",
  },
  bigStar: {
    fontSize: "100px",
    lineHeight: "1",
    filter: "drop-shadow(0 0 12px rgba(251, 191, 36, 0.7))",
  },
  milestone: {
    fontSize: "24px",
    fontWeight: "bold",
    color: "#d97706",
    marginTop: "12px",
    animation: "bounce 0.5s ease-out",
  },
  cheer: {
    fontSize: "18px",
    fontWeight: "bold",
    color: "#d97706",
    marginTop: "12px",
  },
  tapStar: {
    fontSize: "80px",
    background: `linear-gradient(135deg, ${GOLD} 0%, #f59e0b 100%)`,
    border: "none",
    borderRadius: "50%",
    width: "150px",
    height: "150px",
    cursor: "pointer",
    boxShadow: "0 8px 24px rgba(251, 191, 36, 0.5)",
    transition: "all 0.2s ease",
  },
  timelineSection: { display: "flex", flexDirection: "column", gap: "8px" },
  timelineScroll: {
    overflowX: "auto",
    overflowY: "hidden",
    paddingBottom: "8px",
  },
  timelineRow: { display: "flex", gap: "12px", padding: "0 4px" },
  timelineDay: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "6px",
    minWidth: "60px",
    padding: "8px 4px",
    background: "rgba(255,255,255,0.5)",
    borderRadius: "12px",
  },
  timelineLabel: {
    fontSize: "11px",
    color: AMBER_DARK,
    fontWeight: "500",
    whiteSpace: "nowrap",
  },
  stickerStar: {
    fontSize: "36px",
    lineHeight: "1",
    filter: "drop-shadow(0 0 6px rgba(251, 191, 36, 0.5))",
  },
  emptyDay: {
    width: "36px",
    height: "36px",
    borderRadius: "50%",
    border: "2px dashed #d4d4d4",
    background: "rgba(255,255,255,0.3)",
  },
  linkButton: {
    background: "none",
    border: "none",
    color: AMBER,
    fontSize: "13px",
    cursor: "pointer",
    textDecoration: "underline",
    opacity: "0.7",
  },
} as const;

const ANIMATIONS = `
@keyframes shimmer {
  0%, 100% { filter: drop-shadow(0 0 8px rgba(251, 191, 36, 0.6)); }
  50% { filter: drop-shadow(0 0 16px rgba(251, 191, 36, 0.9)) brightness(1.1); }
}
@keyframes jiggle {
  0%, 100% { transform: rotate(-3deg); }
  25% { transform: rotate(2deg); }
  50% { transform: rotate(-2deg); }
  75% { transform: rotate(3deg); }
}
@keyframes starPop {
  0% { transform: scale(0) rotate(-180deg); opacity: 0; }
  50% { transform: scale(1.3) rotate(10deg); }
  70% { transform: scale(0.9) rotate(-5deg); }
  100% { transform: scale(1) rotate(0deg); opacity: 1; }
}
@keyframes sparkleOut {
  0% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes bounce {
  0%, 100% { transform: translateY(0); }
  25% { transform: translateY(-10px); }
  75% { transform: translateY(-5px); }
}
@keyframes confettiFloat {
  0% { transform: translate(0, 0) rotate(0deg) scale(1); opacity: 1; }
  100% { transform: translate(var(--tx), var(--ty)) rotate(360deg) scale(0); opacity: 0; }
}
.magical-star { display: inline-block; animation: shimmer 3s ease-in-out infinite; }
.star-pop {
  animation: starPop 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55) forwards,
             shimmer 3s ease-in-out 0.6s infinite,
             jiggle 2s ease-in-out 0.6s infinite;
}
.star-container, .milestone-celebration { position: relative; }
.sparkle-burst {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -50%); pointer-events: none;
}
.sparkle {
  position: absolute; font-size: 24px; color: #fbbf24;
  text-shadow: 0 0 10px #fbbf24;
  animation: sparkleOut 0.8s ease-out forwards;
}
.s1 { transform: translate(-60px, -60px); }
.s2 { transform: translate(60px, -60px); animation-delay: 0.05s; }
.s3 { transform: translate(-80px, 0); animation-delay: 0.1s; }
.s4 { transform: translate(80px, 0); animation-delay: 0.15s; }
.s5 { transform: translate(-60px, 60px); animation-delay: 0.2s; }
.s6 { transform: translate(60px, 60px); animation-delay: 0.25s; }
.s7 { transform: translate(0, -80px); animation-delay: 0.1s; }
.s8 { transform: translate(0, 80px); animation-delay: 0.15s; }
.tap-star:hover { transform: scale(1.05); box-shadow: 0 12px 32px rgba(251, 191, 36, 0.6); }
.tap-star:active, .toggle-star-btn:active { transform: scale(0.95); }
.tap-star:disabled { opacity: 0.5; cursor: default; }
.confetti-burst {
  position: absolute; top: 0; left: 50%;
  transform: translateX(-50%); pointer-events: none;
}
.confetti { position: absolute; font-size: 20px; animation: confettiFloat 1.5s ease-out forwards; }
.c1 { --tx: -40px; --ty: -60px; }
.c2 { --tx: 40px; --ty: -50px; animation-delay: 0.1s; }
.c3 { --tx: -30px; --ty: -70px; animation-delay: 0.2s; }
.c4 { --tx: 50px; --ty: -40px; animation-delay: 0.3s; }
`;

// ---------------------------------------------------------------------------
// Pattern
// ---------------------------------------------------------------------------

interface DayView {
  date: string;
  label: string;
  hasStar: boolean;
  isProtected: boolean;
  tilt: string;
}

type ViewMode = "main" | "corrections" | "settings";

interface StarChartInput {
  goalName?: PerSpace<Writable<string | Default<"Gold Star Goal">>>;
  goalDescription?: PerSpace<Writable<string | Default<"">>>;
  days?: PerSpace<Writable<DayRecord[] | Default<[]>>>;
  /** Pins "today" (YYYY-MM-DD). Empty uses the viewer's local date. */
  todayOverride?: PerSpace<Writable<string | Default<"">>>;
}

export interface StarChartOutput {
  [NAME]: string;
  [UI]: VNode;
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };
  goalName: string;
  goalDescription: string;
  days: DayRecord[];
  /** Today's date, YYYY-MM-DD, or "" until the clock resolves. */
  today: string;
  currentStreak: number;
  bestStreak: number;
  todayHasStar: boolean;
  /** The celebration for the current streak, or "" when it hits no milestone. */
  milestone: string;
  /** Earn today's star. */
  earnStar: Stream<void>;
  /** Parent correction: toggle the star on a day. */
  toggleDay: Stream<{ date: string }>;
}

const toggleDayHandler = handler<
  { date: string },
  { days: Writable<DayRecord[]> }
>(({ date }, { days }) => {
  if (!date) return;
  days.set(withDayToggled(days.get(), date, randomTilt()));
});

const StarChart = pattern<StarChartInput, StarChartOutput>(
  ({ goalName, goalDescription, days, todayOverride }) => {
    // Re-read every five minutes; only the date part is used.
    const nowCell = wish<number>({ query: "#now/300" });
    const today = computed(() => {
      const override = todayOverride.get();
      if (override) return override;
      return nowCell.result == null
        ? ""
        : formatLocalDate(new Date(nowCell.result));
    });

    const viewMode = new Writable.perSession<ViewMode>("main");

    const todayHasStar = computed(() =>
      days.get().some((d) => d.date === today && d.earned)
    );
    const currentStreak = computed(() =>
      today === "" ? 0 : streakEndingAt(days.get(), today)
    );
    const bestStreak = computed(() => longestStreak(days.get()));
    const milestone = computed(() => milestoneMessage(currentStreak));
    const streakLabel = computed(() =>
      `🔥 ${currentStreak} day${currentStreak === 1 ? "" : "s"}!`
    );

    const timeline = computed((): DayView[] => {
      const all = days.get();
      const first = all.filter(counts).map((d) => d.date).sort()[0];
      if (today === "" || !first) return [];
      const index = byDate(all);
      return daysBetween(first, today).map((date) => {
        const day = index.get(date);
        return {
          date,
          label: shortLabel(date),
          hasStar: !!day?.earned,
          isProtected: !!day?.protected,
          tilt: `rotate(${day?.rotation ?? 0}deg)`,
        };
      });
    });

    const correctionsList = computed((): DayView[] => {
      if (today === "") return [];
      const index = byDate(days.get());
      return daysBackFrom(today, CORRECTION_DAYS).map((date) => {
        const day = index.get(date);
        return {
          date,
          label: longLabel(date),
          hasStar: !!day?.earned,
          isProtected: !!day?.protected,
          tilt: "",
        };
      });
    });

    const earnStar = action(() => {
      const day = today;
      if (day === "") return;
      days.set(withStarEarned(days.get(), day, randomTilt()));
    });
    const toggleDay = toggleDayHandler({ days });

    const showMain = action(() => viewMode.set("main"));
    const showCorrections = action(() => viewMode.set("corrections"));
    const showSettings = action(() => viewMode.set("settings"));

    const isSettings = computed(() => viewMode.get() === "settings");
    const isCorrections = computed(() => viewMode.get() === "corrections");

    const fsContent = computed(() => {
      const lines = timeline.map((d) =>
        `- ${d.date}: ${
          d.hasStar ? "⭐ earned" : d.isProtected ? "protected" : "missed"
        }`
      );
      return [
        `# ${goalName.get()}`,
        goalDescription.get(),
        "",
        `Current streak: ${currentStreak} · Best: ${bestStreak}`,
        "",
        ...lines,
      ].join("\n");
    });

    const settingsView = (
      <div style={styles.column}>
        <button type="button" onClick={showMain} style={styles.back}>
          ← Back
        </button>
        <div style={styles.heading}>Edit Goal</div>
        <div style={styles.panel}>
          <div style={styles.fieldLabel}>Goal Name</div>
          <cf-input
            $value={goalName}
            placeholder="e.g., Dry Night, Big Kid Day"
          />
        </div>
        <div style={styles.panel}>
          <div style={styles.fieldLabel}>Description (optional)</div>
          <cf-input
            $value={goalDescription}
            placeholder="e.g., Stay dry all night long!"
          />
          <div style={styles.hint}>
            A short description to remind what this goal means
          </div>
        </div>
        <button type="button" onClick={showMain} style={styles.done}>
          Done
        </button>
      </div>
    );

    const correctionsView = (
      <div style={styles.column}>
        <button type="button" onClick={showMain} style={styles.back}>
          ← Back
        </button>
        <div style={{ textAlign: "center" }}>
          <div style={styles.heading}>Edit Past Days</div>
          <div style={styles.subtle}>Tap to add or remove stars</div>
        </div>
        <div style={styles.correctionList}>
          {correctionsList.map((day) => (
            <div
              style={{
                ...styles.correctionRow,
                border: day.hasStar
                  ? "2px solid #fbbf24"
                  : "2px solid transparent",
              }}
            >
              <div style={styles.correctionLabel}>{day.label}</div>
              <button
                type="button"
                aria-label={`Toggle star for ${day.label}`}
                onClick={() => toggleDay.send({ date: day.date })}
                className="toggle-star-btn"
                style={styles.toggle}
              >
                {day.hasStar
                  ? <span style={styles.glow}>⭐</span>
                  : day.isProtected
                  ? <span style={styles.dimStar}>⭐</span>
                  : <span style={{ opacity: "0.3" }}>○</span>}
              </button>
            </div>
          ))}
        </div>
      </div>
    );

    const mainView = (
      <div style={styles.column}>
        <button type="button" onClick={showSettings} style={styles.header}>
          <div style={styles.eyebrow}>Star Chart</div>
          <div style={styles.goal}>
            {goalName}
            <span style={{ fontSize: "14px", opacity: "0.5" }}>✏️</span>
          </div>
          {goalDescription
            ? <div style={styles.description}>{goalDescription}</div>
            : null}
        </button>

        {currentStreak > 0
          ? (
            <div style={styles.streak}>
              <div style={styles.streakCount}>{streakLabel}</div>
              <div style={styles.subtle}>Best: {bestStreak} days</div>
            </div>
          )
          : null}

        <div style={styles.todayCard}>
          <div style={styles.eyebrow}>Today · {today}</div>
          {todayHasStar
            ? (
              <div className="star-container">
                <div className="sparkle-burst">
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <div className={`sparkle s${n}`}>✦</div>
                  ))}
                </div>
                <div className="magical-star star-pop" style={styles.bigStar}>
                  ⭐
                </div>
                {milestone
                  ? (
                    <div className="milestone-celebration">
                      <div style={styles.milestone}>{milestone}</div>
                      <div className="confetti-burst">
                        <div className="confetti c1">🎊</div>
                        <div className="confetti c2">✨</div>
                        <div className="confetti c3">🎊</div>
                        <div className="confetti c4">✨</div>
                      </div>
                    </div>
                  )
                  : <div style={styles.cheer}>Great job today!</div>}
              </div>
            )
            : (
              <div>
                <button
                  type="button"
                  aria-label="Earn today's star"
                  onClick={earnStar}
                  disabled={today === ""}
                  className="tap-star"
                  style={styles.tapStar}
                >
                  ⭐
                </button>
                <div style={styles.subtle}>Tap to earn your star!</div>
              </div>
            )}
        </div>

        <div style={styles.timelineSection}>
          <div style={styles.eyebrow}>Recent Days</div>
          <div style={styles.timelineScroll}>
            <div style={styles.timelineRow}>
              {timeline.map((day) => (
                <div style={styles.timelineDay}>
                  <div style={styles.timelineLabel}>{day.label}</div>
                  {day.hasStar
                    ? (
                      <div
                        className="magical-star"
                        style={{ ...styles.stickerStar, transform: day.tilt }}
                      >
                        ⭐
                      </div>
                    )
                    : day.isProtected
                    ? (
                      <div
                        title="Protected day (streak saved!)"
                        style={{ ...styles.stickerStar, ...styles.dimStar }}
                      >
                        ⭐
                      </div>
                    )
                    : <div style={styles.emptyDay} />}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ textAlign: "center", paddingTop: "8px" }}>
          <button
            type="button"
            onClick={showCorrections}
            style={styles.linkButton}
          >
            Edit past days...
          </button>
        </div>
      </div>
    );

    return {
      [NAME]: computed(() => `⭐ ${goalName.get()}`),
      [UI]: (
        <cf-screen style={styles.screen}>
          {isSettings
            ? settingsView
            : isCorrections
            ? correctionsView
            : mainView}
          <style>{ANIMATIONS}</style>
        </cf-screen>
      ),
      [FS]: {
        type: "text/markdown",
        frontmatter: { title: goalName },
        content: fsContent,
      },
      goalName,
      goalDescription,
      days,
      today,
      currentStreak,
      bestStreak,
      todayHasStar,
      milestone,
      earnStar,
      toggleDay,
    };
  },
);

export default StarChart;
