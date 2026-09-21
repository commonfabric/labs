/**
 * The agent runner over two in-process toolsheds, each one memory server.
 *
 * The "cloud" toolshed serves the requester's home space and, in most cases,
 * the requesting space; the "local" toolshed is the one the runner sits
 * beside. A pattern-side runtime stages requests through the real `agent`
 * builtin, and each runner under test connects to both toolsheds with
 * runtimes of its own, the way a runner process does. No model runs: a case
 * either scripts the executor outright, or runs the real harness executor
 * over a scripted prompt loop.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { HarnessPromptLoopResult } from "@commonfabric/cf-harness/prompt-loop";
import { hashStringOf } from "@commonfabric/data-model";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "@commonfabric/cf-harness/handle-table";
import { createSession, Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { PiecesController } from "@commonfabric/piece/ops";
import { type Cell, Runtime } from "@commonfabric/runner";
import {
  agentQueueIndexCell,
  type AgentRunRecord,
  AgentRunRecordSchema,
} from "@commonfabric/runner/agent-run";
import { addressKey, renderCellReference } from "@commonfabric/runner/shared";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { seedHomeAgentQueue } from "../../runner/test/support/agent-queue.ts";
import { createTrustedBuilder } from "../../runner/test/support/trusted-builder.ts";
import { createHarnessAgentRunExecutor } from "../lib/agent-run-harness.ts";
import {
  type AgentRunExecution,
  AgentRunner,
  type AgentRunnerOptions,
  type ClaimedAgentRun,
} from "../lib/agent-runner.ts";

const CLOUD = "https://cloud.example";
const LOCAL = "https://local.example";
const LEASE_MS = 60_000;

const RESULT_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
} as const;

type Server = ReturnType<typeof newLoopbackServer>;

/** A promise and its resolver, for a run a case holds open. */
const defer = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => resolve = r);
  return { promise, resolve };
};

