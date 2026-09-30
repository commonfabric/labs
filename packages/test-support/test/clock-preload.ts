// Shared fake-clock harness for package test suites. A package wires it in
// through Deno's `--preload` on its test task by writing a one-line
// `test/clock-preload.ts` that calls `installFakeClock` with a mode. The
// harness replaces `Deno.test` so each test runs under a controllable clock, and
// exposes drain/advance controls.
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
//     once. The controls are a global `clock` with `settle()`, `tick(ms)`, and
//     `reset()`.
//
//   - "freeze-all": every positive-delay timer FREEZES regardless of caller,
//     and only `setTimeout`/`clearTimeout` are replaced (`setInterval`,
//     `Date.now`, and `performance.now` stay real). A zero-delay timer still
//     fires, so scheduler dispatch and teardown resolve on their own, while a
//     wall-clock sleep deadlocks and announces itself. The control is
//     `t.settle()`, attached to each test's context.
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
// harness (and inside a package's thin `clock-preload.ts` wrapper, which shares
// the basename) are skipped when deciding who scheduled a timer.
const HARNESS_FILE = new URL(import.meta.url).pathname.split("/").pop() ??
  "clock-preload.ts";

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

// How many consecutive turns the auto-advance pump yields to before calling the
// zero-delay work that keeps re-arming a livelock. Each yield is one turn of
// the real event loop, the same cost as one round of `settle()`, whose guard
// this matches; a healthy test's turn chains end within a few dozen.
const AUTO_ADVANCE_STARVATION_LIMIT = 100_000;

/** Which behavior a package's preload selects. */
export type FakeClockMode = "auto-advance" | "freeze-all";

/** Options a package's thin `clock-preload.ts` passes to {@link installFakeClock}. */
export interface FakeClockOptions {
  mode: FakeClockMode;
  // Test-file stems kept entirely on the real clock (no faking). Matched against
  // the registering stack frame as `${stem}.test.ts`. Defaults to none.
  realClockFiles?: readonly string[];
}

interface ResolvedConfig {
  autoAdvance: boolean;
  fakeInterval: boolean;
  fakeTimeSource: boolean;
  exposeGlobalClock: boolean;
  exposeContextSettle: boolean;
  settleAfterBody: boolean;
  realClockFiles: readonly string[];
}

const PRESETS: Record<FakeClockMode, Omit<ResolvedConfig, "realClockFiles">> = {
  "auto-advance": {
    autoAdvance: true,
    fakeInterval: true,
    fakeTimeSource: true,
    exposeGlobalClock: true,
    exposeContextSettle: false,
    settleAfterBody: true,
  },
  "freeze-all": {
    autoAdvance: false,
    fakeInterval: false,
    fakeTimeSource: false,
    exposeGlobalClock: false,
    exposeContextSettle: true,
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

function freezeAround(
  config: ResolvedConfig,
  fn: (t: Deno.TestContext) => void | Promise<void>,
): (t: Deno.TestContext) => Promise<void> {
  return async (t: Deno.TestContext) => {
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
    const scheduleKick = () => {
      if (kickScheduled) return;
      kickScheduled = true;
      realSetTimeout(kick, 0);
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
      if (config.autoAdvance) ticking = true;
      try {
        for (let guard = 0; guard < 100_000; guard++) {
          await drainMicrotasks();
          if (!hasPendingZero()) return;
          kick();
        }
        throw new Error(
          "settle() did not converge: zero-delay work regenerated",
        );
      } finally {
        if (config.autoAdvance) {
          ticking = wasTicking;
          if (!ticking) scheduleAuto();
        }
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
    // deliver the frame it waits for. A turn chain that never ends starves the
    // pump rather than hanging the test: past the starvation limit it throws,
    // naming the condition, as `settle()` does for zero-delay work that
    // regenerates.
    let yields = 0;
    const autoAdvance = () => {
      autoScheduled = false;
      if (ticking) return;
      if (hasPendingZero()) {
        if (++yields > AUTO_ADVANCE_STARVATION_LIMIT) {
          throw new Error(
            `clock auto-advance starved: zero-delay work re-armed itself ` +
              `${AUTO_ADVANCE_STARVATION_LIMIT} turns in a row, so logical ` +
              "time never moved. A turn that always arms another cannot " +
              "settle; the loop it feeds needs a condition that changes.",
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
            "the test explicit clock.tick(ms) control, or list its file in the " +
            "preload's realClockFiles.",
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

    const settleObj = {
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
    if (config.exposeGlobalClock) {
      Reflect.set(globalThis, "clock", settleObj);
    }
    if (config.exposeContextSettle) {
      Reflect.set(t, "settle", settle);
    }

    try {
      await fn(t);
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
      if (config.exposeGlobalClock) {
        Reflect.set(globalThis, "clock", undefined);
      }
    }
  };
}

// Match the whole test-file name, not a bare substring: a name like `wish` must
// not also claim `wish-now-interval.test.ts`.
function registeredFromRealClockFile(
  realClockFiles: readonly string[],
): boolean {
  if (realClockFiles.length === 0) return false;
  const stack = currentStack();
  return realClockFiles.some((name) => stack.includes(`${name}.test.ts`));
}

/**
 * Replace `Deno.test` so every test in the preloading package runs under the
 * fake clock selected by `options.mode`. Call this once, from a package's
 * `test/clock-preload.ts`, which its test task loads through `--preload`.
 */
export function installFakeClock(options: FakeClockOptions): void {
  const config: ResolvedConfig = {
    ...PRESETS[options.mode],
    realClockFiles: options.realClockFiles ?? [],
  };

  const realTest = Deno.test;

  function frozenTest(
    nameOrDef: string | Deno.TestDefinition,
    fn?: (t: Deno.TestContext) => void | Promise<void>,
  ): void {
    if (registeredFromRealClockFile(config.realClockFiles)) {
      if (typeof nameOrDef === "string") realTest(nameOrDef, fn!);
      else realTest(nameOrDef);
      return;
    }
    if (typeof nameOrDef === "string") {
      realTest(nameOrDef, freezeAround(config, fn!));
    } else {
      realTest({ ...nameOrDef, fn: freezeAround(config, nameOrDef.fn) });
    }
  }

  Reflect.set(Deno, "test", frozenTest);
}
