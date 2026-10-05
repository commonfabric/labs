/**
 * Worker-side runtime host for multi-user pattern tests (`cf test`).
 *
 * Each worker owns one full client stack — Identity, StorageManager,
 * Runtime, Engine — in its own JS realm, exactly like one browser tab or
 * CLI process. All workers of a test share one storage server and one
 * space; each runs the test file's `setup` pattern on the SAME result cell
 * (local-first: every client runs the shared instance, so per-user scoped
 * outputs are computed under this worker's principal) and then its own
 * participant pattern, whose `tests` steps the orchestrator drives via a
 * small request/response protocol.
 *
 * The `{ label }` / `{ await }` markers travel through that same shared
 * space, each participant announcing into its own marker document.
 * Announcing commits the marker; awaiting waits for it to arrive here. The
 * announcing participant settles each step before the next, so the server
 * holds everything it wrote before it holds the marker. A replica that has
 * the marker therefore reads the rest from a server that already has it:
 * documents inside this replica's watch set arrive in a fan-out frame the
 * server computes by diffing current storage, which cannot carry the marker
 * while omitting an earlier write it has not yet sent, and a document
 * outside that set is fetched on demand by the assertion's own `pull()`.
 * That is what lets an assertion be read once.
 *
 * Realm isolation is required, not an optimization: two runtimes in one
 * realm cross-talk through module-level state (verified-load registries,
 * frame stack).
 */

import type { RealmEncodedValue } from "@commonfabric/data-model/codec-realm";
import {
  CFC_ENFORCEMENT_MODES,
  type CfcEnforcementMode,
  type CfcFlowLabelsMode,
  isCfcEnforcementMode,
} from "@commonfabric/runner/cfc";
import {
  createSession,
  Identity,
  keyPairFromRealmValue,
} from "@commonfabric/identity";
import type { DID } from "@commonfabric/identity/did";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  ACLManager,
  type Cell,
  type ConsoleHandler,
  ConsoleMethod,
  type Engine,
  experimentalOptionsFromEnv,
  type Pattern,
  PatternCoverageCollector,
  patternCoverageOutputPath,
  Runtime,
  runtimePresets,
  TESTS,
  writePatternCoverageLcov,
} from "@commonfabric/runner";
import { defer } from "@commonfabric/utils/defer";
import { holdWorkerLifetimeLock } from "@commonfabric/utils/worker-lifetime";

import { assertionOutcome } from "./assert-record.ts";
import { printCfcDenials } from "./cfc-denials.ts";
import {
  flushDefaultModuleByteCache,
  getDefaultModuleByteCache,
} from "./compile-byte-cache.ts";
import {
  appendLoggerDeltaMessages,
  type LoggerErrorWarnSnapshot,
  snapshotLoggerErrorWarnCounts,
} from "./console-capture.ts";
import { materializeTestVDOM, mountTestVDOM } from "./materialize-test-vdom.ts";
import { buildActionEvent } from "./trusted-action-event.ts";

export interface WorkerRequest {
  id: number;
  cmd: string;
  args: Record<string, unknown>;
}

export type WorkerResponse =
  | { id: number; ok: unknown }
  | { id: number; error: string };

/**
 * The message a participant worker posts once, before any response, naming
 * its lifetime lock for `terminateWorker()` to wait on.
 */
export interface WorkerLifetimeNotice {
  lifetimeLock: string | undefined;
}

export type StepKind =
  | "action"
  | "assertion"
  | "render"
  | "settle"
  | "label"
  | "await";

export interface StepMeta {
  kind: StepKind;

  /** Marker name for label/await steps. */
  marker?: string;

  skip?: boolean;
}

export interface ParticipantInitResult {
  steps: StepMeta[];
  allowRuntimeErrors: boolean;
  expectNonIdempotent: boolean;
  allowConsoleErrors: boolean;
  allowConsoleWarnings: boolean;

  /**
   * The CFC enforcement mode this participant's runtime resolved to, read off
   * the runtime itself. The orchestrator checks it against the mode the run
   * named, so a participant that came up on another rung says so.
   */
  cfcEnforcementMode: CfcEnforcementMode;

  /** Flow-label mode resolved by this participant runtime. */
  cfcFlowLabels: CfcFlowLabelsMode;
}

