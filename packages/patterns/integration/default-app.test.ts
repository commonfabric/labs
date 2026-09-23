import { debugStr } from "@commonfabric/data-model";
import {
  attachWorkerProfiler,
  awaitViewSettled,
  type CdpWorkerProfiler,
  env,
  Page,
  type ProbeApi,
  startWorkerProfile,
  waitFor,
  waitForCondition,
  writeWorkerProfile,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import {
  waitForActiveSpaceRoot,
  waitForRuntimeIdle,
  waitForRuntimeSynced,
} from "./cfc-browser-helpers.ts";
import {
  clickButtonWithExactText,
  clickButtonWithText,
  clickButtonWithTitle,
} from "./note-button-helpers.ts";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { assert, assertEquals } from "@std/assert";
import { resolveSpaceDid } from "@commonfabric/lib-shell";

// Every step in this file runs under both server-execution postures: no step
// here is listed in the ON arm's skip registry
// (tasks/server-execution-on-skips.ts). Listing one requires adding an in-file
// `serverExecutionOnStepSkip` guard alongside the entry — the registry's
// validator rejects a step entry whose file never calls the guard, since the
// entry would otherwise be decoration.

type BrowserWriteTraceEntry = {
  recordedAt: number;
  entityId: string;
  path: string[];
  writerActionId?: string;
  stack?: string;
};

type BrowserActionRunTraceEntry = {
  recordedAt: number;
  actionId: string;
  actionType: "effect" | "computation";
  parentActionId?: string;
  durationMs: number;
  declaredWrites: BrowserActionRunTraceAddress[];
  actualWrites: BrowserActionRunTraceAddress[];
};

type BrowserActionRunTraceAddress = {
  space: string;
  entityId: string;
  path: string[];
};

type BrowserTriggerTraceEntry = {
  changeIndex: number;
  entityId: string;
  path: string[];
  matchedActionCount: number;
  triggered: Array<{
    actionId: string;
    actionType: "effect" | "computation";
    decision: string;
    pendingBefore: boolean;
    pendingAfter: boolean;
    dirtyBefore: boolean;
    dirtyAfter: boolean;
  }>;
};

const { FRONTEND_URL, SPACE_NAME } = env;

export function parseCaptureSeriesCount(raw: string | undefined): number {
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

Deno.test("parseCaptureSeriesCount clamps invalid capture env values", () => {
  assertEquals(parseCaptureSeriesCount(undefined), 0);
  assertEquals(parseCaptureSeriesCount(""), 0);
  assertEquals(parseCaptureSeriesCount("foo"), 0);
  assertEquals(parseCaptureSeriesCount("-1"), 0);
  assertEquals(parseCaptureSeriesCount("2.8"), 2);
});

const CAPTURE_TRIGGER_TRACE = (() => {
  try {
    return Deno.env.get("CF_CAPTURE_TRIGGER_TRACE") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_WRITE_TRACE_ORDER = (() => {
  try {
    return Deno.env.get("CF_CAPTURE_WRITE_TRACE_ORDER") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_RUNNER_TRIGGER_LOG = (() => {
  try {
    return Deno.env.get("CF_CAPTURE_RUNNER_TRIGGER_LOG") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_RUNNER_TRIGGER_COUNTS = (() => {
  try {
    return Deno.env.get("CF_CAPTURE_RUNNER_TRIGGER_COUNTS") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_WISH_FLOW_COUNTS = (() => {
  try {
    return Deno.env.get("CF_CAPTURE_WISH_FLOW_COUNTS") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_SOURCE_LOCATION_LOG = (() => {
  try {
    return Deno.env.get("CF_CAPTURE_SOURCE_LOCATION_LOG") === "1";
  } catch {
    return false;
  }
})();
const CAPTURE_ACTION_RUN_SERIES = (() => {
  try {
    return parseCaptureSeriesCount(
      Deno.env.get("CF_CAPTURE_ACTION_RUN_SERIES"),
    );
  } catch {
    return 0;
  }
})();
const CAPTURE_HOME_LOAD_SERIES = (() => {
  try {
    return parseCaptureSeriesCount(Deno.env.get("CF_CAPTURE_HOME_LOAD_SERIES"));
  } catch {
    return 0;
  }
})();
const NOTE_CREATE_TIMING_SERIES = (() => {
  try {
    return parseCaptureSeriesCount(
      Deno.env.get("CF_NOTE_CREATE_TIMING_SERIES"),
    );
  } catch {
    return 0;
  }
})();
const CAPTURE_NOTE_CREATE_PROFILE_SERIES = (() => {
  try {
    return parseCaptureSeriesCount(
      Deno.env.get("CF_CAPTURE_NOTE_CREATE_PROFILE_SERIES"),
    );
  } catch {
    return 0;
  }
})();
const CAPTURE_EVENT_INVOCATION_SERIES = (() => {
  try {
    return parseCaptureSeriesCount(
      Deno.env.get("CF_CAPTURE_EVENT_INVOCATION_SERIES"),
    );
  } catch {
    return 0;
  }
})();
// CPU-profile the runtime worker for the first N note-create iterations,
// writing .cpuprofile + ranked self-time reports to CF_CPUPROFILE_DIR
// (default /tmp).
const CAPTURE_NOTE_CREATE_CPUPROFILE_SERIES = (() => {
  try {
    return parseCaptureSeriesCount(
      Deno.env.get("CF_CAPTURE_NOTE_CREATE_CPUPROFILE_SERIES"),
    );
  } catch {
    return 0;
  }
})();
const CPUPROFILE_DIR = (() => {
  try {
    return Deno.env.get("CF_CPUPROFILE_DIR") ?? "/tmp";
  } catch {
    return "/tmp";
  }
})();
type NoteCreateTimingEntry = {
  noteIndex: number;
  noteId: string;
  noteCountBefore: number;
  noteCountAfter: number;
  createToViewMs: number;
  returnToHomeMs: number;
  totalMs: number;
};

type NoteCreateProfileEntry = {
  noteIndex: number;
  missingRequiredTimingKeys: string[];
  focusTiming: Array<{
    logger: string;
    key: string;
    count: number;
    totalTime: number;
    average: number;
    p50: number;
    p95: number;
    max: number;
  }>;
  topTiming: Array<{
    logger: string;
    key: string;
    count: number;
    totalTime: number;
    average: number;
    p50: number;
    p95: number;
    max: number;
  }>;
  settle: {
    executeCalls: number;
    totalDurationMs: number;
    maxDurationMs: number;
    latestDurationMs: number;
    maxIterations: number;
    latestIterations: number;
    recent: Array<{
      totalDurationMs: number;
      iterations: number;
      actionsRun: number;
    }>;
  };
};

describe("default-app flow test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  const spaceName = SPACE_NAME;

  it("should create and navigate to a note", async () => {
    identity = await Identity.generate({ implementation: "noble" });

    const page = shell.page();

    // Navigate directly to the new space (no piece creation via cf tools)
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName },
      identity,
    });

    if (CAPTURE_TRIGGER_TRACE) {
      console.log("Enable trigger trace...");
      await waitFor(async () => {
        return await armTriggerTrace(page);
      });
    }

    if (CAPTURE_WRITE_TRACE_ORDER) {
      console.log("Enable write trace...");
      await waitFor(async () => {
        return await armWriteTrace(page);
      });
    }

    if (CAPTURE_RUNNER_TRIGGER_LOG) {
      console.log("Enable runner trigger-flow logger...");
      await waitFor(async () => {
        return await armRunnerTriggerLogger(page);
      });
    }

    if (CAPTURE_RUNNER_TRIGGER_COUNTS) {
      console.log("Reset logger baselines...");
      await waitFor(async () => {
        return await resetLoggerBaselines(page);
      });
    }

    if (CAPTURE_WISH_FLOW_COUNTS && !CAPTURE_RUNNER_TRIGGER_COUNTS) {
      console.log("Reset logger baselines...");
      await waitFor(async () => {
        return await resetLoggerBaselines(page);
      });
    }

    if (CAPTURE_SOURCE_LOCATION_LOG) {
      console.log("Enable source-location logger...");
      await waitFor(async () => {
        return await armSourceLocationLogger(page);
      });
    }

    const actionRunSeries: unknown[] = [];
    const homeLoadSeries: unknown[] = [];
    const noteCreateTimings: NoteCreateTimingEntry[] = [];
    const noteCreateProfiles: NoteCreateProfileEntry[] = [];
    const eventInvocationSeries: unknown[] = [];
    const noteIterations = Math.max(
      CAPTURE_ACTION_RUN_SERIES > 0 ? CAPTURE_ACTION_RUN_SERIES : 1,
      CAPTURE_HOME_LOAD_SERIES,
      NOTE_CREATE_TIMING_SERIES,
      CAPTURE_NOTE_CREATE_PROFILE_SERIES,
      CAPTURE_EVENT_INVOCATION_SERIES,
      // Profiled notes start at note 2 (note 1 is compile-dominated).
      CAPTURE_NOTE_CREATE_CPUPROFILE_SERIES > 0
        ? 1 + CAPTURE_NOTE_CREATE_CPUPROFILE_SERIES
        : 0,
    );

    let cpuProfiler: CdpWorkerProfiler | undefined;
    if (CAPTURE_NOTE_CREATE_CPUPROFILE_SERIES > 0) {
      console.log("Connect CDP worker profiler...");
      cpuProfiler = await attachWorkerProfiler(shell.wsEndpoint());
    }

    if (CAPTURE_HOME_LOAD_SERIES > 0) {
      const homeLoadSummary = await collectHomeLoadSummaryFromFreshPage(
        shell,
        {
          frontendUrl: FRONTEND_URL,
          spaceName,
          expectNoteInList: false,
        },
      );
      assert(
        homeLoadSummary,
        "Expected initial home load summary to be available",
      );
      homeLoadSeries.push({
        noteCount: 0,
        ...(homeLoadSummary as Record<string, unknown>),
      });
      console.log(
        "Home load summary (0 notes):",
        JSON.stringify(homeLoadSummary, null, 2),
      );
    }

    for (let noteIndex = 1; noteIndex <= noteIterations; noteIndex++) {
      const noteTitlesBefore = await collectNoteTitlesInList(page);
      const noteCountBefore = noteTitlesBefore.length;

      if (noteIndex <= CAPTURE_NOTE_CREATE_PROFILE_SERIES) {
        console.log(
          `Reset note-create profiling baselines (note ${noteIndex})...`,
        );
        await waitFor(async () => {
          return await resetNoteCreateProfiling(page);
        });
      }

      if (CAPTURE_ACTION_RUN_SERIES > 0) {
        console.log(`Enable action run trace for note ${noteIndex}...`);
        await waitFor(async () => {
          return await armActionRunTrace(page);
        });
      }

      if (noteIndex <= CAPTURE_EVENT_INVOCATION_SERIES) {
        console.log(`Reset event invocation trace (note ${noteIndex})...`);
        await waitFor(async () => {
          return await resetEventInvocationTrace(page);
        });
      }

      // Skip note 1: its profile is dominated by first-use pattern compile
      // (out of scope for steady-state measurement) and is large enough to
      // break the CDP websocket message limit.
      let profileThisNote = cpuProfiler !== undefined && noteIndex >= 2 &&
        noteIndex <= 1 + CAPTURE_NOTE_CREATE_CPUPROFILE_SERIES;
      if (profileThisNote) {
        console.log(`Start worker CPU profile (note ${noteIndex})...`);
        profileThisNote = await startWorkerProfile(
          cpuProfiler!,
          `note ${noteIndex}`,
        );
      }

      console.log(`Click notes drop down (note ${noteIndex})...`);
      await clickButtonWithExactText(page, "Notes ▾");
      await awaitViewSettled(page);

      const noteCreateStartedAt = performance.now();
      console.log(`Click 'New Note' (note ${noteIndex})...`);
      await clickButtonWithText(page, "New Note");

      console.log(`Wait for note view (note ${noteIndex})...`);
      await waitForCondition(page, () => {
        const state = globalThis.app?.serialize?.();
        return !!state &&
          !!state.view &&
          typeof state.view === "object" &&
          "pieceId" in state.view &&
          typeof state.view.pieceId === "string" &&
          state.view.pieceId.length > 0;
      });
      const noteId = await page.evaluate(() => {
        const view = globalThis.app?.serialize?.()?.view;
        return view && typeof view === "object" && "pieceId" in view &&
            typeof view.pieceId === "string"
          ? view.pieceId
          : undefined;
      });
      assert(noteId, `Expected a piece id for note ${noteIndex}`);

      await waitForRuntimeIdle(page);
      const noteViewReadyAt = performance.now();

      if (CAPTURE_ACTION_RUN_SERIES > 0) {
        const actionRunSummary = await collectActionRunSummary(page);
        assert(
          actionRunSummary,
          `Expected action run summary for note ${noteIndex}`,
        );
        actionRunSeries.push({
          noteIndex,
          ...(actionRunSummary as Record<string, unknown>),
        });
        console.log(
          `Action run summary (note ${noteIndex}):`,
          JSON.stringify(actionRunSummary, null, 2),
        );
      }

      if (noteIndex === 1 && CAPTURE_WRITE_TRACE_ORDER) {
        const writeTraceSummary = await collectWriteTraceOrderSummary(page);
        assert(
          writeTraceSummary,
          "Expected write trace summary to be available",
        );
        console.log(
          "Write trace order summary (create note):",
          JSON.stringify(writeTraceSummary, null, 2),
        );
      }

      if (noteIndex === 1 && CAPTURE_RUNNER_TRIGGER_LOG) {
        const runnerLogs = await collectCapturedConsoleLogs(
          page,
          "runner.trigger-flow",
        );
        assert(
          Array.isArray(runnerLogs) && runnerLogs.length > 0,
          "Expected runner trigger-flow logs to be available",
        );
        console.log(
          "Runner trigger-flow logs (create note):",
          JSON.stringify(runnerLogs, null, 2),
        );
      }

      if (noteIndex === 1 && CAPTURE_RUNNER_TRIGGER_COUNTS) {
        const runnerCounts = await collectRunnerTriggerFlowCounts(page);
        assert(
          runnerCounts,
          "Expected runner trigger-flow counts to be available",
        );
        console.log(
          "Runner trigger-flow counts (create note):",
          JSON.stringify(runnerCounts, null, 2),
        );
      }

      if (noteIndex === 1 && CAPTURE_WISH_FLOW_COUNTS) {
        const wishCounts = await collectWishFlowCounts(page);
        assert(wishCounts, "Expected runner wish-flow counts to be available");
        console.log(
          "Runner wish-flow counts (create note):",
          JSON.stringify(wishCounts, null, 2),
        );
      }

      if (noteIndex === 1 && CAPTURE_SOURCE_LOCATION_LOG) {
        const sourceLocationLogs = await collectSourceLocationSamples(page);
        console.log(
          "Builder source-location samples (create note):",
          JSON.stringify(sourceLocationLogs, null, 2),
        );
      }

      console.log(`Navigate back to space page (note ${noteIndex})...`);
      await clickPieceLinkWithText(page, spaceName);
      try {
        await shell.waitForState({ view: { spaceName }, identity });
      } catch (error) {
        throw new Error(
          `Space-link navigation did not reach ${spaceName}; ` +
            debugStr`current state: $quote,long${await shell.state()}`,
          { cause: error },
        );
      }
      await waitForRuntimeIdle(page);
      await awaitViewSettled(page);

      const noteTitlesAfter = await collectNoteTitlesInList(page);

      const noteCreateFinishedAt = performance.now();
      const noteCreateTiming: NoteCreateTimingEntry = {
        noteIndex,
        noteId,
        noteCountBefore,
        noteCountAfter: noteTitlesAfter.length,
        createToViewMs: Number(
          (noteViewReadyAt - noteCreateStartedAt).toFixed(3),
        ),
        returnToHomeMs: Number(
          (noteCreateFinishedAt - noteViewReadyAt).toFixed(3),
        ),
        totalMs: Number(
          (noteCreateFinishedAt - noteCreateStartedAt).toFixed(3),
        ),
      };
      noteCreateTimings.push(noteCreateTiming);
      console.log(
        `Note creation timing (note ${noteIndex}):`,
        JSON.stringify(noteCreateTiming, null, 2),
      );

      if (profileThisNote) {
        await writeWorkerProfile(cpuProfiler!, {
          pathPrefix: `${CPUPROFILE_DIR}/default-app-note-${noteIndex}`,
          label: `note-create iteration ${noteIndex}`,
          context: `note ${noteIndex}`,
        });
      }

      if (noteIndex <= CAPTURE_NOTE_CREATE_PROFILE_SERIES) {
        const noteCreateProfile = await collectNoteCreateProfile(page);
        assert(
          noteCreateProfile,
          `Expected note-create profile for note ${noteIndex}`,
        );
        noteCreateProfiles.push({
          noteIndex,
          ...(noteCreateProfile as Omit<NoteCreateProfileEntry, "noteIndex">),
        });
      }

      if (noteIndex <= CAPTURE_EVENT_INVOCATION_SERIES) {
        const eventInvocationSummary = await collectEventInvocationSummary(
          page,
        );
        assert(
          eventInvocationSummary,
          `Expected event invocation summary for note ${noteIndex}`,
        );
        eventInvocationSeries.push({
          noteIndex,
          ...(eventInvocationSummary as Record<string, unknown>),
        });
        console.log(
          `Event invocation summary (note ${noteIndex}):`,
          JSON.stringify(eventInvocationSummary, null, 2),
        );
      }

      if (noteIndex <= CAPTURE_HOME_LOAD_SERIES) {
        console.log(
          `Open fresh home page for load summary (${noteIndex} notes)...`,
        );
        const homeLoadSummary = await collectHomeLoadSummaryFromFreshPage(
          shell,
          {
            frontendUrl: FRONTEND_URL,
            spaceName,
            expectNoteInList: false,
          },
        );
        assert(
          homeLoadSummary,
          `Expected home load summary for ${noteIndex} notes`,
        );
        homeLoadSeries.push({
          noteCount: noteTitlesAfter.length,
          ...(homeLoadSummary as Record<string, unknown>),
        });
        console.log(
          `Home load summary (${noteIndex} notes):`,
          JSON.stringify(homeLoadSummary, null, 2),
        );
      }
    }

    cpuProfiler?.close();

    if (actionRunSeries.length > 0) {
      console.log(
        "Action run series comparison:",
        JSON.stringify(compareActionRunSeries(actionRunSeries), null, 2),
      );
    }

    if (homeLoadSeries.length > 0) {
      console.log(
        "Home load series comparison:",
        JSON.stringify(compareHomeLoadSeries(homeLoadSeries), null, 2),
      );
    }

    if (noteCreateTimings.length > 0) {
      console.log(
        "Note creation timing summary:",
        JSON.stringify(summarizeNoteCreateTimings(noteCreateTimings), null, 2),
      );
    }

    if (noteCreateProfiles.length > 0) {
      console.log(
        "Note creation profile summary:",
        JSON.stringify(compareNoteCreateProfiles(noteCreateProfiles), null, 2),
      );
    }

    if (eventInvocationSeries.length > 0) {
      console.log(
        "Event invocation series:",
        JSON.stringify(eventInvocationSeries, null, 2),
      );
    }

    if (CAPTURE_TRIGGER_TRACE) {
      const triggerSummary = await collectTriggerTraceSummary(page);
      assert(triggerSummary, "Expected trigger trace summary to be available");
      console.log(
        "Trigger trace summary:",
        JSON.stringify(triggerSummary, null, 2),
      );
    }
  });

  it(
    "should persist and reload every rapidly created notebook note",
    async () => {
      identity = await Identity.generate({ implementation: "noble" });
      const notebookSpaceName = globalThis.crypto.randomUUID();
      const notebookSpaceDid = await resolveSpaceDid(
        identity,
        notebookSpaceName,
      );

      const page = shell.page();
      await disposeBrowserRuntime(page);
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: { spaceName: notebookSpaceName },
        identity,
      });

      // shell.goto() waits for URL state and login, while RootView resolves the
      // named view space independently. Do not interact with the previous
      // space's still-rendered root while that resolution is in flight.
      await waitForActiveSpaceRoot(page, notebookSpaceDid);

      console.log("Await runtime idle for notebook regression...");
      await waitForRuntimeIdle(page);
      // Runtime idle can precede the page renderer's Lit update. Wait for the
      // freshly navigated default-app view to bind its menu handlers before the
      // first trusted click, just as the notebook toolbar does below.
      await waitForCondition(
        page,
        () => typeof globalThis.commonfabric?.viewSettled === "function",
      );
      await awaitViewSettled(page);

      try {
        await clickButtonWithExactText(page, "Notes ▾");
        await awaitViewSettled(page);
        await clickButtonWithText(page, "New Notebook");
        // The wait hands back the NOTEBOOK's piece id at the instant it
        // approved `isNotebook` — the step's stable read target from here
        // on. Every later wait and assertion reads the notebook BY THIS ID,
        // never through `view.pieceId` again: under server execution the
        // final "Create" click's speculative run may read a stale
        // `usedCreateAnotherNote` and optimistically navigate into the new
        // note while the authoritative run computes no navigation — a
        // sanctioned outcome (the L2 optimistic-enactment question, ruled
        // PUNT 2026-08-27: the client navigates, so be it). A view-following
        // read then polls a healthy NOTE through notebook accessors until
        // the step's net (the 2026-08-27 r06/r09 root cause,
        // docs/history/plans/server-execution-v2/optimize/
        // keyless-diagnosis-2026-08-27.md); an id-bound read is indifferent
        // to where the view wandered.
        let notebookEntityId: string | undefined;
        try {
          notebookEntityId = await waitForCondition(
            page,
            async (_probe, space) => {
              const commonfabric = globalThis.commonfabric as
                | { readCell?: (options: { id: string }) => Promise<unknown> }
                | undefined;
              const view = globalThis.app?.serialize?.()?.view;
              const pieceId = view && typeof view === "object" &&
                  "pieceId" in view && typeof view.pieceId === "string"
                ? view.pieceId
                : undefined;
              if (!pieceId || !commonfabric?.readCell) return false;
              let current: unknown;
              const originalLog = console.log;
              try {
                console.log = () => {};
                current = await commonfabric.readCell({ id: pieceId });
              } finally {
                console.log = originalLog;
              }
              if (
                (current as { isNotebook?: unknown } | undefined)
                  ?.isNotebook !==
                  true
              ) return false;
              // Navigation may name a cell whose value links to the notebook.
              // Its argument and internal metadata belong to the resolved
              // notebook, not to the cell that carries that reference.
              const piece = await globalThis.commonfabric?.rt?.getPiece(
                pieceId,
                space,
                false,
              );
              if (!piece) return false;
              return (await piece.cell().resolveAsCell()).id();
            },
            { args: [notebookSpaceDid] },
          );
        } catch (error) {
          console.log(
            "Notebook navigation diagnostics:",
            JSON.stringify(await collectNavigationDiagnostics(page), null, 2),
          );
          throw error;
        }
        assert(
          notebookEntityId,
          "Expected the notebook wait to hand back the notebook piece id",
        );

        // Wait until the notebook toolbar is mounted and interactive before
        // clicking. viewSettled resolves once the worker is idle and the
        // rendered view has caught up (vdom applied, Lit updates drained), so the
        // New Note button's handler is bound and a single click is not dropped.
        await waitForCondition(
          page,
          () => typeof globalThis.commonfabric?.viewSettled === "function",
        );
        await awaitViewSettled(page);
        assert(
          await clickButtonWithTitle(page, "New Note"),
          "Expected New Note click to succeed",
        );
        // Arm the event-invocation trace before the note creations, whose markers
        // this test's failure diagnostics read. clickButtonWithTitle settled the
        // view, so the runtime has exposed its telemetry methods and the reset
        // runs once with its success asserted. The first "Create Another" click
        // below settles the view and waits for the button to render, so no
        // separate wait for the modal is needed here.
        assert(
          await resetEventInvocationTrace(page),
          "Expected the event invocation trace to reset",
        );

        const noteCreates = 7;
        for (let i = 0; i < noteCreates - 1; i++) {
          assert(
            await clickButtonWithText(page, "Create Another"),
            `Expected Create Another click ${i + 1} to succeed`,
          );
        }
        assert(
          await clickButtonWithExactText(page, "Create"),
          "Expected final Create click to succeed",
        );

        // The assertions bind to the summary a wait handed back — the state
        // as it was at the instant the predicate approved it — never to a
        // separate read taken after a wait. Under server execution the
        // notebook's derived `noteCount` follows the ruled unresolved-read
        // disposition (OW51): a re-derivation reads cleanly `undefined` and
        // re-triggers, healing back to the settled value. That interim is
        // correct product behavior, so a single-shot read between a wait and
        // its assertion can catch it and fail a healthy run (the OW45
        // register row's measured 1-in-10-quiet / 5-in-10-under-load flake);
        // a wait on the value itself absorbs it, and a value that never
        // reaches `expectedCount` — a genuinely lost note — still fails
        // loudly at waitForCondition's stuck-condition net.
        //
        // The first wait orders the sync barrier after local convergence, so
        // "synced" covers all seven notes' commits; the second wait is the
        // assertion's authority, re-approving the state after that barrier.
        // Its predicate reads the same cells the step has read all along, and
        // any client read registers demand — this step verifies that the
        // created notes' data and derived count converge and survive the sync
        // barrier under serving, not that they materialize unobserved (the
        // reload rehydration surface is integration/reload/
        // default-app-notebook.test.ts's).
        let summary: NotebookSourceSummary | undefined;
        let waitFailure: unknown;
        try {
          await waitForCondition(page, notebookSourceStateMatches, {
            args: [noteCreates, notebookEntityId],
          });
          await waitForRuntimeSynced(page);
          summary = await waitForCondition(page, notebookSourceStateMatches, {
            args: [noteCreates, notebookEntityId],
          });
        } catch (error) {
          // A wait or the sync barrier failed at its net: the state never
          // converged (or synchronization itself failed). Hold the error so
          // the failure path below can print diagnostics and then RE-THROW
          // it — the waits are the step's only signal, and a fresh read
          // must never stand in for them (a fallback read that fed the
          // assertions could green a run whose authority wait failed on a
          // field the assertions don't check).
          waitFailure = error;
        }

        if (summary === undefined) {
          // Failure path only: print the diagnostics the thrown failure
          // cannot carry, from a one-shot read that is expressly NOT the
          // signal (its raciness is harmless here — the step is already
          // failing), then re-throw the authority's own error.
          console.log(
            "Notebook rapid create source diagnostics:",
            JSON.stringify(
              await collectNotebookSourceState(page, notebookEntityId),
              null,
              2,
            ),
          );
          console.log(
            "Notebook rapid create render diagnostics:",
            JSON.stringify(await collectNotebookRenderState(page), null, 2),
          );
          console.log(
            "Notebook rapid create event/action diagnostics:",
            JSON.stringify(
              await collectNotebookCreateTraceSummary(page),
              null,
              2,
            ),
          );
          throw waitFailure ??
            new Error(
              "the post-sync wait resolved without an approved summary",
            );
        }

        // Approved path: the assertions bind to the summary the wait handed
        // back — the state at the instant the predicate approved it.
        assertEquals(summary.argumentNotesLength, noteCreates);
        assertEquals(summary.noteCount, noteCreates);
      } finally {
        await waitForRuntimeIdle(page).catch(
          (error) =>
            console.warn(
              "Failed to await runtime idle after notebook regression",
              error,
            ),
        );
      }
    },
  );
});

async function armTriggerTrace(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const rt = globalThis.commonfabric?.rt;
    if (!rt) return false;
    await rt.setTriggerTraceEnabled(false);
    await rt.setTriggerTraceEnabled(true);
    return true;
  });
}

async function armWriteTrace(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric as {
      watchWrites?: (options: {
        space?: string;
        path?: string[];
        match?: "exact" | "prefix";
        label?: string;
      }) => Promise<unknown>;
      space?: string;
    } | undefined;
    if (!api?.watchWrites) return false;
    await api.watchWrites({
      space: api.space,
      path: [],
      match: "exact",
      label: "root writes",
    });
    return true;
  });
}

async function armRunnerTriggerLogger(page: Page): Promise<boolean> {
  await ensureCapturedConsole(page);
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return false;

    await api.setLoggerEnabled(true, "runner.trigger-flow");
    await api.setLoggerLevel("debug", "runner.trigger-flow");
    return true;
  });
}

async function armSourceLocationLogger(page: Page): Promise<boolean> {
  await ensureCapturedConsole(page);
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return false;

    await api.setLoggerEnabled(true, "builder.source-location");
    await api.setLoggerLevel("debug", "builder.source-location");
    await api.setLoggerEnabled(true, "runner.source-location");
    await api.setLoggerLevel("debug", "runner.source-location");
    return true;
  });
}

async function resetLoggerBaselines(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return false;
    await api.resetLoggerBaselines();
    return true;
  });
}

async function resetNoteCreateProfiling(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return false;
    await api.resetLoggerBaselines();
    await api.setSettleStatsEnabled(false);
    await api.setSettleStatsEnabled(true);
    return true;
  });
}

