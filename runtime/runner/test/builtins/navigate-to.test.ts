/**
 * Runs the `navigateTo` builtin's action directly, one transaction at a time,
 * to reach the run that comes after a navigation has already happened.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/async/defer";
import { getLogger } from "@commonfabric/logger";
import { stub } from "@std/testing/mock";
import { navigateTo } from "../../src/builtins/navigate-to.ts";
import { setNavigateEventContext } from "../../src/builtins/navigate-context.ts";
import type { Cell } from "../../src/cell.ts";
import type { PostCommitSideEffect } from "../../src/cfc/types.ts";
import { stampWaveRunContext } from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import { stampSpeculationRunContext } from "../../src/speculation/overlay-destination.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { refuseAtCommitBoundary } from "../refused-commit.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("navigate-to", () => {
  let runtime: Runtime;
  let navigations: string[];

  beforeEach(() => {
    navigations = [];
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
      navigateCallback: (target) => {
        navigations.push(entityRefToString(target.entityId));
      },
    });
  });

  afterEach(async () => {
    // Disposing the runtime closes the storage manager it was given.
    await runtime.dispose();
  });

  it("sets its result again, without navigating, when it runs after it has navigated", async () => {
    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      "navigate-to run-again parent",
      undefined,
      setupTx,
    );
    const target = runtime.getCell(
      space,
      "navigate-to run-again target",
      undefined,
      setupTx,
    );
    target.set({ title: "target" });
    const inputs = runtime.getImmutableCell(
      space,
      target.getAsLink(),
      undefined,
      setupTx,
    );
    expect((await setupTx.commit().settled).error).toBeUndefined();

    let resultCell: Cell<boolean> | undefined;
    const sendResult = (_tx: IExtendedStorageTransaction, result: unknown) => {
      resultCell = result as Cell<boolean>;
    };
    const builtin = navigateTo(
      inputs,
      sendResult,
      () => {},
      [],
      parentCell,
      runtime,
    );

    const firstTx = runtime.edit();
    builtin.action(firstTx);
    expect((await firstTx.commit().settled).error).toBeUndefined();
    await runtime.settled();
    expect(navigations).toEqual([entityRefToString(target.entityId)]);

    // With the result cleared, a run that consulted it would navigate a second
    // time. The run below is held to the builtin's own record of having
    // navigated, which is what sends it down the path that only sets the
    // result.
    const clearTx = runtime.edit();
    resultCell!.withTx(clearTx).set(false);
    expect((await clearTx.commit().settled).error).toBeUndefined();

    const secondTx = runtime.edit();
    builtin.action(secondTx);
    expect((await secondTx.commit().settled).error).toBeUndefined();
    await runtime.settled();

    expect(navigations.length).toBe(1);
    const readTx = runtime.edit();
    expect(resultCell!.withTx(readTx).get()).toBe(true);
    await readTx.commit().settled;
  });

  it("ignores the post-commit effect of an attempt a later attempt superseded", async () => {
    // A storage layer flushes a refused transaction's effects never, so the
    // superseded effect is flushed here directly: what is under test is that
    // the effect checks which attempt it belongs to when it runs.
    const { builtin, target } = await setUp(
      runtime,
      "superseded",
      "superseded target",
    );

    const refusedTx = runtime.edit();
    const superseded = captureEffects(refusedTx);
    refuseAtCommitBoundary(refusedTx, space, "navigate-to superseded");
    builtin.action(refusedTx);
    expect((await refusedTx.commit().settled).error).toBeDefined();

    const retryTx = runtime.edit();
    builtin.action(retryTx);
    expect((await retryTx.commit().settled).error).toBeUndefined();
    await runtime.settled();
    expect(navigations).toEqual([entityRefToString(target.entityId)]);

    expect(superseded.length).toBe(1);
    await superseded[0].flush(refusedTx);
    await runtime.settled();
    expect(navigations).toEqual([entityRefToString(target.entityId)]);
  });

  describe("with server execution", () => {
    let served: Runtime;
    let speculativeNavigations: string[];

    beforeEach(() => {
      speculativeNavigations = [];
      served = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: StorageManager.emulate({ as: signer }),
        experimental: { serverExecution: true },
        navigateCallback: (target) => {
          speculativeNavigations.push(entityRefToString(target.entityId));
        },
      });
    });

    afterEach(async () => {
      await served.dispose();
    });

    describe("on a client's speculative run", () => {
      it("navigates again once the commit that carried a navigation is refused", async () => {
        const { builtin, target } = await setUp(
          served,
          "speculative retry",
          "speculative target",
        );
        setNavigateEventContext(builtin.action, { eventId: "event-retry" });

        const refusedTx = speculativeTx(served);
        refuseAtCommitBoundary(refusedTx, space, "navigate-to speculative");
        builtin.action(refusedTx);
        expect((await refusedTx.commit().settled).error).toBeDefined();
        await served.settled();
        expect(speculativeNavigations).toEqual([]);

        const retryTx = speculativeTx(served);
        builtin.action(retryTx);
        expect((await retryTx.commit().settled).error).toBeUndefined();
        await served.settled();
        expect(speculativeNavigations).toEqual([
          entityRefToString(target.entityId),
        ]);
      });

      it("ignores the post-commit effect of an attempt a later attempt superseded", async () => {
        // As for the legacy arm, the refused attempt's effect is flushed
        // directly; the storage layer never would.
        const { builtin, target } = await setUp(
          served,
          "speculative stale",
          "speculative stale target",
        );
        setNavigateEventContext(builtin.action, { eventId: "event-stale" });

        const refusedTx = speculativeTx(served);
        const superseded = captureEffects(refusedTx);
        refuseAtCommitBoundary(refusedTx, space, "navigate-to stale");
        builtin.action(refusedTx);
        expect((await refusedTx.commit().settled).error).toBeDefined();

        const retryTx = speculativeTx(served);
        builtin.action(retryTx);
        expect((await retryTx.commit().settled).error).toBeUndefined();
        await served.settled();
        expect(speculativeNavigations).toEqual([
          entityRefToString(target.entityId),
        ]);

        expect(superseded.length).toBe(1);
        await superseded[0].flush(refusedTx);
        await served.settled();
        expect(speculativeNavigations).toEqual([
          entityRefToString(target.entityId),
        ]);
      });
    });

    describe("on a served run", () => {
      // The seal destination stands in for the serving loop's wave: the
      // intent transaction the served run writes is the one transaction
      // created while it is installed, so its seal is what each case
      // decides.

      for (
        const { outcome, seal, reason } of [
          {
            outcome: "refuses",
            seal: () =>
              Promise.resolve({
                error: {
                  name: "StorageTransactionAborted" as const,
                  message: "intent seal refused",
                  reason: new Error("intent seal refused"),
                },
              }),
            reason: "failed to seal",
          },
          {
            outcome: "rejects",
            seal: () => Promise.reject(new Error("intent seal crashed")),
            reason: "seal rejected",
          },
        ]
      ) {
        it(`counts and logs an intent whose seal ${outcome}`, async () => {
          const { builtin } = await setUp(
            served,
            `served ${outcome}`,
            "served target",
          );
          setNavigateEventContext(builtin.action, {
            eventId: `event-${outcome}`,
            acting: { user: signer.did(), session: "session-1" },
          });
          let sealFailures = 0;
          const counted = defer<void>();
          served.notifyServedIntentSealFailure = () => {
            sealFailures++;
            counted.resolve();
          };
          const tx = served.edit();
          stampWaveRunContext(tx, {
            actionId: "navigate-to served",
            kind: "derivation",
          });
          let seals = 0;
          served.installSealDestination({
            seal: () => {
              seals++;
              return seal();
            },
          });
          const logger = getLogger("navigate-to");
          const logged: string[] = [];
          const error = logger.error.bind(logger);
          using _error = stub(logger, "error", (key, ...messages) => {
            logged.push(`${key}: ${messages[0]}`);
            error(key, ...messages);
          });
          try {
            builtin.action(tx);
            // The count and the log are made in one synchronous step.
            await counted.promise;
          } finally {
            served.clearSealDestination();
            tx.abort();
          }

          expect(seals).toBe(1);
          expect(sealFailures).toBe(1);
          expect(logged).toEqual([
            expect.stringMatching(
              new RegExp(`^intent-commit-failed: .*${reason}`),
            ),
          ]);
          expect(speculativeNavigations).toEqual([]);
        });
      }
    });
  });
});

/**
 * A parent cell, a target titled `title`, the immutable input linking to it,
 * and a `navigateTo` builtin over them, committed.
 */