const SETUP_CAUSE = "multi-user-test-setup";
const SETTLE_FAST_MS = 2;

/**
 * One marker document per participant, so the only writer of a document is
 * the participant it belongs to. Announcing is then conflict-free whatever
 * order participants announce in, including from a replica that predates
 * another participant's announcement.
 */
function markersCause(participant: string): string {
  return `multi-user-test-markers:${participant}`;
}

/** Markers one participant has announced, one property per marker name. */
const markersSchema = {
  type: "object",
  additionalProperties: { type: "boolean" },
  default: {},
} as const;

let runtime: Runtime | undefined;
let storageManager:
  | { synced(): Promise<void>; close(): Promise<void> }
  | undefined;
let engine: Engine | undefined;

/** Every participant's marker document, keyed by participant name. */
const markersCells = new Map<string, Cell<Record<string, boolean>>>();

let selfParticipant: string | undefined;
let stepCells: Cell<unknown>[] = [];
let patternCoverage: PatternCoverageCollector | undefined;
let patternCoveragePath: string | undefined;
let patternCoverageRoot: string | undefined;
const runtimeErrors: string[] = [];

/** Channel 1: console.error calls captured via the harness console event. */
const consoleErrors: string[] = [];

/** Channel 1: console.warn calls, captured the same way. */
const consoleWarnings: string[] = [];

const continuousUiErrors: Error[] = [];
let continuousUiCancel: (() => void) | undefined;
// Run-phase gate for channel 1 (mirrors test-runner.ts): flips true at the
// post-compile point where the channel-2 snapshot is taken, so compile-time
// module-evaluation console output does not fail tests.
let consoleCaptureActive = false;

/** Channel 2: logger error/warn count snapshot taken after compile, before run. */
let loggerCountsBeforeRun: LoggerErrorWarnSnapshot = new Map();

function rt(): Runtime {
  if (!runtime) throw new Error("worker not initialized");
  return runtime;
}

async function settle(maxIterations = 20): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    const start = performance.now();
    await rt().idle();
    await storageManager!.synced();
    if (performance.now() - start < SETTLE_FAST_MS) return;
  }
}

function markersCellFor(participant: string): Cell<Record<string, boolean>> {
  const cell = markersCells.get(participant);
  if (!cell) {
    throw new Error(`No marker document for participant "${participant}"`);
  }
  return cell;
}

/**
 * Resolve once `marker` is present in this replica's copy of the marker
 * document `announcedBy` writes.
 *
 * The wait sleeps on the cell's sink, so it wakes on the commit that carries
 * the marker rather than on a clock, and it reads the value once the
 * scheduler is quiescent.
 */
async function waitForMarker(
  announcedBy: string,
  marker: string,
): Promise<void> {
  const cell = markersCellFor(announcedBy);
  let changed = defer<void>();
  const cancel = cell.sink(() => {
    changed.resolve();
    changed = defer<void>();
  });
  try {
    while (true) {
      await rt().idle();
      // Captured before the read, so a change racing the check wakes the next
      // attempt instead of being missed.
      const next = changed.promise;
      if (cell.get()?.[marker] === true) return;
      await next;
    }
  } finally {
    // Cancelling while the action that reported a value is still finalizing
    // does not stick, because finalizing an action resubscribes it.
    await rt().idle();
    cancel();
  }
}

const stepPeekSchema = {
  type: "object",
  properties: {
    action: { type: "unknown" },
    assertion: { type: "unknown" },
    render: { type: "unknown" },
    settle: { type: "boolean" },
    label: { type: "string" },
    await: { type: "string" },
    // The payload is what the step sends, so it is read as authored: an
    // object arrives as an object, reaching the handler as a reference into
    // this step rather than a snapshot of it. `type: "unknown"` marks a value
    // the traversal must not descend into, which is right for the fields this
    // schema only tests for presence and wrong here, where it drops an object
    // payload to `undefined`.
    event: true,
    trustedUi: {
      type: "object",
      properties: {
        surface: { type: "string" },
        action: { type: "string" },
      },
    },
    skip: { type: "boolean" },
    readBudget: true,
  },
} as const;