async function resetEventInvocationTrace(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric as {
      rt?: {
        setTelemetryEnabled?: (enabled: boolean) => Promise<void>;
        on?: (event: string, handler: (marker: unknown) => void) => void;
        off?: (event: string, handler: (marker: unknown) => void) => void;
        idle?: () => Promise<void>;
      };
      __eventInvocationTrace?: unknown[];
      __eventInvocationTraceHandler?: (marker: unknown) => void;
    } | undefined;
    const rt = api?.rt;
    if (!api || !rt?.setTelemetryEnabled || !rt.on || !rt.off) return false;

    if (api.__eventInvocationTraceHandler) {
      rt.off("telemetry", api.__eventInvocationTraceHandler);
    }

    api.__eventInvocationTrace = [];
    api.__eventInvocationTraceHandler = (marker: unknown) => {
      const type = marker && typeof marker === "object"
        ? (marker as { type?: unknown }).type
        : undefined;
      if (
        type === "scheduler.invocation" ||
        type === "scheduler.event.commit" ||
        type === "scheduler.event.preflight"
      ) {
        api.__eventInvocationTrace?.push(marker);
      }
    };
    rt.on("telemetry", api.__eventInvocationTraceHandler);
    await rt.setTelemetryEnabled(true);
    await rt.idle?.();
    return true;
  });
}

