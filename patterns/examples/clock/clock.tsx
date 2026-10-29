import { computed, NAME, pattern, UI, type VNode, wish } from "commonfabric";

// A live wall clock, driven by the reactive `#now` wish.
//
// A pattern cannot read the wall clock in reactive code: `Date.now()` /
// `new Date()` throw inside a lift, computed, or the pattern body (the
// time/entropy capability gate — a live clock read there would break reactive
// idempotency). The ticking time therefore comes from `wish({ query: "#now/1" })`,
// a coarse, one-second, grid-aligned clock the reactive graph can depend on. It
// reads `null` until the wish first resolves, so every derived label guards for
// that window. `new Date(ms)` with an explicit argument is deterministic and is
// not gated, so it is fine for formatting a known timestamp.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${
    pad2(d.getSeconds())
  }`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${
    MONTHS[d.getMonth()]
  } ${d.getFullYear()}`;
}

export interface ClockOutput {
  [NAME]: string;
  [UI]: VNode;

  /** "HH:MM:SS" once #now resolves, "--:--:--" during the load window. */
  time: string;

  /** "Wed 9 Jul 2026" once #now resolves, "" during the load window. */
  date: string;
}

export const Clock = pattern<void, ClockOutput>(() => {
  const now = wish<number>({ query: "#now/1" });

  const time = computed(() =>
    now.result == null ? "--:--:--" : formatTime(now.result)
  );
  const date = computed(() => now.result == null ? "" : formatDate(now.result));

  return {
    [NAME]: computed(() => `Clock — ${time}`),
    [UI]: (
      <div style={{ fontFamily: "system-ui", textAlign: "center" }}>
        <div style={{ fontSize: "2.5rem", fontVariantNumeric: "tabular-nums" }}>
          {time}
        </div>
        <div style={{ opacity: "0.7" }}>{date}</div>
      </div>
    ),
    time,
    date,
  };
});

export default Clock;
