/**
 * The agent runner's queue mechanics: what `cf agent runner` does between
 * reading a user's agent queue and handing one claimed run to an executor.
 *
 * A runner holds one user's identity. It registers itself in the queue's
 * `agentRunner` entry, subscribes to the queue's `entries`, and follows each
 * entry to its `AgentRun` record on whichever host serves the record's space.
 * Queue and record changes wake scans, and a scheduled wake revisits expired
 * leases or retries a failed scan. A scan ends cancelled runs, recovers
 * records whose lease has passed, and claims the oldest queued records under
 * the concurrency cap. The run itself is the executor's, which
 * `agent-run-harness.ts` backs with `cf-harness`.
 */

import type { Cell, NormalizedFullLink, Runtime } from "@commonfabric/runner";
import {
  AGENT_RUN_TERMINAL_STATES,
  type AgentQueueIndex,
  agentQueueIndexCell,
  type AgentRunErrorCode,
  type AgentRunRecord,
  AgentRunRecordSchema,
  CANCELLED,
  PROVIDER_FAILURE,
  REFUSED,
  RUNNER_LOST,
} from "@commonfabric/runner/agent-run";
import type { MemorySpace } from "@commonfabric/runner/storage/cache.deno";
import { addressKey } from "@commonfabric/runner/shared";
import { stringTupleKey } from "@commonfabric/utils/string-tuple-key";

/** The `agentRunner` entry a runner writes into the user's queue. */
export type AgentRunnerEntry = NonNullable<AgentQueueIndex["agentRunner"]>;

/** What a finished run reports beside its outcome. */
export interface AgentRunReport {
  /** Model usage, as the harness reports it: direct plus descendant loops. */
  usage?: Record<string, unknown>;

  usageCoverage?: "direct" | "including-descendants";
  modelTurns?: number;
  toolCalls?: number;

  /** Operator-only reference to the run's artifact root. */
  runRef?: string;
}

/** How one run ended, as its executor reports it. */
export type AgentRunExecution =
  & { report?: AgentRunReport }
  & (
    | { outcome: "completed"; result: NormalizedFullLink }
    | { outcome: "failed"; errorCode: AgentRunErrorCode }
    | { outcome: "refused" }
    | { outcome: "cancelled" }
  );

/** One claimed run, as its executor receives it. */
export interface ClaimedAgentRun {
  /** The record as it read when the run started. */
  record: AgentRunRecord;

  /** The record's address. */
  link: NormalizedFullLink;

  /** The origin of the toolshed serving the record's space. */
  host: string;

  /** Aborted when the requester cancels the run or the runner stops. */
  signal: AbortSignal;

  /**
   * Moves the claim's `leaseUntil` forward. The executor calls it on every
   * durable write the run makes, so the lease measures silence rather than
   * time since the run started.
   */
  renewLease: () => Promise<void>;
}

export interface AgentRunnerOptions {
  /** The user's home space, which holds their queue. */
  homeSpace: MemorySpace;

  /** The origin of the toolshed serving the home space. */
  homeHost: string;

  /**
   * The origin of the toolshed this runner sits beside, written as the
   * `agentRunner` entry's `host`.
   */
  runnerHost: string;

  /** The name this process claims under; unique per process. */
  runnerId: string;

  /** The tool names this runner offers. */
  tools: readonly string[];

  /** How many runs this process holds at once. */
  maxConcurrent: number;

  /** How far ahead of the last durable write a lease reaches. */
  leaseMs: number;

  /** A runtime connected, as the user, to the toolshed at `host`. */
  runtimeForHost: (host: string) => Promise<Runtime>;

  /** Writes the `agentRunner` entry through the queue's authorized writer. */
  registerRunner: (
    entry: AgentRunnerEntry | undefined,
    expectedRegistrationId?: string,
  ) => Promise<void>;

  /** Runs one claimed record to its outcome. */
  execute: (run: ClaimedAgentRun) => Promise<AgentRunExecution>;

  now?: () => Date;

  /** Schedules a wake at `deadline`, returning a function that cancels it. */
  scheduleAt?: (deadline: Date, wake: () => void) => () => void;

  /** Operator-facing progress lines. */
  report?: (message: string) => void;
}