async function collectEventInvocationSummary(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric as {
      rt?: {
        setTelemetryEnabled?: (enabled: boolean) => Promise<void>;
        off?: (event: string, handler: (marker: unknown) => void) => void;
        idle?: () => Promise<void>;
      };
      __eventInvocationTrace?: unknown[];
      __eventInvocationTraceHandler?: (marker: unknown) => void;
    } | undefined;
    const rt = api?.rt;
    if (!api || !rt?.setTelemetryEnabled) return null;

    await rt.idle?.();
    await rt.setTelemetryEnabled(false);
    if (api.__eventInvocationTraceHandler && rt.off) {
      rt.off("telemetry", api.__eventInvocationTraceHandler);
    }

    type Marker = {
      type: string;
      handlerId?: string;
      handlerInfo?: {
        patternName?: string;
        moduleName?: string;
        reads?: string[];
        writes?: string[];
      };
    };
    type PreflightMarker = Marker & {
      readCount?: number;
      shallowReadCount?: number;
      dirtySizeBefore?: number;
      pendingSizeBefore?: number;
      dirtyDependencyCount?: number;
      hasDirtyDependencies?: boolean;
      skipped?: boolean;
      populateMs?: number;
      txToLogMs?: number;
      depCommitMs?: number;
      collectMs?: number;
      scheduleMs?: number;
      stats?: {
        hotActions?: PreflightActionSummary[];
        hotFanoutActions?: PreflightActionSummary[];
        rootDirectWriters?: PreflightActionSummary[];
        visitCount?: number;
        memoHitCount?: number;
        cycleHitCount?: number;
        dirtyInputCount?: number;
        resultTrueCount?: number;
        workSetAddCount?: number;
        reverseDependencyActionCount?: number;
        reverseDependencyEdgeCount?: number;
        logFallbackCount?: number;
        logReadCount?: number;
        logShallowReadCount?: number;
        writerCandidateCount?: number;
        writerOverlapCount?: number;
        directWriterCount?: number;
        maxDepth?: number;
      };
    };
    type PreflightActionSummary = {
      actionId: string;
      actionType?: string;
      visitCount?: number;
      memoHitCount?: number;
      dirtyInputCount?: number;
      resultTrueCount?: number;
      reverseDependencyEdgeCount?: number;
      maxDirectWriterCount?: number;
      dirty?: boolean;
      pending?: boolean;
      readCount?: number;
      shallowReadCount?: number;
      writeCount?: number;
    };
    const markers = (api.__eventInvocationTrace ?? []) as Marker[];
    const rows = new Map<string, {
      handlerId: string;
      count: number;
      patternName?: string;
      moduleName?: string;
      reads?: string[];
      writes?: string[];
    }>();

    for (const marker of markers) {
      if (marker.type !== "scheduler.invocation") continue;
      const handlerId = marker.handlerId ?? "unknown";
      const row = rows.get(handlerId) ?? {
        handlerId,
        count: 0,
        patternName: marker.handlerInfo?.patternName,
        moduleName: marker.handlerInfo?.moduleName,
        reads: marker.handlerInfo?.reads,
        writes: marker.handlerInfo?.writes,
      };
      row.count++;
      rows.set(handlerId, row);
    }

    const preflightRows = new Map<string, {
      handlerId: string;
      count: number;
      skipped: number;
      withDirtyDependencies: number;
      readCountMax: number;
      shallowReadCountMax: number;
      dirtyDependencyCountMax: number;
      dirtySizeBeforeMax: number;
      pendingSizeBeforeMax: number;
      totalPopulateMs: number;
      totalCollectMs: number;
      totalScheduleMs: number;
      totalVisitCount: number;
      totalMemoHitCount: number;
      totalDirtyInputCount: number;
      totalResultTrueCount: number;
      totalWorkSetAddCount: number;
      totalReverseDependencyEdges: number;
      totalWriterCandidates: number;
      totalWriterOverlaps: number;
      totalDirectWriters: number;
      maxVisitCount: number;
      maxDepth: number;
      patternName?: string;
      moduleName?: string;
      reads?: string[];
      writes?: string[];
    }>();
    const hotActionsByHandler = new Map<
      string,
      Map<string, PreflightActionSummary>
    >();
    const hotFanoutActionsByHandler = new Map<
      string,
      Map<string, PreflightActionSummary>
    >();
    const rootDirectWritersByHandler = new Map<
      string,
      Map<string, PreflightActionSummary>
    >();

    const mergeActionSummaries = (
      store: Map<string, Map<string, PreflightActionSummary>>,
      handlerId: string,
      actions: PreflightActionSummary[] | undefined,
    ) => {
      if (!actions?.length) return;
      let byAction = store.get(handlerId);
      if (!byAction) {
        byAction = new Map();
        store.set(handlerId, byAction);
      }
      for (const action of actions) {
        const existing = byAction.get(action.actionId) ?? {
          actionId: action.actionId,
          actionType: action.actionType,
          visitCount: 0,
          memoHitCount: 0,
          dirtyInputCount: 0,
          resultTrueCount: 0,
          reverseDependencyEdgeCount: 0,
          maxDirectWriterCount: 0,
          dirty: false,
          pending: false,
          readCount: 0,
          shallowReadCount: 0,
          writeCount: 0,
        };
        existing.visitCount = (existing.visitCount ?? 0) +
          (action.visitCount ?? 0);
        existing.memoHitCount = (existing.memoHitCount ?? 0) +
          (action.memoHitCount ?? 0);
        existing.dirtyInputCount = (existing.dirtyInputCount ?? 0) +
          (action.dirtyInputCount ?? 0);
        existing.resultTrueCount = (existing.resultTrueCount ?? 0) +
          (action.resultTrueCount ?? 0);
        existing.reverseDependencyEdgeCount =
          (existing.reverseDependencyEdgeCount ?? 0) +
          (action.reverseDependencyEdgeCount ?? 0);
        existing.maxDirectWriterCount = Math.max(
          existing.maxDirectWriterCount ?? 0,
          action.maxDirectWriterCount ?? 0,
        );
        existing.dirty = Boolean(existing.dirty || action.dirty);
        existing.pending = Boolean(existing.pending || action.pending);
        existing.readCount = Math.max(
          existing.readCount ?? 0,
          action.readCount ?? 0,
        );
        existing.shallowReadCount = Math.max(
          existing.shallowReadCount ?? 0,
          action.shallowReadCount ?? 0,
        );
        existing.writeCount = Math.max(
          existing.writeCount ?? 0,
          action.writeCount ?? 0,
        );
        byAction.set(action.actionId, existing);
      }
    };

    for (const marker of markers as PreflightMarker[]) {
      if (marker.type !== "scheduler.event.preflight") continue;
      const handlerId = marker.handlerId ?? "unknown";
      const row = preflightRows.get(handlerId) ?? {
        handlerId,
        count: 0,
        skipped: 0,
        withDirtyDependencies: 0,
        readCountMax: 0,
        shallowReadCountMax: 0,
        dirtyDependencyCountMax: 0,
        dirtySizeBeforeMax: 0,
        pendingSizeBeforeMax: 0,
        totalPopulateMs: 0,
        totalCollectMs: 0,
        totalScheduleMs: 0,
        totalVisitCount: 0,
        totalMemoHitCount: 0,
        totalDirtyInputCount: 0,
        totalResultTrueCount: 0,
        totalWorkSetAddCount: 0,
        totalReverseDependencyEdges: 0,
        totalWriterCandidates: 0,
        totalWriterOverlaps: 0,
        totalDirectWriters: 0,
        maxVisitCount: 0,
        maxDepth: 0,
        patternName: marker.handlerInfo?.patternName,
        moduleName: marker.handlerInfo?.moduleName,
        reads: marker.handlerInfo?.reads,
        writes: marker.handlerInfo?.writes,
      };
      row.count++;
      if (marker.skipped) row.skipped++;
      if (marker.hasDirtyDependencies) row.withDirtyDependencies++;
      row.readCountMax = Math.max(row.readCountMax, marker.readCount ?? 0);
      row.shallowReadCountMax = Math.max(
        row.shallowReadCountMax,
        marker.shallowReadCount ?? 0,
      );
      row.dirtyDependencyCountMax = Math.max(
        row.dirtyDependencyCountMax,
        marker.dirtyDependencyCount ?? 0,
      );
      row.dirtySizeBeforeMax = Math.max(
        row.dirtySizeBeforeMax,
        marker.dirtySizeBefore ?? 0,
      );
      row.pendingSizeBeforeMax = Math.max(
        row.pendingSizeBeforeMax,
        marker.pendingSizeBefore ?? 0,
      );
      row.totalPopulateMs += marker.populateMs ?? 0;
      row.totalCollectMs += marker.collectMs ?? 0;
      row.totalScheduleMs += marker.scheduleMs ?? 0;
      row.totalVisitCount += marker.stats?.visitCount ?? 0;
      row.totalMemoHitCount += marker.stats?.memoHitCount ?? 0;
      row.totalDirtyInputCount += marker.stats?.dirtyInputCount ?? 0;
      row.totalResultTrueCount += marker.stats?.resultTrueCount ?? 0;
      row.totalWorkSetAddCount += marker.stats?.workSetAddCount ?? 0;
      row.totalReverseDependencyEdges +=
        marker.stats?.reverseDependencyEdgeCount ?? 0;
      row.totalWriterCandidates += marker.stats?.writerCandidateCount ?? 0;
      row.totalWriterOverlaps += marker.stats?.writerOverlapCount ?? 0;
      row.totalDirectWriters += marker.stats?.directWriterCount ?? 0;
      row.maxVisitCount = Math.max(
        row.maxVisitCount,
        marker.stats?.visitCount ?? 0,
      );
      row.maxDepth = Math.max(row.maxDepth, marker.stats?.maxDepth ?? 0);
      preflightRows.set(handlerId, row);
      mergeActionSummaries(
        hotActionsByHandler,
        handlerId,
        marker.stats?.hotActions,
      );
      mergeActionSummaries(
        hotFanoutActionsByHandler,
        handlerId,
        marker.stats?.hotFanoutActions,
      );
      mergeActionSummaries(
        rootDirectWritersByHandler,
        handlerId,
        marker.stats?.rootDirectWriters,
      );
    }

    const handlers = [...rows.values()].sort((a, b) =>
      b.count - a.count || a.handlerId.localeCompare(b.handlerId)
    );
    const total = handlers.reduce((sum, row) => sum + row.count, 0);
    const topActionSummaries = (
      store: Map<string, Map<string, PreflightActionSummary>>,
      handlerId: string,
      key: "visitCount" | "reverseDependencyEdgeCount",
    ) =>
      [...(store.get(handlerId)?.values() ?? [])]
        .sort((a, b) =>
          (b[key] ?? 0) - (a[key] ?? 0) ||
          (b.visitCount ?? 0) - (a.visitCount ?? 0) ||
          a.actionId.localeCompare(b.actionId)
        )
        .slice(0, 8);
    const preflightHandlers = [...preflightRows.values()]
      .map((row) => ({
        ...row,
        totalPopulateMs: Number(row.totalPopulateMs.toFixed(3)),
        totalCollectMs: Number(row.totalCollectMs.toFixed(3)),
        totalScheduleMs: Number(row.totalScheduleMs.toFixed(3)),
        hotActions: topActionSummaries(
          hotActionsByHandler,
          row.handlerId,
          "visitCount",
        ),
        hotFanoutActions: topActionSummaries(
          hotFanoutActionsByHandler,
          row.handlerId,
          "reverseDependencyEdgeCount",
        ),
        rootDirectWriters: topActionSummaries(
          rootDirectWritersByHandler,
          row.handlerId,
          "visitCount",
        ),
      }))
      .sort((a, b) =>
        b.totalCollectMs - a.totalCollectMs ||
        b.totalVisitCount - a.totalVisitCount ||
        a.handlerId.localeCompare(b.handlerId)
      );
    return {
      total,
      uniqueHandlers: handlers.length,
      handlers,
      preflights: {
        total: preflightHandlers.reduce((sum, row) => sum + row.count, 0),
        skipped: preflightHandlers.reduce((sum, row) => sum + row.skipped, 0),
        withDirtyDependencies: preflightHandlers.reduce(
          (sum, row) => sum + row.withDirtyDependencies,
          0,
        ),
        handlers: preflightHandlers,
      },
    };
  });
}

