/**
 * Multi-user mode for `cf test`.
 *
 * A multi-user test file exports a descriptor as its default export:
 *
 * ```tsx
 * export const setup = pattern(() => ({ chat: GroupChatDemo({}) }));
 * export const alice = pattern<{ setup: Setup }>(({ setup }) => ({
 *   [TESTS]: [
 *     { action: action_save_alice },
 *     { label: "alice-saved" },
 *     { await: "bob-saved" },
 *     { assertion: assert_sees_bob },
 *   ],
 * }));
 * export const bob = pattern<{ setup: Setup }>(({ setup }) => ({
 *   [TESTS]: [
 *     { await: "alice-saved" },
 *     { assertion: assert_sees_alice },
 *     { action: action_save_bob },
 *     { label: "bob-saved" },
 *   ],
 * }));
 * export default { setup, participants: { alice, bob } };
 * ```
 *
 * Each participant runs in its own worker realm with its own identity
 * (`{ pattern, user: "alice" }` shares an identity for a second session of
 * the same user), all against one shared space on an in-process storage
 * server. The `setup` pattern instantiates the shared piece once; every
 * worker runs that same instance locally (like every browser tab does), so
 * per-user scoped state behaves like production.
 *
 * Coordination: a participant's steps run in order until an
 * `{ await: marker }` for a marker no other participant has announced via
 * `{ label: marker }` yet; the orchestrator then switches to the next
 * runnable participant. If every unfinished participant is parked, the test
 * fails with a deadlock report.
 *
 * A marker is also a durable write in the shared space, which is what makes
 * the handshake a data barrier. Each participant announces into its own
 * marker document, committing after everything it has already committed;
 * crossing a marker waits for it to arrive in the awaiting participant's
 * replica. By then the server holds what the announcing participant wrote
 * first, so the reads that follow resolve against it. An assertion placed
 * after a marker is therefore read once, and a false value is a failure.
 */

import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import { Identity, realmValueFromKeyPair } from "@commonfabric/identity";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { terminateWorker } from "@commonfabric/utils/worker-lifetime";
import type {
  TestResult,
  TestRunnerOptions,
  TestRunResult,
} from "./test-runner.ts";
import type {
  ParticipantInitResult,
  StepMeta,
  WorkerLifetimeNotice,
  WorkerRequest,
  WorkerResponse,
} from "./multi-user-test-worker.ts";

export interface MultiUserParticipantSpec {
  name: string;

  /** Identity seed; participants with the same `user` share an identity. */
  user: string;
}

export interface MultiUserDescriptorMeta {
  participants: MultiUserParticipantSpec[];
}

/**
 * Recognize a multi-user descriptor (default export with a `participants`
 * record of pattern factories or `{ pattern, user? }` entries). Returns the
 * orchestration metadata, or undefined for ordinary single-runtime tests.
 */
export function multiUserDescriptorMeta(
  defaultExport: unknown,
): MultiUserDescriptorMeta | undefined {
  if (
    !isObjectOrArray(defaultExport) ||
    typeof (defaultExport as { participants?: unknown }).participants !==
      "object"
  ) {
    return undefined;
  }
  const raw = (defaultExport as { participants: Record<string, unknown> })
    .participants;
  const participants: MultiUserParticipantSpec[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry === "function") {
      participants.push({ name, user: name });
    } else if (
      isObjectOrArray(entry) &&
      typeof (entry as { pattern?: unknown }).pattern === "function"
    ) {
      const user = (entry as { user?: unknown }).user;
      participants.push({
        name,
        user: typeof user === "string" ? user : name,
      });
    } else {
      return undefined;
    }
  }
  return participants.length > 0 ? { participants } : undefined;
}

