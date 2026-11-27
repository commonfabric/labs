// Shared fake-clock harness for package test suites. A package installs it from
// the `--preload` module its test task loads, `test/clock-preload.ts`, which
// calls `installFakeClock` with a mode. The harness then runs each suite under a
// controllable clock, through `wrapSuites` in `./testing.ts`, and exposes
// drain/advance controls. A test file that needs the real clock says so at the
// top of the file with `useRealClock()`, beside the reason it needs it.
//
// Two modes exist, chosen by the caller:
//
//   - "auto-advance": positive-delay timers are sorted by who scheduled them.
//     A timer armed from `src/` (production code — the runtime's own scheduler,
//     storage, and wake shaper arm throttle windows, backoff, and conflict
//     retries) AUTO-ADVANCES: once the event loop is idle — every zero-delay
//     turn that was armed has run — logical time jumps to the earliest pending
//     one and fires it, in order, with `Date.now` and `performance.now` moving
//     in lockstep. So a window elapses instantly and deterministically, and the
//     reactive waits that await it resolve on their own — no real sleeping,
//     and never ahead of a turn that was already queued. A timer armed from a
//     `test/` file (a wall-clock sleep) FREEZES: it never fires, so a test
//     that waits on one deadlocks, which Deno's async-op sanitizer reports at
//     once.
//
//   - "freeze-all": every positive-delay timer FREEZES regardless of caller,
//     and only `setTimeout`/`clearTimeout` are replaced (`setInterval`,
//     `Date.now`, and `performance.now` stay real). A zero-delay timer still
//     fires, so scheduler dispatch and teardown resolve on their own, while a
//     wall-clock sleep deadlocks and announces itself.
//
// In both modes a test reaches the running suite's controls through `clock`,
// with `settle()`, `tick(ms)`, and `reset()`.
//
// Both modes also replace `setImmediate`/`clearImmediate`, registering an
// immediate as a zero-delay timer, so a turn taken through `setImmediate` lands
// in the same batch and the same census as one taken through
// `setTimeout(fn, 0)`.
//
// In both modes a zero-delay `setTimeout(fn, 0)` fires on a real macrotask, so
// reactive dispatch that runs on `setTimeout(fn, 0)` drains through the real
// event loop with no test-side driving. `settle()` resolves once every
// zero-delay timer and microtask has run to a fixpoint: it is an ordering
// guarantee rather than a deadline, so it cannot lose a race under load, and it
// holds for a test asserting an op is absent as much as one asserting it is
// present. `tick(ms)` advances logical time by `ms`, firing timers in lockstep;
// the auto-advance pump is paused while it runs, so a test can observe a state
// partway through a window.

import { wrapSuites } from "./testing.ts";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
// Not on `globalThis` in the ambient types, and absent altogether in a
// browser, so these read back `undefined` rather than a function there.
const realSetImmediate = (globalThis as { setImmediate?: unknown })
  .setImmediate;
const realClearImmediate = (globalThis as { clearImmediate?: unknown })
  .clearImmediate;
const realDateNow = Date.now;
const realPerformanceNow = performance.now.bind(performance);

// The basename of this module, read from its own URL so the stack-frame caller
// classification keeps working if the file is renamed. Frames inside the
// harness are skipped when deciding who scheduled a timer.
const HARNESS_FILE = import.meta.url.split("/").pop() ?? "fake-clock.ts";

// What `Date.now` and `performance.now` read at logical time zero. Neither is
// zero, because a real clock never reads zero by the time a test runs.
const DATE_ORIGIN = 1_700_000_000_000;
const PERFORMANCE_ORIGIN = 1_000;

type Kind = "zero" | "prod" | "test";
interface Timer {
  id: number;
  cb: (...args: unknown[]) => void;
  fireAt: number;
  args: unknown[];
  kind: Kind;
  interval?: number;
  // Where a production timer was armed, so a runaway can name it. Undefined
  // when the stack carried no frame outside this file.
  site: string | undefined;
}