async function collectTriggerTraceSummary(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const rt = globalThis.commonfabric?.rt;
    if (!rt) return null;

    const trace = await rt.getTriggerTrace();
    const graph = rt.getGraphSnapshot ? await rt.getGraphSnapshot() : undefined;
    type TriggerSample = {
      writerActionId?: string;
      change: string;
      decision: string;
    };

    const counts = new Map<string, number>();
    const samples = new Map<string, TriggerSample[]>();
    const rootSinkChangeCounts = new Map<string, {
      count: number;
      actionIds: Set<string>;
      decisions: Set<string>;
      writerActionIds: Set<string>;
    }>();

    const isRootSink = (actionId: string) =>
      actionId.startsWith("sink:") && /\/of:[^/]+\/$/.test(actionId);

    const pushSample = (actionId: string, sample: TriggerSample) => {
      counts.set(actionId, (counts.get(actionId) ?? 0) + 1);
      const existing = samples.get(actionId) ?? [];
      if (existing.length < 3) {
        existing.push(sample);
      }
      samples.set(actionId, existing);
      if (isRootSink(actionId)) {
        const changeRow = rootSinkChangeCounts.get(sample.change) ?? {
          count: 0,
          actionIds: new Set<string>(),
          decisions: new Set<string>(),
          writerActionIds: new Set<string>(),
        };
        changeRow.count += 1;
        changeRow.actionIds.add(actionId);
        changeRow.decisions.add(sample.decision);
        if (sample.writerActionId) {
          changeRow.writerActionIds.add(sample.writerActionId);
        }
        rootSinkChangeCounts.set(sample.change, changeRow);
      }
    };

    for (const entry of trace) {
      const change = `${entry.space}/${entry.entityId}/${entry.path.join("/")}`;
      for (const action of entry.triggered) {
        pushSample(action.actionId, {
          writerActionId: entry.writerActionId,
          change,
          decision: action.decision,
        });
      }
    }

    return {
      entryCount: trace.length,
      rootSinkActions: [...counts.entries()]
        .filter(([actionId]) => isRootSink(actionId))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([actionId, count]) => ({
          actionId,
          count,
          samples: samples.get(actionId) ?? [],
        })),
      rootSinkChanges: [...rootSinkChangeCounts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 20)
        .map(([change, row]) => ({
          change,
          count: row.count,
          actionIds: [...row.actionIds].slice(0, 5),
          decisions: [...row.decisions],
          writerActionIds: [...row.writerActionIds].slice(0, 5),
        })),
      rootSinkGraphNodes: graph?.nodes
        ?.filter((node: {
          id: string;
          type: string;
        }) => node.type === "effect" && isRootSink(node.id))
        .slice(0, 20)
        .map((node: {
          id: string;
          parentId?: string;
          reads?: string[];
          shallowReads?: string[];
          writes?: string[];
          isDirty: boolean;
          isPending: boolean;
        }) => ({
          id: node.id,
          parentId: node.parentId,
          reads: node.reads ?? [],
          shallowReads: node.shallowReads ?? [],
          writes: node.writes ?? [],
          isDirty: node.isDirty,
          isPending: node.isPending,
        })),
      repeatedActions: [...counts.entries()]
        .filter(([, count]) => count > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([actionId, count]) => ({
          actionId,
          count,
          samples: samples.get(actionId) ?? [],
        })),
    };
  });
}

async function collectWriteTraceOrderSummary(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric as {
      getWriteStackTrace?: () => Promise<BrowserWriteTraceEntry[]>;
      readCell?: (options: { id: string }) => Promise<unknown>;
    } | undefined;
    if (!api?.getWriteStackTrace || !api.readCell) return null;
    const readCell = api.readCell;

    const trace = await api.getWriteStackTrace();
    const rootTrace = trace
      .filter((entry) => entry.path.length === 0)
      .sort((a, b) => a.recordedAt - b.recordedAt);

    // The `stack.includes(...)` tests in `classifyStack` and
    // `interestingCallPath` match frame text, which no engine promises to keep
    // stable, and a filter that matches nothing looks exactly like a run with
    // nothing to report. Two ways they go quiet:
    //
    // The `_CellImpl` names are the bundler's, not the source's. Renaming
    // `CellImpl` or changing how the shell is bundled breaks every one of them.
    //
    // A member converted to a `#` private name changes its own frame text.
    // Chrome writes `at #member`, Deno writes `at Class.#member`, and a
    // public member keeps its class in both. The split does not follow the V8
    // version -- for one example, the two were a single V8 minor apart on the
    // machine this was tested on, as of this writing -- so it says nothing
    // about a third engine, or a later Chrome. Match the bare `#member`, a
    // substring of both, rather than either whole form.
    function classifyStack(stack?: string): string {
      if (!stack) return "unknown";
      if (
        stack.includes("_CellImpl.setMetaRaw") &&
        stack.includes("#setupInternal")
      ) {
        return "setup:setMetaRaw";
      }
      if (
        stack.includes("_CellImpl.setRawUntyped") &&
        stack.includes("#setupInternal")
      ) {
        return "setup:setRawUntyped";
      }
      if (stack.includes("_CellImpl.setRawUntyped")) {
        return "raw:setRawUntyped";
      }
      if (stack.includes("sendValueToBinding")) {
        return "diff:sendValueToBinding";
      }
      if (stack.includes("_CellImpl.push")) {
        return "diff:Cell.push";
      }
      if (stack.includes("_CellImpl.send")) {
        return "diff:Cell.send";
      }
      if (stack.includes("_CellImpl.set")) {
        return "diff:Cell.set";
      }
      if (stack.includes("applyChangeSet")) {
        return "diff:applyChangeSet";
      }
      return "other";
    }

    function interestingCallPath(stack?: string): string[] {
      if (!stack) return [];
      const lines = stack.split("\n").map((line) => line.trim());
      const interesting = lines.filter((line) =>
        line.includes("handler:") ||
        line.includes("raw:") ||
        line.includes("postRun") ||
        line.includes("#instantiatePatternNode") ||
        line.includes("Runner.run") ||
        line.includes("#setupInternal") ||
        line.includes("sendValueToBinding") ||
        line.includes("diffAndUpdate") ||
        line.includes("applyChangeSet") ||
        line.includes("_CellImpl.push") ||
        line.includes("_CellImpl.send") ||
        line.includes("_CellImpl.setMetaRaw") ||
        line.includes("_CellImpl.setRawUntyped") ||
        line.includes("_CellImpl.set")
      );
      return interesting.slice(0, 8);
    }

    function summarizeValue(value: unknown): Record<string, unknown> {
      if (value === undefined) return { kind: "undefined" };
      if (value === null) return { kind: "null" };
      if (typeof value === "boolean") return { kind: "boolean", value };
      if (typeof value === "number") return { kind: "number", value };
      if (typeof value === "string") {
        return {
          kind: "string",
          preview: value.length > 120 ? `${value.slice(0, 117)}...` : value,
        };
      }
      if (Array.isArray(value)) return { kind: "array", length: value.length };
      if (typeof value !== "object") return { kind: typeof value };

      const record = value as Record<string, unknown>;
      const internal = typeof record.internal === "object" && record.internal
        ? record.internal as Record<string, unknown>
        : undefined;
      return {
        kind: "object",
        topKeys: Object.keys(record).slice(0, 8),
        internalKeys: internal ? Object.keys(internal).slice(0, 8) : [],
      };
    }

    const groups = new Map<string, typeof rootTrace>();
    for (const entry of rootTrace) {
      const existing = groups.get(entry.entityId) ?? [];
      existing.push(entry);
      groups.set(entry.entityId, existing);
    }

    const sequences = await Promise.all(
      [...groups.entries()]
        .filter(([, entries]) => entries.length > 1)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 12)
        .map(async ([entityId, entries]) => {
          const currentValue = await readCell({ id: entityId });
          const firstRecordedAt = entries[0]?.recordedAt ?? 0;
          return {
            entityId,
            count: entries.length,
            currentValue: summarizeValue(currentValue),
            sequence: entries.map((entry, index) => ({
              order: index + 1,
              dtMs: Number((entry.recordedAt - firstRecordedAt).toFixed(3)),
              kind: classifyStack(entry.stack),
              writerActionId: entry.writerActionId,
              callPath: interestingCallPath(entry.stack),
            })),
          };
        }),
    );

    return {
      entryCount: trace.length,
      rootEntryCount: rootTrace.length,
      repeatedEntityCount: sequences.length,
      sequences,
    };
  });
}

async function armActionRunTrace(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const rt = globalThis.commonfabric?.rt;
    if (!rt) return false;
    await rt.setActionRunTraceEnabled(false);
    await rt.setActionRunTraceEnabled(true);
    return true;
  });
}

async function disposeBrowserRuntime(page: Page): Promise<void> {
  await page.evaluate(async () => {
    try {
      await globalThis.commonfabric?.rt?.dispose();
    } catch (error) {
      console.warn(
        "Failed to dispose browser runtime before navigation",
        error,
      );
    } finally {
      if (globalThis.commonfabric) {
        globalThis.commonfabric.rt = undefined;
      }
    }
  });
}

async function waitForHomePageReady(
  page: Page,
  options: { spaceName: string; expectNoteInList: boolean },
): Promise<void> {
  await waitForCondition(page, (_probe, spaceName) => {
    const app = globalThis.app;
    const rt = globalThis.commonfabric?.rt;
    const state = app?.serialize?.();
    const view = state?.view;
    return !!(
      rt &&
      state &&
      view &&
      typeof view === "object" &&
      "spaceName" in view &&
      view.spaceName === spaceName
    );
  }, { args: [options.spaceName] });

  if (options.expectNoteInList) {
    await waitForCondition(page, noteTitlesExceed, { args: [0] });
  }

  await waitForRuntimeIdle(page);
}

// Reads the notebook by `knownNotebookId` when the caller captured one (the
// sanctioned optimistic navigation can leave the view on a NOTE — see
// notebookSourceStateMatches), else by the current view's piece id. Reports
// `viewPieceId` separately either way, so a failure dump distinguishes
// "wrong state" from "wrong piece under the reader" — the confusion the
// 2026-08-27 r06/r09 diagnosis found in this step's recorded reds.
async function collectNotebookSourceState(
  page: Page,
  knownNotebookId?: string,
): Promise<{
  notebookEntityId?: string;
  viewPieceId?: string;
  argumentNotesLength?: number;
  noteCount?: number;
  showNewNotePrompt?: boolean;
  usedCreateAnotherNote?: boolean;
}> {
  return await page.evaluate(async (knownId?: string) => {
    const api = globalThis.commonfabric as {
      readCell?: (options: {
        id: string;
        path?: string[];
        meta?: "argument" | "internal";
      }) => Promise<unknown>;
    } | undefined;

    const appState = globalThis.app?.serialize?.();
    const view = appState?.view;
    const viewPieceId = view && typeof view === "object" &&
        "pieceId" in view && typeof view.pieceId === "string"
      ? view.pieceId
      : undefined;
    const notebookEntityId = knownId ?? viewPieceId;
    if (!notebookEntityId || !api?.readCell) {
      return { notebookEntityId, viewPieceId };
    }

    const resolveInternalManifest = async (
      manifest: unknown,
    ): Promise<Record<string, unknown>> => {
      const resolved: Record<string, unknown> = {};
      if (!Array.isArray(manifest)) return resolved;

      for (const entry of manifest) {
        if (entry === null || typeof entry !== "object") continue;
        const { partialCause, link } = entry as {
          partialCause?: unknown;
          link?: { sync?: () => Promise<unknown> };
        };
        const key = typeof partialCause === "string"
          ? partialCause
          : JSON.stringify(partialCause) ?? String(partialCause);
        if (link && typeof link.sync === "function") {
          resolved[key] = await link.sync();
        }
      }
      return resolved;
    };

    let notebookArgument: unknown;
    let notebookInternalManifest: unknown;
    const originalLog = console.log;
    try {
      console.log = () => {};
      notebookArgument = await api.readCell({
        id: notebookEntityId,
        meta: "argument",
      });
      notebookInternalManifest = await api.readCell({
        id: notebookEntityId,
        meta: "internal",
      });
    } finally {
      console.log = originalLog;
    }
    const notebookInternal = await resolveInternalManifest(
      notebookInternalManifest,
    );
    const argumentNotes = (notebookArgument as { notes?: unknown } | undefined)
      ?.notes;
    const resolvedArgumentNotes = Array.isArray(argumentNotes)
      ? argumentNotes
      : argumentNotes !== null && typeof argumentNotes === "object" &&
          typeof (argumentNotes as { sync?: unknown }).sync === "function"
      ? await (argumentNotes as { sync: () => Promise<unknown> }).sync()
      : undefined;

    return {
      notebookEntityId,
      viewPieceId,
      // `notes` is a first-class Cell in the notebook argument schema. Newer
      // argument links preserve that wrapper, so debug reads return a handle;
      // older pieces may still materialize the array inline.
      argumentNotesLength: Array.isArray(resolvedArgumentNotes)
        ? resolvedArgumentNotes.length
        : undefined,
      noteCount:
        typeof (notebookInternal as { noteCount?: unknown } | undefined)
            ?.noteCount === "number"
          ? (notebookInternal as { noteCount: number }).noteCount
          : undefined,
      showNewNotePrompt:
        typeof (notebookInternal as { showNewNotePrompt?: unknown } | undefined)
            ?.showNewNotePrompt === "boolean"
          ? (notebookInternal as { showNewNotePrompt: boolean })
            .showNewNotePrompt
          : undefined,
      usedCreateAnotherNote: typeof (
          notebookInternal as { usedCreateAnotherNote?: unknown } | undefined
        )?.usedCreateAnotherNote === "boolean"
        ? (notebookInternal as { usedCreateAnotherNote: boolean })
          .usedCreateAnotherNote
        : undefined,
    };
  }, { args: [knownNotebookId] });
}

// The state notebookSourceStateMatches approves and hands back. Every field
// is a defined, JSON-safe value by construction — the predicate answers only
// when all of them hold — so the answer crosses the page boundary intact.
type NotebookSourceSummary = {
  notebookEntityId: string;
  argumentNotesLength: number;
  noteCount: number;
  showNewNotePrompt: boolean;
  usedCreateAnotherNote: boolean;
};

