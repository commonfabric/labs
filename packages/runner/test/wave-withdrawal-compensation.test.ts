/**
 * In-memory bookkeeping that the runtime undoes when a transaction does not
 * become durable, exercised where a transaction commits by being sealed into a
 * wave and the wave withdraws it afterwards.
 *
 * On a serving runtime a transaction's commit resolves once it is sealed into
 * a wave, and the wave can still withdraw it: a contribution that read a
 * pending write the wave drops is dropped with it, and an abandoned wave
 * withdraws everything sealed into it. Bookkeeping that reverts only when the
 * commit reports an error survives the withdrawal, and then describes writes
 * that never landed. Each case here withdraws one such transaction and checks
 * that whatever runs next converges on the state a durable commit would have
 * left.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { seedHomeAgentQueue } from "./support/agent-queue.ts";
import { ServingWaves } from "./support/serving-waves.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("wave withdrawal compensation");

type Source = { value: number; tag?: string };

describe("wave withdrawal compensation", () => {
  let waves: ServingWaves;

  beforeEach(async () => {
    waves = await ServingWaves.open(signer);
  });

  afterEach(async () => {
    await waves.dispose();
  });

  const newSource = async (value: number): Promise<Cell<Source>> => {
    const { runtime } = waves;
    const source = runtime.getCell<Source>(waves.space, "source", undefined);
    const seed = runtime.edit();
    source.withTx(seed).set({ value });
    expect((await seed.commit()).error).toBeUndefined();
    await waves.storageManager.synced();
    return source;
  };

  describe("a child that a derivation materializes", () => {
    // The derivation hands back a child pattern with the value baked in, so
    // the child's own node reads nothing that a later setup of the child
    // writes. A running child whose initial writes were withdrawn is
    // therefore never woken to write them again; only a fresh start of the
    // child does.

    /**
     * Starts a parent whose `child` is the pattern `makeChild` returns for the
     * source's value: none for `0`, and otherwise a child doubling the value.
     * `makeChild` also reads the source's `tag`, so a change to the tag runs it
     * again over the same value.
     */
    const startParent = async (source: Cell<Source>) => {
      const { runtime } = waves;
      const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
      const childPattern = pattern<{ value: number }>(({ value }) => ({
        doubled: lift((input: number) => input * 2)(value),
      }));
      const makeChild = lift(({ value, tag: _tag }: Source) =>
        value === 0 ? undefined : childPattern({ value })
      );
      const parentPattern = pattern<Source>(({ value, tag }) => ({
        child: makeChild({ value, tag }),
      }));
      const setup = runtime.edit();
      stampWaveRunContext(setup, { actionId: "setup", kind: "bookkeeping" });
      const parent = runtime.getCell<{ child?: unknown }>(
        waves.space,
        "parent",
        undefined,
        setup,
      );
      runtime.run(
        setup,
        parentPattern,
        { value: source.key("value"), tag: source.key("tag") },
        parent,
      );
      expect((await setup.commit()).error).toBeUndefined();
      const stopReading = parent.key("child").sink(() => {});
      await runtime.scheduler.idleWithPendingCommits();
      const doubled = async () => {
        await waves.storageManager.synced();
        return await (parent.key("child").resolveAsCell() as Cell<
          { doubled?: number }
        >).key("doubled").pull();
      };
      return { doubled, stopReading };
    };

    it("is set up again after the wave that first set it up is abandoned", async () => {
      const source = await newSource(0);
      waves.serve();
      const { doubled, stopReading } = await startParent(source);
      try {
        await waves.commitAll();

        await waves.writeAsPeer(source, (cell) => cell.key("value").set(1));
        expect(
          waves.current,
          "the setup of the child was sealed into a wave",
        ).toBeDefined();
        await waves.abandonWave();
        await waves.commitAll();
        expect(await doubled(), "the child doubles the value").toBe(2);

        await waves.writeAsPeer(source, (cell) => cell.key("value").set(4));
        await waves.commitAll();
        expect(await doubled(), "the child follows the value").toBe(8);
      } finally {
        stopReading();
      }
    });

    it("swaps to a pattern again after the wave that swapped to it is abandoned", async () => {
      const source = await newSource(1);
      waves.serve();
      const { doubled, stopReading } = await startParent(source);
      try {
        await waves.commitAll();
        expect(await doubled(), "the first child doubles the value").toBe(2);

        await waves.writeAsPeer(source, (cell) => cell.key("value").set(2));
        expect(
          waves.current,
          "the swap to the second child was sealed into a wave",
        ).toBeDefined();
        await waves.abandonWave();
        await waves.commitAll();
        expect(await doubled(), "the first child is still running").toBe(2);

        await waves.writeAsPeer(source, (cell) => cell.key("tag").set("x"));
        await waves.commitAll();
        expect(await doubled(), "the second child doubles the value").toBe(4);
      } finally {
        stopReading();
      }
    });
  });

  describe("an agent request", () => {
    it("is staged again after the wave drops its first staging", async () => {
      // The agent reads its task from a document that a doomed derivation
      // writes an unrelated field of, so the staging reads through that
      // pending write and the wave drops the two together. The scheduler runs
      // the agent again once the replica has rolled back, over the same task,
      // and so over the same request.
      const { runtime } = waves;
      const acting = { user: signer.did() };
      type Request = { task: string; other?: number; tag?: string };

      const seed = runtime.edit();
      stampWaveRunContext(seed, {
        actionId: "seed",
        kind: "bookkeeping",
        acting,
      });
      seedHomeAgentQueue(runtime, waves.space, seed);
      const request = runtime.getCell<Request>(
        waves.space,
        "request",
        undefined,
        seed,
      );
      request.set({ task: "summarize" });
      expect((await seed.commit()).error).toBeUndefined();
      await waves.storageManager.synced();

      // The wave opens before an authored write moves the document on, so the
      // derivation's write sealed into it reads a stale basis.
      waves.openWave();
      const authored = runtime.edit();
      request.withTx(authored).key("tag").set("authored");
      expect((await authored.commit()).error).toBeUndefined();
      waves.serve(acting);
      const doomed = runtime.edit();
      stampWaveRunContext(doomed, {
        actionId: "rewrite-request",
        kind: "derivation",
      });
      request.withTx(doomed).key("other").set(1);
      expect((await doomed.commit()).error).toBeUndefined();

      const { agent, pattern } = createTrustedBuilder(runtime).commonfabric;
      const agentPattern = pattern<{ task: string }>(({ task }) =>
        agent({
          task,
          inputs: {},
          resultSchema: { type: "string" },
          // deno-lint-ignore no-explicit-any
        } as any)
      );
      const setup = runtime.edit();
      stampWaveRunContext(setup, {
        actionId: "setup",
        kind: "bookkeeping",
        acting,
      });
      const resultCell = runtime.getCell<Record<string, unknown>>(
        waves.space,
        "agent",
        agentPattern.resultSchema,
        setup,
      );
      runtime.run(
        setup,
        agentPattern,
        { task: request.key("task") },
        resultCell,
      );
      expect((await setup.commit()).error).toBeUndefined();
      const stopReading = resultCell.sink(() => {});
      try {
        await runtime.scheduler.idleWithPendingCommits();
        expect(waves.current, "the first staging was sealed into a wave")
          .toBeDefined();
        await waves.commitWave();
        expect(
          request.withTx(runtime.readTx()).get().other,
          "the wave dropped the doomed write",
        ).toBeUndefined();

        // The run the scheduler re-arms stages the request into the next wave,
        // which this case leaves open: what would follow its commit is the
        // request's own effect, which this case is not about.
        const staged = resultCell.withTx(runtime.readTx()).get() as {
          pending?: boolean;
          requestHash?: string;
        } | undefined;
        expect(staged?.pending, "the request is pending").toBe(true);
        expect(staged?.requestHash, "the request is recorded").toBeDefined();
      } finally {
        stopReading();
      }
    });
  });
});