function classifyStep(stepCell: Cell<unknown>, index: number): StepMeta {
  const peek = stepCell.asSchema(stepPeekSchema).get() as {
    action?: unknown;
    assertion?: unknown;
    render?: unknown;
    settle?: boolean;
    label?: string;
    await?: string;
    skip?: boolean;
    readBudget?: unknown;
  };
  if (peek?.readBudget !== undefined) {
    throw new Error(
      `Step ${index + 1}: read budgets are not supported in multi-user tests`,
    );
  }
  const skip = peek?.skip === true ? { skip: true } : {};
  if (typeof peek?.label === "string") {
    return { kind: "label", marker: peek.label, ...skip };
  }
  if (typeof peek?.await === "string") {
    return { kind: "await", marker: peek.await, ...skip };
  }
  if (peek?.settle === true) return { kind: "settle", ...skip };
  // Streams/computeds peek as present-but-opaque; key presence is the signal.
  if (Object.hasOwn(peek ?? {}, "render")) return { kind: "render", ...skip };
  if (Object.hasOwn(peek ?? {}, "action")) return { kind: "action", ...skip };
  if (Object.hasOwn(peek ?? {}, "assertion")) {
    return { kind: "assertion", ...skip };
  }
  throw new Error(
    `Test step ${index} has none of ` +
      `action/assertion/render/settle/label/await ` +
      // The step's own keys, not the peek's: the peek schema has already
      // dropped every key it does not declare, which is exactly the set an
      // author needs named here.
      `(keys: ${
        Object.keys(stepCell.get() as object ?? {}).join(",") || "none"
      })`,
  );
}

/**
 * The CFC enforcement mode an `init` request names, if it names one.
 *
 * The request crosses a worker boundary as plain data, so the name arrives
 * untyped. A name off the ladder is reported here rather than installed: the
 * ladder is a closed set, and a runtime holding a mode outside it is on no
 * rung.
 */
function requestedEnforcementMode(
  input: unknown,
): CfcEnforcementMode | undefined {
  if (input === undefined) return undefined;
  if (!isCfcEnforcementMode(input)) {
    throw new Error(
      `Initialization \`cfcEnforcementMode\` is ${String(input)}, not one ` +
        `of ${CFC_ENFORCEMENT_MODES.join(", ")}`,
    );
  }
  return input;
}