// Serialized into the page by waitForCondition: read the notebook's argument
// and internal cells and report whether the rapidly created notes have all
// landed — `expectedCount` notes present, the new-note prompt closed, and the
// "create another" flag cleared. Inlines the collection that
// collectNotebookSourceState performs so the wait resolves the instant the
// source state converges rather than on a polling tick. Answers the approved
// summary rather than `true`, so the caller's assertions read the state as it
// was when the condition held — a fresh read after the wait can instead land
// in the ruled interim of a served re-derivation (`noteCount` cleanly
// `undefined`, then re-triggered and healed) and fail a healthy run.
//
// Reads the notebook by the CALLER-CAPTURED id, never through the current
// view: the final "Create" click's speculative run may enact an optimistic
// navigation into the new note that the authoritative run computed no intent
// for — sanctioned (L2 ruled PUNT 2026-08-27), so `view.pieceId` is allowed
// to be a NOTE here, and a view-following read would poll that healthy note
// through notebook accessors until the step's net (the 2026-08-27 r06/r09
// root cause). The id-bound read asserts the same product facts wherever the
// view wandered.
const notebookSourceStateMatches = async (
  _probe: ProbeApi,
  expectedCount: number,
  notebookEntityId: string,
): Promise<NotebookSourceSummary | false> => {
  const api = globalThis.commonfabric as {
    readCell?: (options: {
      id: string;
      path?: string[];
      meta?: "argument" | "internal";
    }) => Promise<unknown>;
  } | undefined;

  if (!notebookEntityId || !api?.readCell) return false;

  const resolveInternalManifest = async (
    manifest: unknown,
  ): Promise<Record<string, unknown>> => {
    const resolved: Record<string, unknown> = {};
    if (!Array.isArray(manifest)) return resolved;
    for (const entry of manifest) {
      if (entry === null || typeof entry !== "object") continue;
      const { partialCause, link } = entry as {
        partialCause?: unknown;
        link?: { sync?: () => Promise<unknown> };
      };
      const key = typeof partialCause === "string"
        ? partialCause
        : JSON.stringify(partialCause) ?? String(partialCause);
      if (link && typeof link.sync === "function") {
        resolved[key] = await link.sync();
      }
    }
    return resolved;
  };

  let notebookArgument: unknown;
  let notebookInternalManifest: unknown;
  const originalLog = console.log;
  try {
    console.log = () => {};
    notebookArgument = await api.readCell({
      id: notebookEntityId,
      meta: "argument",
    });
    notebookInternalManifest = await api.readCell({
      id: notebookEntityId,
      meta: "internal",
    });
  } finally {
    console.log = originalLog;
  }
  const notebookInternal = await resolveInternalManifest(
    notebookInternalManifest,
  );

  const argumentNotes = (notebookArgument as { notes?: unknown } | undefined)
    ?.notes;
  const resolvedArgumentNotes = Array.isArray(argumentNotes)
    ? argumentNotes
    : argumentNotes !== null && typeof argumentNotes === "object" &&
        typeof (argumentNotes as { sync?: unknown }).sync === "function"
    ? await (argumentNotes as { sync: () => Promise<unknown> }).sync()
    : undefined;
  const argumentNotesLength = Array.isArray(resolvedArgumentNotes)
    ? resolvedArgumentNotes.length
    : undefined;
  const internal = notebookInternal as {
    noteCount?: unknown;
    showNewNotePrompt?: unknown;
    usedCreateAnotherNote?: unknown;
  };
  if (
    argumentNotesLength === expectedCount &&
    internal.noteCount === expectedCount &&
    internal.showNewNotePrompt === false &&
    internal.usedCreateAnotherNote === false
  ) {
    return {
      notebookEntityId,
      argumentNotesLength,
      noteCount: internal.noteCount,
      showNewNotePrompt: internal.showNewNotePrompt,
      usedCreateAnotherNote: internal.usedCreateAnotherNote,
    };
  }
  return false;
};

async function collectHomeLoadSummaryFromFreshPage(
  shell: ShellIntegration,
  options: {
    frontendUrl: string;
    spaceName: string;
    expectNoteInList: boolean;
  },
): Promise<unknown> {
  const page = await shell.newPage();
  const startedAt = performance.now();

  try {
    await page.goto(`${options.frontendUrl}/${options.spaceName}`);
    await page.applyConsoleFormatter();
    await waitForHomePageReady(page, {
      spaceName: options.spaceName,
      expectNoteInList: options.expectNoteInList,
    });

    const homeLoadSummary = await collectHomeLoadSummary(page);
    if (!homeLoadSummary || typeof homeLoadSummary !== "object") {
      return homeLoadSummary;
    }
    return {
      loadDurationMs: Number((performance.now() - startedAt).toFixed(3)),
      ...(homeLoadSummary as Record<string, unknown>),
    };
  } finally {
    await page.close();
  }
}

async function collectActionRunSummary(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const rt = globalThis.commonfabric?.rt;
    if (!rt?.getActionRunTrace || !rt?.idle) return null;
    await rt.idle();
    const trace = await rt.getActionRunTrace() as BrowserActionRunTraceEntry[];
    const toTargetKey = (target: BrowserActionRunTraceAddress) =>
      `${target.space}/${target.entityId}/${target.path.join("/")}`;
    const getInstanceTargets = (entry: BrowserActionRunTraceEntry) => {
      const declaredTargets = (entry.declaredWrites ?? []).map(toTargetKey);
      if (declaredTargets.length > 0) return [...new Set(declaredTargets)];
      const actualTargets = (entry.actualWrites ?? []).map(toTargetKey);
      if (actualTargets.length > 0) return [...new Set(actualTargets)];
      return ["(no writes)"];
    };

    const byAction = new Map<string, {
      actionType: "effect" | "computation";
      count: number;
      totalDurationMs: number;
      maxDurationMs: number;
      parentActionIds: Set<string>;
    }>();
    const byActionInstance = new Map<string, {
      actionId: string;
      actionType: "effect" | "computation";
      instanceTargets: string[];
      count: number;
      totalDurationMs: number;
      maxDurationMs: number;
      parentActionIds: Set<string>;
    }>();

    for (const entry of trace) {
      const row = byAction.get(entry.actionId) ?? {
        actionType: entry.actionType,
        count: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        parentActionIds: new Set<string>(),
      };
      row.count += 1;
      row.totalDurationMs += entry.durationMs;
      row.maxDurationMs = Math.max(row.maxDurationMs, entry.durationMs);
      if (entry.parentActionId) {
        row.parentActionIds.add(entry.parentActionId);
      }
      byAction.set(entry.actionId, row);

      const instanceTargets = getInstanceTargets(entry);
      const instanceKey = `${entry.actionId}::${instanceTargets.join(" | ")}`;
      const instanceRow = byActionInstance.get(instanceKey) ?? {
        actionId: entry.actionId,
        actionType: entry.actionType,
        instanceTargets,
        count: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        parentActionIds: new Set<string>(),
      };
      instanceRow.count += 1;
      instanceRow.totalDurationMs += entry.durationMs;
      instanceRow.maxDurationMs = Math.max(
        instanceRow.maxDurationMs,
        entry.durationMs,
      );
      if (entry.parentActionId) {
        instanceRow.parentActionIds.add(entry.parentActionId);
      }
      byActionInstance.set(instanceKey, instanceRow);
    }

    const actions = [...byAction.entries()]
      .map(([actionId, row]) => ({
        actionId,
        actionType: row.actionType,
        count: row.count,
        totalDurationMs: Number(row.totalDurationMs.toFixed(3)),
        averageDurationMs: Number((row.totalDurationMs / row.count).toFixed(3)),
        maxDurationMs: Number(row.maxDurationMs.toFixed(3)),
        parentActionIds: [...row.parentActionIds].sort(),
      }))
      .sort((a, b) =>
        b.count - a.count ||
        b.totalDurationMs - a.totalDurationMs ||
        a.actionId.localeCompare(b.actionId)
      );
    const actionInstances = [...byActionInstance.values()]
      .map((row) => ({
        actionId: row.actionId,
        actionType: row.actionType,
        instanceTargets: row.instanceTargets,
        count: row.count,
        totalDurationMs: Number(row.totalDurationMs.toFixed(3)),
        averageDurationMs: Number((row.totalDurationMs / row.count).toFixed(3)),
        maxDurationMs: Number(row.maxDurationMs.toFixed(3)),
        parentActionIds: [...row.parentActionIds].sort(),
      }))
      .sort((a, b) =>
        b.count - a.count ||
        b.totalDurationMs - a.totalDurationMs ||
        a.actionId.localeCompare(b.actionId) ||
        a.instanceTargets.join(" | ").localeCompare(
          b.instanceTargets.join(" | "),
        )
      );

    return {
      traceLength: trace.length,
      uniqueActions: actions.length,
      uniqueActionInstances: actionInstances.length,
      effectsRun: trace.filter((entry) => entry.actionType === "effect").length,
      computationsRun: trace.filter((entry) =>
        entry.actionType === "computation"
      )
        .length,
      actions,
      actionInstances,
    };
  });
}

async function collectNotebookCreateTraceSummary(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric as {
      rt?: {
        idle?: () => Promise<void>;
        getActionRunTrace?: () => Promise<BrowserActionRunTraceEntry[]>;
        getTriggerTrace?: () => Promise<BrowserTriggerTraceEntry[]>;
        getGraphSnapshot?: () => Promise<{ nodes?: unknown[] }>;
      };
      readCell?: (options: {
        id: string;
        path?: string[];
        meta?: "argument" | "internal";
      }) => Promise<unknown>;
      __eventInvocationTrace?: unknown[];
    } | undefined;
    const rt = api?.rt;
    await rt?.idle?.();
    const appState = (globalThis as any).app?.serialize?.();
    const resultPieceId = appState?.view &&
        typeof appState.view === "object" &&
        "pieceId" in appState.view &&
        typeof appState.view.pieceId === "string"
      ? appState.view.pieceId
      : undefined;

    const markers = (api?.__eventInvocationTrace ?? []) as Array<{
      type?: string;
      handlerId?: string;
      handlerInfo?: { patternName?: string; moduleName?: string };
      writes?: string[];
      writeCount?: number;
      changedWriteCount?: number;
      error?: string;
    }>;
    const eventInvocations = markers
      .filter((marker) => marker.type === "scheduler.invocation")
      .map((marker) => ({
        handlerId: marker.handlerId,
        patternName: marker.handlerInfo?.patternName,
        moduleName: marker.handlerInfo?.moduleName,
      }));
    const notebookInvocations = eventInvocations.filter((marker) =>
      marker.handlerId?.includes("/api/patterns/notes/notebook.tsx") ||
      marker.moduleName?.includes("notebook")
    );
    const eventCommits = markers
      .filter((marker) => marker.type === "scheduler.event.commit")
      .map((marker) => ({
        handlerId: marker.handlerId,
        patternName: marker.handlerInfo?.patternName,
        moduleName: marker.handlerInfo?.moduleName,
        writeCount: marker.writeCount,
        changedWriteCount: marker.changedWriteCount,
        writes: marker.writes ?? [],
        error: marker.error,
      }));
    const notebookCommits = eventCommits.filter((marker) =>
      marker.handlerId?.includes("/api/patterns/notes/notebook.tsx") ||
      marker.moduleName?.includes("notebook")
    );
    const finalNotebookCommit = notebookCommits.at(-1);
    const notebookNotesWrite = finalNotebookCommit?.writes?.find((write) =>
      write.includes("/value/argument/notes")
    );
    const notebookEntityId = notebookNotesWrite?.match(
      /\/(of:[^/]+)\/value\/argument\/notes/,
    )?.[1];
    const resolveInternalManifest = async (
      manifest: unknown,
    ): Promise<Record<string, unknown>> => {
      const resolved: Record<string, unknown> = {};
      if (!Array.isArray(manifest)) return resolved;

      for (const entry of manifest) {
        if (entry === null || typeof entry !== "object") continue;
        const { partialCause, link } = entry as {
          partialCause?: unknown;
          link?: { sync?: () => Promise<unknown> };
        };
        const key = typeof partialCause === "string"
          ? partialCause
          : JSON.stringify(partialCause) ?? String(partialCause);
        if (link && typeof link.sync === "function") {
          resolved[key] = await link.sync();
        }
      }
      return resolved;
    };

    let notebookArgument: unknown;
    let notebookInternalManifest: unknown;
    if (notebookEntityId && api?.readCell) {
      notebookArgument = await api.readCell({
        id: notebookEntityId,
        meta: "argument",
      });
      notebookInternalManifest = await api.readCell({
        id: notebookEntityId,
        meta: "internal",
      });
    }
    const notebookInternal = await resolveInternalManifest(
      notebookInternalManifest,
    );
    const triggerTrace = await rt?.getTriggerTrace?.() ?? [];
    const notebookNotesTriggers = triggerTrace
      .filter((entry) =>
        entry.entityId === notebookEntityId &&
        entry.path.slice(0, 3).join("/") === "value/argument/notes"
      )
      .map((entry) => ({
        changeIndex: entry.changeIndex,
        path: entry.path,
        matchedActionCount: entry.matchedActionCount,
        triggered: entry.triggered.map((triggered) => ({
          actionId: triggered.actionId,
          actionType: triggered.actionType,
          decision: triggered.decision,
          pendingBefore: triggered.pendingBefore,
          pendingAfter: triggered.pendingAfter,
          dirtyBefore: triggered.dirtyBefore,
          dirtyAfter: triggered.dirtyAfter,
        })),
      }));
    const notebookNotesTriggersByPath = triggerTrace
      .filter((entry) =>
        entry.path.slice(0, 3).join("/") === "value/argument/notes"
      )
      .map((entry) => ({
        entityId: entry.entityId,
        path: entry.path,
        matchedActionCount: entry.matchedActionCount,
        triggered: entry.triggered
          .filter((triggered) =>
            triggered.actionId.includes("/api/patterns/notes/notebook.tsx")
          )
          .map((triggered) => ({
            actionId: triggered.actionId,
            actionType: triggered.actionType,
            decision: triggered.decision,
            pendingBefore: triggered.pendingBefore,
            pendingAfter: triggered.pendingAfter,
            dirtyBefore: triggered.dirtyBefore,
            dirtyAfter: triggered.dirtyAfter,
          })),
      }));
    const finalNotebookNotesTriggers = notebookNotesTriggers.slice(-2);
    const graph = await rt?.getGraphSnapshot?.();
    const notebookCoreNodes = (graph?.nodes ?? [])
      .filter((node: any) =>
        typeof node.id === "string" &&
        node.id.includes("/api/patterns/notes/notebook.tsx") &&
        (
          node.id.includes(":531:34") ||
          node.id.includes(":532:33") ||
          (node.writes ?? []).some((write: string) =>
            write.includes("/value/internal/noteCount") ||
            write.includes("/value/internal/$NAME")
          ) ||
          (
            notebookEntityId !== undefined &&
            (node.reads ?? []).some((read: string) =>
              read.includes(notebookEntityId) &&
              read.includes("/value/argument/notes")
            )
          )
        )
      )
      .map((node: any) => ({
        id: node.id,
        isPending: node.isPending,
        isDirty: node.isDirty,
        isDemanded: node.isDemanded,
        isDebouncedWaiting: node.isDebouncedWaiting,
        readCount: (node.reads ?? []).length,
        noteReads: (node.reads ?? []).filter((read: string) =>
          notebookEntityId === undefined ||
          read.includes(notebookEntityId) ||
          read.includes("/value/internal/noteCount") ||
          read.includes("/value/internal/$NAME")
        ).slice(0, 8),
        shallowReadCount: (node.shallowReads ?? []).length,
        noteShallowReads: (node.shallowReads ?? []).filter((read: string) =>
          notebookEntityId === undefined ||
          read.includes(notebookEntityId) ||
          read.includes("/value/internal/noteCount") ||
          read.includes("/value/internal/$NAME")
        ).slice(0, 8),
        writeCount: (node.writes ?? []).length,
        relevantWrites: (node.writes ?? []).filter((write: string) =>
          notebookEntityId === undefined ||
          write.includes(notebookEntityId) ||
          write.includes("/value/internal/noteCount") ||
          write.includes("/value/internal/$NAME")
        ).slice(0, 8),
      }));

    const trace = await rt?.getActionRunTrace?.() ?? [];
    const notebookActions = trace
      .filter((entry) =>
        entry.actionId.includes("/api/patterns/notes/notebook.tsx")
      )
      .map((entry) => ({
        actionId: entry.actionId,
        actionType: entry.actionType,
        actualWrites: entry.actualWrites.map((write) =>
          `${write.space}/${write.entityId}/${write.path.join("/")}`
        ),
      }));

    const byNotebookHandler = new Map<string, number>();
    for (const marker of notebookInvocations) {
      const id = marker.handlerId ?? "unknown";
      byNotebookHandler.set(id, (byNotebookHandler.get(id) ?? 0) + 1);
    }
    const byNotebookAction = new Map<string, number>();
    for (const entry of notebookActions) {
      byNotebookAction.set(
        entry.actionId,
        (byNotebookAction.get(entry.actionId) ?? 0) + 1,
      );
    }

    return {
      eventInvocationCount: eventInvocations.length,
      notebookInvocationCount: notebookInvocations.length,
      notebookInvocationsByHandler: [...byNotebookHandler.entries()].map((
        [handlerId, count],
      ) => ({ handlerId, count })),
      notebookCommits: notebookCommits.map((commit) => ({
        handlerId: commit.handlerId,
        writeCount: commit.writeCount,
        changedWriteCount: commit.changedWriteCount,
        keyWrites: commit.writes.filter((write) =>
          write.includes("/value/argument/notes") ||
          write.includes("/value/internal/showNewNotePrompt") ||
          write.includes("/value/internal/usedCreateAnotherNote")
        ),
        error: commit.error,
      })),
      notebookEntityId,
      resultPieceId,
      notebookArgumentNotesLength: Array.isArray(
          (notebookArgument as { notes?: unknown[] } | undefined)
            ?.notes,
        )
        ? (notebookArgument as { notes: unknown[] }).notes.length
        : undefined,
      notebookInternalPromptState: {
        noteCount: (notebookInternal as { noteCount?: unknown } | undefined)
          ?.noteCount,
        showNewNotePrompt:
          (notebookInternal as { showNewNotePrompt?: unknown } | undefined)
            ?.showNewNotePrompt,
        usedCreateAnotherNote:
          (notebookInternal as { usedCreateAnotherNote?: unknown } | undefined)
            ?.usedCreateAnotherNote,
      },
      finalNotebookNotesTriggers: finalNotebookNotesTriggers.map((entry) => ({
        changeIndex: entry.changeIndex,
        path: entry.path,
        matchedActionCount: entry.matchedActionCount,
        triggeredCount: entry.triggered.length,
        triggered: entry.triggered.slice(0, 12).map((triggered) => ({
          actionId: triggered.actionId,
          actionType: triggered.actionType,
          decision: triggered.decision,
          pendingBefore: triggered.pendingBefore,
          pendingAfter: triggered.pendingAfter,
          dirtyBefore: triggered.dirtyBefore,
          dirtyAfter: triggered.dirtyAfter,
        })),
      })),
      notebookNotesTriggersByPath: notebookNotesTriggersByPath.slice(-3),
      notebookCoreNodes,
      notebookActionCount: notebookActions.length,
      notebookActionsById: [...byNotebookAction.entries()].map((
        [actionId, count],
      ) => ({ actionId, count })),
      notebookActionTail: notebookActions
        .filter((entry) =>
          entry.actionId.includes(":531:34") ||
          entry.actionId.includes(":532:33") ||
          entry.actualWrites.some((write) =>
            write.includes("/value/internal/noteCount") ||
            write.includes("/value/internal/$NAME")
          )
        )
        .slice(-20),
    };
  });
}