// How many production timers one test may auto-advance through before the pump
// calls it a livelock. A backoff the real clock would pace re-arms as fast as
// the event loop turns here, so a retry that cannot succeed never stops. The
// ceiling has to sit below the point where that loop exhausts the heap,
// otherwise V8 aborts the process first and no test is named. Across the runner
// suite — the heaviest user of auto-advance — one test reaches 160 fires and
// every other one stays under a hundred.
const AUTO_ADVANCE_LIMIT = 2_000;

// How many consecutive turns of zero-delay work `settle()` drains, and the
// auto-advance pump yields to, before calling the work that keeps re-arming a
// livelock, unless the preload names another limit. Each is one turn of the
// real event loop; a healthy test's turn chains end within a few dozen.
const DEFAULT_TURN_LIMIT = 100_000;

/** Which behavior a package's preload selects. */
export type FakeClockMode = "auto-advance" | "freeze-all";

/** Options a package's `clock-preload.ts` passes to {@link installFakeClock}. */
export interface FakeClockOptions {
  mode: FakeClockMode;
  /**
   * How many consecutive turns of zero-delay work the clock runs before it
   * reports the work as a livelock that never settles. Defaults to 100 000.
   */
  turnLimit?: number;
}

interface ModeConfig {
  autoAdvance: boolean;
  fakeInterval: boolean;
  fakeTimeSource: boolean;
  settleAfterBody: boolean;
}

interface ResolvedConfig extends ModeConfig {
  turnLimit: number;
}

const PRESETS: Record<FakeClockMode, ModeConfig> = {
  "auto-advance": {
    autoAdvance: true,
    fakeInterval: true,
    fakeTimeSource: true,
    settleAfterBody: true,
  },
  "freeze-all": {
    autoAdvance: false,
    fakeInterval: false,
    fakeTimeSource: false,
    settleAfterBody: false,
  },
};

// The current call stack, as newline-separated frames with the innermost first.
//
// A plain `new Error().stack` is enough until SES enters the picture. The runner
// package locks SES down the first time a test builds a `Runtime`, with
// `errorTaming` set to "safe" — a permanent, process-global change. Safe taming
// still captures each error's frames, but hides them behind the tamed `stack`
// accessor, which from then on reads back as the empty string. Every timer a
// test schedules after that first lockdown would otherwise arrive here with no
// stack to classify, so `callerIsTest` would read every one as `src/` and let a
// stray test sleep auto-advance instead of freezing.
//
// SES hands the real frames back through `getStackString`, the sanctioned hook
// it installs on the global during lockdown; the runtime's own error mapping
// reads stacks through the same hook. We use it whenever lockdown has installed
// it, and fall back to the native `stack` before lockdown, and in a package that
// loads this harness without ever loading SES. Reading the frames this way keeps
// the caller classification working without relaxing the production error
// taming.
function currentStack(): string {
  const error = new Error();
  const getStackString = (globalThis as {
    getStackString?: (error: Error) => string;
  }).getStackString;
  if (typeof getStackString === "function") {
    return getStackString(error) ?? "";
  }
  return error.stack ?? "";
}

// The immediate caller of setTimeout: the first stack frame outside this file.
function callerFrame(): string | undefined {
  const stack = currentStack();
  for (const line of stack.split("\n").slice(1)) {
    if (line.includes(HARNESS_FILE)) continue;
    // Stack lines arrive as `    at <site>`; the caller is the site itself.
    return line.trim().replace(/^at /, "");
  }
  return undefined;
}

