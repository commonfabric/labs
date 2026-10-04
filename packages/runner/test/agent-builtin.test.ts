/**
 * The `agent` builtin without a runner: what its staging transaction leaves
 * behind, and how its result cell follows the record from there.
 *
 * No agent runs here. The record the post-commit effect creates is the
 * handoff to a runner, so a fake runner in each case writes the fields a
 * real one would — `claimed`, `completed` with a result link, `failed` with
 * an error code — straight into the record, and the cases assert what the
 * builtin's result cell derives from each.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/utils/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { createBuilder } from "../src/builder/factory.ts";
import { agentQueueIndexCell } from "../src/builtins/agent.ts";
import { renderCellReference } from "../src/cell-reference.ts";
import type { Cell } from "../src/cell.ts";
import { isCellLink } from "../src/link-utils.ts";
import { Runtime, type RuntimeOptions } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { seedHomeAgentQueue } from "./support/agent-queue.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("agent builtin");
const space = signer.did();

const RESULT_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
} as const;

// A caveat no sink is cleared for under an empty ceiling. Reading an input
// carrying it puts it on the staged request, which the `agent: []` ceiling
// below refuses at `enforce-strict`.
const PROMPT_INFLUENCE = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
  source: "of:hostile",
} as const;

type AgentResult = {
  pending?: boolean;
  result?: { answer: string };
  error?: string;
  requestHash?: string;
  run?: {
    state?: string;
    submittedAt?: string;
    tools?: string[];
    task?: string;
  };
  host?: string;
};

describe("agent builtin", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: ReturnType<typeof createBuilder>["commonfabric"];

  /**
   * Builds the runtime under test; `agentBuiltin` is on unless overridden.
   * The home space holds an empty agent queue unless `seedQueue` is false.
   */
  const setUp = (
    options: Partial<RuntimeOptions> = {},
    { seedQueue = true }: { seedQueue?: boolean } = {},
  ) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://fabric.example/"),
      storageManager,
      ...options,
    });
    tx = runtime.edit();
    if (seedQueue) seedHomeAgentQueue(runtime, space, tx);
    ({ commonfabric } = createTrustedBuilder(runtime));
  };

  afterEach(async () => {
    await tx.commit();
    await runtime.idle();
    await runtime.dispose();
    await storageManager.close();
  });

  /** Runs a pattern calling `agent()` over `finished`, and returns its cell. */
  const runAgentPattern = (
    id: string,
    params: Record<string, unknown> = {},
  ): Cell<AgentResult> => {
    const { pattern, agent, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const finished = BuilderCell.of(["Dune", "Solaris"], {
        type: "array",
        items: { type: "string" },
      });
      return agent({
        task: "which of these would a reader of the listed authors like?",
        inputs: { finished },
        resultSchema: RESULT_SCHEMA,
        ...params,
        // deno-lint-ignore no-explicit-any
      } as any);
    });
    const resultCell = runtime.getCell(space, id, testPattern.resultSchema, tx);
    const result = runtime.run(tx, testPattern, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    return result as Cell<AgentResult>;
  };

  /** Resolves once the record behind `result.run` reports a state. */
  const waitForRecord = async (result: Cell<AgentResult>) => {
    await waitForCellValue<{ state?: string }>(
      runtime,
      result.key("run"),
      (value) => value?.state !== undefined,
    );
    await runtime.settled();
    return result.key("run").resolveAsCell();
  };

  /**
   * Stops the piece behind `result` and runs it again with nothing carried
   * over, as a process taking over from one that stopped does, and returns
   * the new run's result once everything it started has settled.
   */
  const restart = async (id: string, result: Cell<AgentResult>) => {
    runtime.runner.stop(result);
    tx = runtime.edit();
    const restarted = runAgentPattern(id);
    await tx.commit();
    const cancelDemand = restarted.sink(() => {});
    await runtime.settled();
    cancelDemand();
    return restarted;
  };

  it("settles with an error naming the flag when `agentBuiltin` is off", async () => {
    setUp({ experimental: { agentBuiltin: false } });
    const result = runAgentPattern("agent-flag-off");
    await tx.commit();

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => typeof value?.error === "string",
    );
    await runtime.settled();

    expect(settled.error).toContain("agentBuiltin");
    expect(settled.pending).toBe(false);
    expect(result.withTx().key("run").get()).toBeUndefined();
  });

  it("creates a queued record holding the task as a value and each input as a link", async () => {
    setUp();
    const result = runAgentPattern("agent-record-shape");
    await tx.commit();

    const record = await waitForRecord(result);
    const raw = record.getRaw() as Record<string, unknown>;

    expect(raw.state).toBe("queued");
    expect(raw.task).toBe(
      "which of these would a reader of the listed authors like?",
    );
    expect(typeof raw.submittedAt).toBe("string");
    expect(raw.stateSince).toBe(raw.submittedAt);
    expect(raw.requestHash).toBe(result.withTx().key("requestHash").get());
    // The input reaches the record as a reference and never as its value.
    const inputs = raw.inputs as Record<string, unknown>;
    expect(isCellLink(inputs.finished)).toBe(true);
    expect(record.key("inputs").key("finished").get()).toEqual([
      "Dune",
      "Solaris",
    ]);
    expect(result.withTx().key("pending").get()).toBe(true);
    // The host serving the record's space rides beside the `run` link.
    expect(result.withTx().key("host").get()).toBe("https://fabric.example");
    // Nothing a runner writes is present yet.
    expect(raw.claim).toBeUndefined();
    expect(raw.result).toBeUndefined();
    expect(raw.outcome).toBeUndefined();
  });

  for (const name of ["", "bad name", ".hidden"]) {
    it(`rejects the invalid input name ${JSON.stringify(name)} before staging`, async () => {
      setUp();
      const result = runAgentPattern(`agent-invalid-input-${name}`, {
        inputs: { [name]: ["Dune"] },
      });
      await tx.commit();

      const settled = await waitForCellValue<AgentResult>(
        runtime,
        result,
        (value) => typeof value?.error === "string",
      );
      expect(settled.error).toContain("INVALID_INPUT");
      expect(settled.pending).toBe(false);
      expect(result.withTx().key("run").get()).toBeUndefined();
      expect(agentQueueIndexCell(runtime, space).key("entries").get()).toEqual(
        [],
      );
    });
  }

  it("uses the canonical run scope when the stored queue has an unscoped item schema", async () => {
    setUp();
    const entries = runtime.getCell(space, "stored-agent-entries", {
      type: "array",
      items: {
        type: "object",
        properties: {
          run: { type: "object" },
          host: { type: "string" },
        },
        required: ["run", "host"],
      },
    }, tx);
    entries.set([]);
    agentQueueIndexCell(runtime, space, tx).key("entries").set(entries);
    const logger = getLogger("normalizeAndDiff");
    const warningsBefore = logger.countsByKey.diff?.warn ?? 0;
    const result = runAgentPattern("agent-stored-queue-scope");
    await tx.commit();

    const record = await waitForRecord(result);
    const index = agentQueueIndexCell(runtime, space);
    await waitForCellValue<{ run: unknown; host: string }[]>(
      runtime,
      index.key("entries"),
      (value) => value?.length === 1,
    );
    const indexed = index.key("entries").key(0).key("run").resolveAsCell();
    expect(indexed.getAsNormalizedFullLink().scope).toBe("user");
    expect(indexed.equals(record)).toBe(true);
    expect(logger.countsByKey.diff?.warn ?? 0).toBe(warningsBefore);
  });

  it("appends one `{run, host}` entry to the requester's home index", async () => {
    setUp();
    const result = runAgentPattern("agent-home-index");
    await tx.commit();

    const record = await waitForRecord(result);
    const index = agentQueueIndexCell(runtime, space);
    const entries = await waitForCellValue<
      { run: unknown; host: string; address?: string }[]
    >(
      runtime,
      index.key("entries"),
      (value) => (value?.length ?? 0) > 0,
    );

    expect(entries.length).toBe(1);
    expect(entries[0].host).toBe("https://fabric.example");
    expect(entries[0].address).toBe(
      renderCellReference(record.getAsNormalizedFullLink()),
    );
    expect(
      index.key("entries").key(0).key("run").resolveAsCell()
        .getAsNormalizedFullLink().id,
    ).toBe(record.getAsNormalizedFullLink().id);
  });

  it("writes the entry into the queue the home default pattern holds", async () => {
    setUp();
    const result = runAgentPattern("agent-index-home-piece");
    await tx.commit();

    await waitForRecord(result);
    const queue = runtime.getHomeSpaceCell().key("defaultPattern")
      .resolveAsCell()
      // deno-lint-ignore no-explicit-any
      .key("agentQueue" as any) as Cell<{ entries?: { host: string }[] }>;
    const entries = await waitForCellValue<{ host: string }[]>(
      runtime,
      queue.key("entries"),
      (value) => (value?.length ?? 0) > 0,
    );

    expect(entries.map((entry) => entry.host)).toEqual([
      "https://fabric.example",
    ]);
  });

  it("ends the record as `refused` when the home space holds no queue", async () => {
    setUp({}, { seedQueue: false });
    const result = runAgentPattern("agent-no-queue");
    await tx.commit();

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => value?.pending === false,
    );
    await runtime.settled();

    expect(settled.error).toBe("REFUSED");
    expect(agentQueueIndexCell(runtime, space).get()).toBeUndefined();
    expect(runtime.getHomeSpaceCell().getRaw()).toBeUndefined();
  });

  it("settles with a refusal when loading the home queue fails", async () => {
    setUp();
    const result = runAgentPattern("agent-queue-load-failure");
    const syncCell = storageManager.syncCell.bind(storageManager);
    let rejected = false;
    using _sync = stub(storageManager, "syncCell", (cell, options) => {
      const link = cell.getAsNormalizedFullLink();
      if (!rejected && link.path?.at(-1) === "agentQueue") {
        rejected = true;
        return Promise.reject(new Error("queue unavailable"));
      }
      return syncCell(cell, options);
    });
    await tx.commit();

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => value?.pending === false,
    );
    await runtime.settled();

    expect(settled.error).toBe("agent request was refused before it started");
    expect(settled.run).toBeUndefined();
    expect(rejected).toBe(true);
  });

  it("lists two requests staged together as two entries to two records", async () => {
    setUp();
    // Two requests whose index writes run side by side: each entry has to
    // land as an element of its own, not as one element written twice.
    const first = runAgentPattern("agent-index-pair-a", { task: "first" });
    const second = runAgentPattern("agent-index-pair-b", { task: "second" });
    await tx.commit();

    await waitForRecord(first);
    await waitForRecord(second);
    const index = agentQueueIndexCell(runtime, space);
    await waitForCellValue<unknown[]>(
      runtime,
      index.key("entries"),
      (value) => (value?.length ?? 0) > 1,
    );
    await runtime.settled();

    const tasks = [0, 1].map((at) =>
      (index.key("entries").key(at).key("run").resolveAsCell().get() as {
        task?: string;
      })?.task
    );
    expect(tasks.toSorted()).toEqual(["first", "second"]);
  });

  it("creates no second record on a memo hit", async () => {
    setUp();
    const hits: string[] = [];
    runtime.effectMemoObserver = (event) => {
      if (event.kind === "hit") hits.push(event.id);
    };
    const result = runAgentPattern("agent-memo-hit");
    await tx.commit();

    const record = await waitForRecord(result);
    const submittedAt = record.get()?.submittedAt;
    const hash = result.withTx().key("requestHash").get();

    // A runner's claim changes the record, which re-runs the builtin over an
    // unchanged request: the memo hit, and no second staging.
    await runtime.editWithRetry((tx) => {
      record.withTx(tx).key("state").set("claimed");
      record.withTx(tx).key("stateSince").set("2026-09-18T00:00:01.000Z");
    });
    await waitForCellValue<{ state?: string }>(
      runtime,
      result.key("run"),
      (value) => value?.state === "claimed",
    );
    await runtime.settled();

    expect(hits).toContain(`agent:${hash}`);
    expect(record.get()?.submittedAt).toBe(submittedAt);
    expect(result.withTx().key("pending").get()).toBe(true);
    const entries = agentQueueIndexCell(runtime, space).key("entries").get();
    expect(entries?.length).toBe(1);
  });

  it("derives `pending: false` and `result` from a completed record", async () => {
    setUp();
    const result = runAgentPattern("agent-completed");
    await tx.commit();

    const record = await waitForRecord(result);
    const answer = runtime.getCell<{ answer: string }>(
      space,
      "agent-completed-answer",
      RESULT_SCHEMA,
    );
    await runtime.editWithRetry((tx) => {
      answer.withTx(tx).set({ answer: "Solaris" });
      const recordTx = record.withTx(tx);
      recordTx.key("state").set("completed");
      recordTx.key("outcome").set("completed");
      recordTx.key("result").set(answer);
    });

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => value?.pending === false,
    );
    await runtime.settled();

    expect(settled.error).toBeUndefined();
    expect(result.withTx().key("result").get()).toEqual({ answer: "Solaris" });
    expect(result.withTx().key("run").get()?.state).toBe("completed");
  });

  it("derives `error` from a failed record's `errorCode`", async () => {
    setUp();
    const result = runAgentPattern("agent-failed");
    await tx.commit();

    const record = await waitForRecord(result);
    await runtime.editWithRetry((tx) => {
      const recordTx = record.withTx(tx);
      recordTx.key("state").set("failed");
      recordTx.key("outcome").set("failed");
      recordTx.key("errorCode").set("PROVIDER_FAILURE");
    });

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => value?.pending === false,
    );
    await runtime.settled();

    expect(settled.error).toBe("PROVIDER_FAILURE");
    expect(result.withTx().key("result").get()).toBeUndefined();
  });

  it("settles the refusal when the staging transaction is abandoned", async () => {
    setUp({
      cfcEnforcementMode: "enforce-strict",
      cfcSinkMaxConfidentiality: { agent: [] },
    });
    const { Cell: BuilderCell } = commonfabric;
    const { pattern, agent } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const task = BuilderCell.of("a briefing the ceiling does not admit", {
        type: "string",
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      });
      // deno-lint-ignore no-explicit-any
      return agent({ task, inputs: {}, resultSchema: RESULT_SCHEMA } as any);
    });
    const resultCell = runtime.getCell(
      space,
      "agent-abandoned",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell) as Cell<
      AgentResult
    >;
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => typeof value?.error === "string" && value.error.length > 0,
    );
    await runtime.settled();

    expect(settled.error).toContain("was refused before it started");
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(settled.pending).toBe(false);
    expect(result.withTx().key("run").get()).toBeUndefined();
  });

  it("refuses before staging a request outside its own `maxConfidentiality`", async () => {
    setUp();
    const { pattern, agent, Cell: BuilderCell } = commonfabric;
    const testPattern = pattern<Record<string, never>>(() => {
      const task = BuilderCell.of("a task built from labeled data", {
        type: "string",
        ifc: { confidentiality: [PROMPT_INFLUENCE] },
      });
      return agent({
        task,
        inputs: {},
        resultSchema: RESULT_SCHEMA,
        maxConfidentiality: [],
        // deno-lint-ignore no-explicit-any
      } as any);
    });
    const resultCell = runtime.getCell(
      space,
      "agent-own-ceiling",
      testPattern.resultSchema,
      tx,
    );
    const result = runtime.run(tx, testPattern, {}, resultCell) as Cell<
      AgentResult
    >;
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => typeof value?.error === "string" && value.error.length > 0,
    );
    await runtime.settled();

    expect(settled.error).toContain("maxConfidentiality");
    expect(settled.error).not.toContain(PROMPT_INFLUENCE.source);
    expect(settled.pending).toBe(false);
    expect(result.withTx().key("run").get()).toBeUndefined();
  });

  it("settles idle, with no error, while the task is empty", async () => {
    setUp();
    const result = runAgentPattern("agent-no-request", { task: "" });
    await tx.commit();

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => value?.pending === false,
    );
    await runtime.settled();

    expect(settled.error).toBeUndefined();
    expect(settled.requestHash).toBeUndefined();
    expect(result.withTx().key("run").get()).toBeUndefined();
  });

  it("refuses before staging when no requesting identity resolves a home space", async () => {
    setUp();
    // A serving runtime running a node with no demanding principal resolves
    // no home space; the stub stands in for that posture.
    runtime.homeSpacePrincipalFor = () => undefined;
    const result = runAgentPattern("agent-no-identity");
    await tx.commit();

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => typeof value?.error === "string",
    );
    await runtime.settled();

    expect(settled.error).toContain("INVALID_INPUT");
    expect(settled.pending).toBe(false);
    expect(result.withTx().key("run").get()).toBeUndefined();
  });

  describe("when a post-commit write is rejected", () => {
    // `editWithRetry` reports a commit it could not land as `{ error }`. The
    // effect makes its writes in a fixed order — the record, then the index
    // entry — so rejecting the nth call rejects that write and no other.

    /**
     * Rejects each of the numbered writes, counting from the next one, and
     * runs `before` ahead of the first of them.
     */
    const rejectEffectWrite = (
      nths: number[],
      before?: () => Promise<void>,
    ) => {
      const original = runtime.editWithRetry.bind(runtime);
      let calls = 0;
      runtime.editWithRetry = (async (fn, ...rest) => {
        calls += 1;
        if (calls === nths[0]) await before?.();
        if (nths.includes(calls)) {
          return { error: new Error("rejected for the test") };
        }
        return original(fn, ...rest);
      }) as typeof runtime.editWithRetry;
    };

    it("settles the refusal when the record cannot be created", async () => {
      setUp();
      const result = runAgentPattern("agent-record-rejected");
      rejectEffectWrite([1]);
      await tx.commit();

      const settled = await waitForCellValue<AgentResult>(
        runtime,
        result,
        (value) => typeof value?.error === "string",
      );
      await runtime.settled();

      expect(settled.error).toContain("was refused before it started");
      expect(settled.pending).toBe(false);
      expect(result.withTx().key("run").get()).toBeUndefined();
    });

    it("leaves the request pending when the refusal cannot be written either", async () => {
      setUp();
      const result = runAgentPattern("agent-record-and-refusal-rejected");
      rejectEffectWrite([1, 2]);
      await tx.commit();
      await waitForCellValue<AgentResult>(
        runtime,
        result,
        (value) => value?.requestHash !== undefined,
      );
      await runtime.settled();

      // Nothing could be written, so the cell still holds what the staging
      // transaction committed; the rejection is reported to the operator.
      expect(result.withTx().key("pending").get()).toBe(true);
      expect(result.withTx().key("error").get()).toBeUndefined();
    });

    it("leaves the record queued when neither the index nor the refusal can be written", async () => {
      setUp();
      const result = runAgentPattern("agent-index-and-refusal-rejected");
      rejectEffectWrite([2, 3]);
      await tx.commit();

      const record = await waitForRecord(result);

      expect(record.get()?.state).toBe("queued");
      expect(result.withTx().key("pending").get()).toBe(true);
    });

    it("lists the record left unindexed once the piece starts again", async () => {
      setUp();
      const id = "agent-unindexed-restart";
      const first = runAgentPattern(id);
      rejectEffectWrite([2, 3]);
      await tx.commit();
      const record = await waitForRecord(first);
      const queue = agentQueueIndexCell(runtime, space);
      expect(queue.key("entries").get()).toEqual([]);

      const second = await restart(id, first);
      const entries = queue.key("entries").get() ?? [];

      expect(entries.map((entry) => entry.run.getAsNormalizedFullLink().id))
        .toEqual([record.getAsNormalizedFullLink().id]);
      expect(record.get()?.state).toBe("queued");
      expect(second.withTx().key("run").resolveAsCell().equals(record))
        .toBe(true);
      expect(second.withTx().key("pending").get()).toBe(true);
    });

    /**
     * Leaves a `queued` record no index lists, then restarts its piece with
     * the restarted node's listing rejected, and runs `race` as that
     * listing is attempted. Returns the record and the restarted result.
     */
    const restartWithListingRejected = async (
      id: string,
      race: (record: Cell<unknown>) => Promise<void>,
    ) => {
      setUp();
      const first = runAgentPattern(id);
      rejectEffectWrite([2, 3]);
      await tx.commit();
      const record = await waitForRecord(first);
      rejectEffectWrite([1], () => race(record));
      return { record, second: await restart(id, first) };
    };

    it("leaves a record another node listed while this node's listing failed", async () => {
      const { record, second } = await restartWithListingRejected(
        "agent-listed-elsewhere",
        async (record) => {
          const list = runtime.edit();
          agentQueueIndexCell(runtime, space, list).key("entries").push({
            run: record,
            host: "https://fabric.example",
          });
          await list.commit();
        },
      );

      expect(record.get()?.state).toBe("queued");
      expect(second.withTx().key("pending").get()).toBe(true);
      expect(second.withTx().key("error").get()).toBeUndefined();
    });

    it("leaves a record a runner claimed while this node's listing failed", async () => {
      // The claim is made with no entry listing the record, as when the
      // queue is rewritten after a runner has claimed it.
      const { record, second } = await restartWithListingRejected(
        "agent-claimed-unlisted",
        async (record) => {
          const claim = runtime.edit();
          record.withTx(claim).key("state").set("claimed");
          await claim.commit();
        },
      );

      expect(record.get()?.state).toBe("claimed");
      expect(second.withTx().key("pending").get()).toBe(true);
    });

    it("lists the record on a later run after the release check refused a listing", async () => {
      setUp();
      const id = "agent-listing-release-refused";
      const first = runAgentPattern(id);
      rejectEffectWrite([2, 3]);
      await tx.commit();
      const record = await waitForRecord(first);
      const queue = agentQueueIndexCell(runtime, space);

      // The release check compares the staged request with the policy input
      // the committed transaction prepared. Handing the first listing effect
      // a committed transaction that prepared none is how it is refused.
      let refusals = 1;
      const edit = runtime.edit.bind(runtime);
      runtime.edit = ((...args: Parameters<typeof runtime.edit>) => {
        const editTx = edit(...args);
        const enqueue = editTx.enqueuePostCommitEffect.bind(editTx);
        editTx.enqueuePostCommitEffect = (effect) =>
          enqueue(
            effect.kind !== "agent-list" || refusals-- <= 0 ? effect : {
              ...effect,
              flush: () =>
                effect.flush(
                  {
                    getCfcState: () => ({
                      writePolicyInputs: [],
                      prepare: {
                        status: "prepared",
                        input: { writePolicyInputs: [] },
                      },
                    }),
                  } as unknown as IExtendedStorageTransaction,
                ),
            },
          );
        return editTx;
      }) as typeof runtime.edit;
      const second = await restart(id, first);
      expect(queue.key("entries").get()).toEqual([]);

      // A change to the record runs the node again.
      const cancelDemand = second.sink(() => {});
      const touch = runtime.edit();
      record.withTx(touch).key("stateSince").set("2026-09-25T00:00:01.000Z");
      await touch.commit();
      await runtime.settled();
      cancelDemand();

      expect(
        (queue.key("entries").get() ?? []).map((entry) =>
          entry.run.getAsNormalizedFullLink().id
        ),
      ).toEqual([record.getAsNormalizedFullLink().id]);
      expect(second.withTx().key("error").get()).toBeUndefined();
    });

    it("leaves the cell to a newer request staged while the refusal waited", async () => {
      setUp();
      const { pattern, agent } = commonfabric;
      const testPattern = pattern<{ task: string }>(({ task }) =>
        // deno-lint-ignore no-explicit-any
        agent({ task, inputs: {}, resultSchema: RESULT_SCHEMA } as any)
      );
      const taskCell = runtime.getCell<string>(
        space,
        "agent-replaced-task",
        { type: "string" },
        tx,
      );
      taskCell.set("the first task");
      const resultCell = runtime.getCell(
        space,
        "agent-replaced",
        testPattern.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        testPattern,
        { task: taskCell },
        resultCell,
      ) as Cell<AgentResult>;
      runtime.prepareTxForCommit(tx);
      // The first request's record is rejected, and before its refusal is
      // written the task changes, which stages a second request.
      rejectEffectWrite([1], async () => {
        const replace = runtime.edit();
        taskCell.withTx(replace).set("the second task");
        await replace.commit();
      });
      await tx.commit();

      const record = await waitForRecord(result);

      expect(record.get()?.task).toBe("the second task");
      expect(result.withTx().key("error").get()).toBeUndefined();
      expect(result.withTx().key("pending").get()).toBe(true);
    });

    it("ends the record as `refused` when it cannot be indexed", async () => {
      setUp();
      const result = runAgentPattern("agent-index-rejected");
      rejectEffectWrite([2]);
      await tx.commit();

      const settled = await waitForCellValue<AgentResult>(
        runtime,
        result,
        (value) => value?.pending === false,
      );
      await runtime.settled();

      expect(settled.error).toBe("REFUSED");
      expect(result.withTx().key("run").get()?.state).toBe("refused");
      const entries = agentQueueIndexCell(runtime, space).key("entries").get();
      expect(entries ?? []).toEqual([]);
    });
  });

  it("refuses an unindexed record when the home queue disappears after record creation", async () => {
    setUp();
    const result = runAgentPattern("agent-queue-disappears");
    const editWithRetry = runtime.editWithRetry.bind(runtime);
    let effectWrites = 0;
    runtime.editWithRetry = (async (fn, ...rest) => {
      if (++effectWrites === 2) {
        await editWithRetry((removal) => {
          runtime.getCell(
            space,
            "test-home-default-pattern",
            undefined,
            removal,
          ).set({});
        });
      }
      return await editWithRetry(fn, ...rest);
    }) as typeof runtime.editWithRetry;
    await tx.commit();

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => value?.pending === false,
    );
    await runtime.settled();

    expect(settled.error).toBe("REFUSED");
    expect(result.withTx().key("run").get()?.state).toBe("refused");
    expect(agentQueueIndexCell(runtime, space).get()).toBeUndefined();
  });

  it("settles a request whose release check refuses it after commit", async () => {
    setUp();
    // The release check compares the staged request with the policy input
    // the committed transaction prepared. Handing the effect a committed
    // transaction that prepared none is how this case reaches the refusal.
    const edit = runtime.edit.bind(runtime);
    runtime.edit = ((...args: Parameters<typeof runtime.edit>) => {
      const editTx = edit(...args);
      const enqueue = editTx.enqueuePostCommitEffect.bind(editTx);
      editTx.enqueuePostCommitEffect = (effect) =>
        enqueue(
          effect.kind !== "agent-start" ? effect : {
            ...effect,
            flush: () =>
              effect.flush(
                {
                  getCfcState: () => ({
                    writePolicyInputs: [],
                    prepare: {
                      status: "prepared",
                      input: { writePolicyInputs: [] },
                    },
                  }),
                } as unknown as IExtendedStorageTransaction,
              ),
          },
        );
      return editTx;
    }) as typeof runtime.edit;
    const result = runAgentPattern("agent-release-refused");
    await tx.commit();

    const settled = await waitForCellValue<AgentResult>(
      runtime,
      result,
      (value) => typeof value?.error === "string",
    );
    await runtime.settled();

    expect(settled.error).toContain("was not released after commit");
    expect(settled.pending).toBe(false);
    expect(result.withTx().key("run").get()).toBeUndefined();
  });

  describe("when the effect finds its work already done", () => {
    /** Runs `before` ahead of the numbered effect write, which then proceeds. */
    const beforeEffectWrite = (nth: number, before: () => Promise<void>) => {
      const original = runtime.editWithRetry.bind(runtime);
      let calls = 0;
      runtime.editWithRetry = (async (fn, ...rest) => {
        calls += 1;
        if (calls === nth) await before();
        return await original(fn, ...rest);
      }) as typeof runtime.editWithRetry;
    };

    it("writes nothing over a record that already exists", async () => {
      setUp();
      const result = runAgentPattern("agent-record-exists");
      beforeEffectWrite(1, async () => {
        const claim = runtime.edit();
        const record = result.key("run").resolveAsCell();
        record.withTx(claim).key("state").set("claimed");
        await claim.commit();
      });
      await tx.commit();

      const record = await waitForRecord(result);

      // The effect's creation would have written the task and `queued`.
      expect(record.get()?.state).toBe("claimed");
      expect(record.getRaw()).not.toHaveProperty("task");
    });

    it("appends no second index entry for a record already listed", async () => {
      setUp();
      const result = runAgentPattern("agent-already-listed");
      beforeEffectWrite(2, async () => {
        const list = runtime.edit();
        agentQueueIndexCell(runtime, space, list).key("entries").push({
          run: result.key("run").resolveAsCell(),
          host: "https://fabric.example",
        });
        await list.commit();
      });
      await tx.commit();

      await waitForRecord(result);
      const entries = agentQueueIndexCell(runtime, space).key("entries").get();

      expect(entries?.length).toBe(1);
    });
  });

  it("leaves a listed record as it is when the piece starts again", async () => {
    setUp();
    const id = "agent-listed-restart";
    const first = runAgentPattern(id);
    await tx.commit();
    const record = await waitForRecord(first);
    const before = record.getRaw();

    const second = await restart(id, first);

    expect(record.getRaw()).toEqual(before);
    expect(agentQueueIndexCell(runtime, space).key("entries").get()?.length)
      .toBe(1);
    expect(second.withTx().key("pending").get()).toBe(true);
    expect(second.withTx().key("error").get()).toBeUndefined();
  });

  describe("the tool check against the registered runner", () => {
    it("fails before staging when `tools` names a tool the runner does not offer", async () => {
      setUp();
      agentQueueIndexCell(runtime, space, tx).key("agentRunner").set({
        host: "https://fabric.example",
        tools: ["loom_search"],
        registrationId: "runner-1",
        registeredAt: "2026-09-18T00:00:00.000Z",
      });
      const result = runAgentPattern("agent-tool-refused", {
        tools: ["loom_profile"],
      });
      await tx.commit();

      const settled = await waitForCellValue<AgentResult>(
        runtime,
        result,
        (value) => typeof value?.error === "string",
      );
      await runtime.settled();

      expect(settled.error).toContain("INVALID_INPUT");
      expect(settled.error).toContain("loom_profile");
      expect(settled.pending).toBe(false);
      expect(result.withTx().key("run").get()).toBeUndefined();
    });

    it("stages and stays queued when no runner is registered", async () => {
      setUp();
      const result = runAgentPattern("agent-tool-no-runner", {
        tools: ["loom_profile"],
      });
      await tx.commit();

      const record = await waitForRecord(result);

      expect(record.get()?.state).toBe("queued");
      expect(record.get()?.tools).toEqual(["loom_profile"]);
      expect(result.withTx().key("error").get()).toBeUndefined();
    });
  });
});