function compareActionRunSeries(series: unknown[]): unknown {
  const notes = series as Array<{
    noteIndex: number;
    traceLength: number;
    uniqueActions: number;
    uniqueActionInstances: number;
    effectsRun: number;
    computationsRun: number;
    actions: Array<{
      actionId: string;
      actionType: "effect" | "computation";
      count: number;
      totalDurationMs: number;
      averageDurationMs: number;
      maxDurationMs: number;
      parentActionIds: string[];
    }>;
    actionInstances: Array<{
      actionId: string;
      actionType: "effect" | "computation";
      instanceTargets: string[];
      count: number;
      totalDurationMs: number;
      averageDurationMs: number;
      maxDurationMs: number;
      parentActionIds: string[];
    }>;
  }>;

  const byAction = new Map<string, {
    actionType: "effect" | "computation";
    counts: Record<number, number>;
    totalDurationMs: Record<number, number>;
  }>();
  const byActionInstance = new Map<string, {
    actionId: string;
    actionType: "effect" | "computation";
    instanceTargets: string[];
    counts: Record<number, number>;
    totalDurationMs: Record<number, number>;
  }>();

  for (const note of notes) {
    for (const action of note.actions) {
      const row = byAction.get(action.actionId) ?? {
        actionType: action.actionType,
        counts: {},
        totalDurationMs: {},
      };
      row.counts[note.noteIndex] = action.count;
      row.totalDurationMs[note.noteIndex] = action.totalDurationMs;
      byAction.set(action.actionId, row);
    }
    for (const actionInstance of note.actionInstances) {
      const instanceKey = `${actionInstance.actionId}::${
        actionInstance.instanceTargets.join(" | ")
      }`;
      const row = byActionInstance.get(instanceKey) ?? {
        actionId: actionInstance.actionId,
        actionType: actionInstance.actionType,
        instanceTargets: actionInstance.instanceTargets,
        counts: {},
        totalDurationMs: {},
      };
      row.counts[note.noteIndex] = actionInstance.count;
      row.totalDurationMs[note.noteIndex] = actionInstance.totalDurationMs;
      byActionInstance.set(instanceKey, row);
    }
  }

  const noteIndices = notes.map((note) => note.noteIndex);
  const rows = [...byAction.entries()].map(([actionId, row]) => {
    const counts = noteIndices.map((noteIndex) => row.counts[noteIndex] ?? 0);
    const durations = noteIndices.map((noteIndex) =>
      row.totalDurationMs[noteIndex] ?? 0
    );
    return {
      actionId,
      actionType: row.actionType,
      counts,
      durationsMs: durations.map((value) => Number(value.toFixed(3))),
      deltaLastVsFirst: counts[counts.length - 1]! - counts[0]!,
    };
  }).sort((a, b) =>
    b.deltaLastVsFirst - a.deltaLastVsFirst ||
    (b.counts[b.counts.length - 1] ?? 0) -
      (a.counts[a.counts.length - 1] ?? 0) ||
    a.actionId.localeCompare(b.actionId)
  );
  const instanceRows = [...byActionInstance.values()].map((row) => {
    const counts = noteIndices.map((noteIndex) => row.counts[noteIndex] ?? 0);
    const durations = noteIndices.map((noteIndex) =>
      row.totalDurationMs[noteIndex] ?? 0
    );
    return {
      actionId: row.actionId,
      actionType: row.actionType,
      instanceTargets: row.instanceTargets,
      counts,
      durationsMs: durations.map((value) => Number(value.toFixed(3))),
      deltaLastVsFirst: counts[counts.length - 1]! - counts[0]!,
    };
  }).sort((a, b) =>
    b.deltaLastVsFirst - a.deltaLastVsFirst ||
    (b.counts[b.counts.length - 1] ?? 0) -
      (a.counts[a.counts.length - 1] ?? 0) ||
    a.actionId.localeCompare(b.actionId) ||
    a.instanceTargets.join(" | ").localeCompare(b.instanceTargets.join(" | "))
  );

  return {
    notes: notes.map((note) => ({
      noteIndex: note.noteIndex,
      traceLength: note.traceLength,
      uniqueActions: note.uniqueActions,
      uniqueActionInstances: note.uniqueActionInstances,
      effectsRun: note.effectsRun,
      computationsRun: note.computationsRun,
    })),
    increasedOnLaterRuns: rows.filter((row) => row.deltaLastVsFirst > 0).slice(
      0,
      25,
    ),
    unchangedAcrossRuns: rows.filter((row) =>
      row.counts.every((count) => count === row.counts[0])
    ).slice(0, 25),
    onlyInLaterRuns: rows.filter((row) =>
      row.counts[0] === 0 &&
      row.counts.slice(1).some((count) => count > 0)
    ).slice(0, 25),
    noteActionInstancesIncreasedOnLaterRuns: instanceRows.filter((row) =>
      row.actionId.includes("/notes/note.tsx") && row.deltaLastVsFirst > 0
    ).slice(0, 25),
    noteActionInstancesUnchangedAcrossRuns: instanceRows.filter((row) =>
      row.actionId.includes("/notes/note.tsx") &&
      row.counts.every((count) => count === row.counts[0])
    ).slice(0, 25),
  };
}

function summarizeNoteCreateTimings(
  series: NoteCreateTimingEntry[],
): unknown {
  const summarizeValues = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (value: number) =>
      sorted[
        Math.min(
          sorted.length - 1,
          Math.max(0, Math.ceil(sorted.length * value) - 1),
        )
      ] ?? 0;

    const sum = sorted.reduce((total, current) => total + current, 0);
    return {
      minMs: Number((sorted[0] ?? 0).toFixed(3)),
      avgMs: Number((sum / Math.max(sorted.length, 1)).toFixed(3)),
      p50Ms: Number(percentile(0.5).toFixed(3)),
      p95Ms: Number(percentile(0.95).toFixed(3)),
      maxMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
    };
  };

  return {
    count: series.length,
    totals: summarizeValues(series.map((entry) => entry.totalMs)),
    createToView: summarizeValues(series.map((entry) => entry.createToViewMs)),
    returnToHome: summarizeValues(series.map((entry) => entry.returnToHomeMs)),
    notes: series,
  };
}

function compareNoteCreateProfiles(
  series: NoteCreateProfileEntry[],
): unknown {
  const noteIndices = series.map((entry) => entry.noteIndex);
  const byTimingKey = new Map<string, {
    logger: string;
    key: string;
    totalTimes: Record<number, number>;
    averages: Record<number, number>;
    counts: Record<number, number>;
    p95s: Record<number, number>;
  }>();

  for (const entry of series) {
    for (const row of entry.focusTiming) {
      const key = `${row.logger}:${row.key}`;
      const existing = byTimingKey.get(key) ?? {
        logger: row.logger,
        key: row.key,
        totalTimes: {},
        averages: {},
        counts: {},
        p95s: {},
      };
      existing.totalTimes[entry.noteIndex] = row.totalTime;
      existing.averages[entry.noteIndex] = row.average;
      existing.counts[entry.noteIndex] = row.count;
      existing.p95s[entry.noteIndex] = row.p95;
      byTimingKey.set(key, existing);
    }
  }

  const focusTimingGrowth = [...byTimingKey.values()]
    .map((row) => {
      const totals = noteIndices.map((noteIndex) =>
        row.totalTimes[noteIndex] ?? 0
      );
      const averages = noteIndices.map((noteIndex) =>
        row.averages[noteIndex] ?? 0
      );
      const counts = noteIndices.map((noteIndex) => row.counts[noteIndex] ?? 0);
      const p95s = noteIndices.map((noteIndex) => row.p95s[noteIndex] ?? 0);
      return {
        logger: row.logger,
        key: row.key,
        totalTimes: totals,
        averages,
        counts,
        p95s,
        deltaLastVsFirst: Number(
          (
            (totals[totals.length - 1] ?? 0) -
            (totals[0] ?? 0)
          ).toFixed(3),
        ),
      };
    })
    .sort((a, b) =>
      b.deltaLastVsFirst - a.deltaLastVsFirst ||
      (b.totalTimes[b.totalTimes.length - 1] ?? 0) -
        (a.totalTimes[a.totalTimes.length - 1] ?? 0) ||
      `${a.logger}:${a.key}`.localeCompare(`${b.logger}:${b.key}`)
    );

  const lastEntry = series[series.length - 1];

  return {
    notes: series.map((entry) => ({
      noteIndex: entry.noteIndex,
      settleExecuteCalls: entry.settle.executeCalls,
      settleTotalDurationMs: entry.settle.totalDurationMs,
      settleMaxDurationMs: entry.settle.maxDurationMs,
      settleMaxIterations: entry.settle.maxIterations,
    })),
    focusTimingGrowth,
    missingRequiredTimingKeys: series.map((entry) => ({
      noteIndex: entry.noteIndex,
      keys: entry.missingRequiredTimingKeys,
    })),
    focusTimingAtMaxNoteCount: lastEntry?.focusTiming ?? [],
    topTimingAtMaxNoteCount: lastEntry?.topTiming ?? [],
    settleAtMaxNoteCount: lastEntry?.settle ?? null,
  };
}

