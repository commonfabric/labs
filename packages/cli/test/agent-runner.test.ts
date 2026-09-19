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

import type { HarnessPromptLoopResult } from "@commonfabric/cf-harness/prompt-loop";
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
import { renderCellReference } from "@commonfabric/runner/shared";
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
      registerRunner: async (entry) => {
        await own[CLOUD].editWithRetry((tx) => {
          agentQueueIndexCell(own[CLOUD], home, tx).key("agentRunner")
            .set(entry);
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
    const states: string[] = [];
    const stop = recordOf(result).sink((value) => {
      if (value?.state && states.at(-1) !== value.state) {
        states.push(value.state);
      }
    });
    const runtime = connect(CLOUD);
    await startRunner(completing(() => runtime));

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
    const execute = (name: string) => (_run: ClaimedAgentRun) => {
      claims.push(name);
      return held.promise;
    };
    // Both runners follow the queue before the request exists, so both see
    // the new entry and race for it.
    const [a, b] = await Promise.all([
      startRunner(execute("a")),
      startRunner(execute("b")),
    ]);

    const result = await submit();
    await waitForState(result, "running");
    await patternSide.idle();

    expect(claims.length).toBe(1);
    expect(a.activeRuns + b.activeRuns).toBe(1);
    expect(recordOf(result).get()?.attempts).toBe(1);

    held.resolve({ outcome: "failed", errorCode: "PROVIDER_FAILURE" });
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
      await startRunner((run) => {
        claimed.push(run.record.attempts ?? 0);
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

  it("renews the lease when the run reports a durable write", async () => {
    const renewed = defer<void>();
    const held = defer<AgentRunExecution>();
    await startRunner(async (run) => {
      clock = new Date("2026-09-18T12:10:00.000Z");
      await run.renewLease();
      renewed.resolve();
      return held.promise;
    });
    const result = await submit();
    await renewed.promise;

    const record = await waitForCellValue<AgentRunRecord>(
      patternSide,
      recordOf(result),
      (value) => value?.claim?.leaseUntil === "2026-09-18T12:11:00.000Z",
    );
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
          // What an aborted harness run reports on its way out.
          resolve({ outcome: "failed", errorCode: "PROVIDER_FAILURE" }));
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

  it("leaves a request naming a tool it does not offer `queued`", async () => {
    const result = await submit({ tools: ["loom_profile"] });
    const runner = await startRunner(() =>
      Promise.resolve({ outcome: "refused" })
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
      registeredAt: "2026-09-18T12:00:00.000Z",
      lastClaimAt: "2026-09-18T12:05:00.000Z",
    });
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
    ) => {
      const sessionRuntime = connect(CLOUD);
      const pieces = new PiecesController(
        await createSession({ identity: signer, spaceDid: home }),
        sessionRuntime,
      );
      let seen: { argv?: unknown; slotRole?: string } = {};
      const execute = createHarnessAgentRunExecutor({
        identityKeyPath: join(workRoot, "unused.key"),
        requester: home,
        workRoot,
        report: (m) => Deno.env.get("AGENT_TEST_DEBUG") && console.log(m),
        harnessArgs: [
          "--model-provider",
          "openai-compatible-gateway",
          "--gateway-auth-mode",
          "none",
        ],
        harnessDeps: {
          env: {},
          fabricSessionFactory: () => Promise.resolve({ pieces }),
          createPromptLoop: (options) => ({
            runPrompt: (prompt) => {
              seen = {
                slotRole: prompt.promptSlotBinding?.role,
                argv: options.inputCells,
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
      await startRunner(execute);
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
      expect(
        (seen().argv as { name: string }[]).map((cell) => cell.name),
      ).toEqual(["finished"]);
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
      let finished: Cell<unknown> | undefined;
      await startHarnessRunner(async ({ resultPath }) => {
        const minted = await mintAddressHandle(
          createHarnessHandleTable("run-token"),
          renderCellReference(finished!.getAsNormalizedFullLink()),
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
      finished = (recordOf(result).key("inputs").get() as unknown as Record<
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

    it("fails as `PROVIDER_FAILURE` a run that wrote no result", async () => {
      await startHarnessRunner(() =>
        Promise.resolve(loopResult("run-no-result"))
      );
      const result = await submit();

      const record = await waitForState(result, "failed");

      expect(record.errorCode).toBe("PROVIDER_FAILURE");
      expect(record.modelTurns).toBe(3);
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
