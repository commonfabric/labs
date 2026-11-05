/**
 * The exit discipline for a run that writes: a `cf` invocation that ENDS
 * while its run has not reported must not look like a success.
 *
 * A Deno process whose main promise is still pending, with no work left on
 * the event loop, does not hang — it drains and exits, silently, with code
 * 0. Every await in a bulk apply sits under that rule: the engine can stop
 * settling anywhere between opening a session and returning its report, and
 * the process then ends having written part of a migration, printed no
 * summary, and told its caller everything went well. A script cannot see the
 * difference, and neither can an operator reading a log whose last line is a
 * row that applied normally.
 *
 * So the report is not the only thing that decides how the process ends. A
 * run arms a guard for the whole of its life and stands it down the moment
 * it has reported; if the process ends first, the guard says so on stderr
 * and raises the exit code. It is armed on the real event — the process
 * ending — rather than on a clock, so it costs a run that finishes nothing
 * and cannot cut one short.
 *
 * Scoped to the runs that write. A command whose whole job is to stay up
 * until interrupted (`cf piece render --watch`) ends exactly this way on
 * purpose, so this is never installed process-wide.
 */

/** Injectable effects, for tests. */
export interface UnreportedRunDeps {
  /** Registers the process-end hook the guard reports from. */
  addUnloadListener?: (handler: () => void) => void;

  /** Where the guard's report goes. */
  printError?: (message: string) => void;

  /** The code the process is ending with, read inside the hook. */
  readExitCode?: () => number;

  /** Raise the code the process is ending with. */
  setExitCode?: (code: number) => void;
}

/** A run's handle on its own guard. */
export interface RunReportGuard {
  /**
   * This run has reported; the guard stands down. Idempotent, and safe to
   * call on the failure path too — a run that ended by throwing reports
   * through the error it threw.
   */
  reported(): void;
}

interface ArmedRun {
  describe: () => string;
}

// Module-level rather than per-instance so a process running two guarded
// runs still installs at most one hook, from at most one registration.
const armed = new Set<ArmedRun>();
let unloadHookInstalled = false;

/** Test-only: clears the armed runs and the hook guard between cases. */
export function resetUnreportedRunGuardsForTest(): void {
  armed.clear();
  unloadHookInstalled = false;
}

/** The production hook registration; a test injects its own. */
export function addProcessUnloadListener(handler: () => void): void {
  globalThis.addEventListener("unload", handler);
}

/** The production reading of the code the process is ending with. */
export function processExitCode(): number {
  return Deno.exitCode;
}

/** The production write of the code the process is ending with. */
export function setProcessExitCode(code: number): void {
  Deno.exitCode = code;
}

/**
 * Arm a guard over one run. `describe` composes the line the guard reports
 * if the process ends first — called at that moment, so it can name what the
 * run had settled by then rather than what it knew when it started.
 *
 * The hook is installed once per process, by the first run to arm one, and
 * every later run joins it. A test that injects effects therefore resets
 * through {@link resetUnreportedRunGuardsForTest} between cases, the same way
 * the deferred version-skew note does.
 */
export function guardRunReport(
  describe: () => string,
  deps: UnreportedRunDeps = {},
): RunReportGuard {
  const printError = deps.printError ?? console.error;
  const readExitCode = deps.readExitCode ?? processExitCode;
  const setExitCode = deps.setExitCode ?? setProcessExitCode;
  const addUnloadListener = deps.addUnloadListener ?? addProcessUnloadListener;
  const run: ArmedRun = { describe };
  armed.add(run);
  if (!unloadHookInstalled) {
    unloadHookInstalled = true;
    addUnloadListener(() => {
      if (armed.size === 0) return;
      for (const pending of armed) printError(pending.describe());
      // Raise a success into a failure and leave a failure alone: a process
      // already ending nonzero has a reason of its own, and overwriting it
      // would replace the report the caller is about to read.
      if (readExitCode() === 0) setExitCode(1);
      armed.clear();
    });
  }
  return {
    reported: () => {
      armed.delete(run);
    },
  };
}

