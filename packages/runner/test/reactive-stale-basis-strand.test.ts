// Regression for a reactive-compute convergence strand: a subscription-driven
// recompute that hits a burst of same-replica-race rejections
// (StorageTransactionInconsistent) must converge, not exhaust a bounded retry
// budget and strand at its stale value.
//
// This is the reactive-path analog of the event-handler residual closed in
// mergeable-append-multispace-conflict.test.ts. StorageTransactionInconsistent
// is a stale-basis rejection: a value the transaction read changed on this
// replica between the read and the commit, which re-running against the settled
// replica resolves (see packages/runner/src/storage/rejection.ts). A conflict —
// the upstream stale-read analog — has always been retried off the reactive
// budget (a WAIT for catch-up, not a failure). The local same-replica race was
// not: it fell into the bounded MAX_RETRIES_FOR_REACTIVE path alongside genuinely
// terminal transport/malformed errors, so a burst longer than the budget left the
// compute a permanent zombie against the pre-storm value — nothing re-triggers it
// once the input stops changing.
//
// The multiplayer symptom this guards against: two sessions share a piece; a
// second session's per-session derived view (its own materialized recompute of
// shared state) reacts to the first session's write. Under contention its
// commits hit the same-replica race; past ten of them the view sticks at the
// stale value while the writer's own view is correct. Multiplayer "the other
// browser's view is stuck" flakes can take this shape.
//
// The test drives it deterministically: two runtimes share one piece; the second
// runtime's replica commits are failed with a StorageTransactionInconsistent
// burst longer than the budget, then let through. The first runtime bumps the
// shared input; the second must still converge its own derived output.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { MAX_RETRIES_FOR_REACTIVE } from "../src/scheduler/constants.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("reactive-stale-basis-strand");
const space = signer.did();

// Shared `input`; a per-session `output` each session materializes from the input
// via a lift. The second session reacting to the first session's input change is
// a standalone reactive commit (the subscription-triggered recompute path), not a
// lift folded into its own runtime's event commit. `output` is per-session so the
// reacting session's strand is observable on its own partition rather than masked
// by the writer's committed value arriving over the wire.
const SRC = [
  "import { pattern, handler, lift, Writable } from 'commonfabric';",
  "const bump = handler<{ v: number }, { input: Writable<number> }>((e, { input }) => { input.set(e.v); });",
  "const mirror = lift<{ input: number; output: Writable<number> }, void>(({ input, output }) => { output.set(input * 2); });",
  "export default pattern(() => {",
  "  const input = new Writable<number>(1).for('input');",
  "  const output = Writable.perSession.of<number>(0);",
  "  mirror({ input, output });",
  "  return { input, output, bump: bump({ input }) };",
  "});",
].join("\n");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: SRC }],
};

const RESULT_CAUSE = "reactive-stale-basis-strand host";

function makeRuntime(server: MemoryV2Server.Server) {
  const storage = EmulatedStorageManager.connectTo(server, { as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  return { rt, storage };
}

describe("reactive recompute survives a same-replica-race burst", () => {
  let server: MemoryV2Server.Server;
  beforeEach(() => {
    server = newSharedServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("a subscription-driven recompute converges past a StorageTransactionInconsistent burst", async () => {
    const { rt: rt1, storage: s1 } = makeRuntime(server);
    const { rt: rt2, storage: s2 } = makeRuntime(server);
    try {
      // rt1 creates the piece; rt2 opens the same piece by result cause.
      const tx1 = rt1.edit();
      const parent1 = await rt1.patternManager.compilePattern(PROGRAM, {
        space,
        tx: tx1,
      });
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        space,
        RESULT_CAUSE,
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const h1 = rt1.run(tx1, parent1 as any, {}, resultCell1);
      rt1.prepareTxForCommit(tx1);
      expect((await tx1.commit()).error).toBeUndefined();
      h1.key("output").sink(() => {});
      await h1.pull();
      await rt1.idle();
      await s1.synced();

      const tx2 = rt2.edit();
      const parent2 = await rt2.patternManager.compilePattern(PROGRAM, {
        space,
        tx: tx2,
      });
      const resultCell2 = rt2.getCell<Record<string, unknown>>(
        space,
        RESULT_CAUSE,
        undefined,
        tx2,
      );
      // deno-lint-ignore no-explicit-any
      const h2 = rt2.run(tx2, parent2 as any, {}, resultCell2);
      rt2.prepareTxForCommit(tx2);
      // rt2 opens an already-created piece, so its setup write may conflict with
      // rt1's committed setup; it re-derives from confirmed state, so a conflict
      // here is expected and benign.
      await tx2.commit();
      h2.key("output").sink(() => {});
      await h2.pull();
      await rt2.idle();
      await s2.synced();

      // Both sessions seeded output = input * 2 = 2.
      expect(h1.key("output").get()).toBe(2);
      expect(h2.key("output").get()).toBe(2);

      // Fail rt2's replica commits with a same-replica-race rejection for a burst
      // LONGER than the reactive retry budget, then let them through: the burst
      // ends on its own once every injected rejection has been consumed.
      // Pre-fix the recompute exhausts the budget on the burst and gives up;
      // post-fix it rides the burst out off the budget, exactly as it does for
      // a conflict.
      const injectTotal = MAX_RETRIES_FOR_REACTIVE + 5;
      const replica2 = s2.open(space).replica as unknown as {
        commitNative: (...args: unknown[]) => Promise<unknown>;
      };
      const realCommit = replica2.commitNative.bind(replica2);
      let gate = false;
      let injectedRemaining = injectTotal;
      replica2.commitNative = (...args: unknown[]) => {
        if (gate && injectedRemaining > 0) {
          injectedRemaining--;
          return Promise.resolve({
            error: {
              name: "StorageTransactionInconsistent",
              message: "injected same-replica race",
            },
          });
        }
        return realCommit(...args);
      };

      // rt1 bumps the shared input; rt2's per-session recompute reacts under the
      // burst.
      gate = true;
      const bumpTx = rt1.edit();
      h1.withTx(bumpTx).key("bump").send({ v: 7 });
      expect((await bumpTx.commit()).error).toBeUndefined();
      await rt1.idle();
      await s1.synced();

      // rt2 converges on its own: the subscription push, the burst of refused
      // recomputes, and the commit that lands once the burst is spent are each
      // paced by the runtime's own timers, so the wait is on the output's
      // committed changes rather than on a fixed number of drain rounds — a
      // loop of round trips never lets those timers fire.
      await waitForCellValue<number>(
        rt2,
        h2.key("output"),
        (value) => value === 14,
      );

      // rt1 (uninjected) always converges.
      expect(h1.key("output").get()).toBe(14);
      // The burst was consumed in full — the recompute rode it out rather than
      // giving up at the budget.
      expect(injectedRemaining).toBe(0);
      // rt2's per-session recompute converges to the fresh value instead of
      // stranding at the pre-storm 2.
      expect(h2.key("output").get()).toBe(14);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
      await s1.close();
      await s2.close();
    }
  });
});