async function collectHomeLoadSummary(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const rt = globalThis.commonfabric?.rt;
    if (!rt?.getLoggerCounts || !rt?.getGraphSnapshot || !rt?.idle) return null;
    await rt.idle();

    const { timing } = await rt.getLoggerCounts();
    const graph = await rt.getGraphSnapshot();

    type TimingRow = {
      count: number;
      totalTime: number;
      average: number;
      p50: number;
      p95: number;
      max: number;
    };

    const schedulerTiming = (timing["scheduler"] ?? {}) as Record<
      string,
      TimingRow
    >;
    const schedulerRunCount = schedulerTiming["scheduler/run"]?.count ?? 0;
    const schedulerRunActionCount =
      schedulerTiming["scheduler/run/action"]?.count ?? 0;
    const topSchedulerTiming = Object.entries(schedulerTiming)
      .sort((a, b) => (b[1].totalTime ?? 0) - (a[1].totalTime ?? 0))
      .slice(0, 16)
      .map(([key, value]) => ({
        key,
        count: value.count ?? 0,
        totalTime: Number((value.totalTime ?? 0).toFixed(3)),
        average: Number((value.average ?? 0).toFixed(3)),
        p50: Number((value.p50 ?? 0).toFixed(3)),
        p95: Number((value.p95 ?? 0).toFixed(3)),
        max: Number((value.max ?? 0).toFixed(3)),
      }));

    type GraphNode = {
      id: string;
      type: "effect" | "computation" | "input" | "inactive";
      stats?: {
        runCount: number;
        totalTime: number;
        averageTime: number;
        lastRunTime: number;
      };
    };

    const typedNodes = graph.nodes as GraphNode[];
    const actionNodes = typedNodes.filter((node) =>
      (node.type === "effect" || node.type === "computation") && node.stats
    );
    const byActionId = new Map<string, {
      actionId: string;
      actionType: "effect" | "computation";
      runCount: number;
      totalTime: number;
      averageTime: number;
    }>();

    for (const node of actionNodes) {
      const stats = node.stats;
      if (!stats) continue;
      const actionType = node.type === "effect" ? "effect" : "computation";
      const existing = byActionId.get(node.id);
      if (!existing || stats.runCount > existing.runCount) {
        byActionId.set(node.id, {
          actionId: node.id,
          actionType,
          runCount: stats.runCount,
          totalTime: stats.totalTime,
          averageTime: stats.averageTime,
        });
      }
    }

    const actionRows = [...byActionId.values()];
    const computationRows = actionRows.filter((row) =>
      row.actionType === "computation"
    );
    const effectRows = actionRows.filter((row) => row.actionType === "effect");

    const topActions = actionRows
      .sort((a, b) =>
        b.runCount - a.runCount ||
        b.totalTime - a.totalTime ||
        a.actionId.localeCompare(b.actionId)
      )
      .slice(0, 20)
      .map((row) => ({
        actionId: row.actionId,
        actionType: row.actionType,
        runCount: row.runCount,
        totalTime: Number(row.totalTime.toFixed(3)),
        averageTime: Number(row.averageTime.toFixed(3)),
      }));

    return {
      graph: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        computations: typedNodes.filter((node) => node.type === "computation")
          .length,
        effects: typedNodes.filter((node) => node.type === "effect").length,
        inputs: typedNodes.filter((node) => node.type === "input").length,
        inactive: typedNodes.filter((node) => node.type === "inactive").length,
        actionsWithStats: actionNodes.length,
        actionRuns: schedulerRunCount,
        actionRunsThroughActionBody: schedulerRunActionCount,
        actionRunsFromStats: actionRows.reduce(
          (sum, row) => sum + row.runCount,
          0,
        ),
        actionTotalTimeFromStats: Number(
          actionRows.reduce((sum, row) => sum + row.totalTime, 0).toFixed(3),
        ),
        computationRunsFromStats: computationRows.reduce(
          (sum, row) => sum + row.runCount,
          0,
        ),
        computationTotalTimeFromStats: Number(
          computationRows
            .reduce((sum, row) => sum + row.totalTime, 0)
            .toFixed(3),
        ),
        effectRunsFromStats: effectRows.reduce(
          (sum, row) => sum + row.runCount,
          0,
        ),
        effectTotalTimeFromStats: Number(
          effectRows.reduce((sum, row) => sum + row.totalTime, 0).toFixed(3),
        ),
      },
      topSchedulerTiming,
      topActions,
    };
  });
}

async function collectNoteCreateProfile(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api?.getLoggerCounts || !api?.getSettleStatsHistory || !api?.idle) {
      return null;
    }

    await api.idle();

    type TimingRow = {
      count: number;
      totalTime: number;
      average: number;
      p50: number;
      p95: number;
      max: number;
    };

    const { timing } = await api.getLoggerCounts();
    // These phases are the stable scheduler-v2 spine and must exist after a
    // note-create run. Keep them separate from workload-dependent event and
    // builtin phases so deleted/misspelled scheduler keys are reported rather
    // than silently disappearing from the profile.
    const requiredSchedulerKeys = [
      ["scheduler", "scheduler/execute"],
      ["scheduler", "scheduler/execute/settle"],
      ["scheduler", "scheduler/run"],
      ["scheduler", "scheduler/run/action"],
      ["scheduler", "scheduler/run/commit"],
      ["scheduler", "scheduler/run/resubscribe"],
    ] as const;
    const focusKeys = [
      ...requiredSchedulerKeys,
      ["scheduler", "scheduler/execute/event"],
      ["scheduler", "scheduler/execute/event/presyncInputs"],
      ["scheduler", "scheduler/execute/event/pullPopulateDependencies"],
      ["scheduler", "scheduler/execute/event/pullTxToReactivityLog"],
      ["scheduler", "scheduler/execute/event/pullDepCommitStart"],
      ["scheduler", "scheduler/execute/event/pullCollectInvalidUpstream"],
      ["scheduler", "scheduler/execute/event/pullScheduleInvalidUpstream"],
      ["scheduler", "scheduler/execute/event/handlerAction"],
      ["traverse", "traverse"],
      ["runner", "stream/readInputs"],
      ["runner", "stream/invokeJavaScriptImplementation"],
      ["runner", "stream/postRun"],
      ["runner", "action/readInputs"],
      ["runner", "action/invokeJavaScriptImplementation"],
      ["runner", "action/postRun"],
      ["runner", "raw/run/wish"],
      ["runner.wish-flow", "wish/phase/action-total"],
      ["runner.wish-flow", "wish/phase/input-get"],
      ["runner.wish-flow", "wish/phase/parse-target"],
      ["runner.wish-flow", "wish/phase/resolve-base"],
      ["runner.wish-flow", "wish/phase/resolve-paths"],
      ["runner.wish-flow", "wish/phase/dedupe-results"],
      ["runner.wish-flow", "wish/phase/candidates-cell"],
      ["runner.wish-flow", "wish/phase/result-ui-get"],
      ["runner.wish-flow", "wish/phase/send-fast"],
      ["runner.wish-flow", "wish/phase/send-pending"],
      ["runner.wish-flow", "wish/phase/send-error"],
      ["runner.wish-flow", "wish/phase/favorites-cell"],
      ["runner.wish-flow", "wish/phase/favorites-get"],
      ["runner.wish-flow", "wish/phase/favorites-filter"],
      ["runner.wish-flow", "wish/phase/favorites-result-map"],
      ["runner.wish-flow", "wish/phase/mentionable-cell"],
      ["runner.wish-flow", "wish/phase/mentionable-get"],
      ["runner.wish-flow", "wish/phase/mentionable-filter"],
      ["runner.wish-flow", "wish/phase/mentionable-piece-get"],
      ["runner.wish-flow", "wish/phase/mentionable-name-check"],
      ["runner.wish-flow", "wish/phase/mentionable-schema"],
      ["runner.wish-flow", "wish/phase/mentionable-schema-stringify"],
      ["runner.wish-flow", "wish/phase/mentionable-tag-match"],
      ["runner.wish-flow", "wish/phase/mentionable-result-map"],
      ["runner", "raw/run/map"],
      ["runner", "raw/run/ifElse"],
      ["runner", "raw/run/when"],
    ] as const;

    const missingRequiredTimingKeys = requiredSchedulerKeys
      .filter(([loggerName, key]) => !(timing[loggerName] ?? {})[key])
      .map(([loggerName, key]) => `${loggerName}:${key}`);

    const focusTiming = focusKeys
      .map(([loggerName, key]) => {
        const row = (timing[loggerName] ?? {})[key] as TimingRow | undefined;
        if (!row) return null;
        return {
          logger: loggerName,
          key,
          count: row.count ?? 0,
          totalTime: Number((row.totalTime ?? 0).toFixed(3)),
          average: Number((row.average ?? 0).toFixed(3)),
          p50: Number((row.p50 ?? 0).toFixed(3)),
          p95: Number((row.p95 ?? 0).toFixed(3)),
          max: Number((row.max ?? 0).toFixed(3)),
        };
      })
      .filter((row) => row !== null);

    const topTiming = Object.entries(timing)
      .filter(([loggerName]) =>
        [
          "scheduler",
          "traverse",
          "storage.cache",
          "worker-reconciler",
          "runner",
          "stream",
          "raw",
          "runner.wish-flow",
        ].includes(loggerName)
      )
      .flatMap(([loggerName, rows]) =>
        Object.entries(rows as Record<string, TimingRow>).map(([key, row]) => ({
          logger: loggerName,
          key,
          count: row.count ?? 0,
          totalTime: Number((row.totalTime ?? 0).toFixed(3)),
          average: Number((row.average ?? 0).toFixed(3)),
          p50: Number((row.p50 ?? 0).toFixed(3)),
          p95: Number((row.p95 ?? 0).toFixed(3)),
          max: Number((row.max ?? 0).toFixed(3)),
        }))
      )
      .sort((a, b) =>
        b.totalTime - a.totalTime ||
        b.count - a.count ||
        `${a.logger}:${a.key}`.localeCompare(`${b.logger}:${b.key}`)
      )
      .slice(0, 20);

    type SettleHistoryEntry = {
      recordedAt: number;
      stats: {
        iterations: Array<{
          workSetSize: number;
          orderSize: number;
          actionsRun: number;
          durationMs: number;
        }>;
        totalDurationMs: number;
      };
    };

    const settleHistory = await api
      .getSettleStatsHistory() as readonly SettleHistoryEntry[];
    const recentHistory = settleHistory.slice(-8);
    const settle = {
      executeCalls: settleHistory.length,
      totalDurationMs: Number(
        recentHistory.reduce(
          (sum, entry) => sum + entry.stats.totalDurationMs,
          0,
        )
          .toFixed(3),
      ),
      maxDurationMs: Number(
        Math.max(
          0,
          ...recentHistory.map((entry) => entry.stats.totalDurationMs),
        ).toFixed(3),
      ),
      latestDurationMs: Number(
        (recentHistory[recentHistory.length - 1]?.stats.totalDurationMs ?? 0)
          .toFixed(3),
      ),
      maxIterations: Math.max(
        0,
        ...recentHistory.map((entry) => entry.stats.iterations.length),
      ),
      latestIterations:
        recentHistory[recentHistory.length - 1]?.stats.iterations.length ?? 0,
      recent: recentHistory.map((entry) => ({
        totalDurationMs: Number(entry.stats.totalDurationMs.toFixed(3)),
        iterations: entry.stats.iterations.length,
        actionsRun: entry.stats.iterations.reduce(
          (sum, iteration) => sum + iteration.actionsRun,
          0,
        ),
      })),
    };

    return {
      focusTiming,
      topTiming,
      settle,
      missingRequiredTimingKeys,
    };
  });
}

function compareHomeLoadSeries(series: unknown[]): unknown {
  const loads = series as Array<{
    noteCount: number;
    loadDurationMs: number;
    graph: {
      nodes: number;
      edges: number;
      computations: number;
      effects: number;
      inputs: number;
      inactive: number;
    };
    topSchedulerTiming: Array<{
      key: string;
      count: number;
      totalTime: number;
      average: number;
      p50: number;
      p95: number;
      max: number;
    }>;
    topActions: Array<{
      actionId: string;
      actionType: "effect" | "computation";
      runCount: number;
      totalTime: number;
      averageTime: number;
    }>;
  }>;

  const noteCounts = loads.map((load) => load.noteCount);
  const byTimingKey = new Map<string, {
    totals: Record<number, number>;
    counts: Record<number, number>;
  }>();
  const byActionId = new Map<string, {
    actionType: "effect" | "computation";
    runCounts: Record<number, number>;
    totalTimes: Record<number, number>;
  }>();

  for (const load of loads) {
    for (const row of load.topSchedulerTiming) {
      const existing = byTimingKey.get(row.key) ?? {
        totals: {},
        counts: {},
      };
      existing.totals[load.noteCount] = row.totalTime;
      existing.counts[load.noteCount] = row.count;
      byTimingKey.set(row.key, existing);
    }

    for (const row of load.topActions) {
      const existing = byActionId.get(row.actionId) ?? {
        actionType: row.actionType,
        runCounts: {},
        totalTimes: {},
      };
      existing.runCounts[load.noteCount] = row.runCount;
      existing.totalTimes[load.noteCount] = row.totalTime;
      byActionId.set(row.actionId, existing);
    }
  }

  const timingGrowth = [...byTimingKey.entries()]
    .map(([key, row]) => {
      const totals = noteCounts.map((noteCount) => row.totals[noteCount] ?? 0);
      const counts = noteCounts.map((noteCount) => row.counts[noteCount] ?? 0);
      return {
        key,
        totals,
        counts,
        deltaLastVsFirst: totals[totals.length - 1]! - totals[0]!,
      };
    })
    .sort((a, b) =>
      b.deltaLastVsFirst - a.deltaLastVsFirst ||
      (b.totals[b.totals.length - 1] ?? 0) -
        (a.totals[a.totals.length - 1] ?? 0) ||
      a.key.localeCompare(b.key)
    );

  const actionGrowth = [...byActionId.entries()]
    .map(([actionId, row]) => {
      const runCounts = noteCounts.map((noteCount) =>
        row.runCounts[noteCount] ?? 0
      );
      const totalTimes = noteCounts.map((noteCount) =>
        row.totalTimes[noteCount] ?? 0
      );
      return {
        actionId,
        actionType: row.actionType,
        runCounts,
        totalTimes,
        deltaLastVsFirst: runCounts[runCounts.length - 1]! - runCounts[0]!,
      };
    })
    .sort((a, b) =>
      b.deltaLastVsFirst - a.deltaLastVsFirst ||
      (b.runCounts[b.runCounts.length - 1] ?? 0) -
        (a.runCounts[a.runCounts.length - 1] ?? 0) ||
      a.actionId.localeCompare(b.actionId)
    );

  return {
    loads: loads.map((load) => ({
      noteCount: load.noteCount,
      loadDurationMs: load.loadDurationMs,
      graph: load.graph,
    })),
    loadDurationGrowth: {
      values: loads.map((load) => ({
        noteCount: load.noteCount,
        loadDurationMs: load.loadDurationMs,
      })),
      deltaLastVsFirst: Number(
        (
          (loads[loads.length - 1]?.loadDurationMs ?? 0) -
          (loads[0]?.loadDurationMs ?? 0)
        ).toFixed(3),
      ),
    },
    schedulerTimingGrowth: timingGrowth.filter((row) =>
      row.deltaLastVsFirst > 0
    )
      .slice(0, 20),
    actionRunGrowth: actionGrowth.filter((row) => row.deltaLastVsFirst > 0)
      .slice(0, 20),
    topLoadActionsAtMaxNoteCount: actionGrowth
      .sort((a, b) =>
        (b.runCounts[b.runCounts.length - 1] ?? 0) -
          (a.runCounts[a.runCounts.length - 1] ?? 0) ||
        a.actionId.localeCompare(b.actionId)
      )
      .slice(0, 20),
  };
}