/** A record this runner follows. */
type FollowedRecord = {
  host: string;
  runtime: Runtime;
  record: Cell<AgentRunRecord>;
  stopFollowing: () => void;
};

/** A run this runner holds. */
type ActiveRun = {
  abort: AbortController;
  token: object;
  finished?: Promise<void>;
};

/** Helper for {@link AgentRunner}, which names a record across hosts. */
const recordKey = (host: string, link: NormalizedFullLink): string =>
  stringTupleKey([host, addressKey(link)]);

/**
 * One user's runner over their agent queue. `start()` registers it and
 * begins following the queue; `stop()` aborts the runs it holds and stops
 * following. `idle()` resolves once no scan is pending and no run is held.
 */
export class AgentRunner {
  readonly #options: AgentRunnerOptions;
  readonly #now: () => Date;
  readonly #followed = new Map<string, FollowedRecord>();
  readonly #active = new Map<string, ActiveRun>();
  #registeredAt: string | undefined;
  #stopQueue: (() => void) | undefined;
  #scan: Promise<void> | undefined;
  #scanRequested = false;
  #cancelScheduledWake: (() => void) | undefined;
  #stopped = false;

  constructor(options: AgentRunnerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** Registers the runner and begins following the user's queue. */
  async start(): Promise<void> {
    const { homeHost, homeSpace } = this.#options;
    const runtime = await this.#options.runtimeForHost(homeHost);
    const queue = agentQueueIndexCell(runtime, homeSpace);
    await queue.sync();
    this.#registeredAt = this.#now().toISOString();
    await this.#register();
    try {
      // The subscription's first call is the scan on start; every later call
      // is an index change.
      this.#stopQueue = queue.key("entries").sink(() => this.#requestScan());
    } catch (error) {
      try {
        await this.#options.registerRunner(
          undefined,
          this.#options.runnerId,
        );
      } catch (cleanupError) {
        this.#options.report?.(
          `agent runner: could not clear a failed registration: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
        );
      }
      throw error;
    }
  }

  /** Aborts held runs, waits for them to end, and stops following. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cancelScheduledWake?.();
    this.#cancelScheduledWake = undefined;
    this.#stopQueue?.();
    // A claim already committing must become active before we abort held runs.
    await this.#scan;
    for (const run of this.#active.values()) {
      run.abort.abort(new Error("the agent runner is stopping"));
    }
    await this.idle();
    for (const followed of this.#followed.values()) {
      followed.stopFollowing();
    }
    this.#followed.clear();
    if (this.#registeredAt !== undefined) {
      await this.#options.registerRunner(
        undefined,
        this.#options.runnerId,
      );
      this.#registeredAt = undefined;
    }
  }

  /** Resolves once no scan is pending and no run is held. */
  async idle(): Promise<void> {
    while (this.#scan !== undefined || this.#active.size > 0) {
      await Promise.all([
        this.#scan,
        ...[...this.#active.values()].flatMap((run) =>
          run.finished === undefined ? [] : [run.finished]
        ),
      ]);
    }
  }

  /** The number of runs this runner holds. */
  get activeRuns(): number {
    return this.#active.size;
  }

  /** Helper for the runner, which writes or refreshes its registration. */
  #register(lastClaimAt?: string): Promise<void> {
    const { runnerHost, tools } = this.#options;
    return this.#options.registerRunner({
      host: runnerHost,
      tools: [...tools],
      registrationId: this.#options.runnerId,
      registeredAt: this.#registeredAt!,
      ...(lastClaimAt !== undefined ? { lastClaimAt } : {}),
    });
  }

  /** Replaces the pending timed wake with one at `deadline`. */
  #scheduleWake(deadline: Date): void {
    this.#cancelScheduledWake?.();
    const scheduleAt = this.#options.scheduleAt ?? ((at, wake) => {
      const timer = setTimeout(
        wake,
        Math.max(0, at.getTime() - this.#now().getTime()),
      );
      return () => clearTimeout(timer);
    });
    this.#cancelScheduledWake = scheduleAt(deadline, () => {
      this.#cancelScheduledWake = undefined;
      this.#requestScan();
    });
  }

  /**
   * Runs a scan now, or marks one wanted when a scan is in flight, so that
   * scans never overlap and a change arriving mid-scan is not lost.
   */
  #requestScan(): void {
    if (this.#stopped) return;
    this.#scanRequested = true;
    if (this.#scan !== undefined) return;
    this.#scan = (async () => {
      try {
        while (this.#scanRequested && !this.#stopped) {
          this.#scanRequested = false;
          await this.#scanOnce();
        }
      } catch (error) {
        this.#options.report?.(
          `agent runner: a queue scan failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        this.#scheduleWake(new Date(this.#now().getTime() + 1_000));
      } finally {
        this.#scan = undefined;
      }
    })();
  }

  /** Helper for the scan, which follows every record the queue names. */
  async #followEntries(): Promise<boolean> {
    const runtime = await this.#options.runtimeForHost(
      this.#options.homeHost,
    );
    const entries = agentQueueIndexCell(runtime, this.#options.homeSpace)
      .key("entries").get() ?? [];
    const present = new Set(
      entries.map((entry) =>
        recordKey(entry.host, entry.run.getAsNormalizedFullLink())
      ),
    );
    for (const [key, followed] of this.#followed) {
      if (present.has(key)) continue;
      followed.stopFollowing();
      this.#followed.delete(key);
    }
    let failed = false;
    for (const entry of entries) {
      const link = entry.run.getAsNormalizedFullLink();
      const key = recordKey(entry.host, link);
      if (this.#followed.has(key)) continue;
      try {
        const hostRuntime = await this.#options.runtimeForHost(entry.host);
        const record = hostRuntime.getCellFromLink(
          link,
          AgentRunRecordSchema,
        ) as unknown as Cell<AgentRunRecord>;
        await record.sync();
        this.#followed.set(key, {
          host: entry.host,
          runtime: hostRuntime,
          record,
          // A record's change — a cancel, another runner's claim — wakes the
          // runner the way an index change does.
          stopFollowing: record.sink(() => this.#requestScan()),
        });
      } catch (error) {
        failed = true;
        this.#options.report?.(
          `agent runner: could not follow ${key}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return failed;
  }

  /** One pass over the queue: cancels, recovery, then claims. */
  async #scanOnce(): Promise<void> {
    this.#cancelScheduledWake?.();
    this.#cancelScheduledWake = undefined;
    const followFailed = await this.#followEntries();
    const now = this.#now();
    let nextWake = followFailed ? new Date(now.getTime() + 1_000) : undefined;
    const queued: { key: string; followed: FollowedRecord; at: string }[] = [];

    for (const [key, followed] of this.#followed) {
      const value = followed.record.get();
      if (value === undefined) continue;
      if (AGENT_RUN_TERMINAL_STATES.has(value.state)) continue;
      const active = this.#active.get(key);

      if (value.cancelRequestedAt !== undefined) {
        if (active !== undefined) {
          active.abort.abort(new Error("the requester cancelled the run"));
        } else if (value.state === "queued") {
          await this.#cancelQueued(followed);
          continue;
        }
      }

      if (value.state === "queued") {
        const offered = (value.tools ?? []).every((tool) =>
          this.#options.tools.includes(tool)
        );
        if (offered) queued.push({ key, followed, at: value.submittedAt });
        continue;
      }

      const leaseUntil = value.claim?.leaseUntil;
      if (leaseUntil !== undefined && new Date(leaseUntil) > now) {
        const deadline = new Date(leaseUntil);
        if (nextWake === undefined || deadline < nextWake) {
          nextWake = deadline;
        }
        continue;
      }
      const recovered = await this.#recover(followed);
      if (
        recovered && active !== undefined &&
        this.#active.get(key)?.token === active.token
      ) {
        active.abort.abort(new Error("the agent run's lease expired"));
        this.#active.delete(key);
      }
    }

    queued.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    for (const candidate of queued) {
      if (
        this.#stopped || this.#active.size >= this.#options.maxConcurrent
      ) break;
      const deadline = await this.#claim(candidate.key, candidate.followed);
      if (
        deadline !== undefined &&
        (nextWake === undefined || deadline < nextWake)
      ) {
        nextWake = deadline;
      }
    }
    if (nextWake !== undefined && !this.#stopped) {
      this.#scheduleWake(nextWake);
    }
  }

  /**
   * Recovers a record whose runner stopped writing: back to `queued` when it
   * has been claimed once, `failed` as `RUNNER_LOST` when it has been claimed
   * twice. A cancellation request ends the expired run as `cancelled`.
   * The transaction re-reads the state and lease, so a record another runner
   * moved in the meantime is left alone. Returns whether recovery committed.
   */
  async #recover({ runtime, record }: FollowedRecord): Promise<boolean> {
    const now = this.#now();
    const stamp = now.toISOString();
    const { ok } = await runtime.editWithRetry((tx) => {
      const current = record.withTx(tx);
      const state = current.key("state").get();
      if (state !== "claimed" && state !== "running") return undefined;
      const leaseUntil = current.key("claim").get()?.leaseUntil;
      if (leaseUntil !== undefined && new Date(leaseUntil) > now) {
        return undefined;
      }
      const attempts = current.key("attempts").get() ?? 1;
      current.key("claim").set(undefined);
      current.key("stateSince").set(stamp);
      if (current.key("cancelRequestedAt").get() !== undefined) {
        current.key("state").set("cancelled");
        current.key("outcome").set("cancelled");
        current.key("errorCode").set(CANCELLED);
        current.key("finishedAt").set(stamp);
        return "cancelled";
      }
      if (attempts <= 1) {
        current.key("state").set("queued");
        return "re-queued";
      }
      current.key("state").set("failed");
      current.key("outcome").set("failed");
      current.key("errorCode").set(RUNNER_LOST);
      current.key("finishedAt").set(stamp);
      return "failed as RUNNER_LOST";
    });
    if (ok !== undefined) {
      this.#options.report?.(
        `agent runner: ${record.get()?.requestHash} lost its runner, ${ok}`,
      );
    }
    return ok !== undefined;
  }

  /** Ends a record nobody claimed, when it is still `queued`. */
  async #cancelQueued({ runtime, record }: FollowedRecord): Promise<void> {
    const stamp = this.#now().toISOString();
    await runtime.editWithRetry((tx) => {
      const current = record.withTx(tx);
      if (current.key("state").get() !== "queued") return;
      current.key("state").set("cancelled");
      current.key("stateSince").set(stamp);
      current.key("outcome").set("cancelled");
      current.key("errorCode").set(CANCELLED);
      current.key("finishedAt").set(stamp);
    });
  }

  /**
   * Claims a queued record by committing `state: claimed`, the claim, and
   * `attempts` incremented. The transaction reads `state`, so of two runners
   * racing for one record one commits and the other, re-run against the
   * winner's write, finds the record no longer queued and writes nothing.
   */
  async #claim(
    key: string,
    followed: FollowedRecord,
  ): Promise<Date | undefined> {
    const { runtime, record } = followed;
    const now = this.#now();
    const stamp = now.toISOString();
    const leaseUntil = new Date(now.getTime() + this.#options.leaseMs)
      .toISOString();
    const { ok } = await runtime.editWithRetry((tx) => {
      const current = record.withTx(tx);
      if (current.key("state").get() !== "queued") return false;
      if (current.key("cancelRequestedAt").get() !== undefined) return false;
      current.key("state").set("claimed");
      current.key("stateSince").set(stamp);
      current.key("claim").set({ runner: this.#options.runnerId, leaseUntil });
      current.key("attempts").set((current.key("attempts").get() ?? 0) + 1);
      return true;
    });
    if (ok !== true) return undefined;
    const abort = new AbortController();
    const active: ActiveRun = { abort, token: {} };
    this.#active.set(key, active);
    active.finished = this.#run(key, followed, active);
    await this.#register(stamp);
    return new Date(leaseUntil);
  }

  /**
   * Writes to a record this runner holds. The transaction checks that the
   * claim is still this runner's and the record not yet terminal, so a run
   * whose lease passed and whose record another runner recovered writes
   * nothing over that recovery. Returns whether the write was made.
   */
  async #writeHeld(
    { runtime, record }: FollowedRecord,
    write: (current: Cell<AgentRunRecord>) => void,
  ): Promise<boolean> {
    const { ok } = await runtime.editWithRetry((tx) => {
      const current = record.withTx(tx);
      const state = current.key("state").get();
      if (AGENT_RUN_TERMINAL_STATES.has(state)) return false;
      if (current.key("claim").get()?.runner !== this.#options.runnerId) {
        return false;
      }
      write(current);
      return true;
    });
    return ok === true;
  }

  /** Runs one claimed record to a terminal state. */
  async #run(
    key: string,
    followed: FollowedRecord,
    active: ActiveRun,
  ): Promise<void> {
    // Yields once, so `#claim` has recorded this run as active before the
    // run's first write wakes a scan.
    await Promise.resolve();
    const { abort } = active;
    const { record, host } = followed;
    const leaseUntil = () =>
      new Date(this.#now().getTime() + this.#options.leaseMs).toISOString();
    let execution: AgentRunExecution | undefined;
    try {
      const started = this.#now().toISOString();
      const held = await this.#writeHeld(followed, (current) => {
        current.key("state").set("running");
        current.key("stateSince").set(started);
        current.key("startedAt").set(started);
        current.key("claim").key("leaseUntil").set(leaseUntil());
      });
      if (held && this.#active.get(key)?.token === active.token) {
        const value = record.get();
        if (value === undefined) {
          throw new Error("the claimed record does not read");
        }
        this.#options.report?.(`agent runner: running ${value.requestHash}`);
        execution = await this.#options.execute({
          record: value,
          link: record.getAsNormalizedFullLink(),
          host,
          signal: abort.signal,
          renewLease: async () => {
            if (this.#active.get(key)?.token !== active.token) return;
            const renewed = await this.#writeHeld(followed, (current) => {
              current.key("claim").key("leaseUntil").set(leaseUntil());
            });
            if (renewed) this.#requestScan();
          },
        });
      }
    } catch (error) {
      this.#options.report?.(
        `agent runner: a run failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      execution = { outcome: "failed", errorCode: PROVIDER_FAILURE };
    }
    try {
      if (
        execution !== undefined &&
        this.#active.get(key)?.token === active.token
      ) {
        try {
          await this.#finish(followed, execution, abort);
        } catch (error) {
          this.#options.report?.(
            `agent runner: terminal write failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } finally {
      if (this.#active.get(key)?.token === active.token) {
        this.#active.delete(key);
        this.#requestScan();
      }
    }
  }

  /** Helper for `#run`, which writes a run's terminal fields. */
  async #finish(
    followed: FollowedRecord,
    reported: AgentRunExecution,
    abort: AbortController,
  ): Promise<void> {
    const { record, runtime } = followed;
    const finishedAt = this.#now().toISOString();
    let outcome = reported.outcome;
    const held = await this.#writeHeld(followed, (current) => {
      // A cancel wins over whatever the run reported, including one committed
      // after execution returned but before this transaction reached storage.
      const execution: AgentRunExecution = abort.signal.aborted ||
          current.key("cancelRequestedAt").get() !== undefined
        ? { outcome: "cancelled", report: reported.report }
        : reported;
      outcome = execution.outcome;
      const report = execution.report ?? {};
      const errorCode = execution.outcome === "failed"
        ? execution.errorCode
        : execution.outcome === "refused"
        ? REFUSED
        : execution.outcome === "cancelled"
        ? CANCELLED
        : undefined;
      if (execution.outcome === "completed") {
        current.key("result").set(runtime.getCellFromLink(execution.result));
      }
      current.key("state").set(execution.outcome);
      current.key("stateSince").set(finishedAt);
      current.key("finishedAt").set(finishedAt);
      current.key("outcome").set(execution.outcome);
      if (errorCode !== undefined) current.key("errorCode").set(errorCode);
      current.key("claim").set(undefined);
      if (report.usage !== undefined) current.key("usage").set(report.usage);
      if (report.usageCoverage !== undefined) {
        current.key("usageCoverage").set(report.usageCoverage);
      }
      if (report.modelTurns !== undefined) {
        current.key("modelTurns").set(report.modelTurns);
      }
      if (report.toolCalls !== undefined) {
        current.key("toolCalls").set(report.toolCalls);
      }
      if (report.runRef !== undefined) current.key("runRef").set(report.runRef);
    });
    const name = record.get()?.requestHash;
    this.#options.report?.(
      held
        ? `agent runner: ${name} ended ${outcome}`
        : `agent runner: ${name} was no longer held`,
    );
  }
}