// A frame in a `test/` directory (or a `.test.ts` file) is test code.
function frameIsTest(frame: string | undefined): boolean {
  return frame !== undefined &&
    (/\/test\//.test(frame) || /\.test\.ts/.test(frame));
}

async function freezeAround(
  config: ResolvedConfig,
  run: () => Promise<void>,
): Promise<void> {
  let elapsed = 0;
  let seq = 1;
  let ticking = false;
  let kickScheduled = false;
  let autoScheduled = false;
  const timers = new Map<number, Timer>();

  const drainMicrotasks = () =>
    new Promise<void>((resolve) => realSetTimeout(resolve, 0));

  // Fire pending zero-delay timers (scheduler dispatch) on a real macrotask.
  // The batch is snapshotted, so one callback can clear another that is
  // still to come in it; a real clock would not then fire the cleared one,
  // so the membership re-check keeps that promise.
  const kick = () => {
    kickScheduled = false;
    for (const tm of [...timers.values()]) {
      if (tm.kind !== "zero" || tm.fireAt > elapsed) continue;
      if (!timers.has(tm.id)) continue;
      timers.delete(tm.id);
      tm.cb(...tm.args);
    }
  };
  // The pump follows every kick, so it watches a turn chain for as long as the
  // chain runs, whether or not a production timer waits behind it.
  const scheduleKick = () => {
    if (kickScheduled) return;
    kickScheduled = true;
    realSetTimeout(kick, 0);
    scheduleAuto();
  };

  const hasPendingZero = () =>
    kickScheduled ||
    [...timers.values()].some((tm) =>
      tm.kind === "zero" && tm.fireAt <= elapsed
    );

  const settle = async () => {
    // Pause auto-advance while draining, so `settle()` observes reactive work
    // without letting a production timer (a throttle/debounce window) fire —
    // that is what lets a test check a state partway through a window.
    const wasTicking = ticking;
    ticking = true;
    try {
      for (let guard = 0; guard < config.turnLimit; guard++) {
        await drainMicrotasks();
        if (!hasPendingZero()) return;
        kick();
      }
      throw new Error(
        "settle() did not converge: zero-delay work regenerated",
      );
    } finally {
      ticking = wasTicking;
      if (!ticking) scheduleAuto();
    }
  };

  // The earliest positive-delay timer due by `limit`. One armed for the
  // instant the clock already stands at — the second of two armed together,
  // once the first has fired — is due, not past, so both fire. `onlyProd`
  // restricts to the runtime's own timers (used by the
  // auto-advance pump, so a test's frozen sleep is never fired on its own);
  // `tick` passes false, advancing test timers too, so a test can model a
  // slow async step with `setTimeout` and step through it explicitly.
  const nextTimer = (limit: number, onlyProd: boolean): Timer | undefined => {
    let next: Timer | undefined;
    for (const tm of timers.values()) {
      if (tm.kind === "zero" || tm.fireAt > limit) continue;
      if (onlyProd && tm.kind !== "prod") continue;
      if (!next || tm.fireAt < next.fireAt) next = tm;
    }
    return next;
  };
  const nextProd = (limit: number) => nextTimer(limit, true);
  let autoCount = 0;
  // Fires per arming site, so a runaway names the timer that dominated it
  // rather than whichever one happened to be last.
  const autoBySite = new Map<string, number>();
  const busiestSite = (): string => {
    let worst = "an unrecorded site";
    let most = 0;
    for (const [site, count] of autoBySite) {
      if (count > most) {
        most = count;
        worst = `${site} (${count} of them)`;
      }
    }
    return worst;
  };
  // Auto-advance: fire the earliest production timer due, jumping the clock
  // to it, so the runtime's reactive waits resolve without real time passing.
  // Only once the loop is idle. A zero-delay turn still armed — or a kick
  // already queued to run one — is work the real clock runs before any
  // positive-delay timer, and a frame crosses the loopback transport and the
  // memory server's refresh a turn at a time; so the pump yields to it,
  // re-queuing itself behind the pending kick, and jumps only when no turn
  // is left. That keeps a production backstop — the storage layer's 30 s
  // conflict read-repair wait, for one — from firing between the turns that
  // deliver the frame it waits for. With no turn left and no production
  // timer pending there is nothing to jump to, so the pump stops until the
  // next kick or production timer queues it. A turn chain that never ends
  // starves the pump rather than hanging the test, in either mode: past the
  // turn limit it throws, naming the condition, as `settle()` does for
  // zero-delay work that regenerates.
  let yields = 0;
  const autoAdvance = () => {
    autoScheduled = false;
    if (ticking) return;
    if (hasPendingZero()) {
      if (++yields > config.turnLimit) {
        throw new Error(
          `fake clock starved: zero-delay work re-armed itself ` +
            `${config.turnLimit} turns in a row, so the event loop never ` +
            "went idle. A turn that always arms another cannot settle; the " +
            "loop it feeds needs a condition that changes.",
        );
      }
      scheduleAuto();
      return;
    }
    yields = 0;
    const next = nextProd(Infinity);
    if (!next) return;
    const site = next.site ?? "an unrecorded site";
    autoBySite.set(site, (autoBySite.get(site) ?? 0) + 1);
    if (++autoCount > AUTO_ADVANCE_LIMIT) {
      throw new Error(
        `clock auto-advance runaway: ${AUTO_ADVANCE_LIMIT} production ` +
          `timers fired in this test, most of them armed at ${busiestSite()}. ` +
          "A backoff the real clock would pace re-arms as fast as the event " +
          "loop turns here, so a retry that cannot succeed never stops. Give " +
          "the test explicit clock.tick(ms) control, or keep its file on " +
          "the real clock with useRealClock().",
      );
    }
    elapsed = Math.max(elapsed, next.fireAt);
    if (next.interval === undefined) timers.delete(next.id);
    else next.fireAt = elapsed + next.interval;
    next.cb(...next.args);
    if (nextProd(Infinity)) scheduleAuto();
  };
  const scheduleAuto = () => {
    if (autoScheduled || ticking) return;
    autoScheduled = true;
    realSetTimeout(autoAdvance, 0);
  };

  const controls: Clock = {
    settle,
    async tick(ms: number) {
      if (ms < 0) throw new Error("tick(ms) requires ms >= 0");
      ticking = true;
      try {
        const target = elapsed + ms;
        for (let guard = 0; guard < 1_000_000; guard++) {
          await settle();
          const next = nextTimer(target, false);
          if (!next) break;
          elapsed = Math.max(elapsed, next.fireAt);
          if (next.interval === undefined) timers.delete(next.id);
          else next.fireAt = elapsed + next.interval;
          next.cb(...next.args);
        }
        elapsed = target;
        await settle();
      } finally {
        ticking = false;
        scheduleAuto();
      }
    },
    // Return logical time to zero and drop every pending timer. One
    // `freezeAround` wraps a whole `describe`, so a suite whose cases each
    // start from a known instant — reading absolute, coarsened wall-clock
    // values — calls this from `beforeEach` to keep a clock an earlier case
    // built from leaking into the next.
    reset() {
      elapsed = 0;
      seq = 1;
      autoCount = 0;
      autoBySite.clear();
      yields = 0;
      ticking = false;
      kickScheduled = false;
      autoScheduled = false;
      timers.clear();
    },
  };

  const fakeSetTimeout = (
    cb: (...args: unknown[]) => void,
    delay = 0,
    ...args: unknown[]
  ): number => {
    const id = seq++;
    const ms = Number(delay) || 0;
    if (ms <= 0) {
      timers.set(id, {
        id,
        cb,
        fireAt: elapsed,
        args,
        kind: "zero",
        site: undefined,
      });
      scheduleKick();
      return id;
    }
    const site = callerFrame();
    if (!config.autoAdvance || frameIsTest(site)) {
      timers.set(id, {
        id,
        cb,
        fireAt: elapsed + ms,
        args,
        kind: "test",
        site,
      });
    } else {
      timers.set(id, {
        id,
        cb,
        fireAt: elapsed + ms,
        args,
        kind: "prod",
        site,
      });
      scheduleAuto();
    }
    return id;
  };
  const fakeSetInterval = (
    cb: (...args: unknown[]) => void,
    delay = 0,
    ...args: unknown[]
  ): number => {
    const id = seq++;
    const ms = Math.max(1, Number(delay) || 0);
    const site = callerFrame();
    const kind: Kind = (!config.autoAdvance || frameIsTest(site))
      ? "test"
      : "prod";
    timers.set(id, {
      id,
      cb,
      fireAt: elapsed + ms,
      args,
      kind,
      interval: ms,
      site,
    });
    if (kind === "prod") scheduleAuto();
    return id;
  };
  // `setImmediate` asks for the next turn of the event loop, which is what a
  // zero-delay `setTimeout` asks for, so it is registered as one: same
  // `kick()` batch, same census `settle()` reads. Code that takes its turn
  // through `setImmediate` — the memory transport's frame pump and the
  // memory server's subscription refresh do, because waking Deno's loop for
  // a timer costs milliseconds — then runs exactly where a zero-delay timer
  // would have, under the harness's control rather than beside it.
  const fakeSetImmediate = (
    cb: (...args: unknown[]) => void,
    ...args: unknown[]
  ): number => fakeSetTimeout(cb, 0, ...args);
  const fakeClear = (id: number): void => {
    timers.delete(id);
  };

  Reflect.set(globalThis, "setTimeout", fakeSetTimeout);
  Reflect.set(globalThis, "clearTimeout", fakeClear);
  Reflect.set(globalThis, "setImmediate", fakeSetImmediate);
  Reflect.set(globalThis, "clearImmediate", fakeClear);
  if (config.fakeInterval) {
    Reflect.set(globalThis, "setInterval", fakeSetInterval);
    Reflect.set(globalThis, "clearInterval", fakeClear);
  }
  if (config.fakeTimeSource) {
    Reflect.set(Date, "now", () => DATE_ORIGIN + elapsed);
    Reflect.set(performance, "now", () => PERFORMANCE_ORIGIN + elapsed);
  }
  active = controls;

  try {
    await run();
    if (config.settleAfterBody) await settle();
  } finally {
    // A kick or autoAdvance macrotask may still sit queued on the real event
    // loop when the body returns (settle's own finally re-arms auto-advance).
    // Emptying the timer map makes those callbacks no-ops, so this test's
    // timers cannot fire — and reschedule onto the real clock — once real
    // time is restored.
    timers.clear();
    Reflect.set(globalThis, "setTimeout", realSetTimeout);
    Reflect.set(globalThis, "clearTimeout", realClearTimeout);
    Reflect.set(globalThis, "setImmediate", realSetImmediate);
    Reflect.set(globalThis, "clearImmediate", realClearImmediate);
    if (config.fakeInterval) {
      Reflect.set(globalThis, "setInterval", realSetInterval);
      Reflect.set(globalThis, "clearInterval", realClearInterval);
    }
    if (config.fakeTimeSource) {
      Reflect.set(Date, "now", realDateNow);
      Reflect.set(performance, "now", realPerformanceNow);
    }
    active = undefined;
  }
}

/** The controls a suite running under the fake clock has. */
export interface Clock {
  /** Drains zero-delay work to a fixpoint without moving the clock. */
  settle(): Promise<void>;

  /**
   * Advances logical time by `ms`, firing positive-delay timers in lockstep
   * with `Date.now` and `performance.now` where the mode fakes those.
   */
  tick(ms: number): Promise<void>;

  /**
   * Returns logical time to zero and drops every pending timer. A suite whose
   * cases each start from a known instant calls it from `beforeEach`.
   */
  reset(): void;
}

/** The controls of the suite running now, while one runs. */
let active: Clock | undefined;

/** The running suite's controls, refusing where no suite runs under the clock. */
function running(): Clock {
  if (active === undefined) {
    throw new Error(
      "clock is only available inside a test running under the fake clock",
    );
  }
  return active;
}

/**
 * The controls of the suite running now, or undefined where none runs under
 * the fake clock, such as in a file that called `useRealClock()`.
 */
export function runningClock(): Clock | undefined {
  return active;
}

/** The controls of whichever suite is running under the fake clock. */
export const clock: Clock = {
  settle: () => running().settle(),
  tick: (ms) => running().tick(ms),
  reset: () => running().reset(),
};

/** Whether this test file asked for the real clock. */
let realClock = false;

/**
 * Keeps every suite of the test file calling it on the real clock. Call it at
 * the top of the file, beside a comment saying why the file needs it. It does
 * nothing where no fake clock is installed.
 */
export function useRealClock(): void {
  realClock = true;
}

/**
 * Runs every suite in the preloading package under the fake clock selected by
 * `options.mode`, apart from those of a file that called `useRealClock()`.
 * Call this once, from a package's `test/clock-preload.ts`, which its test
 * task loads through `--preload`.
 */
export function installFakeClock(options: FakeClockOptions): void {
  const config = {
    ...PRESETS[options.mode],
    turnLimit: options.turnLimit ?? DEFAULT_TURN_LIMIT,
  };
  wrapSuites((run) => realClock ? run() : freezeAround(config, run));
}
