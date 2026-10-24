// Server-execution v2 stage F (docs/specs/server-side-execution/
// serving-loop.md §1): the ExecutorHost bootstrap. Under
// EXPERIMENTAL_SERVER_EXECUTION this process hosts one committing runtime
// per ACTIVE space — the serving loop — wired to the co-hosted memory
// server: the admission-side observer (plane b) activates spaces, lease
// writes ride the direct engine plane (plane c), and the serving
// runtimes' storage sessions are in-process loopback connections with the
// SAME signed session-open production clients present (plane a). OFF,
// whether selected by the default or an explicit override, nothing here
// runs and toolshed is byte-identical to the pre-v2 behavior.

import {
  type EnvReader,
  experimentalOptionsFromEnv,
  type RuntimeFetch,
} from "@commonfabric/runner";
import { publishServingExperimentalOverrides } from "./experimental-posture.ts";
import { serverExecutionEnabledFromEnv } from "./server-execution-flag.ts";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { DEFAULT_FLUSH_DEADLINE_MS } from "@commonfabric/runner/executor/space-server";
import {
  SERVING_RUNTIME_EXPERIMENTAL,
  servingRuntimeFactory,
} from "@commonfabric/runner/executor/serving-runtime";
import {
  type ServingLoopHandle,
  ServingWorker,
} from "@commonfabric/runner/executor/serving-worker-host";
import type { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import type { Identity } from "@commonfabric/identity";
import {
  servedLifecycleRunner,
  type ServedLifecycleVerbRunner,
} from "@commonfabric/piece/ops";
import {
  getLoggerCountsBreakdown,
  getTimingStatsBreakdown,
} from "@commonfabric/utils/logger";
import { ProcessModuleByteCache } from "@commonfabric/test-support/compile-byte-cache";

/**
 * The serving loop as the rest of this process reaches it, whichever thread
 * runs it: the lifecycle verbs the route sends, and the loop's counters and
 * close.
 */
export type ServingLoop = ServedLifecycleVerbRunner & ServingLoopHandle;

let loop: ServingLoop | undefined;

/** The production default for the per-space outstanding-network-effect
 * cap (serving-loop.md §5; README §3.8's multi-tenancy contract needs a
 * bound ON by default — a runaway LLM fan-out must degrade only its own
 * space). An operator-tunable posture, not a spec constant. */
export const DEFAULT_MAX_OUTSTANDING_EFFECTS = 16;

/** The longest delay `setTimeout()` honors, in milliseconds. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The Phase-6 policy knobs the toolshed bootstrap threads into the
 * ExecutorHost (`SpaceServerPolicy`'s env-overridable subset). */
export type ServerExecutionEnvPolicy = {
  flushDeadlineMs?: number;
  flushDeadlineMaxMs?: number;
  maxOutstandingEffects?: number;
  egressRatePerSecond?: number;
  storeReadThrough?: boolean;
  overlapWaveCommit?: boolean;
  parkedRuntimeRetentionMs?: number;
};

/**
 * Resolve the Phase-6 policy knobs from env (serving-loop.md §3's
 * T_flush "tuned in Phase 6 with the other budgets"; §5's per-space
 * budgets). Each is env-overridable; the defaults are the production
 * posture:
 * - T_flush stays the SpaceServer's built-in default (100 ms, the ruled
 *   50–100 ms order) unless overridden, and grows after a cut settle only
 *   when `SERVER_EXECUTION_FLUSH_DEADLINE_MAX_MS` names a longer cap;
 * - the outstanding-network-effect cap defaults to
 *   `DEFAULT_MAX_OUTSTANDING_EFFECTS` per space; the LITERAL `0` is the
 *   operator's explicit opt-out (unbounded);
 * - egress pacing defaults OFF (the cap alone bounds concurrency; a rate
 *   value is a deliberate operator choice);
 * - the store read-through (`SpaceServerPolicy.storeReadThrough`,
 *   SERVER_EXECUTION_STORE_READ_THROUGH) defaults OFF; only the literal
 *   `true` turns it on;
 * - the overlapped wave commit (`SpaceServerPolicy.overlapWaveCommit`,
 *   SERVER_EXECUTION_OVERLAP_COMMIT) defaults OFF, on the same reading;
 * - how long an idle-parked space's runtime is kept for its next tenure
 *   (`SpaceServerPolicy.parkedRuntimeRetentionMs`,
 *   SERVER_EXECUTION_PARKED_RUNTIME_RETENTION_MS) stays the host's
 *   built-in default unless overridden; the literal `0` keeps none, and
 *   a value past the longest delay a timer honors reads as unset.
 *
 * Parsing is FAIL-CLOSED for the cap: an unparseable or negative value
 * ("abc", "-1", "1.5") falls back to the default and warns, instead of
 * being silently indistinguishable from the explicit `0` opt-out (a
 * typo must never disable the production bound). The other knobs have
 * no dangerous "absent" meaning — absent = the built-in default — so
 * garbage there simply reads as unset (also warned).
 */
export function serverExecutionPolicyFromEnv(
  envGet: EnvReader,
  warn: (message: string) => void = (message) => console.warn(message),
): ServerExecutionEnvPolicy {
  /** A strictly non-negative decimal integer, or undefined for anything
   * else (garbage, sign, fraction, exponent — `parseInt` would accept
   * prefixes of those). */
  const strictNonNegativeInt = (raw: string): number | undefined =>
    /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;

  const readRaw = (name: string): string | undefined => {
    const raw = envGet(name);
    return raw === undefined || raw === "" ? undefined : raw;
  };

  /** Positive-int knobs whose absence means the built-in default. */
  const positiveOrDefault = (name: string): number | undefined => {
    const raw = readRaw(name);
    if (raw === undefined) return undefined;
    const value = strictNonNegativeInt(raw);
    if (value === undefined || value <= 0) {
      warn(
        `Server-execution v2: ignoring ${name}=${JSON.stringify(raw)} ` +
          "(expected a positive integer); using the built-in default",
      );
      return undefined;
    }
    return value;
  };

  const flushDeadlineMs = positiveOrDefault(
    "SERVER_EXECUTION_FLUSH_DEADLINE_MS",
  );
  const flushDeadlineMaxMs = positiveOrDefault(
    "SERVER_EXECUTION_FLUSH_DEADLINE_MAX_MS",
  );
  const egressRatePerSecond = positiveOrDefault(
    "SERVER_EXECUTION_EGRESS_RATE_PER_S",
  );
  const capRaw = readRaw("SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS");
  let maxOutstandingEffects: number | undefined;
  if (capRaw === undefined) {
    maxOutstandingEffects = DEFAULT_MAX_OUTSTANDING_EFFECTS;
  } else {
    const value = strictNonNegativeInt(capRaw);
    if (value === undefined) {
      warn(
        "Server-execution v2: ignoring SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS=" +
          `${JSON.stringify(capRaw)} (expected a non-negative integer; ` +
          "the literal 0 means unbounded); using the default " +
          `${DEFAULT_MAX_OUTSTANDING_EFFECTS}`,
      );
      maxOutstandingEffects = DEFAULT_MAX_OUTSTANDING_EFFECTS;
    } else if (value === 0) {
      // The explicit opt-out: unbounded (absent from the policy).
      maxOutstandingEffects = undefined;
    } else {
      maxOutstandingEffects = value;
    }
  }
  const retentionRaw = readRaw(
    "SERVER_EXECUTION_PARKED_RUNTIME_RETENTION_MS",
  );
  // The retention arms a timer, and a delay past the timer's range fires
  // at once, so such a value reads as unset rather than as "keep long".
  const retentionValue = retentionRaw === undefined
    ? undefined
    : strictNonNegativeInt(retentionRaw);
  const parkedRuntimeRetentionMs = retentionValue !== undefined &&
      retentionValue <= MAX_TIMER_DELAY_MS
    ? retentionValue
    : undefined;
  if (retentionRaw !== undefined && parkedRuntimeRetentionMs === undefined) {
    warn(
      "Server-execution v2: ignoring " +
        "SERVER_EXECUTION_PARKED_RUNTIME_RETENTION_MS=" +
        `${JSON.stringify(retentionRaw)} (expected a non-negative integer ` +
        `of at most ${MAX_TIMER_DELAY_MS}; the literal 0 keeps no parked ` +
        "runtime); using the built-in default",
    );
  }
  const readThroughRaw = readRaw("SERVER_EXECUTION_STORE_READ_THROUGH");
  let storeReadThrough: boolean | undefined;
  if (readThroughRaw === "true") {
    storeReadThrough = true;
  } else if (readThroughRaw !== undefined && readThroughRaw !== "false") {
    warn(
      "Server-execution v2: ignoring SERVER_EXECUTION_STORE_READ_THROUGH=" +
        `${JSON.stringify(readThroughRaw)} (expected "true" or "false"); ` +
        "the store read-through stays OFF",
    );
  }
  const overlapRaw = readRaw("SERVER_EXECUTION_OVERLAP_COMMIT");
  let overlapWaveCommit: boolean | undefined;
  if (overlapRaw === "true") {
    overlapWaveCommit = true;
  } else if (overlapRaw !== undefined && overlapRaw !== "false") {
    warn(
      "Server-execution v2: ignoring SERVER_EXECUTION_OVERLAP_COMMIT=" +
        `${JSON.stringify(overlapRaw)} (expected "true" or "false"); ` +
        "the overlapped wave commit stays OFF",
    );
  }
  return {
    ...(flushDeadlineMs !== undefined ? { flushDeadlineMs } : {}),
    ...(flushDeadlineMaxMs !== undefined ? { flushDeadlineMaxMs } : {}),
    ...(maxOutstandingEffects !== undefined ? { maxOutstandingEffects } : {}),
    ...(egressRatePerSecond !== undefined ? { egressRatePerSecond } : {}),
    ...(storeReadThrough !== undefined ? { storeReadThrough } : {}),
    ...(overlapWaveCommit !== undefined ? { overlapWaveCommit } : {}),
    ...(parkedRuntimeRetentionMs !== undefined
      ? { parkedRuntimeRetentionMs }
      : {}),
  };
}

/**
 * The RULED test switch for the serving loop's space-root ensure (OW45
 * arm-B stage 1, RULED 2026-08-24 — the owner: production spaces always
 * get a default pattern; "for tests this is annoying overhead", so test
 * harnesses may switch the ensure off). `SERVER_EXECUTION_ENSURE_SPACE_ROOTS`:
 * unset or "true" = ON (the production posture); the literal "false" =
 * OFF for every space this toolshed serves (a whole-instance switch —
 * per-space discrimination is deferred by the same ruling). Parsing is
 * FAIL-TO-PRODUCTION: garbage reads as ON with a warning, so a typo can
 * never silently strip production spaces of their roots.
 */
export function ensureSpaceRootsFromEnv(
  envGet: EnvReader,
  warn: (message: string) => void = (message) => console.warn(message),
): boolean {
  const raw = envGet("SERVER_EXECUTION_ENSURE_SPACE_ROOTS");
  if (raw === undefined || raw === "" || raw === "true") return true;
  if (raw === "false") return false;
  warn(
    "Server-execution v2: ignoring SERVER_EXECUTION_ENSURE_SPACE_ROOTS=" +
      `${JSON.stringify(raw)} (expected "true" or "false"); the space-root ` +
      "ensure stays ON (the production posture)",
  );
  return true;
}

/**
 * Whether the serving loop runs in a Worker of this process
 * (`SERVER_EXECUTION_WORKER`): the literal `true` selects the worker; `false`
 * and unset keep the loop on this thread, and anything else warns and keeps
 * it there.
 */
export function serverExecutionWorkerFromEnv(
  envGet: EnvReader,
  warn: (message: string) => void = (message) => console.warn(message),
): boolean {
  const raw = envGet("SERVER_EXECUTION_WORKER");
  if (raw === "true") return true;
  if (raw !== undefined && raw !== "" && raw !== "false") {
    warn(
      "Server-execution v2: ignoring SERVER_EXECUTION_WORKER=" +
        `${JSON.stringify(raw)} (expected "true" or "false"); the serving ` +
        "loop stays on the main thread",
    );
  }
  return false;
}

/**
 * Start the serving loop when the flag is on: in a Worker of this process
 * under `SERVER_EXECUTION_WORKER`, on this thread otherwise. Called once from
 * toolshed startup, after the memory server exists. Returns the loop (or
 * undefined off the flag) so shutdown can close it.
 */
export function startServerExecutionHost(options: {
  server: MemoryServer;
  identity: Identity;

  /** The patterns/compile base — the serving runtimes' `apiUrl`. */
  apiUrl: URL;

  /**
   * The serving runtimes' outbound fetch on the main thread; unset, the
   * platform fetch. The worker's entry (`lib/serving-worker.ts`) builds the
   * same self-directed fetch in its own realm, and this one does not reach
   * it.
   */
  fetch?: RuntimeFetch;

  envGet?: EnvReader;
}): ServingLoop | undefined {
  const envGet = options.envGet ?? Deno.env.get;
  // The process's ONE flag resolution (server-execution-flag.ts): the
  // explicit env value, else the first-party default — the same answer
  // the memory route used for its service-principal grant.
  if (!serverExecutionEnabledFromEnv(envGet)) {
    return undefined;
  }
  // The other experimental flags still reach the serving runtimes from env.
  const experimental = experimentalOptionsFromEnv(envGet);
  console.log(
    `Server-execution v2: serving loop ON (service ${options.identity.did()})`,
  );
  // Phase 6 policy knobs — see `serverExecutionPolicyFromEnv`.
  const ensureSpaceRoots = ensureSpaceRootsFromEnv(envGet);
  if (!ensureSpaceRoots) {
    console.log(
      "Server-execution v2: space-root ensure OFF by " +
        "SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false (test posture; " +
        "production default is ON)",
    );
  }
  const policy = serverExecutionPolicyFromEnv(envGet);
  if (policy.storeReadThrough === true) {
    console.log(
      "Server-execution v2: store read-through ON by " +
        "SERVER_EXECUTION_STORE_READ_THROUGH=true (serving runtimes read " +
        "their home space from the engine; default is OFF)",
    );
  }
  if (policy.flushDeadlineMaxMs !== undefined) {
    // The space server treats a cap no longer than the deadline as no cap.
    const base = policy.flushDeadlineMs ?? DEFAULT_FLUSH_DEADLINE_MS;
    if (policy.flushDeadlineMaxMs > base) {
      console.log(
        "Server-execution v2: flush deadline grows after a cut settle, up " +
          `to ${policy.flushDeadlineMaxMs} ms, by ` +
          "SERVER_EXECUTION_FLUSH_DEADLINE_MAX_MS (default is a fixed deadline)",
      );
    } else {
      console.warn(
        "Server-execution v2: ignoring SERVER_EXECUTION_FLUSH_DEADLINE_MAX_MS=" +
          `${policy.flushDeadlineMaxMs} (no longer than the ${base} ms ` +
          "deadline); the deadline stays fixed",
      );
    }
  }
  if (policy.overlapWaveCommit === true) {
    console.log(
      "Server-execution v2: overlapped wave commit ON by " +
        "SERVER_EXECUTION_OVERLAP_COMMIT=true (a wave's commit is in flight " +
        "while the next cycle drains and settles; default is OFF)",
    );
  }
  if (serverExecutionWorkerFromEnv(envGet)) {
    console.log(
      "Server-execution v2: serving loop in a Worker by " +
        "SERVER_EXECUTION_WORKER=true (default is the main thread)",
    );
    // The worker's entry adds the lifecycle verbs, the self-directed fetch
    // and the module cache itself (lib/serving-worker.ts).
    const worker = new ServingWorker({
      server: options.server,
      identity: options.identity,
      apiUrl: options.apiUrl,
      workerModule: new URL("./serving-worker.ts", import.meta.url),
      policy,
      ensureSpaceRoots,
      experimental,
    });
    loop = {
      runLifecycleVerb: (space, verb) => worker.runLifecycleVerb(space, verb),
      stats: () => worker.stats(),
      diagnostics: () => worker.diagnostics(),
      host: undefined,
      close: () => worker.close(),
    };
  } else {
    const host = new ExecutorHost({
      policy,
      ensureSpaceRoots,
      server: options.server,
      serviceIdentity: options.identity.did(),
      // The serving runtimes' own flags: the environment's, with the ones
      // every serving runtime forces on top. `/api/meta` publishes those same
      // forced flags below.
      createRuntime: servingRuntimeFactory({
        server: options.server,
        identity: options.identity,
        apiUrl: options.apiUrl,
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        experimental,
        // One cache for every space this host serves. A space's root pattern
        // compiles into that space's own storage closure, which a fresh space
        // never holds; the shared cache is what lets a later space's
        // activation skip the transform-and-emit step for modules this
        // process compiled.
        moduleByteCache: new ProcessModuleByteCache(),
      }),
    });
    loop = {
      ...servedLifecycleRunner(host, options.identity),
      stats: () => host.stats(),
      diagnostics: () =>
        Promise.resolve({
          loggerCounts: getLoggerCountsBreakdown(),
          timingStats: getTimingStatsBreakdown(),
        }),
      host,
      close: () => host.close(),
    };
  }
  // Only now, with the loop actually up: what `/api/meta` adds to the base
  // posture, so a client adopting this deployment's flags gets the ones the
  // SERVING runtimes run rather than only the generic webhook runtime's.
  publishServingExperimentalOverrides(SERVING_RUNTIME_EXPERIMENTAL);
  return loop;
}

/**
 * The serving loop while it runs, for the routes that hand it work — the
 * pattern-lifecycle verbs among them; `undefined` off the flag.
 */
export function serverExecutionHost(): ServingLoop | undefined {
  return loop;
}

export async function stopServerExecutionHost(): Promise<void> {
  await loop?.close();
  loop = undefined;
  // Nothing serves any more, so `/api/meta` reports the base posture again.
  publishServingExperimentalOverrides(null);
}