class ParticipantWorker {
  readonly name: string;
  #worker: Worker;
  #lifetimeLock?: string;
  #nextId = 1;
  #failure?: Error;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(name: string, onError: (error: Error) => void) {
    this.name = name;
    this.#worker = new Worker(
      new URL("./multi-user-test-worker.ts", import.meta.url),
      { type: "module", name: `cf-test:${name}` },
    );
    this.#worker.onmessage = (
      event: MessageEvent<WorkerResponse | WorkerLifetimeNotice>,
    ) => {
      if ("lifetimeLock" in event.data) {
        this.#lifetimeLock = event.data.lifetimeLock;
        return;
      }
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      if ("error" in event.data) {
        pending.reject(new Error(`[${this.name}] ${event.data.error}`));
      } else {
        pending.resolve(event.data.ok);
      }
    };
    this.#worker.onerror = (event) => {
      event.preventDefault();
      onError(new Error(`[${this.name}] worker error: ${event.message}`));
    };
  }

  call(
    cmd: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    const request: WorkerRequest = { id, cmd, args };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage(request);
    });
  }

  /**
   * Rejects pending and future calls with `error`, and terminates the worker,
   * settling once it has been torn down.
   */
  async terminate(
    error = new Error(`[${this.name}] worker terminated`),
  ): Promise<void> {
    this.#fail(error);
    await terminateWorker(this.#worker, this.#lifetimeLock);
  }

  /** Reject pending and future calls once the worker cannot answer them. */
  #fail(error: Error): void {
    this.#failure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

interface ParticipantState {
  spec: MultiUserParticipantSpec;
  worker: ParticipantWorker;
  steps: StepMeta[];
  cursor: number;
  actionCount: number;
  assertionCount: number;
  lastActionName: string | null;
  allowRuntimeErrors: boolean;
  expectNonIdempotent: boolean;
  allowConsoleErrors: boolean;
  allowConsoleWarnings: boolean;
}

/**
 * Check one participant against the rung the run named.
 *
 * A participant builds its own runtime in its own worker, so the mode a run
 * names is honored in as many places as there are participants. The rung read
 * back off each built runtime is checked here, and the participant that is not
 * on it is named. A run that names no mode leaves every participant to its
 * preset.
 */
export function assertParticipantRung(
  participant: string,
  named: CfcEnforcementMode | undefined,
  reached: CfcEnforcementMode,
): void {
  if (named !== undefined && reached !== named) {
    throw new Error(
      `participant "${participant}" came up at CFC ${reached}, not the ` +
        `${named} this run names`,
    );
  }
}

export async function runMultiUserTestPattern(
  testPath: string,
  meta: MultiUserDescriptorMeta,
  options: TestRunnerOptions = {},
): Promise<TestRunResult> {
  // A caller supplying a store means to read what the run wrote, and to be
  // told what it instantiated (see `TestRunnerOptions.storageHost`). The
  // participants do both in workers of their own, against a storage server
  // this function starts, so the caller's store and observer come back empty
  // while the participants' assertions pass.
  if (options.storageHost !== undefined) {
    throw new Error(
      `${testPath} is a multi-user test: its participants run in workers of ` +
        `their own, against a storage server this runner starts, so a ` +
        `caller-supplied \`storageHost\` would be handed back unwritten`,
    );
  }
  const startTime = performance.now();
  const results: TestResult[] = [];
  const runtimeErrors: string[] = [];
  const nonIdempotent: string[] = [];
  let runResult: TestRunResult | undefined;

  const server = StandaloneMemoryServer.start();
  const participants: ParticipantState[] = [];
  const workers: ParticipantWorker[] = [];

  try {
    const identities = new Map<string, Identity>();
    for (const spec of meta.participants) {
      if (!identities.has(spec.user)) {
        identities.set(
          spec.user,
          await Identity.fromPassphrase(`test-runner ${spec.user}`, {
            implementation: "noble",
          }),
        );
      }
    }

    // The first participant creates the shared space, and every participant
    // may write to it.
    const owner = identities.get(meta.participants[0].user)!;
    const creator = StorageManager.open({ as: owner, memoryHost: server.url });
    let spaceDid: string;
    try {
      spaceDid = await creator.createSpace({
        ...Object.fromEntries(
          [...identities.values()].map((identity) => [identity.did(), "WRITE"]),
        ),
        [owner.did()]: "OWNER",
      });
    } finally {
      await creator.close();
    }

    // Sequential init: the first worker materializes the shared setup
    // instance (and the wish("#default") seed); the rest resume it.
    for (const [index, spec] of meta.participants.entries()) {
      const worker = new ParticipantWorker(spec.name, (error) => {
        // The failed worker may be idle while another participant is waiting.
        // Reject every worker's requests so that failure reaches the active
        // await, including during initialization, and cleanup can proceed.
        // Every worker is terminated again, and waited for, on the way out.
        for (const worker of workers) void worker.terminate(error);
      });
      workers.push(worker);
      try {
        const init = await worker.call("init", {
          identity: realmValueFromKeyPair(
            identities.get(spec.user)!.keyPair,
          ),
          spaceDid,
          apiUrl: server.url.href,
          testPath,
          root: options.root,
          // Each participant compiles the pattern in its own worker, so the
          // attachment has to cross that boundary: a participant reading a data
          // file otherwise fails for want of a closure the parent had.
          dataFilePaths: options.dataFilePaths,
          patternCoverageDir: options.patternCoverageDir,
          continuousUI: options.continuousUI,
          noIdempotencyCheck: options.noIdempotencyCheck,
          participant: spec.name,
          participants: meta.participants.map((p) => p.name),
          seedDefaults: index === 0,
          // A test that names a mode names it for every participant, the way
          // the single-user runner honors it.
          cfcEnforcementMode: options.cfcEnforcementMode,
          cfcFlowLabels: options.cfcFlowLabels,
          cfcDenials: options.cfcDenials,
        }) as ParticipantInitResult;
        assertParticipantRung(
          spec.name,
          options.cfcEnforcementMode,
          init.cfcEnforcementMode,
        );
        if (
          options.cfcFlowLabels !== undefined &&
          init.cfcFlowLabels !== options.cfcFlowLabels
        ) {
          throw new Error(
            `Participant "${spec.name}" resolved flow labels to ${init.cfcFlowLabels}, expected ${options.cfcFlowLabels}`,
          );
        }
        console.log(
          `  [${spec.name}] CFC posture: enforcement=${init.cfcEnforcementMode} flowLabels=${init.cfcFlowLabels}`,
        );
        participants.push({
          spec,
          worker,
          steps: init.steps,
          cursor: 0,
          actionCount: 0,
          assertionCount: 0,
          lastActionName: null,
          allowRuntimeErrors: init.allowRuntimeErrors,
          expectNonIdempotent: init.expectNonIdempotent,
          allowConsoleErrors: init.allowConsoleErrors,
          allowConsoleWarnings: init.allowConsoleWarnings,
        });
        if (options.verbose) {
          console.log(
            `  [${spec.name}] ${init.steps.length} step(s), user "${spec.user}"`,
          );
        }
      } catch (error) {
        await worker.call("dispose").catch(() => {});
        await worker.terminate();
        throw error;
      }
    }

    // Marker scheduler: round-robin in declaration order; each turn runs a
    // participant's steps until it parks on an unannounced marker or ends.
    const announced = new Map<string, string>();
    while (participants.some((p) => p.cursor < p.steps.length)) {
      let progressed = false;
      for (const participant of participants) {
        while (participant.cursor < participant.steps.length) {
          const index = participant.cursor;
          const step = participant.steps[index];
          if (step.kind === "await" && !step.skip) {
            const announcedBy = announced.get(step.marker!);
            if (announcedBy === undefined) break; // parked
            // The marker is announced, so the server holds it. Wait for it to
            // reach this participant's replica; whatever the announcing
            // participant committed first is already on the server, so the
            // reads that follow resolve against it.
            await participant.worker.call("awaitMarker", {
              announcedBy,
              marker: step.marker,
            }).catch((cause: Error) => {
              throw new Error(
                `[${participant.spec.name}] waiting for marker ` +
                  `"${step.marker}" announced by ${announcedBy}: ` +
                  cause.message,
                { cause },
              );
            });
            participant.cursor++;
            progressed = true;
            if (options.verbose) {
              console.log(`  [${participant.spec.name}] ⇣ ${step.marker}`);
            }
            continue;
          }
          participant.cursor++;
          progressed = true;
          if (step.skip) {
            recordSkip(participant, step, results, options);
            continue;
          }
          if (step.kind === "label") {
            // Commit before announcing, so a participant released by the
            // announcement always finds a marker the server already holds.
            await participant.worker.call("label", { marker: step.marker });
            announced.set(step.marker!, participant.spec.name);
            if (options.verbose) {
              console.log(`  [${participant.spec.name}] ⇡ ${step.marker}`);
            }
            continue;
          }
          if (step.kind === "action") {
            participant.actionCount++;
            participant.lastActionName = `action_${participant.actionCount}`;
            const stepStart = performance.now();
            await participant.worker.call("action", { index });
            if (options.verbose) {
              console.log(
                `  [${participant.spec.name}] ${participant.lastActionName} (${
                  Math.round(performance.now() - stepStart)
                }ms)`,
              );
            }
            continue;
          }
          if (step.kind === "render") {
            const stepStart = performance.now();
            await participant.worker.call("render", { index });
            if (options.verbose) {
              console.log(
                `  [${participant.spec.name}] ◇ render (${
                  Math.round(performance.now() - stepStart)
                }ms)`,
              );
            }
            continue;
          }
          if (step.kind === "settle") {
            const stepStart = performance.now();
            await participant.worker.call("settleStep");
            if (options.verbose) {
              console.log(
                `  [${participant.spec.name}] ⋯ settle (${
                  Math.round(performance.now() - stepStart)
                }ms)`,
              );
            }
            continue;
          }
          // Assertion: read once. The step that preceded it settled this
          // participant's own work, and a marker it crossed carried the other
          // participants' work with it, so a false value here is a failure.
          participant.assertionCount++;
          const name =
            `${participant.spec.name}/assertion_${participant.assertionCount}`;
          const stepStart = performance.now();
          let passed = false;
          let error: string | undefined;
          try {
            const outcome = await participant.worker.call("assertion", {
              index,
            }) as { passed: boolean; error?: string };
            passed = outcome.passed;
            error = outcome.error;
          } catch (assertionError) {
            passed = false;
            error = String(
              (assertionError as Error).message ?? assertionError,
            );
          }
          const durationMs = performance.now() - stepStart;
          // runTests prints each result; no per-step echo here.
          results.push({
            name,
            passed,
            afterAction: participant.lastActionName === null
              ? null
              : `${participant.spec.name}/${participant.lastActionName}`,
            ...(error !== undefined ? { error } : {}),
            durationMs,
          });
        }
      }
      if (!progressed) {
        const parked = participants
          .filter((p) => p.cursor < p.steps.length)
          .map((p) => `${p.spec.name} awaits "${p.steps[p.cursor].marker}"`)
          .join("; ");
        throw new Error(
          `Deadlock: every remaining participant is parked (${parked}). ` +
            `Check {label}/{await} markers for a cycle or a missing label.`,
        );
      }
    }

    // Apply allowRuntimeErrors / expectNonIdempotent / allowConsoleErrors /
    // allowConsoleWarnings PER participant — one participant opting out must
    // not mask another participant's failures — so the aggregate result reports
    // only unallowed entries with the flags left off.
    let anyExpectNonIdempotent = false;
    let expectedNonIdempotentDetected = false;
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];
    for (const participant of participants) {
      const health = await participant.worker.call("health") as {
        runtimeErrors: string[];
        consoleErrors: string[];
        consoleWarnings: string[];
        nonIdempotent: string[];
      };
      if (!participant.allowRuntimeErrors) {
        runtimeErrors.push(
          ...health.runtimeErrors.map((e) => `[${participant.spec.name}] ${e}`),
        );
      }
      if (!participant.allowConsoleErrors) {
        consoleErrors.push(
          ...health.consoleErrors.map((e) => `[${participant.spec.name}] ${e}`),
        );
      }
      if (!participant.allowConsoleWarnings) {
        consoleWarnings.push(
          ...health.consoleWarnings.map((e) =>
            `[${participant.spec.name}] ${e}`
          ),
        );
      }
      if (participant.expectNonIdempotent) {
        anyExpectNonIdempotent = true;
        if (health.nonIdempotent.length > 0) {
          expectedNonIdempotentDetected = true;
        }
      } else {
        nonIdempotent.push(
          ...health.nonIdempotent.map((e) => `[${participant.spec.name}] ${e}`),
        );
      }
    }
    // expectNonIdempotent asserts the detector fires. Which runtime re-runs
    // the offending computation depends on sync/scheduling, so the
    // expectation is satisfied when ANY flagged participant saw a violation;
    // it fails as a synthetic result when none did (the aggregate's flag
    // field stays unset, so runTests applies no result-level expectation).
    if (anyExpectNonIdempotent && !expectedNonIdempotentDetected) {
      results.push({
        name: "expectNonIdempotent",
        passed: false,
        afterAction: null,
        error: "expected non-idempotent computation(s), none detected",
        durationMs: 0,
      });
    }

    return runResult = {
      path: testPath,
      results,
      totalDurationMs: performance.now() - startTime,
      navigations: [],
      runtimeErrors,
      nonIdempotent,
      consoleErrors,
      consoleWarnings,
    };
  } catch (error) {
    return runResult = {
      path: testPath,
      results,
      totalDurationMs: performance.now() - startTime,
      navigations: [],
      runtimeErrors,
      nonIdempotent,
      consoleErrors: [],
      consoleWarnings: [],
      error: error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}`
        : String(error),
    };
  } finally {
    let teardownError: Error | undefined;
    for (const participant of participants) {
      if (options.patternCoverageDir) {
        await participant.worker.call("writeCoverage").catch((error) => {
          console.error(
            `[cf test] failed to write pattern coverage for ${participant.spec.name}: ${
              formatError(error)
            }`,
          );
        });
      }
      await participant.worker.call("dispose").catch((error: Error) => {
        console.error(
          `[cf test] teardown failed for ${participant.spec.name}: ${
            formatError(error)
          }`,
        );
        teardownError ??= error;
      });
      await participant.worker.terminate();
    }
    await server.close().catch(() => {});
    if (teardownError) {
      // A throw from `finally` replaces the pending result. Keep that result
      // visible, including step and runtime health failures, before raising.
      if (runResult) {
        console.error(
          `[cf test] result before teardown failure for ${testPath}:\n${
            JSON.stringify(runResult, null, 2)
          }`,
        );
      }
      // deno-lint-ignore no-unsafe-finally
      throw teardownError;
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? error.stack || error.message || String(error)
    : String(error);
}

function recordSkip(
  participant: ParticipantState,
  step: StepMeta,
  results: TestResult[],
  options: TestRunnerOptions,
): void {
  if (step.kind === "assertion") {
    participant.assertionCount++;
    const name =
      `${participant.spec.name}/assertion_${participant.assertionCount}`;
    results.push({
      name,
      passed: true,
      skipped: true,
      afterAction: null,
      durationMs: 0,
    });
  } else if (step.kind === "action") {
    participant.actionCount++;
    if (options.verbose) {
      console.log(
        `  [${participant.spec.name}] ⊘ action_${participant.actionCount} (skipped)`,
      );
    }
  }
}