/**
 * How far a guarded run had got. `running` is before its engine returned;
 * `reporting` is after — the report is in hand and is being written out.
 *
 * The guard stays armed across both, because both can end the process
 * without the operator being told anything: the engine can stop settling,
 * and so can the writing of what it returned. What the two cannot share is
 * the CLAIM. "It did not return" is false of a run that returned, and a
 * guard that said it would be lying in the opposite direction from the one
 * it exists to prevent.
 */
export type ApplyRunPhase = "running" | "reporting";

/** What one guarded apply run has settled by the time it is asked. */
export interface ApplyRunProgress {
  /**
   * Whether this run's rows are being watched as they settle. False for a
   * run whose engine takes no row callback: its rows settle where this
   * process cannot see them, so a count of zero would be an absence of
   * observation rather than an absence of work — and "no row settled" would
   * be false of it rather than merely unhelpful.
   */
  observed: boolean;

  /** Rows the run reported, by verdict, in the order first seen. */
  verdicts: Map<string, number>;

  /**
   * Where the run stands. Moved to `reporting` by the command the moment its
   * engine returns, so the line the guard composes describes what actually
   * happened rather than what was true when the guard was armed.
   */
  phase: ApplyRunPhase;
}

/**
 * What an apply run reports when the process ends before it does. It names
 * the verb, what had settled, and what the operator does next — everything
 * the missing summary would have carried, minus the claims only a returned
 * report can support.
 *
 * The opening clause is the run's {@link ApplyRunPhase}: a run whose engine
 * never returned, or one whose report never finished being written. Both end
 * the process with the operator uninformed; only the first is the engine's
 * doing, and saying so of the second would be false.
 *
 * The row count has three readings, and the distinction between the last two
 * is the whole point of {@link ApplyRunProgress.observed}. A watched run that
 * settled rows names them and their verdicts. A watched run that settled none
 * says so, which is a fact about the run. An UNWATCHED run says the number is
 * not known here — never zero, because zero would be a claim this process is
 * in no position to make, and a wrong number is worse than no number: an
 * operator can act on it. That reason is about the missing callback rather
 * than about returning, so it holds in either phase.
 *
 * Nothing here asserts that rows it does not name were left alone either. A
 * run that stopped stopped somewhere this process cannot see, so the closing
 * line sends the reader to the one thing that can see it.
 */
export function describeUnreportedApplyRun(
  verb: string,
  progress: ApplyRunProgress,
): string {
  const settled = [...progress.verdicts.values()].reduce(
    (total, count) => total + count,
    0,
  );
  const tally = [...progress.verdicts.entries()]
    .map(([verdict, count]) => `${verdict}: ${count}`)
    .join(" · ");
  const reporting = progress.phase === "reporting";
  return [
    reporting
      ? `${verb} ran to a report, but the process exited before that report ` +
        `finished.`
      : `${verb} ended before it reported: the process exited while the run ` +
        `was still in flight.`,
    !progress.observed
      ? `  How many rows it settled is not known here: this run counts its ` +
        `rows only in the report itself.`
      : settled === 0
      ? `  No row settled before it ended.`
      : `  ${settled} ${settled === 1 ? "row" : "rows"} settled — ${tally}.` +
        // Only the running phase has rows beyond the count to be unsure
        // about. Once the engine has returned, a watched run's count IS its
        // report's row count, and hedging it would understate what is known.
        (reporting
          ? ``
          : ` Whether anything after them was written is not known here.`),
    // The same command without `--apply`, rather than a named verification:
    // every verb that arms a guard has a dry mode that classifies each piece
    // where it now stands, and a survey — which reads references — would say
    // nothing about a repair, whose work is in the documents.
    (reporting
      ? `  What the report would have said beyond this is lost. `
      : `  `) +
    `Re-running resumes it, and rows that landed are not redone. The same ` +
    `command without \`--apply\` says where every piece now stands.`,
  ].join("\n");
}
