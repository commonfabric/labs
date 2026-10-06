import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import type { PostCommitSideEffect } from "../src/cfc/types.ts";
import { abandonRunnerAcceptanceEffects } from "../src/executor/runner-acceptance.ts";
import {
  requireWaveAcceptance,
  stampWaveRunContext,
  WaveAccumulator,
  waveSettlementOf,
} from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("keyless program selection");
const space = signer.did();

describe("runner-keyless-program-selection", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let cancelDemands: Array<() => void>;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    cancelDemands = [];
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    for (const cancel of cancelDemands) cancel();
    runtime.clearSealDestination();
    await runtime.dispose();
    await storage.close();
  });

  /** Starts a scoped keyless program and returns a different live program. */
  async function startProgram() {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const first = pattern<{ value: number }>(({ value }) => ({
      answer: lift((input: number) => input + 1)(value),
    }));
    const second = pattern<{ value: number }>(({ value }) => ({
      answer: lift((input: number) => input + 10)(value),
    }));
    const result = runtime.getCell<{ answer: number }>(
      space,
      "keyless-child",
      first.resultSchema,
      undefined,
      "user",
    );
    const tx = runtime.edit();
    runtime.run(tx, first, { value: 1 }, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    cancelDemands.push(result.sink(() => {}));
    expect(await result.pull()).toEqual({ answer: 2 });
    const original = runtime.runner.sessionPatternPointerFor(result);
    expect(original?.identity.startsWith("keyless:")).toBe(true);
    return { result, second, original: original! };
  }

  /** Mutates the live input through the piece's argument link. */
  async function writeValue(result: Cell<unknown>, value: number) {
    const argument = result.getArgumentCell();
    expect(argument).toBeDefined();
    const tx = runtime.edit();
    argument!.withTx(tx).key("value").set(value);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
  }

  /** Holds effects until the wave accepts, as the serving destination does. */
  function beginWave() {
    const wave = new WaveAccumulator({
      space,
      basisSeq: 0,
      scopeKeyIdentity: runtime.scopeKeyIdentity,
      replicaFor: (space) => storage.open(space).replica,
    });
    const effects: PostCommitSideEffect[] = [];
    runtime.installSealDestination({
      seal: (tx) => wave.seal(tx),
      deferSealedEffects: (_tx, deferred) => {
        for (const effect of deferred) effects.push(effect);
        return true;
      },
    });
    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "keyless-pointer-change",
      kind: "bookkeeping",
    });
    return {
      wave,
      tx,
      effects,
      abandon: (reason: string) => {
        runtime.clearSealDestination();
        wave.abandon(reason);
        abandonRunnerAcceptanceEffects(effects, reason);
      },
    };
  }

  it("keeps a staged keyless pointer private across transaction wrappers and abort", async () => {
    const { result, second, original } = await startProgram();
    const tx = runtime.edit();
    const wrapper = new TransactionWrapper(tx);
    runtime.setup(wrapper, second, { value: 1 }, result.withTx(wrapper));

    const staged = runtime.runner.sessionPatternPointerFor(result.withTx(tx));
    expect(staged?.identity).not.toBe(original.identity);
    expect(staged?.identity.startsWith("keyless:")).toBe(true);
    expect(runtime.runner.sessionPatternPointerFor(result)?.identity).toBe(
      original.identity,
    );
    expect(tx.abort("The keyless setup is refused").error).toBeUndefined();
    expect(runtime.runner.sessionPatternPointerFor(result)?.identity).toBe(
      original.identity,
    );
    await writeValue(result, 5);
    expect(result.key("answer").get()).toBe(6);
  });

  it("reuses setup metadata from the caller's transaction", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const program = pattern<{ value: number }>(({ value }) => ({
      answer: lift((input: number) => input + 1)(value),
    }));
    const result = runtime.getCell(
      space,
      "actor-only-setup",
      program.resultSchema,
      undefined,
      "user",
    );
    const actor = {
      principal: (await Identity.fromPassphrase("keyless setup actor")).did(),
      sessionId: runtime.scopeKeyIdentity.sessionId,
    };
    const first = runtime.edit();
    first.tx.scopeKeyIdentity = actor;
    try {
      runtime.run(first, program, { value: 1 }, result.withTx(first));
      expect(result.getMetaRaw("argument")).toBeUndefined();

      const started = await runtime.setup(first, program, { value: 2 }, result);
      expect(started.getAsNormalizedFullLink().id).toBe(
        result.getAsNormalizedFullLink().id,
      );
      expect(
        result.withTx(first).getArgumentCell()?.withTx(first).key("value")
          .get(),
      ).toBe(2);
    } finally {
      expect(first.abort("The actor setup check is complete").error)
        .toBeUndefined();
    }
  });

  it("preserves the accepted keyless program when a staged setup wave is withdrawn", async () => {
    const { result, second, original } = await startProgram();
    const { wave, tx, abandon } = beginWave();
    runtime.setup(new TransactionWrapper(tx), second, { value: 2 }, result);
    expect((await tx.commit().settled).error).toBeUndefined();
    const settlement = waveSettlementOf(tx);
    expect(settlement).toBeDefined();
    expect(runtime.runner.sessionPatternPointerFor(result)?.identity).toBe(
      original.identity,
    );

    abandon("The keyless setup wave is withdrawn");
    expect((await settlement)?.error).toBeDefined();
    await wave.settled();
    expect(runtime.runner.sessionPatternPointerFor(result)?.identity).toBe(
      original.identity,
    );
    await writeValue(result, 5);
    expect(result.key("answer").get()).toBe(6);
  });

  it("keeps a keyless swap with unchanged stored data private until its wave is accepted", async () => {
    const { result, second, original } = await startProgram();
    const { wave, tx, abandon } = beginWave();
    runtime.setup(tx, second, { value: 1 }, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    const published = runtime.runner.sessionPatternPointerFor(result);

    abandon("The program-only setup wave is withdrawn");
    await wave.settled();
    expect(published?.identity).toBe(original.identity);
    expect(runtime.runner.sessionPatternPointerFor(result)?.identity).toBe(
      original.identity,
    );
    await writeValue(result, 5);
    expect(result.key("answer").get()).toBe(6);
  });

  it("rejects publication when a deferred effect flushes after its contribution withdraws", async () => {
    const { result, second, original } = await startProgram();
    const { wave, tx, effects } = beginWave();
    runtime.setup(tx, second, { value: 2 }, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    const settlement = waveSettlementOf(tx);
    expect(settlement).toBeDefined();

    runtime.clearSealDestination();
    wave.abandon("The setup contribution is withdrawn");
    expect((await settlement)?.error).toBeDefined();
    await wave.settled();
    // The outbox may flush an effect whose own contribution withdrew.
    for (const effect of effects) await effect.flush(tx);
    expect(runtime.runner.sessionPatternPointerFor(result)?.identity).toBe(
      original.identity,
    );
    await writeValue(result, 5);
    expect(result.key("answer").get()).toBe(6);
  });

  it("withdraws a program-only choice that read a selectively withdrawn contribution", async () => {
    const { result, second, original } = await startProgram();
    const choice = runtime.getCell<number>(space, "keyless-choice", undefined);
    const { wave, tx, effects } = beginWave();
    const parent = runtime.edit();
    stampWaveRunContext(parent, {
      actionId: "derive-keyless-choice",
      kind: "derivation",
    });
    choice.withTx(parent).set(10);
    expect((await parent.commit().settled).error).toBeUndefined();

    expect(choice.withTx(tx).get()).toBe(10);
    runtime.setup(new TransactionWrapper(tx), second, { value: 1 }, result);
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(wave.contributionCount).toBe(2);
    const choiceId = choice.getAsNormalizedFullLink().id;
    const outcome = await wave.commitWave({
      currentHeads: () => Promise.resolve(new Map([[`${choiceId} space`, 1]])),
      concurrentWritePaths: () => Promise.resolve([]),
      commitWave: () => {
        throw new Error("The withdrawn choice must leave no durable writes");
      },
    });
    runtime.clearSealDestination();
    await wave.settled();
    expect(outcome.aborted).toBeUndefined();
    expect(outcome.dispositions[0]).toEqual({ kind: "dropped" });
    expect(outcome.dispositions[1]).toEqual({ kind: "dropped" });
    for (const effect of effects) await effect.flush(tx);
    expect(runtime.runner.sessionPatternPointerFor(result)?.identity).toBe(
      original.identity,
    );
    await writeValue(result, 5);
    expect(result.key("answer").get()).toBe(6);
  });

  it("holds an opted-in local change with no reads until the wave verdict", async () => {
    const { wave, tx, abandon } = beginWave();
    requireWaveAcceptance(new TransactionWrapper(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    const settlement = waveSettlementOf(tx);
    expect(settlement).toBeDefined();
    let settled = false;
    void settlement!.then(() => settled = true);
    await Promise.resolve();
    expect(settled).toBe(false);

    abandon("The local-only wave is withdrawn");
    expect((await settlement)?.error).toBeDefined();
    await wave.settled();
    expect(settled).toBe(true);
  });

  it("wakes the shared coordinator when setup accepts a different keyless program", async () => {
    const { result, second, original } = await startProgram();
    const tx = runtime.edit();
    runtime.setup(tx, second, { value: 1 }, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(runtime.runner.sessionPatternPointerFor(result)?.identity).not.toBe(
      original.identity,
    );
    expect(await result.pull()).toEqual({ answer: 11 });
    await writeValue(result, 5);
    expect(result.key("answer").get()).toBe(15);
    expect(runtime.runner.accessForTestingOnly.scopedProgramCounts()).toEqual([
      { piece: result.getAsNormalizedFullLink().id, variants: 1 },
    ]);
  });

  it("publishes a program-only change after its empty wave accepts", async () => {
    const { result, second, original } = await startProgram();
    const { wave, tx, effects } = beginWave();
    runtime.setup(tx, second, { value: 1 }, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    const settlement = waveSettlementOf(tx);
    expect(settlement).toBeDefined();
    expect(effects.length).toBeGreaterThan(0);
    expect(runtime.runner.sessionPatternPointerFor(result)?.identity).toBe(
      original.identity,
    );
    const outcome = await wave.commitWave({
      currentHeads: () => Promise.resolve(new Map()),
      concurrentWritePaths: () => Promise.resolve([]),
      commitWave: () => {
        throw new Error("An empty wave must not write to storage");
      },
    });
    expect(outcome.aborted).toBeUndefined();
    runtime.clearSealDestination();
    expect((await settlement)?.error).toBeUndefined();
    for (const effect of effects) await effect.flush(tx);
    expect(await result.pull()).toEqual({ answer: 11 });
  });

  it("wakes an installed program that ran before its keyless pointer was accepted", async () => {
    const { result, second, original } = await startProgram();
    const priorActions = new Set(
      runtime.scheduler.accessForTestingOnly.nodes.computations,
    );
    const { wave, tx, effects } = beginWave();
    runtime.run(tx, second, { value: 1 }, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    const newActions = [
      ...runtime.scheduler.accessForTestingOnly.nodes.computations,
    ].filter((action) => !priorActions.has(action));
    expect(newActions.length).toBeGreaterThan(0);

    runtime.scheduler.setActionRunTraceEnabled(true);
    for (const action of newActions) await runtime.scheduler.run(action);
    const newActionIds = new Set(
      newActions.map((action) =>
        runtime.scheduler.accessForTestingOnly.getActionId(action)
      ),
    );
    expect(
      runtime.scheduler.getActionRunTrace().some((entry) =>
        newActionIds.has(entry.actionId)
      ),
    ).toBe(true);
    expect(runtime.runner.sessionPatternPointerFor(result)?.identity).toBe(
      original.identity,
    );
    expect(result.key("answer").get()).toBe(2);

    const outcome = await wave.commitWave({
      currentHeads: () => Promise.resolve(new Map()),
      concurrentWritePaths: () => Promise.resolve([]),
      commitWave: () => {
        throw new Error("An empty wave must not write to storage");
      },
    });
    expect(outcome.aborted).toBeUndefined();
    runtime.clearSealDestination();
    for (const effect of effects) await effect.flush(tx);
    expect(await result.pull()).toEqual({ answer: 11 });
    await writeValue(result, 5);
    expect(result.key("answer").get()).toBe(15);
  });

  it("preserves a keyless pointer and graph when the clear wave is withdrawn", async () => {
    const { result, original } = await startProgram();
    const { wave, tx, abandon } = beginWave();
    runtime.runner.clearInTransaction(new TransactionWrapper(tx), result);
    expect(runtime.runner.sessionPatternPointerFor(result.withTx(tx)))
      .toBeUndefined();
    expect((await tx.commit().settled).error).toBeUndefined();
    const settlement = waveSettlementOf(tx);
    expect(settlement).toBeDefined();
    expect(runtime.runner.sessionPatternPointerFor(result)?.identity).toBe(
      original.identity,
    );

    abandon("The keyless clear wave is withdrawn");
    expect((await settlement)?.error).toBeDefined();
    await wave.settled();
    await writeValue(result, 5);
    expect(result.key("answer").get()).toBe(6);
    expect(runtime.runner.sessionPatternPointerFor(result)?.identity).toBe(
      original.identity,
    );
  });

  it("does not publish a pending setup after the runner stops", async () => {
    const { result, second, original } = await startProgram();
    const tx = runtime.edit();
    runtime.setup(tx, second, { value: 2 }, result.withTx(tx));
    runtime.runner.stopAll();
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();

    expect(runtime.runner.sessionPatternPointerFor(result)?.identity).toBe(
      original.identity,
    );
    expect(runtime.runner.cancels.size).toBe(0);
    expect(runtime.runner.accessForTestingOnly.scopedProgramCounts()).toEqual(
      [],
    );
  });
});