async function collectCapturedConsoleLogs(
  page: Page,
  substring: string,
): Promise<unknown> {
  const logs = await page.evaluate(() => {
    const globalState = globalThis as typeof globalThis & {
      __cfCapturedConsoleLogs?: Array<{ method: string; text: string }>;
    };
    return globalState.__cfCapturedConsoleLogs ?? [];
  }) as Array<{ method: string; text: string }>;

  return logs
    .filter((entry) => entry.text.includes(substring))
    .slice(-80);
}

async function collectRunnerTriggerFlowCounts(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return null;

    const { counts } = await api.getLoggerCounts();
    const loggerCounts = counts["runner.trigger-flow"];
    if (!loggerCounts) return null;
    type CountRow = {
      total: number;
      debug: number;
      info: number;
      warn: number;
      error: number;
    };
    const keyedCounts = loggerCounts as Record<string, CountRow>;

    const toRows = (prefix: string) =>
      Object.entries(keyedCounts)
        .filter(([key]) => key.startsWith(prefix))
        .sort((a, b) => (b[1].total ?? 0) - (a[1].total ?? 0))
        .slice(0, 12)
        .map(([key, value]) => ({
          key,
          total: value.total ?? 0,
          debug: value.debug ?? 0,
          info: value.info ?? 0,
          warn: value.warn ?? 0,
          error: value.error ?? 0,
        }));

    return {
      runnerRun: toRows("runner-run/"),
      setupInternal: toRows("setup-internal/"),
      instantiatePatternNode: toRows("instantiate-pattern-node/"),
    };
  });
}

async function collectWishFlowCounts(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return null;

    const { timing } = await api.getLoggerCounts();

    type TimingRow = {
      count: number;
      average: number;
      p50: number;
      p95: number;
      max: number;
      lastTime: number;
    };
    const timingRows = (timing["runner.wish-flow"] ?? {}) as Record<
      string,
      TimingRow
    >;
    if (Object.keys(timingRows).length === 0) return null;

    const toTimingRows = (prefix: string) =>
      Object.entries(timingRows)
        .filter(([key]) => key.startsWith(prefix))
        .sort((a, b) => (b[1].average ?? 0) - (a[1].average ?? 0))
        .slice(0, 16)
        .map(([key, value]) => ({
          key,
          count: value.count ?? 0,
          average: Number((value.average ?? 0).toFixed(3)),
          p50: Number((value.p50 ?? 0).toFixed(3)),
          p95: Number((value.p95 ?? 0).toFixed(3)),
          max: Number((value.max ?? 0).toFixed(3)),
          lastTime: Number((value.lastTime ?? 0).toFixed(3)),
        }));

    return {
      phaseTiming: toTimingRows("wish/phase/"),
      phaseQueryTiming: toTimingRows("wish/phase-query/"),
      resolveTiming: toTimingRows("wish/resolve/"),
      syncTiming: toTimingRows("wish/sync/"),
    };
  });
}

async function collectSourceLocationSamples(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const api = globalThis.commonfabric?.rt;
    if (!api) return null;

    const { flags } = await api.getLoggerCounts();
    const builderSamples =
      (flags["builder.source-location"]?.sample ?? {}) as Record<
        string,
        {
          raw?: string;
          frame?: { file?: string; line?: number; col?: number };
          mapped?: {
            source?: string | null;
            line?: number | null;
            column?: number | null;
            name?: string | null;
          } | null;
          parsedFrames?: Array<{
            index?: number;
            raw?: string;
            frame?: { file?: string; line?: number; col?: number };
          }>;
        }
      >;
    const runnerSamples =
      (flags["runner.source-location"]?.sample ?? {}) as Record<
        string,
        {
          name?: string;
          raw?: string;
          frame?: { file?: string; line?: number; col?: number };
          mapped?: {
            source?: string | null;
            line?: number | null;
            column?: number | null;
            name?: string | null;
          } | null;
          parsedFrames?: Array<{
            index?: number;
            raw?: string;
            frame?: { file?: string; line?: number; col?: number };
          }>;
        }
      >;

    const normalizeSamples = (
      samples: Record<
        string,
        {
          name?: string;
          raw?: string;
          frame?: { file?: string; line?: number; col?: number };
          mapped?: {
            source?: string | null;
            line?: number | null;
            column?: number | null;
            name?: string | null;
          } | null;
          parsedFrames?: Array<{
            index?: number;
            raw?: string;
            frame?: { file?: string; line?: number; col?: number };
          }>;
        }
      >,
    ) =>
      Object.entries(samples)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-12)
        .map(([id, sample]) => ({
          id,
          name: sample.name,
          raw: sample.raw,
          frame: sample.frame,
          mapped: sample.mapped,
          parsedFrames: sample.parsedFrames?.slice(0, 5),
        }));

    return {
      builder: normalizeSamples(builderSamples),
      runner: normalizeSamples(runnerSamples),
    };
  });
}

async function ensureCapturedConsole(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const globalState = globalThis as typeof globalThis & {
      __cfCapturedConsoleLogs?: Array<{ method: string; text: string }>;
      __cfConsolePatched?: boolean;
    };

    if (!globalState.__cfConsolePatched) {
      globalState.__cfCapturedConsoleLogs = [];
      const methods = ["debug", "info", "warn", "error", "log"] as const;
      for (const method of methods) {
        const original = console[method].bind(console);
        console[method] = (...args: unknown[]) => {
          const text = args.map((arg) => {
            if (typeof arg === "string") return arg;
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          }).join(" ");
          globalState.__cfCapturedConsoleLogs?.push({ method, text });
          if ((globalState.__cfCapturedConsoleLogs?.length ?? 0) > 500) {
            globalState.__cfCapturedConsoleLogs?.splice(0, 100);
          }
          return original(...args);
        };
      }
      globalState.__cfConsolePatched = true;
    } else {
      globalState.__cfCapturedConsoleLogs = [];
    }

    return true;
  });
}

async function collectNotebookRenderState(page: Page): Promise<{
  isNotebook: boolean;
  noteCount: number;
  notesLength: number;
  mentionableLength: number;
  showNewNotePrompt?: boolean;
  usedCreateAnotherNote?: boolean;
  storedUiNoteChips: number;
  storedUiNoteLabels: string[];
  renderedNoteChips: number;
  renderedNoteLabels: string[];
}> {
  return await page.evaluate(async () => {
    const commonfabric = globalThis.commonfabric as any;
    const appState = globalThis.app?.serialize?.();
    const view = appState?.view;
    const pieceId = view && typeof view === "object" && "pieceId" in view &&
        typeof view.pieceId === "string"
      ? view.pieceId
      : undefined;
    let current: any;
    if (pieceId) {
      const originalLog = console.log;
      try {
        console.log = () => {};
        current = await commonfabric?.readCell?.({ id: pieceId });
      } finally {
        console.log = originalLog;
      }
    }
    const notes = Array.isArray(current?.notes) ? current.notes : [];
    const mentionable = Array.isArray(current?.mentionable)
      ? current.mentionable
      : [];
    const collectStoredNoteLabels = (value: unknown) => {
      const labels: string[] = [];
      const seen = new WeakSet<object>();

      function visit(currentValue: unknown): void {
        if (currentValue === null || currentValue === undefined) return;
        if (typeof currentValue !== "object") return;
        if (seen.has(currentValue)) return;
        seen.add(currentValue);

        const record = currentValue as Record<string, unknown>;
        const label = typeof record.label === "string"
          ? record.label
          : typeof (record.props as { label?: unknown } | undefined)?.label ===
              "string"
          ? (record.props as { label: string }).label
          : undefined;
        if (label?.trim().startsWith("📝 New Note")) {
          labels.push(label.trim());
        }

        if (Array.isArray(currentValue)) {
          for (const item of currentValue) visit(item);
          return;
        }
        for (const item of Object.values(record)) visit(item);
      }

      visit(value);
      return labels;
    };
    const collectRenderedNoteLabels = (root: Document | ShadowRoot) => {
      const labels: string[] = [];

      function collect(currentRoot: Document | ShadowRoot): void {
        for (const el of currentRoot.querySelectorAll("*")) {
          if (el.localName === "cf-chip") {
            const label = ((el as any).label ?? el.getAttribute("label") ?? "")
              .trim();
            if (label.startsWith("📝 New Note")) {
              labels.push(label);
            }
          }
          if ((el as HTMLElement).shadowRoot) {
            collect((el as HTMLElement).shadowRoot!);
          }
        }
      }

      collect(root);
      return labels;
    };
    const noteLabels = collectRenderedNoteLabels(document);
    const storedUiNoteLabels = collectStoredNoteLabels(current?.["$UI"]);

    return {
      isNotebook: current?.isNotebook === true,
      noteCount: typeof current?.noteCount === "number"
        ? current.noteCount
        : -1,
      notesLength: notes.length,
      mentionableLength: mentionable.length,
      showNewNotePrompt: typeof current?.showNewNotePrompt === "boolean"
        ? current.showNewNotePrompt
        : undefined,
      usedCreateAnotherNote: typeof current?.usedCreateAnotherNote === "boolean"
        ? current.usedCreateAnotherNote
        : undefined,
      storedUiNoteChips: storedUiNoteLabels.length,
      storedUiNoteLabels,
      renderedNoteChips: noteLabels.length,
      renderedNoteLabels: noteLabels,
    };
  });
}

async function collectNavigationDiagnostics(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const commonfabric = globalThis.commonfabric as any;
    const appState = globalThis.app?.serialize?.();
    const view = appState?.view;
    const pieceId = view && typeof view === "object" && "pieceId" in view &&
        typeof view.pieceId === "string"
      ? view.pieceId
      : undefined;
    const current = pieceId
      ? await commonfabric?.readCell?.({ id: pieceId })
      : undefined;
    const buttonTexts: string[] = [];
    const renderedButtonTexts: string[] = [];

    function collectButtonTexts(root: Document | ShadowRoot): void {
      for (const el of root.querySelectorAll("cf-button, button, a")) {
        const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
        if (text) {
          buttonTexts.push(text);
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (
            style.display !== "none" && style.visibility !== "hidden" &&
            rect.width > 0 && rect.height > 0
          ) {
            renderedButtonTexts.push(text);
          }
        }
        if ((el as HTMLElement).shadowRoot) {
          collectButtonTexts((el as HTMLElement).shadowRoot!);
        }
      }
    }

    collectButtonTexts(document);

    return {
      location: globalThis.location.href,
      appState,
      currentName: current?.$NAME,
      currentIsNotebook: current?.isNotebook === true,
      currentKeys: current && typeof current === "object"
        ? Object.keys(current).slice(0, 30)
        : [],
      runtimeSpace: globalThis.app.getRuntimeSpaceDID(),
      buttonTexts: buttonTexts.slice(0, 40),
      renderedButtonTexts: renderedButtonTexts.slice(0, 40),
    };
  });
}

// Serialized into the page by waitForCondition: find the space link whose
// visible text contains `searchText` and activate it, reporting whether one was
// found. Prefers the shell breadcrumb before falling back to generic anchors:
// the selectors are tried one at a time, because a combined selector matches in
// document order and lets an unrelated descendant <a> containing the space name
// win. Activation uses DOM click() rather than an Astral coordinate click,
// which can hit a transient overlay even after resolving the right node. The
// predicate finds and clicks in one page-side pass, so the click lands on the
// element the search just resolved with no window for a re-render in between;
// waitForCondition stops the instant it returns true, so the click fires once.
const findAndClickPieceLink = (
  probe: ProbeApi,
  searchText: string,
): boolean => {
  for (
    const selector of [
      ".header-space",
      "#header-space-link",
      "#header-space",
      "a",
    ]
  ) {
    const link = probe.collect(selector).find((element) =>
      (element as HTMLElement).innerText?.trim().includes(searchText)
    ) as HTMLElement | undefined;
    if (link) {
      link.click();
      return true;
    }
  }
  return false;
};

// Wait for the space link to render, then activate it once.
async function clickPieceLinkWithText(
  page: Page,
  searchText: string,
): Promise<void> {
  try {
    await waitForCondition(page, findAndClickPieceLink, { args: [searchText] });
  } catch (cause) {
    throw new Error(
      `Unable to find a space link matching "${searchText}" to click`,
      { cause },
    );
  }
}

// Serialized into the page by waitForCondition: count the unique rendered
// "📝 New Note #<hash>" titles across the document and every shadow root and
// report whether more than `minCount` are present. Inlines the collection that
// collectNoteTitlesInList performs so the wait resolves the instant the list
// grows rather than on a polling tick.
const noteTitlesExceed = (probe: ProbeApi, minCount: number): boolean => {
  const titles = new Set<string>();
  for (const element of probe.collect("*")) {
    const text = element.textContent;
    if (!text) continue;
    for (const match of text.matchAll(/📝 New Note #[A-Za-z0-9_-]+/g)) {
      titles.add(match[0]);
    }
  }
  return titles.size > minCount;
};

async function collectNoteTitlesInList(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const titles = new Set<string>();

    function search(root: Document | ShadowRoot): void {
      const allElements = root.querySelectorAll("*");
      for (const el of allElements) {
        const text = el.textContent;
        if (text) {
          for (
            const match of text.matchAll(/📝 New Note #[A-Za-z0-9_-]+/g)
          ) {
            titles.add(match[0]);
          }
        }
        if (el.shadowRoot) {
          search(el.shadowRoot);
        }
      }
    }
    search(document);
    return [...titles].sort();
  });
}