const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  /**
   * Boot the stack, run the shared `setup` pattern, run this worker's
   * participant pattern, and return the classified step list.
   */
  async init(args) {
    const requestedMode = requestedEnforcementMode(args.cfcEnforcementMode);
    const flowLabels = args.cfcFlowLabels;
    if (
      flowLabels !== undefined && flowLabels !== "off" &&
      flowLabels !== "observe" && flowLabels !== "persist"
    ) {
      throw new Error(
        `Initialization cfcFlowLabels is ${
          String(flowLabels)
        }, not off, observe, or persist`,
      );
    }
    const identity = await Identity.fromKeyPair(
      keyPairFromRealmValue(
        args.identity as RealmEncodedValue,
        "Initialization `identity`",
      ),
    );
    const session = createSession({
      identity,
      spaceDid: args.spaceDid as DID,
    });
    const space = session.space;
    // The Deno storage cache opens SQLite as it loads, so it waits for the
    // session it will open against.
    // deno-lint-ignore cf-imports/no-inline-module-import
    const { StorageManager } = await import(
      "@commonfabric/runner/storage/cache.deno"
    );
    storageManager = StorageManager.open({
      as: session.as,
      // Host only — the storage path (/api/storage/memory) is joined
      // internally (see createStorageAddressResolver).
      memoryHost: new URL(args.apiUrl as string),
    });
    patternCoverage = typeof args.patternCoverageDir === "string"
      ? new PatternCoverageCollector()
      : undefined;
    patternCoveragePath = typeof args.patternCoverageDir === "string"
      ? patternCoverageOutputPath(
        args.patternCoverageDir,
        args.testPath as string,
        args.participant as string,
      )
      : undefined;
    patternCoverageRoot = typeof args.root === "string" ? args.root : undefined;
    // `runtimePresets.patternTest` carries the shared first-party posture
    // (CT-1814) and the same env-honored experimental flags as the
    // single-user runner (this worker previously ignored EXPERIMENTAL_*, so
    // the two harness modes could run under different flags).
    runtime = new Runtime(runtimePresets.patternTest({
      apiUrl: new URL(import.meta.url),
      storageManager: storageManager as never,
      experimental: experimentalOptionsFromEnv(Deno.env.get),
      errorHandlers: [(error: Error) => runtimeErrors.push(String(error))],
      moduleByteCache: getDefaultModuleByteCache(),
      // The collector is the runtime's, which makes every compile an
      // instrumented one and names the instrumented variant wherever the
      // runtime reads or writes a compiled closure. Replicating a pattern
      // instantiated with `inSpace()` reads the participant's closure that
      // way, so the variant it asks for is the one the compile below wrote.
      ...(patternCoverage !== undefined ? { patternCoverage } : {}),
      ...(flowLabels !== undefined ? { cfcFlowLabels: flowLabels } : {}),
      ...(requestedMode !== undefined
        ? { cfcEnforcementMode: requestedMode }
        : {}),
    }));
    if (args.noIdempotencyCheck !== true) runtime.enableIdempotencyCheck();
    if (args.cfcDenials === true) {
      // This worker runs one participant for its whole life, so nothing stops
      // the printing.
      printCfcDenials((line) =>
        console.log(`    [${String(args.participant)}] ${line}`)
      );
    }
    // Channel 1: capture pattern-code console.error / console.warn calls.
    runtime.scheduler.onConsole(
      (({ method, args }) => {
        if (!consoleCaptureActive) {
          return args;
        }
        if (method === ConsoleMethod.Error) {
          consoleErrors.push(
            `[console.error] ${args.map((a) => String(a)).join(" ")}`,
          );
        } else if (method === ConsoleMethod.Warn) {
          consoleWarnings.push(
            `[console.warn] ${args.map((a) => String(a)).join(" ")}`,
          );
        }
        return args;
      }) satisfies ConsoleHandler,
    );
    // Use the runtime's own harness (see test-runner.ts): a second Engine
    // splits verified-load/source-map state and breaks CFC verified-binding
    // identities under enforcement.
    engine = runtime.harness;

    const program = await resolveLocalProgram((r) => engine!.resolve(r), {
      main: args.testPath as string,
      ...(typeof args.root === "string" ? { root: args.root } : {}),
      ...(Array.isArray(args.dataFilePaths)
        ? { dataFilePaths: args.dataFilePaths as string[] }
        : {}),
    });
    // `compileAndRegisterModules` seals compile + evaluate + register (see
    // test-runner.ts): map/filter/flatMap ops resolve via their content-addressed
    // canonical artifact instead of the defer-corrupted embedded graph (CT-1811).
    // The closure is written into the shared space, for the same reason
    // test-runner.ts writes it: a pattern instantiated with `inSpace()` is
    // replicated from it.
    const evalResult = await runtime.patternManager.compileAndRegisterModules(
      program,
      undefined,
      { space },
    );
    const { main } = evalResult;
    // Channel 2: snapshot logger counts AFTER compile, before the run phase.
    loggerCountsBeforeRun = snapshotLoggerErrorWarnCounts();
    consoleCaptureActive = true;
    const descriptor = (main?.default ?? {}) as {
      setup?: Pattern;
      participants?: Record<string, Pattern | { pattern: Pattern }>;
    };
    const entry = descriptor.participants?.[args.participant as string];
    const participantFactory = typeof entry === "function"
      ? entry
      : (entry as { pattern?: Pattern } | undefined)?.pattern;
    if (typeof participantFactory !== "function") {
      throw new Error(
        `No participant pattern "${args.participant}" in test descriptor`,
      );
    }

    // Subscribe to every participant's marker document before any step runs,
    // so an announcement is already in this replica's watch set when it is
    // made rather than being fetched after the fact.
    selfParticipant = args.participant as string;
    for (const name of args.participants as string[]) {
      const cell = rt().getCell<Record<string, boolean>>(
        space,
        markersCause(name),
        markersSchema,
      );
      await cell.sync();
      markersCells.set(name, cell);
    }

    // Load the space's access list before any pattern runs, so that
    // `spaceAccess()` in a computed reads the list on its first run. A run
    // before the list arrives returns `undefined`, and an assertion, which is
    // read once, can read that value before the list's arrival replaces it.
    await new ACLManager(rt(), space).get();

    // Minimal wish("#default") environment, seeded once by the first worker.
    if (args.seedDefaults === true) {
      const setupTx = rt().edit();
      const spaceCell = rt().getCell(space, space, undefined, setupTx);
      const defaultPatternCell = rt().getCell(
        space,
        "default-pattern",
        undefined,
        setupTx,
      );
      const pieceRegistry = (defaultPatternCell as any).key("pieceRegistry");
      pieceRegistry.set([]);
      (defaultPatternCell as any).key("backlinksIndex").set({
        mentionable: [],
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);
      rt().prepareTxForCommit?.(setupTx);
      await setupTx.commit();
      await rt().idle();
    }

    // Run the shared setup pattern on a cause-derived result cell: every
    // worker runs the SAME instance (the first materializes it, the rest
    // resume it from storage and compute their own per-user partitions).
    let setupCell: Cell<Record<string, unknown>> | undefined;
    if (typeof descriptor.setup === "function") {
      const tx = rt().edit();
      setupCell = rt().getCell<Record<string, unknown>>(
        space,
        SETUP_CAUSE,
        undefined,
        tx,
      );
      await setupCell.sync();
      rt().run(tx, descriptor.setup, {}, setupCell);
      rt().prepareTxForCommit?.(tx);
      await tx.commit();
      await settle();
    }

    const tx = rt().edit();
    const resultCell = rt().getCell<Record<string, unknown>>(
      space,
      `multi-user-test-${args.participant}`,
      undefined,
      tx,
    );
    rt().run(
      tx,
      participantFactory,
      setupCell !== undefined ? { setup: setupCell } : {},
      resultCell,
    );
    rt().prepareTxForCommit?.(tx);
    await tx.commit();
    if (args.continuousUI === true) {
      continuousUiCancel = await mountTestVDOM(
        resultCell.key("$UI") as Cell<unknown>,
        (error) => continuousUiErrors.push(error),
      );
    }
    await settle();

    const stepsValue = resultCell.key(TESTS).asSchema(
      {
        type: "array",
        items: { type: "object", asCell: ["cell"] },
        default: [],
      } as const,
    ).get();
    if (!Array.isArray(stepsValue)) {
      throw new Error(
        `Participant "${args.participant}" must return { [TESTS]: TestStep[] }`,
      );
    }
    stepCells = stepsValue as Cell<unknown>[];

    const result: ParticipantInitResult = {
      steps: stepCells.map((cell, index) => classifyStep(cell, index)),
      allowRuntimeErrors:
        await (resultCell.key("allowRuntimeErrors") as Cell<unknown>)
          .pull() === true,
      expectNonIdempotent:
        await (resultCell.key("expectNonIdempotent") as Cell<unknown>)
          .pull() === true,
      allowConsoleErrors:
        await (resultCell.key("allowConsoleErrors") as Cell<unknown>)
          .pull() === true,
      allowConsoleWarnings:
        await (resultCell.key("allowConsoleWarnings") as Cell<unknown>)
          .pull() === true,
      cfcEnforcementMode: rt().cfcEnforcementMode,
      cfcFlowLabels: rt().cfcFlowLabels,
    };
    return result;
  },

  /** Invoke an action step's stream and settle. */
  async action({ index }) {
    const stepCell = stepCells[index as number];
    const stream = stepCell.key("action" as never) as unknown as {
      send?: (value: unknown) => void;
    };
    if (typeof stream?.send !== "function") {
      throw new Error(`Test step ${index} action is not a stream`);
    }
    const meta = stepCell.asSchema(stepPeekSchema).get() as {
      event?: unknown;
      trustedUi?: unknown;
    };
    stream.send(buildActionEvent(meta?.event, meta?.trustedUi));
    await settle();
    return {};
  },

  /** Evaluate an assertion step, reporting what a false value held. */
  async assertion({ index }) {
    const stepCell = stepCells[index as number];
    const value = await (stepCell.key("assertion" as never) as Cell<unknown>)
      .pull();
    // An `assert(...)` assertion carries the operands recorded while the
    // condition ran, so a failure names them and their values.
    return assertionOutcome(value);
  },

  /** Materialize one VDOM target, then remove its renderer demand. */
  async render({ index }) {
    const stepCell = stepCells[index as number];
    await materializeTestVDOM(
      stepCell.key("render" as never) as Cell<unknown>,
      () => settle(),
    );
    return {};
  },

  /**
   * Settle fully (scheduler, storage, and in-flight async builtin I/O) for an
   * explicit `{ settle: true }` step. Every step already settles before the
   * next, so this is a demand for full settlement at a point the author names.
   */
  async settleStep() {
    await settle();
    return {};
  },

  /**
   * Announce a coordination marker as a durable write, ordered after every
   * commit this participant has already made.
   */
  async label({ marker }) {
    const tx = rt().edit();
    markersCellFor(selfParticipant!).withTx(tx).key(marker as string).set(true);
    rt().prepareTxForCommit?.(tx);
    // A dropped marker is a wait that never ends, so the commit's verdict is
    // read rather than assumed.
    const result = await tx.commit();
    if (result.error) {
      throw new Error(
        `Announcing marker "${marker}" failed: ${result.error.message}`,
      );
    }
    await settle();
    return {};
  },

  /** Wait for another participant's marker to reach this replica. */
  async awaitMarker({ announcedBy, marker }) {
    await waitForMarker(announcedBy as string, marker as string);
    await settle();
    return {};
  },

  /** Runtime health for end-of-run reporting. */
  health() {
    // Apply channel-2 logger deltas now (end of run) so they are included in
    // the health report returned to the orchestrator.
    appendLoggerDeltaMessages(
      loggerCountsBeforeRun,
      consoleErrors,
      consoleWarnings,
    );
    return Promise.resolve({
      runtimeErrors: [
        ...runtimeErrors,
        ...continuousUiErrors.map((error) =>
          `[continuous $UI] ${String(error)}`
        ),
      ],
      consoleErrors: [...consoleErrors],
      consoleWarnings: [...consoleWarnings],
      nonIdempotent: rt().getIdempotencyViolations?.()?.map((violation) => {
        const { actionId, differingWriteKeys } = violation as {
          actionId?: string;
          differingWriteKeys?: string[];
        };
        const id = String(actionId ?? violation);
        return differingWriteKeys?.length
          ? `${id} (differing writes: ${differingWriteKeys.join(", ")})`
          : id;
      }) ?? [],
    });
  },

  async writeCoverage() {
    if (patternCoverage && patternCoveragePath) {
      await writePatternCoverageLcov(
        patternCoverage,
        patternCoveragePath,
        { root: patternCoverageRoot },
      );
    }
    return {};
  },

  async dispose() {
    stepCells = [];
    markersCells.clear();
    selfParticipant = undefined;
    continuousUiCancel?.();
    continuousUiCancel = undefined;
    continuousUiErrors.length = 0;
    // `engine` is the runtime's own harness; runtime.dispose() disposes it.
    await runtime?.dispose();
    await storageManager?.close();
    flushDefaultModuleByteCache();
    runtime = undefined;
    storageManager = undefined;
    engine = undefined;
    patternCoverage = undefined;
    patternCoveragePath = undefined;
    patternCoverageRoot = undefined;
    return {};
  },
};

// Every response follows the lifetime notice, so the orchestrator holds the
// lock's name before any reply can lead it to terminate this worker.
const announced = holdWorkerLifetimeLock().then((lifetimeLock) =>
  (self as unknown as Worker).postMessage(
    { lifetimeLock } satisfies WorkerLifetimeNotice,
  )
);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  await announced;
  const { id, cmd, args } = event.data;
  const handler = handlers[cmd];
  const respond = (response: WorkerResponse) =>
    (self as unknown as Worker).postMessage(response);
  if (!handler) {
    respond({ id, error: `unknown command "${cmd}"` });
    return;
  }
  handler(args).then(
    (ok) => respond({ id, ok }),
    (error: unknown) => respond({ id, error: formatError(error) }),
  );
};

function formatError(error: unknown): string {
  return error instanceof Error
    ? error.stack || error.message || String(error)
    : String(error);
}