describe("agent runner", () => {
  let signer: Identity;
  let home: `did:key:${string}`;
  let servers: Record<string, Server>;
  let runtimes: Runtime[];
  let managers: EmulatedStorageManager[];
  let runners: AgentRunner[];
  let clock: Date;
  let patternSide: Runtime;
  let requests: number;

  /** A runtime of its own on the toolshed at `host`, as the requester. */
  const connect = (host: string, options: { agentBuiltin?: boolean } = {}) => {
    const storageManager = EmulatedStorageManager.connectTo(servers[host], {
      as: signer,
    });
    const runtime = new Runtime({
      apiUrl: new URL(host),
      storageManager,
      ...(options.agentBuiltin ? { experimental: { agentBuiltin: true } } : {}),
    });
    managers.push(storageManager);
    runtimes.push(runtime);
    return runtime;
  };

  beforeEach(async () => {
    signer = await Identity.fromPassphrase(
      `agent runner ${crypto.randomUUID()}`,
    );
    home = signer.did();
    servers = {
      [CLOUD]: newLoopbackServer({ subscriptionRefreshDelayMs: 0 }),
      [LOCAL]: newLoopbackServer({ subscriptionRefreshDelayMs: 0 }),
    };
    runtimes = [];
    managers = [];
    runners = [];
    requests = 0;
    clock = new Date("2026-09-18T12:00:00.000Z");
    patternSide = connect(CLOUD, { agentBuiltin: true });
    const tx = patternSide.edit();
    seedHomeAgentQueue(patternSide, home, tx);
    await tx.commit();
    await patternSide.idle();
  });

  afterEach(async () => {
    for (const runner of runners) await runner.stop();
    for (const runtime of runtimes) {
      await runtime.idle();
      await runtime.dispose();
    }
    for (const manager of managers) await manager.close();
    for (const server of Object.values(servers)) await server.close();
  });

  /**
   * Stages one request through the `agent` builtin on `runtime`, in the
   * requester's own space on that runtime's toolshed, and returns the
   * builtin's result cell once its record exists.
   */
  const submit = async (
    params: Record<string, unknown> = {},
    runtime: Runtime = patternSide,
    inputIfc?: { confidentiality: string[] },
  ) => {
    const id = `request-${++requests}`;
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, agent, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const finished = BuilderCell.of(["Dune", "Solaris"], {
        type: "array",
        items: { type: "string" },
        ...(inputIfc !== undefined ? { ifc: inputIfc } : {}),
      });
      return agent({
        task: `recommend a book (${id})`,
        inputs: { finished },
        resultSchema: RESULT_SCHEMA,
        ...params,
        // deno-lint-ignore no-explicit-any
      } as any);
    });
    const tx = runtime.edit();
    const resultCell = runtime.getCell(home, id, testPattern.resultSchema, tx);
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await waitForCellValue<{ state?: string }>(
      runtime,
      result.key("run"),
      (value) => value?.state !== undefined,
    );
    return result as Cell<{
      pending?: boolean;
      error?: string;
      result?: { answer?: string };
      run?: AgentRunRecord;
    }>;
  };

  /** The record behind a builtin result cell, read on `runtime`. */
  const recordOf = (
    result: Cell<{ run?: AgentRunRecord }>,
    runtime: Runtime = patternSide,
  ) =>
    runtime.getCellFromLink(
      result.key("run").resolveAsCell().getAsNormalizedFullLink(),
      AgentRunRecordSchema,
    ) as unknown as Cell<AgentRunRecord>;

  /** Resolves once `result`'s record reads `state` on the pattern side. */
  const waitForState = (
    result: Cell<{ run?: AgentRunRecord }>,
    state: AgentRunRecord["state"],
  ) =>
    waitForCellValue<AgentRunRecord>(
      patternSide,
      recordOf(result),
      (value) => value?.state === state,
    );

  /** Starts a runner with runtimes of its own on both toolsheds. */
  const startRunner = async (
    execute: AgentRunnerOptions["execute"],
    options: Partial<AgentRunnerOptions> = {},
  ) => {
    const own: Record<string, Runtime> = {
      [CLOUD]: connect(CLOUD),
      [LOCAL]: connect(LOCAL),
    };
    const runner = new AgentRunner({
      homeSpace: home,
      homeHost: CLOUD,
      runnerHost: LOCAL,
      runnerId: `${home}#${crypto.randomUUID()}`,
      tools: ["loom_search"],
      maxConcurrent: 1,
      leaseMs: LEASE_MS,
      runtimeForHost: (host) => Promise.resolve(own[host]),
      // The queue under test is seeded data with no owner-protected writer,
      // so the registration is written straight into it.
      registerRunner: async (entry, expectedRegistrationId) => {
        await own[CLOUD].editWithRetry((tx) => {
          const registered = agentQueueIndexCell(own[CLOUD], home, tx)
            .key("agentRunner");
          if (
            entry === undefined && expectedRegistrationId !== undefined &&
            registered.get()?.registrationId !== expectedRegistrationId
          ) return;
          registered.set(entry);
        });
      },
      execute,
      now: () => clock,
      report: (m) => Deno.env.get("AGENT_TEST_DEBUG") && console.log(m),
      ...options,
    });
    runners.push(runner);
    await runner.start();
    return runner;
  };

  /** An executor that completes every run with a result document it writes. */
  const completing =
    (runtimeFor: () => Runtime) =>
    async (run: ClaimedAgentRun): Promise<AgentRunExecution> => {
      const runtime = runtimeFor();
      const answer = runtime.getCell<{ answer: string }>(
        run.link.space,
        `answer-${run.record.requestHash}`,
      );
      await runtime.editWithRetry((tx) => {
        answer.withTx(tx).set({ answer: "Hyperion" });
      });
      return {
        outcome: "completed",
        result: answer.getAsNormalizedFullLink(),
        report: {
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
          usageCoverage: "including-descendants",
          modelTurns: 2,
          toolCalls: 1,
          runRef: "/runs/1",
        },
      };
    };

  it("moves a record from `queued` through `claimed` and `running` to `completed`", async () => {
    const result = await submit();
    const runtime = connect(CLOUD);
    const states: string[] = [];
    const stop = recordOf(result, runtime).sink((value) => {
      if (value?.state && states.at(-1) !== value.state) {
        states.push(value.state);
      }
    });
    await startRunner(completing(() => runtime), {
      runtimeForHost: () => Promise.resolve(runtime),
    });

    const record = await waitForState(result, "completed");
    stop();

    expect(states).toEqual(["queued", "claimed", "running", "completed"]);
    expect(record.outcome).toBe("completed");
    expect(record.attempts).toBe(1);
    expect(record.claim).toBeUndefined();
    expect(record.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    });
    expect(record.usageCoverage).toBe("including-descendants");
    expect(record.modelTurns).toBe(2);
    expect(record.toolCalls).toBe(1);
    expect(record.runRef).toBe("/runs/1");
    const settled = await waitForCellValue<{ pending?: boolean }>(
      patternSide,
      result,
      (value) => value?.pending === false,
    );
    expect(settled.pending).toBe(false);
    expect(result.key("result").get()).toEqual({ answer: "Hyperion" });
  });

  it("ends a record `failed` with the executor's error code", async () => {
    const result = await submit();
    await startRunner(() =>
      Promise.resolve({ outcome: "failed", errorCode: "LIMIT_REACHED" })
    );

    const record = await waitForState(result, "failed");

    expect(record.errorCode).toBe("LIMIT_REACHED");
    expect(record.outcome).toBe("failed");
  });

  it("ends a record `failed` as `PROVIDER_FAILURE` when the executor throws", async () => {
    const result = await submit();
    await startRunner(() => Promise.reject(new Error("the model is down")));

    const record = await waitForState(result, "failed");

    expect(record.errorCode).toBe("PROVIDER_FAILURE");
  });

  it("ends a record `refused`, distinct from `failed`, on a writer refusal", async () => {
    const result = await submit();
    await startRunner(() => Promise.resolve({ outcome: "refused" }));

    const record = await waitForState(result, "refused");

    expect(record.outcome).toBe("refused");
    expect(record.errorCode).toBe("REFUSED");
  });

  it("creates no second record, and runs nothing twice, on a memo hit", async () => {
    let runs = 0;
    const runtime = connect(CLOUD);
    const complete = completing(() => runtime);
    const runner = await startRunner((run) => {
      runs += 1;
      return complete(run);
    });
    const first = await submit({ task: "the same request" });
    await waitForState(first, "completed");

    // The same request in the same instance: the node re-runs and finds its
    // record.
    const tx = patternSide.edit();
    first.withTx(tx).key("pending").get();
    await tx.commit();
    await patternSide.idle();
    await runner.idle();

    const entries = agentQueueIndexCell(patternSide, home).key("entries")
      .get() ?? [];
    expect(entries.length).toBe(1);
    expect(runs).toBe(1);
  });

  it("claims once when two runners race for one record", async () => {
    const held = defer<AgentRunExecution>();
    const claims: string[] = [];
    const started = defer<void>();
    const execute = (name: string) => (_run: ClaimedAgentRun) => {
      claims.push(name);
      started.resolve();
      return held.promise;
    };
    // Both runners follow the queue before the request exists, so both see
    // the new entry and race for it.
    const [a, b] = await Promise.all([
      startRunner(execute("a")),
      startRunner(execute("b")),
    ]);

    const result = await submit();
    try {
      await started.promise;
      await waitForState(result, "running");
      await patternSide.idle();

      expect(claims.length).toBe(1);
      expect(a.activeRuns + b.activeRuns).toBe(1);
      expect(recordOf(result).get()?.attempts).toBe(1);
    } finally {
      held.resolve({ outcome: "failed", errorCode: "PROVIDER_FAILURE" });
    }
    await waitForState(result, "failed");
  });

  it("holds a second record `queued` under the concurrency cap, then claims it", async () => {
    const held = defer<AgentRunExecution>();
    let runs = 0;
    await startRunner(() => {
      runs += 1;
      return runs === 1
        ? held.promise
        : Promise.resolve({ outcome: "refused" as const });
    });
    const first = await submit();
    await waitForState(first, "running");
    const second = await submit();
    await patternSide.idle();

    expect(recordOf(second).get()?.state).toBe("queued");

    held.resolve({ outcome: "refused" });
    await waitForState(second, "refused");
    expect(runs).toBe(2);
  });

  it("leaves queued requests unclaimed when stopping an active run", async () => {
    const started = defer<void>();
    const stopped = defer<void>();
    const release = defer<AgentRunExecution>();
    const runnerSide = connect(CLOUD);
    let runs = 0;
    const runner = await startRunner((run) => {
      runs += 1;
      if (runs > 1) return Promise.resolve({ outcome: "refused" });
      started.resolve();
      run.signal.addEventListener("abort", () => stopped.resolve(), {
        once: true,
      });
      return release.promise;
    }, { runtimeForHost: () => Promise.resolve(runnerSide) });
    const first = await submit();
    await started.promise;
    const second = await submit();
    await waitForCellValue<unknown[]>(
      runnerSide,
      agentQueueIndexCell(runnerSide, home).key("entries"),
      (entries) => entries?.length === 2,
    );

    const stopping = runner.stop();
    await stopped.promise;
    release.resolve({ outcome: "cancelled" });
    await stopping;
    await waitForState(first, "cancelled");
    await patternSide.idle();

    expect(runs).toBe(1);
    expect(recordOf(second).get()?.state).toBe("queued");
  });

  for (const left of ["claimed", "running"] as const) {
    it(`re-queues a killed runner's record left \`${left}\` once, then fails it`, async () => {
      const result = await submit();
      // A runner that died after its claim committed: the record holds a
      // claim whose lease is behind the clock and no process holds it.
      const kill = async (attempts: number) => {
        await patternSide.editWithRetry((tx) => {
          const record = recordOf(result).withTx(tx);
          record.key("state").set(left);
          record.key("attempts").set(attempts);
          record.key("outcome").set(undefined);
          record.key("errorCode").set(undefined);
          record.key("finishedAt").set(undefined);
          record.key("claim").set({
            runner: "did:key:dead#1",
            leaseUntil: "2026-09-18T11:00:00.000Z",
          });
        });
      };
      await kill(1);
      const claimed: number[] = [];
      const started = defer<void>();
      await startRunner((run) => {
        claimed.push(run.record.attempts ?? 0);
        started.resolve();
        return new Promise<AgentRunExecution>((resolve) => {
          run.signal.addEventListener(
            "abort",
            () => resolve({ outcome: "cancelled" }),
          );
        });
      });

      // Re-queued once, and claimed again as the second attempt.
      await waitForCellValue<AgentRunRecord>(
        patternSide,
        recordOf(result),
        (value) => value?.state === "running" && value.attempts === 2,
      );
      // The committed state can arrive before the runner starts its executor.
      await started.promise;
      expect(claimed).toEqual([2]);

      // The second runner dies too. Stopping it is as close as a test gets,
      // so what its stop wrote is put back to what a dead process leaves. A
      // new runner then finds the lease passed and `attempts` at two, and
      // fails the record instead of queueing it again.
      await runners.pop()!.stop();
      await kill(2);
      let ran = false;
      await startRunner(() => {
        ran = true;
        return Promise.resolve({ outcome: "refused" });
      });

      const record = await waitForState(result, "failed");
      expect(record.errorCode).toBe("RUNNER_LOST");
      expect(record.claim).toBeUndefined();
      expect(ran).toBe(false);
    });
  }

  for (const state of ["claimed", "running"] as const) {
    for (const expired of [false, true]) {
      it(`${expired ? "cancels" : "preserves"} a cancellation-requested \`${state}\` record with ${expired ? "an expired" : "a live"} remote lease`, async () => {
        const result = await submit();
        await patternSide.editWithRetry((tx) => {
          const record = recordOf(result).withTx(tx);
          record.key("state").set(state);
          record.key("attempts").set(2);
          record.key("cancelRequestedAt").set("2026-09-18T11:59:00.000Z");
          record.key("claim").set({
            runner: "did:key:remote#1",
            leaseUntil: expired
              ? "2026-09-18T11:00:00.000Z"
              : "2026-09-18T13:00:00.000Z",
          });
        });
        const runnerSide = connect(CLOUD);
        let executions = 0;
        const runner = await startRunner(() => {
          executions++;
          return Promise.resolve({ outcome: "refused" });
        }, { runtimeForHost: () => Promise.resolve(runnerSide) });
        await runner.idle();

        const record = recordOf(result, runnerSide).get();
        expect(record?.state).toBe(expired ? "cancelled" : state);
        expect(record?.attempts).toBe(2);
        expect(executions).toBe(0);
        if (expired) {
          expect(record?.errorCode).toBe("CANCELLED");
          expect(record?.outcome).toBe("cancelled");
          expect(record?.claim).toBeUndefined();
          expect(record?.finishedAt).toBe(clock.toISOString());
        } else {
          expect(record?.claim?.runner).toBe("did:key:remote#1");
          expect(record?.finishedAt).toBeUndefined();
        }
      });
    }
  }

  it("leaves a claimed record alone while its lease reaches past now", async () => {
    const result = await submit();
    await patternSide.editWithRetry((tx) => {
      const record = recordOf(result).withTx(tx);
      record.key("state").set("running");
      record.key("attempts").set(1);
      record.key("claim").set({
        runner: "did:key:alive#1",
        leaseUntil: "2026-09-18T12:30:00.000Z",
      });
    });
    const runner = await startRunner(() =>
      Promise.resolve({ outcome: "refused" })
    );
    await runner.idle();

    expect(recordOf(result).get()?.state).toBe("running");
    expect(recordOf(result).get()?.claim?.runner).toBe("did:key:alive#1");
  });

  it("wakes at a foreign lease deadline and recovers the record", async () => {
    const result = await submit();
    await patternSide.editWithRetry((tx) => {
      const record = recordOf(result).withTx(tx);
      record.key("state").set("running");
      record.key("attempts").set(2);
      record.key("claim").set({
        runner: "did:key:alive#1",
        leaseUntil: "2026-09-18T12:30:00.000Z",
      });
    });
    const runnerSide = connect(CLOUD);
    const runnerRecord = recordOf(result, runnerSide);
    await runnerRecord.sync();
    await waitForCellValue<AgentRunRecord>(
      runnerSide,
      runnerRecord,
      (value) =>
        value?.state === "running" &&
        value.claim?.leaseUntil === "2026-09-18T12:30:00.000Z",
    );
    let wake: (() => void) | undefined;
    let deadline: Date | undefined;
    const runner = await startRunner(
      () => Promise.resolve({ outcome: "refused" }),
      {
        scheduleAt: (at, scheduled) => {
          deadline = at;
          wake = scheduled;
          return () => {};
        },
        runtimeForHost: () => Promise.resolve(runnerSide),
      },
    );
    await runner.idle();
    expect(deadline?.toISOString()).toBe("2026-09-18T12:30:00.000Z");

    clock = new Date("2026-09-18T12:30:00.000Z");
    wake!();
    const recovered = await waitForState(result, "failed");
    expect(recovered.errorCode).toBe("RUNNER_LOST");
  });

  it("expires and retries an active run whose executor becomes silent", async () => {
    const firstAborted = defer<void>();
    const wakeScheduled = defer<void>();
    let wake: (() => void) | undefined;
    let executions = 0;
    await startRunner((run) => {
      executions += 1;
      if (executions > 1) {
        return Promise.resolve({ outcome: "refused" });
      }
      run.signal.addEventListener("abort", () => firstAborted.resolve(), {
        once: true,
      });
      return new Promise<AgentRunExecution>(() => {});
    }, {
      scheduleAt: (at, scheduled) => {
        if (at.toISOString() === "2026-09-18T12:01:00.000Z") {
          wake = scheduled;
          wakeScheduled.resolve();
        }
        return () => {};
      },
    });
    const result = await submit();
    await waitForState(result, "running");
    await wakeScheduled.promise;

    clock = new Date("2026-09-18T12:01:00.000Z");
    wake!();

    await firstAborted.promise;
    const ended = await waitForState(result, "refused");
    expect(ended.attempts).toBe(2);
    expect(executions).toBe(2);
  });

  it("stops following a record removed from the queue", async () => {
    const result = await submit();
    await patternSide.editWithRetry((tx) => {
      const record = recordOf(result).withTx(tx);
      record.key("state").set("running");
      record.key("attempts").set(2);
      record.key("claim").set({
        runner: "did:key:removed#1",
        leaseUntil: "2026-09-18T12:30:00.000Z",
      });
    });
    let wake: (() => void) | undefined;
    let executions = 0;
    const runner = await startRunner(
      () => {
        executions++;
        return Promise.resolve({ outcome: "refused" });
      },
      {
        scheduleAt: (_at, scheduled) => {
          wake = scheduled;
          return () => {};
        },
      },
    );
    await runner.idle();
    await patternSide.editWithRetry((tx) => {
      agentQueueIndexCell(patternSide, home, tx).key("entries").set([]);
    });
    await runner.idle();

    clock = new Date("2026-09-18T12:30:00.000Z");
    wake?.();
    await runner.idle();
    expect(recordOf(result).get()?.state).toBe("running");
    expect(executions).toBe(0);
  });

  it("renews the lease when the run reports a durable write", async () => {
    const renewed = defer<void>();
    const wakeScheduled = defer<void>();
    const held = defer<AgentRunExecution>();
    await startRunner(async (run) => {
      clock = new Date("2026-09-18T12:10:00.000Z");
      await run.renewLease();
      renewed.resolve();
      return held.promise;
    }, {
      scheduleAt: (at) => {
        if (at.toISOString() === "2026-09-18T12:11:00.000Z") {
          wakeScheduled.resolve();
        }
        return () => {};
      },
    });
    const result = await submit();
    await renewed.promise;

    const record = await waitForCellValue<AgentRunRecord>(
      patternSide,
      recordOf(result),
      (value) => value?.claim?.leaseUntil === "2026-09-18T12:11:00.000Z",
    );
    await wakeScheduled.promise;
    expect(record.state).toBe("running");

    held.resolve({ outcome: "refused" });
    await waitForState(result, "refused");
  });

  it("aborts a run through its signal on `cancel` and ends it `cancelled`", async () => {
    const started = defer<void>();
    await startRunner((run) => {
      started.resolve();
      return new Promise<AgentRunExecution>((resolve) => {
        run.signal.addEventListener("abort", () =>
          // Even a late success cannot outrun cancellation.
          resolve({ outcome: "completed", result: run.link }));
      });
    });
    const result = await submit();
    await started.promise;
    await waitForState(result, "running");

    await patternSide.editWithRetry((tx) => {
      recordOf(result).withTx(tx).key("cancelRequestedAt")
        .set("2026-09-18T12:01:00.000Z");
    });

    const record = await waitForState(result, "cancelled");
    expect(record.errorCode).toBe("CANCELLED");
    const settled = await waitForCellValue<{ error?: string }>(
      patternSide,
      result,
      (value) => value?.error !== undefined,
    );
    expect(settled.error).toBe("CANCELLED");
  });

  it("ends a queued record `cancelled` without running it", async () => {
    const result = await submit();
    await patternSide.editWithRetry((tx) => {
      recordOf(result).withTx(tx).key("cancelRequestedAt")
        .set("2026-09-18T12:01:00.000Z");
    });
    let ran = false;
    await startRunner(() => {
      ran = true;
      return Promise.resolve({ outcome: "refused" });
    });

    await waitForState(result, "cancelled");
    expect(ran).toBe(false);
  });

  it("writes nothing over a record another runner took while its run was out", async () => {
    const held = defer<AgentRunExecution>();
    const reports: string[] = [];
    await startRunner(() => held.promise, {
      report: (message) => reports.push(message),
    });
    const result = await submit();
    await waitForState(result, "running");

    // The lease passed and another runner recovered and claimed the record.
    await patternSide.editWithRetry((tx) => {
      const record = recordOf(result).withTx(tx);
      record.key("attempts").set(2);
      record.key("claim").set({
        runner: "did:key:other#1",
        leaseUntil: "2026-09-18T13:00:00.000Z",
      });
    });
    await waitForCellValue<AgentRunRecord>(
      patternSide,
      recordOf(result),
      (value) => value?.claim?.runner === "did:key:other#1",
    );
    held.resolve({ outcome: "refused" });
    await runners[0].idle();

    expect(recordOf(result).get()?.state).toBe("running");
    expect(recordOf(result).get()?.claim?.runner).toBe("did:key:other#1");
    expect(reports.some((line) => line.includes("was no longer held"))).toBe(
      true,
    );
  });

  for (
    const conflict of [
      "recovered",
      "renewed",
      "cancelled",
      "cancel requested",
      "finished",
    ] as const
  ) {
    it(`rechecks a record ${conflict} by another client before its write commits`, async () => {
      const result = await submit();
      const recovering = conflict === "recovered" || conflict === "renewed";
      await patternSide.editWithRetry((tx) => {
        const record = recordOf(result).withTx(tx);
        if (recovering) {
          record.key("state").set("running");
          record.key("attempts").set(1);
          record.key("claim").set({
            runner: "did:key:remote#1",
            leaseUntil: "2026-09-18T11:00:00.000Z",
          });
        }
        if (conflict === "cancelled") {
          record.key("cancelRequestedAt").set(clock.toISOString());
        }
      });
      const runnerSide = connect(CLOUD);
      const original = runnerSide.editWithRetry.bind(runnerSide);
      let callbacks = 0;
      const interleaveAt = conflict === "finished" ? 2 : 1;
      runnerSide.editWithRetry = ((fn, ...rest) =>
        original((tx) => {
          const value = fn(tx);
          if (++callbacks === interleaveAt) {
            const commit = tx.commit.bind(tx);
            tx.commit = async (...args) => {
              await patternSide.editWithRetry((competing) => {
                const record = recordOf(result).withTx(competing);
                if (conflict === "renewed") {
                  record.key("claim").key("leaseUntil").set(
                    "2026-09-18T13:00:00.000Z",
                  );
                } else if (conflict === "cancel requested") {
                  record.key("cancelRequestedAt").set(clock.toISOString());
                } else {
                  record.key("state").set("cancelled");
                  record.key("outcome").set("cancelled");
                  record.key("errorCode").set("CANCELLED");
                  record.key("finishedAt").set(clock.toISOString());
                  record.key("claim").set(undefined);
                }
              });
              return commit(...args);
            };
          }
          return value;
        }, ...rest)) as typeof runnerSide.editWithRetry;
      let executed = false;
      const runner = await startRunner(() => {
        executed = true;
        return Promise.resolve({ outcome: "refused" });
      }, { runtimeForHost: () => Promise.resolve(runnerSide) });
      await runner.idle();

      const record = recordOf(result, runnerSide).get();
      expect(callbacks).toBeGreaterThan(interleaveAt);
      expect(executed).toBe(false);
      expect(record?.state).toBe(
        conflict === "renewed" ? "running" : "cancelled",
      );
      if (conflict === "renewed") {
        expect(record?.claim?.leaseUntil).toBe("2026-09-18T13:00:00.000Z");
      }
      if (conflict === "cancel requested") {
        expect(record?.attempts).toBeUndefined();
      }
    });
  }

  it("does not execute a record deleted after its running-state write commits", async () => {
    const result = await submit();
    const runnerSide = connect(CLOUD);
    const original = runnerSide.editWithRetry.bind(runnerSide);
    let writes = 0;
    runnerSide.editWithRetry = (async (fn, ...rest) => {
      const sequence = ++writes;
      const committed = await original(fn, ...rest);
      if (sequence === 2) {
        await patternSide.editWithRetry((tx) => {
          recordOf(result).withTx(tx).setRaw(undefined);
        });
        await waitForCellValue(
          runnerSide,
          recordOf(result, runnerSide),
          (value) => value === undefined,
        );
      }
      return committed;
    }) as typeof runnerSide.editWithRetry;
    const reports: string[] = [];
    let executed = false;
    const runner = await startRunner(() => {
      executed = true;
      return Promise.resolve({ outcome: "refused" });
    }, {
      runtimeForHost: () => Promise.resolve(runnerSide),
      report: (message) => reports.push(message),
    });
    await runner.idle();

    expect(executed).toBe(false);
    expect(reports).toContain(
      "agent runner: a run failed: the claimed record does not read",
    );
    expect(recordOf(result, runnerSide).get()).toBeUndefined();
  });

  it("reports a scan that fails, and goes on following the queue", async () => {
    const reports: string[] = [];
    await patternSide.editWithRetry((tx) => {
      agentQueueIndexCell(patternSide, home, tx).key("entries").push({
        run: patternSide.getCell(home, "a record on a host nobody serves"),
        host: "https://unknown.example",
      });
    });
    const own = connect(CLOUD);
    await startRunner(() => Promise.resolve({ outcome: "refused" }), {
      report: (message) => reports.push(message),
      runtimeForHost: (host) =>
        host === CLOUD
          ? Promise.resolve(own)
          : Promise.reject(new Error(`no toolshed at ${host}`)),
    });
    await runners[0].idle();

    expect(reports.some((message) =>
      message.includes("could not follow") &&
      message.includes("no toolshed at https://unknown.example")
    )).toBe(true);
  });

  it("continues past a bad queue entry and runs a later valid one", async () => {
    await patternSide.editWithRetry((tx) => {
      agentQueueIndexCell(patternSide, home, tx).key("entries").push({
        run: patternSide.getCell(home, "bad record"),
        host: "https://unknown.example",
      });
    });
    const result = await submit();
    const own = connect(CLOUD);
    await startRunner(() => Promise.resolve({ outcome: "refused" }), {
      runtimeForHost: (host) =>
        host === CLOUD
          ? Promise.resolve(own)
          : Promise.reject(new Error(`no toolshed at ${host}`)),
    });

    await waitForState(result, "refused");
  });

  it("retries a failed scan through the scheduler without a queue write", async () => {
    const result = await submit();
    const own = connect(CLOUD);
    let calls = 0;
    let wake: (() => void) | undefined;
    const runner = await startRunner(
      () => Promise.resolve({ outcome: "refused" }),
      {
        runtimeForHost: () => {
          calls++;
          return calls === 2
            ? Promise.reject(new Error("transient queue read"))
            : Promise.resolve(own);
        },
        scheduleAt: (_at, scheduled) => {
          wake = scheduled;
          return () => {};
        },
      },
    );
    await runner.idle();
    expect(recordOf(result).get()?.state).toBe("queued");
    wake!();
    await waitForState(result, "refused");
  });

  it("claims the older of two queued records first under a cap of one", async () => {
    const first = await submit();
    clock = new Date("2026-09-18T12:00:05.000Z");
    const second = await submit();
    const order: string[] = [];
    await startRunner((run) => {
      order.push(run.record.task);
      return Promise.resolve({ outcome: "refused" });
    });

    await waitForState(first, "refused");
    await waitForState(second, "refused");

    expect(order).toEqual([
      recordOf(first).get()!.task,
      recordOf(second).get()!.task,
    ]);
  });

  it("leaves a request naming a tool it does not offer `queued`", async () => {
    const result = await submit({ tools: ["loom_profile"] });
    const runner = await startRunner(() =>
      Promise.resolve({ outcome: "refused" })
    );
    await runner.idle();

    expect(recordOf(result).get()?.state).toBe("queued");
  });

  it("leaves a research request queued on the default runner surface", async () => {
    const result = await submit({ tools: ["research"] });
    const runner = await startRunner(
      () => Promise.resolve({ outcome: "refused" }),
      { tools: ["describe_handle", "web_fetch"] },
    );
    await runner.idle();

    expect(recordOf(result).get()?.state).toBe("queued");
  });

  it("writes the `agentRunner` entry on start and refreshes it on claim", async () => {
    const runner = await startRunner(() =>
      Promise.resolve({ outcome: "refused" })
    );
    const registered = await waitForCellValue<
      { host: string; tools: string[]; lastClaimAt?: string }
    >(
      patternSide,
      agentQueueIndexCell(patternSide, home).key("agentRunner"),
      (value) => value !== undefined,
    );
    expect(registered).toEqual({
      host: LOCAL,
      tools: ["loom_search"],
      registrationId: expect.any(String),
      registeredAt: "2026-09-18T12:00:00.000Z",
    });

    clock = new Date("2026-09-18T12:05:00.000Z");
    const result = await submit();
    await waitForState(result, "refused");
    await runner.idle();

    const refreshed = await waitForCellValue<{ lastClaimAt?: string }>(
      patternSide,
      agentQueueIndexCell(patternSide, home).key("agentRunner"),
      (value) => value?.lastClaimAt !== undefined,
    );
    expect(refreshed).toEqual({
      host: LOCAL,
      tools: ["loom_search"],
      registrationId: expect.any(String),
      registeredAt: "2026-09-18T12:00:00.000Z",
      lastClaimAt: "2026-09-18T12:05:00.000Z",
    });

    await runner.stop();
    runners.splice(runners.indexOf(runner), 1);
    const cleared = await waitForCellValue(
      patternSide,
      agentQueueIndexCell(patternSide, home).key("agentRunner"),
      (value) => value === undefined,
    );
    expect(cleared).toBeUndefined();
  });

  it("does not let a stopped runner clear its replacement's registration", async () => {
    const first = await startRunner(() =>
      Promise.resolve({ outcome: "refused" })
    );
    const firstRegistration = agentQueueIndexCell(patternSide, home)
      .key("agentRunner").get();
    const second = await startRunner(() =>
      Promise.resolve({ outcome: "refused" })
    );
    const secondRegistration = await waitForCellValue<
      { registrationId?: string }
    >(
      patternSide,
      agentQueueIndexCell(patternSide, home).key("agentRunner"),
      (value) =>
        value?.registrationId !== undefined &&
        value.registrationId !== firstRegistration?.registrationId,
    );

    await first.stop();
    runners.splice(runners.indexOf(first), 1);

    expect(
      agentQueueIndexCell(patternSide, home).key("agentRunner").get()
        ?.registrationId,
    ).toBe(secondRegistration.registrationId);
    await second.stop();
    runners.splice(runners.indexOf(second), 1);
  });

  it("finds a record on another toolshed through its `{run, host}` entry", async () => {
    // The requesting space is served by the local toolshed; the home space,
    // and so the queue, by the cloud one. The entry's `host` is the only
    // thing that says where the record is.
    const localPatternSide = connect(LOCAL, { agentBuiltin: true });
    const localSpace = (await Identity.fromPassphrase("a local space")).did();
    const id = "cross-host-request";
    const record = localPatternSide.getCell(
      localSpace,
      id,
      AgentRunRecordSchema,
    ) as unknown as Cell<AgentRunRecord>;
    const stamp = clock.toISOString();
    await localPatternSide.editWithRetry((tx) => {
      const self = localPatternSide.getCell(localSpace, `${id}-request`);
      record.withTx(tx).set({
        requestHash: id,
        request: self,
        piece: self,
        space: self,
        task: "a request from a locally served space",
        inputs: {},
        resultSchema: RESULT_SCHEMA,
        submittedAt: stamp,
        state: "queued",
        stateSince: stamp,
        // deno-lint-ignore no-explicit-any
      } as any);
    });
    // The cloud toolshed holds no such space: only the entry's host leads to
    // the record.
    expect(
      patternSide.getCellFromLink(record.getAsNormalizedFullLink()).get(),
    ).toBeUndefined();
    await patternSide.editWithRetry((tx) => {
      agentQueueIndexCell(patternSide, home, tx).key("entries").push({
        run: patternSide.getCellFromLink(record.getAsNormalizedFullLink()),
        host: LOCAL,
      });
    });

    const hosts: string[] = [];
    await startRunner((run) => {
      hosts.push(run.host);
      return Promise.resolve({ outcome: "refused" });
    });

    const ended = await waitForCellValue<AgentRunRecord>(
      localPatternSide,
      record,
      (value) => value?.state === "refused",
    );
    expect(hosts).toEqual([LOCAL]);
    expect(ended.attempts).toBe(1);
  });

  it("preserves a subscription failure when registration cleanup also fails", async () => {
    const subscriptionFailure = new Error("queue subscription failed");
    const queue = {
      key: () => queue,
      asSchema: () => queue,
      sync: () => Promise.resolve(),
      sink: () => {
        throw subscriptionFailure;
      },
    };

    for (
      const cleanupFailure of [new Error("cleanup error"), "cleanup string"]
    ) {
      const registrations: unknown[] = [];
      const reports: string[] = [];
      const runner = new AgentRunner({
        homeSpace: home,
        homeHost: CLOUD,
        runnerHost: LOCAL,
        runnerId: `${home}#cleanup-failure`,
        tools: [],
        maxConcurrent: 1,
        leaseMs: LEASE_MS,
        runtimeForHost: () =>
          Promise.resolve({ getCell: () => queue } as unknown as Runtime),
        registerRunner: (entry) => {
          registrations.push(entry);
          return entry === undefined
            ? Promise.reject(cleanupFailure)
            : Promise.resolve();
        },
        execute: () => Promise.resolve({ outcome: "cancelled" }),
        report: (message) => reports.push(message),
        now: () => clock,
      });

      await expect(runner.start()).rejects.toBe(subscriptionFailure);
      expect(registrations).toHaveLength(2);
      expect(registrations[0]).not.toBeUndefined();
      expect(registrations[1]).toBeUndefined();
      expect(reports).toContain(
        `agent runner: could not clear a failed registration: ${
          cleanupFailure instanceof Error
            ? cleanupFailure.message
            : cleanupFailure
        }`,
      );
    }
  });

  it("follows a queue entry again when its serving host changes", async () => {
    const localSide = connect(LOCAL);
    const id = "moved-host-request";
    const cloudRecord = patternSide.getCell(
      home,
      id,
      AgentRunRecordSchema,
    ) as unknown as Cell<AgentRunRecord>;
    const localRecord = localSide.getCell(
      home,
      id,
      AgentRunRecordSchema,
    ) as unknown as Cell<AgentRunRecord>;
    const seed = async (
      runtime: Runtime,
      record: Cell<AgentRunRecord>,
      tools: AgentRunRecord["tools"],
    ) => {
      await runtime.editWithRetry((tx) => {
        const self = runtime.getCell(home, `${id}-request`, undefined, tx);
        record.withTx(tx).set({
          requestHash: id,
          request: self,
          piece: self,
          space: self,
          task: "a request whose serving host moves",
          inputs: {},
          resultSchema: RESULT_SCHEMA,
          ...(tools === undefined ? {} : { tools }),
          submittedAt: clock.toISOString(),
          state: "queued",
          stateSince: clock.toISOString(),
        });
      });
    };
    await seed(patternSide, cloudRecord, ["loom_profile"]);
    await seed(localSide, localRecord, undefined);
    await patternSide.editWithRetry((tx) => {
      agentQueueIndexCell(patternSide, home, tx).key("entries").set([{
        run: cloudRecord,
        host: CLOUD,
      }]);
    });
    const runner = await startRunner(() =>
      Promise.resolve({ outcome: "refused" })
    );
    await runner.idle();
    expect(cloudRecord.get()?.state).toBe("queued");

    await patternSide.editWithRetry((tx) => {
      agentQueueIndexCell(patternSide, home, tx).key("entries").set([{
        run: cloudRecord,
        host: LOCAL,
      }]);
    });

    const ended = await waitForCellValue<AgentRunRecord>(
      localSide,
      localRecord,
      (value) => value?.state === "refused",
    );
    expect(ended.attempts).toBe(1);
    expect(cloudRecord.get()?.state).toBe("queued");
  });

  describe("with the harness executor over a scripted prompt loop", () => {
    let workRoot: string;

    beforeEach(async () => {
      workRoot = await Deno.makeTempDir({ prefix: "agent-runner-test-" });
    });

    afterEach(async () => {
      await Deno.remove(workRoot, { recursive: true });
    });

    /** The loop result a scripted run hands back. */
    const loopResult = (runId: string): HarnessPromptLoopResult => ({
      model: "scripted",
      finalAssistantText: "Done.",
      transcript: [],
      modelTurns: 3,
      totalUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      runState: {
        runId,
        status: "completed",
        createdAt: "2026-09-18T12:00:00.000Z",
        updatedAt: "2026-09-18T12:00:01.000Z",
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        policyEvents: [],
        toolOutputs: [],
        artifactRoot: join(workRoot, "artifacts"),
      } as unknown as HarnessPromptLoopResult["runState"],
    });

    /** A runner whose runs go through `runCfHarnessCli` and the writer. */
    const startHarnessRunner = async (
      script: (context: {
        resultPath: string;
        signal?: AbortSignal;
        emit: () => Promise<void>;
      }) => Promise<HarnessPromptLoopResult>,
      options: {
        report?: (message: string) => void;
        omitHarnessArgs?: boolean;
      } = {},
    ) => {
      const sessionRuntime = connect(CLOUD);
      const pieces = new PiecesController(
        await createSession({ identity: signer, spaceDid: home }),
        sessionRuntime,
      );
      let seen: {
        argv?: unknown;
        slotRole?: string;
        model?: string;
        allowedTools?: readonly string[];
        observationCeiling?: unknown;
        workspaces: string[];
      } = { workspaces: [] };
      const execute = createHarnessAgentRunExecutor({
        identityKeyPath: join(workRoot, "unused.key"),
        requester: home,
        workRoot,
        allowedTools: ["describe_handle"],
        report: options.report ??
          ((m) => Deno.env.get("AGENT_TEST_DEBUG") && console.log(m)),
        ...(options.omitHarnessArgs ? {} : { model: "scripted" }),
        harnessDeps: {
          env: {
            CF_HARNESS_MODEL_PROVIDER: "openai-compatible-gateway",
            CF_HARNESS_GATEWAY_AUTH_MODE: "none",
          },
          fabricSessionFactory: () => Promise.resolve({ pieces }),
          createPromptLoop: (options) => ({
            runPrompt: (prompt) => {
              seen = {
                workspaces: [
                  ...seen.workspaces,
                  options.workspaceHostPath!,
                ],
                slotRole: prompt.promptSlotBinding?.role,
                model: options.model,
                argv: options.inputCells,
                allowedTools: options.allowedToolIds,
                observationCeiling: options.fabricSession
                  ?.cfcReadMaxConfidentiality,
              };
              return script({
                resultPath: join(
                  options.workspaceHostPath!,
                  "agent-result.json",
                ),
                signal: prompt.signal,
                emit: async () => {
                  await prompt.onTranscriptEvent?.(
                    { type: "assistant_message" } as never,
                  );
                },
              });
            },
            runTranscript: () => Promise.reject(new Error("not a resume")),
          }),
        },
      });
      await startRunner(execute, { tools: ["describe_handle"] });
      return () => seen;
    };

    it("writes the structured result and the run's usage, turns, and artifact reference", async () => {
      const seen = await startHarnessRunner(async ({ resultPath, emit }) => {
        await emit();
        await Deno.writeTextFile(
          resultPath,
          JSON.stringify({ answer: "Hyperion" }),
        );
        return loopResult("run-completed");
      });
      const result = await submit();

      const record = await waitForState(result, "completed");

      expect(record.usage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      });
      expect(record.usageCoverage).toBe("including-descendants");
      expect(record.modelTurns).toBe(3);
      expect(record.toolCalls).toBe(0);
      expect(record.runRef).toBe(join(workRoot, "artifacts"));
      const settled = await waitForCellValue<{ result?: { answer?: string } }>(
        patternSide,
        result,
        (value) => value?.result?.answer !== undefined,
      );
      expect(settled.result?.answer).toBe("Hyperion");
      // The task is a pattern's text, bound as context, and the request's
      // input reached the run as an input cell named as the request names it.
      expect(seen().slotRole).toBe("context");
      expect(seen().model).toBe("scripted");
      expect(
        (seen().argv as { name: string }[]).map((cell) => cell.name),
      ).toEqual(["finished"]);
    });

    for (const explicitCeiling of [false, true]) {
      it(`bounds observations by ${explicitCeiling ? "the explicit request ceiling" : "the requester by default"}`, async () => {
        const seen = await startHarnessRunner(async ({ resultPath }) => {
          await Deno.writeTextFile(
            resultPath,
            JSON.stringify({ answer: "Solaris" }),
          );
          return loopResult("run-observation-ceiling");
        });
        const result = await submit(
          explicitCeiling
            ? { maxConfidentiality: ["https://cfc.test/atom/reading"] }
            : {},
        );
        const record = await waitForCellValue<AgentRunRecord>(
          patternSide,
          recordOf(result),
          (value) => value?.outcome !== undefined,
        );

        expect(record.state).toBe("completed");
        expect(seen().observationCeiling).toEqual(
          explicitCeiling
            ? ["https://cfc.test/atom/reading"]
            : [{ type: CFC_ATOM_TYPE.User, subject: home }],
        );
      });
    }

    for (const schema of [true, false]) {
      it(`preserves a boolean result schema of \`${schema}\``, async () => {
        await startHarnessRunner(async ({ resultPath }) => {
          await Deno.writeTextFile(
            resultPath,
            JSON.stringify({ answer: "Hyperion" }),
          );
          return loopResult(`run-boolean-schema-${schema}`);
        });
        const result = await submit({ resultSchema: schema });

        const record = await waitForCellValue<AgentRunRecord>(
          patternSide,
          recordOf(result),
          (value) => value?.outcome !== undefined,
        );

        expect(record.state).toBe(schema ? "completed" : "failed");
        expect(record.errorCode).toBe(schema ? undefined : "PROVIDER_FAILURE");
      });
    }

    it("allows `submit_result` alongside an explicit request tool list", async () => {
      const seen = await startHarnessRunner(async ({ resultPath }) => {
        await Deno.writeTextFile(
          resultPath,
          JSON.stringify({ answer: "Hyperion" }),
        );
        return loopResult("run-explicit-tools");
      });
      const result = await submit({ tools: ["describe_handle"] });

      const record = await waitForCellValue<AgentRunRecord>(
        patternSide,
        recordOf(result),
        (value) => value?.outcome !== undefined,
      );

      expect(record.state).toBe("completed");
      expect(seen().allowedTools).toEqual(["describe_handle", "submit_result"]);
    });

    it("uses the runner's allowlist when the request omits `tools`", async () => {
      const seen = await startHarnessRunner(async ({ resultPath }) => {
        await Deno.writeTextFile(
          resultPath,
          JSON.stringify({ answer: "Hyperion" }),
        );
        return loopResult("run-default-tools");
      });
      const result = await submit();

      await waitForState(result, "completed");
      expect(seen().allowedTools).toEqual(["describe_handle", "submit_result"]);
    });

    it("allows only `submit_result` for an explicitly empty tool list", async () => {
      const seen = await startHarnessRunner(async ({ resultPath }) => {
        await Deno.writeTextFile(
          resultPath,
          JSON.stringify({ answer: "Hyperion" }),
        );
        return loopResult("run-empty-tools");
      });
      const result = await submit({ tools: [] });

      await waitForState(result, "completed");
      expect(seen().allowedTools).toEqual(["submit_result"]);
    });

    it("accepts a handle token at an `asCell` position and writes a link there", async () => {
      // The position declares the referent's shape, which a token is not: the
      // run's validation has to leave `asCell` positions to the writer.
      const schema = {
        type: "object",
        properties: {
          answer: { type: "string" },
          basedOn: {
            type: "array",
            items: { type: "string" },
            asCell: ["cell"],
          },
        },
        required: ["answer", "basedOn"],
      };
      const input: { finished?: Cell<unknown> } = {};
      await startHarnessRunner(async ({ resultPath }) => {
        const minted = await mintAddressHandle(
          createHarnessHandleTable("run-token"),
          renderCellReference(input.finished!.getAsNormalizedFullLink()),
        );
        await Deno.writeTextFile(
          resultPath,
          JSON.stringify({ answer: "Hyperion", basedOn: minted.token }),
        );
        const result = loopResult("run-token");
        return {
          ...result,
          runState: { ...result.runState, handleTable: minted.table },
        };
      });
      // A link is written only to a document that carries a label, so the
      // input is labeled, and the request's ceiling admits that label.
      const READING = "https://cfc.test/atom/reading";
      const result = await submit(
        { resultSchema: schema, maxConfidentiality: [READING] },
        patternSide,
        { confidentiality: [READING] },
      );
      input.finished =
        (recordOf(result).key("inputs").get() as unknown as Record<
          string,
          Cell<unknown>
        >).finished;

      const record = await waitForState(result, "completed");

      expect(record.outcome).toBe("completed");
      const written = recordOf(result).key("result").resolveAsCell();
      await written.sync();
      expect(
        (written.get() as { basedOn?: string[] }).basedOn,
      ).toEqual(["Dune", "Solaris"]);
    });

    it("ends `refused` a result the space's policy will not commit", async () => {
      // The run observed a cell labeled outside the request's ceiling, so the
      // join the result would carry does not fit the ceiling declared on it.
      const READING = "https://cfc.test/atom/reading";
      const SECRET = "https://cfc.test/atom/secret";
      const secret = patternSide.getCell(home, "a secret the run observed", {
        type: "string",
        ifc: { confidentiality: [SECRET] },
      });
      await patternSide.editWithRetry((tx) => {
        secret.withTx(tx).set("the butler did it");
      });
      await startHarnessRunner(async ({ resultPath }) => {
        const minted = await mintAddressHandle(
          createHarnessHandleTable("run-refused"),
          renderCellReference(secret.getAsNormalizedFullLink()),
        );
        await Deno.writeTextFile(
          resultPath,
          JSON.stringify({ answer: "Hyperion" }),
        );
        const result = loopResult("run-refused");
        return {
          ...result,
          runState: { ...result.runState, handleTable: minted.table },
        };
      });
      const result = await submit(
        { maxConfidentiality: [READING] },
        patternSide,
        { confidentiality: [READING] },
      );

      const record = await waitForState(result, "refused");

      expect(record.errorCode).toBe("REFUSED");
      expect(record.result).toBeUndefined();
    });

    it("fails as `PROVIDER_FAILURE` a result naming a handle the run does not hold", async () => {
      await startHarnessRunner(async ({ resultPath }) => {
        await Deno.writeTextFile(
          resultPath,
          JSON.stringify({ answer: "cfh:a:zzzzz" }),
        );
        // A run that reports direct usage alone, and no artifact root.
        const { totalUsage, ...result } = loopResult("run-unheld");
        const { artifactRoot: _root, ...runState } = result
          .runState as unknown as Record<string, unknown>;
        return {
          ...result,
          usage: totalUsage,
          runState: runState as unknown as HarnessPromptLoopResult["runState"],
        };
      });
      const result = await submit();

      const record = await waitForState(result, "failed");

      expect(record.errorCode).toBe("PROVIDER_FAILURE");
      expect(record.usageCoverage).toBe("direct");
      expect(record.runRef).toBeUndefined();
    });

    it("fails as `PROVIDER_FAILURE` a run that wrote no result", async () => {
      await startHarnessRunner(() =>
        Promise.resolve(loopResult("run-no-result"))
      );
      const result = await submit();

      const record = await waitForState(result, "failed");

      expect(record.errorCode).toBe("PROVIDER_FAILURE");
      expect(record.modelTurns).toBe(3);
    });

    it("does not reuse a result file left by an earlier attempt", async () => {
      const result = await submit();
      const workspace = join(
        workRoot,
        hashStringOf([
          CLOUD,
          addressKey(recordOf(result).getAsNormalizedFullLink()),
        ]),
        "workspace",
      );
      await Deno.mkdir(workspace, { recursive: true });
      await Deno.writeTextFile(
        join(workspace, "agent-result.json"),
        JSON.stringify({ answer: "stale" }),
      );
      await startHarnessRunner(() =>
        Promise.resolve(loopResult("run-stale-result"))
      );

      const ended = await waitForState(result, "failed");
      expect(ended.errorCode).toBe("PROVIDER_FAILURE");
      expect(ended.result).toBeUndefined();
    });

    it("fails before invoking the provider when the stale result path cannot be removed", async () => {
      const result = await submit();
      const staleResult = join(
        workRoot,
        hashStringOf([
          CLOUD,
          addressKey(recordOf(result).getAsNormalizedFullLink()),
        ]),
        "workspace",
        "agent-result.json",
      );
      await Deno.mkdir(staleResult, { recursive: true });
      await Deno.writeTextFile(join(staleResult, "kept"), "not removable");
      let invoked = false;
      await startHarnessRunner(() => {
        invoked = true;
        return Promise.resolve(loopResult("run-stale-result-directory"));
      });

      const ended = await waitForState(result, "failed");

      expect(invoked).toBe(false);
      expect(ended.errorCode).toBe("PROVIDER_FAILURE");
      expect(ended.result).toBeUndefined();
    });

    it("uses distinct workspaces for distinct records with one request hash", async () => {
      const first = await submit({ task: "the same task" });
      const second = await submit({ task: "the same task" });
      const requestHash = recordOf(first).get()!.requestHash;
      await patternSide.editWithRetry((tx) => {
        recordOf(second).withTx(tx).key("requestHash").set(requestHash);
      });
      const seen = await startHarnessRunner(async ({ resultPath }) => {
        await Deno.writeTextFile(
          resultPath,
          JSON.stringify({ answer: "Hyperion" }),
        );
        return loopResult(`run-workspace-${crypto.randomUUID()}`);
      });

      await waitForState(first, "completed");
      await waitForState(second, "completed");

      expect(recordOf(first).get()?.requestHash).toBe(
        recordOf(second).get()?.requestHash,
      );
      expect(new Set(seen().workspaces).size).toBe(2);
    });

    it("fails when the validated result file disappears before the writer reads it", async () => {
      let file: string | undefined;
      let removed = false;
      await startHarnessRunner(async ({ resultPath }) => {
        file = resultPath;
        await Deno.writeTextFile(
          resultPath,
          JSON.stringify({ answer: "Solaris" }),
        );
        return loopResult("run-disappearing-result");
      }, {
        omitHarnessArgs: true,
        report: (message) => {
          if (message.includes("Done.") && file !== undefined) {
            Deno.removeSync(file);
            removed = true;
          }
        },
      });
      const result = await submit();
      const record = await waitForState(result, "failed");

      expect(removed).toBe(true);
      expect(record.errorCode).toBe("PROVIDER_FAILURE");
      expect(record.result).toBeUndefined();
    });

    it("reports a prompt-loop provider error as `PROVIDER_FAILURE`", async () => {
      await startHarnessRunner(() =>
        Promise.reject(new Error("provider disconnected"))
      );
      const result = await submit();
      const record = await waitForState(result, "failed");

      expect(record.errorCode).toBe("PROVIDER_FAILURE");
    });

    it("fails as `PROVIDER_FAILURE` a result that does not fit the schema", async () => {
      await startHarnessRunner(async ({ resultPath }) => {
        await Deno.writeTextFile(resultPath, JSON.stringify({ answer: 7 }));
        return loopResult("run-bad-result");
      });
      const result = await submit();

      const record = await waitForState(result, "failed");

      expect(record.errorCode).toBe("PROVIDER_FAILURE");
    });

    it("fails as `LIMIT_REACHED` a run the model-turn limit ended", async () => {
      await startHarnessRunner(() =>
        Promise.reject(
          new Error(
            "prompt loop exceeded max model turns (8) without a final assistant response",
          ),
        )
      );
      const result = await submit();

      const record = await waitForState(result, "failed");

      expect(record.errorCode).toBe("LIMIT_REACHED");
    });

    it("ends `cancelled` a run whose loop the cancel aborted", async () => {
      const started = defer<void>();
      await startHarnessRunner(({ signal }) => {
        started.resolve();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
          );
        });
      });
      const result = await submit();
      await started.promise;
      await waitForState(result, "running");

      await patternSide.editWithRetry((tx) => {
        recordOf(result).withTx(tx).key("cancelRequestedAt")
          .set("2026-09-18T12:01:00.000Z");
      });

      const record = await waitForState(result, "cancelled");
      expect(record.errorCode).toBe("CANCELLED");
    });
  });
});
