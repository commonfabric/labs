import {
  computed,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

// A worked example of the two pattern-facing surfaces of the timing
// side-channel mitigations.
//
// 1. Reading time — the reactive `#now` clock. You cannot read the wall clock in
//    reactive code: `Date.now()` / `new Date()` throw in a lift, a computed, or
//    the pattern body (a live clock read would make the computation
//    non-idempotent). The replacement is the `#now` wish:
//      wish({ query: "#now" })     one durable snapshot — the piece's
//                                  FIRST-EVER load; reloads and other
//                                  runtimes read the original capture
//      wish({ query: "#now/N" })   a fresh snapshot every N seconds
//    Both are coarse (one second) and grid-aligned, and read `null` until the
//    wish resolves — so guard for that load window. `new Date(ms)` with an
//    explicit argument is deterministic and is NOT gated.
//    For a one-off timestamp of the TRIGGERING EVENT, `Date.now()` / `new Date()`
//    are allowed directly inside a handler/action — no wish needed. That is the
//    event's own instant, frozen for the whole handler cascade and coarsened to
//    one second; it is NOT a live wall-clock read (shaped/delayed delivery can
//    make it lag real time). Use it to stamp the event; use `#now/N` when the
//    value must keep refreshing reactively.
//
// 2. Receiving input — delivery shaping (W3 events, plan-B cell flips). Input
//    reaches a pattern two ways, and both are shaped by the same token bucket: the
//    "Tap" button sends an event to a handler, and each keystroke in the text box
//    writes a bound `$value` cell that a derived value observes. A pattern's only
//    sub-second timing signal is the rate of input it observes, so the shaper
//    floors the SUSTAINED rate to about one delivery per second while leaving
//    ordinary interaction realtime: a burst of rapid taps or keystrokes (up to a
//    budget of ~10) is delivered immediately, and only sustained mashing/typing is
//    throttled. Nothing is dropped — every tap is counted, and the latest typed
//    value always arrives. Only real renderer input is shaped; a headless test is
//    delivered immediately.

function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Runs when a (shaped) tap is actually delivered. The clock IS readable in a
// handler — coarsened to one second — so stamp when this delivery ran.
const registerTap = handler<
  Record<string, never>,
  { taps: Writable<number>; lastTapAt: Writable<string> }
>((_event, { taps, lastTapAt }) => {
  taps.set(taps.get() + 1);
  lastTapAt.set(formatClock(Date.now()));
});

// Lets a headless test drive the text box (a real browser drives it via the
// `$value` binding). Renderer keystrokes are shaped; this test send is not.
const setTyped = handler<{ value: string }, { typed: Writable<string> }>(
  (event, { typed }) => {
    typed.set(event.value);
  },
);

export interface ReactiveNowOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The piece's first-load time, "HH:MM:SS" (or "…" before #now resolves). */
  loadedAt: string;

  /** The ticking current time, "HH:MM:SS" (or "…"). */
  now: string;

  /** Whole seconds since load, e.g. "12s ago" (or "…"). */
  sinceLoad: string;

  /** How many times the tap handler has actually been delivered. */
  taps: number;

  /** Coarse time the last tap was delivered ("—" before the first). */
  lastTapAt: string;

  /** The tap event stream (also driven by the button). */
  tap: Stream<Record<string, never>>;

  /** The current text of the bound `$value` box. */
  typed: string;

  /** Length of `typed`, derived — updates as the keystroke write propagates. */
  charCount: number;

  /** `typed` upper-cased, derived — a second observer of the same cell flip. */
  echo: string;

  /** Test-only stream to set the text box (the browser uses the `$value` bind). */
  type: Stream<{ value: string }>;
}

export const ReactiveNow = pattern<void, ReactiveNowOutput>(() => {
  // One-shot: resolves once, then holds durably — "when this piece FIRST
  // loaded", shared by every later reload and runtime (not per-session).
  const loadedAtCell = wish<number>({ query: "#now" });
  // Ticking: a fresh coarse timestamp every second.
  const nowCell = wish<number>({ query: "#now/1" });

  const loadedAt = computed(() =>
    loadedAtCell.result == null ? "…" : formatClock(loadedAtCell.result)
  );
  const now = computed(() =>
    nowCell.result == null ? "…" : formatClock(nowCell.result)
  );
  // Elapsed since load. Both operands are #now-derived, so the subtraction stays
  // reactive and idempotent — no raw clock read anywhere.
  const sinceLoad = computed(() => {
    if (loadedAtCell.result == null || nowCell.result == null) return "…";
    const seconds = Math.max(
      0,
      Math.round((nowCell.result - loadedAtCell.result) / 1000),
    );
    return `${seconds}s ago`;
  });

  const taps = new Writable(0);
  const lastTapAt = new Writable("—");
  const tap = registerTap({ taps, lastTapAt });

  // Keystroke path: the box writes `typed` on every keypress; charCount and echo
  // observe that cell flip, so they show the shaping of the $value write.
  const typed = new Writable("");
  const charCount = computed(() => (typed.get() ?? "").length);
  const echo = computed(() => (typed.get() ?? "").toUpperCase());
  const type = setTyped({ typed });

  return {
    [NAME]: "Reactive #now demo",
    [UI]: (
      <div style={{ fontFamily: "system-ui", lineHeight: "1.6" }}>
        <div>Loaded at: {loadedAt}</div>
        <div>Now: {now}</div>
        <div>Loaded {sinceLoad}</div>

        <div style={{ borderTop: "1px solid #ccc", margin: "0.75rem 0" }} />

        <div style={{ fontWeight: "600" }}>
          Input delivery shaping — tap fast and watch
        </div>
        <cf-button onClick={() => tap.send({})}>Tap</cf-button>
        <div>Handler deliveries: {taps}</div>
        <div>Last tap delivered: {lastTapAt}</div>
        <div style={{ opacity: "0.7", fontSize: "0.85em" }}>
          Normal tapping is realtime; only sustained mashing throttles to about
          one delivery per second. Every tap is still counted.
        </div>

        <div style={{ borderTop: "1px solid #ccc", margin: "0.75rem 0" }} />

        <div style={{ fontWeight: "600" }}>
          Keystroke shaping — type fast and watch
        </div>
        {
          /* timingStrategy="immediate" writes the cell on every keystroke (the
            default debounces 300ms), so the shaper — not the component — is what
            you observe here. */
        }
        <cf-input
          $value={typed}
          timingStrategy="immediate"
          placeholder="Type here…"
        />
        <div>Characters: {charCount}</div>
        <div>Upper-cased: {echo}</div>
        <div style={{ opacity: "0.7", fontSize: "0.85em" }}>
          The character you type always appears at once. The derived values
          above update in realtime as you type normally, and throttle to about
          one update per second only under sustained fast typing — the latest
          value always arrives.
        </div>
      </div>
    ),
    loadedAt,
    now,
    sinceLoad,
    taps,
    lastTapAt,
    tap,
    typed,
    charCount,
    echo,
    type,
  };
});

export default ReactiveNow;