async function setUp(
  runtime: Runtime,
  label: string,
  title: string,
): Promise<{ builtin: ReturnType<typeof navigateTo>; target: Cell<unknown> }> {
  const setupTx = runtime.edit();
  const parentCell = runtime.getCell(
    space,
    `navigate-to ${label} parent`,
    undefined,
    setupTx,
  );
  const target = runtime.getCell<unknown>(
    space,
    `navigate-to ${label} target`,
    undefined,
    setupTx,
  );
  target.set({ title });
  const inputs = runtime.getImmutableCell(
    space,
    target.getAsLink(),
    undefined,
    setupTx,
  );
  expect((await setupTx.commit().settled).error).toBeUndefined();
  const builtin = navigateTo(
    inputs,
    () => {},
    () => {},
    [],
    parentCell,
    runtime,
  );
  return { builtin, target };
}

/** A transaction stamped as a client's speculative run. */
function speculativeTx(runtime: Runtime): IExtendedStorageTransaction {
  const tx = runtime.edit();
  stampSpeculationRunContext(tx, {
    actionId: "navigate-to speculative",
    kind: "derivation",
  });
  return tx;
}

/** The post-commit effects enqueued on `tx`, as they are enqueued. */
function captureEffects(
  tx: IExtendedStorageTransaction,
): PostCommitSideEffect[] {
  const effects: PostCommitSideEffect[] = [];
  const enqueue = tx.enqueuePostCommitEffect.bind(tx);
  tx.enqueuePostCommitEffect = (effect) => {
    effects.push(effect);
    enqueue(effect);
  };
  return effects;
}
