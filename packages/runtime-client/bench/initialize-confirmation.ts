/**
 * Measures iframe reattachment initialization with a pending state edit and a
 * foreign native producer. Compilation and setup are outside timing. The
 * foreign server response is held for an additional 100 ms after the state
 * edit's receipt settles. This models remote work. Both total time from
 * releasing the state edit and residual time after its receipt are reported;
 * loopback receipt coverage itself can take about a second in this fixture.
 *
 * Run from the repository root:
 * deno run -A packages/runtime-client/bench/initialize-confirmation.ts
 */

import { assertEquals } from "@std/assert";
import { stub } from "@std/testing/mock";
import type { RuntimeProcessor } from "@/backends/runtime-processor.ts";
import { createInitializeConfirmationFixture } from "../test/support/initialize-confirmation-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createInitializeConfirmationFixture>>;

/**
 * Measures the real handler, or an exact baseline processor over the same
 * fixture. `waitForGlobalBarrier` observes the baseline's wait instead of the
 * candidate's provider confirmation. Warm calls use a fully settled fixture.
 */
export async function measureInitializeConfirmation(
  processorFor: (
    fixture: Fixture,
  ) => Pick<RuntimeProcessor, "handleCellInitialize"> = (fixture) =>
    fixture.processor,
  serviceDelayMs = 100,
  waitForGlobalBarrier = false,
) {
  const fixture = await createInitializeConfirmationFixture();
  let initializing: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const processor = processorFor(fixture);
    const waiting = Promise.withResolvers<void>();
    using gates = new DisposableStack();
    if (waitForGlobalBarrier) {
      const settled = fixture.storage.pendingCommitsSettled.bind(
        fixture.storage,
      );
      gates.use(stub(fixture.storage, "pendingCommitsSettled", () => {
        waiting.resolve();
        return settled();
      }));
    } else {
      const provider = fixture.storage.open(fixture.identity.did());
      const synced = provider.synced.bind(provider);
      gates.use(stub(provider, "synced", () => {
        waiting.resolve();
        return synced();
      }));
    }
    initializing = processor.handleCellInitialize(fixture.request);
    await waiting.promise;
    const started = performance.now();
    fixture.releaseA.resolve();
    await fixture.committing;
    const confirmed = performance.now();
    timer = setTimeout(() => fixture.releaseB.resolve(), serviceDelayMs);
    const response = await initializing;
    const ended = performance.now();
    const elapsedMs = ended - started;
    const afterConfirmationMs = ended - confirmed;
    assertEquals(response, { value: fixture.changed });
    const unrelatedPendingAtResponse = fixture.storage.hasPendingCommits();
    clearTimeout(timer);
    fixture.releaseB.resolve();
    await fixture.runtime.scheduler.idleWithPendingCommits();
    const warmStarted = performance.now();
    let warmResponse: unknown;
    for (let i = 0; i < 100; i++) {
      warmResponse = await processor.handleCellInitialize(fixture.request);
    }
    const warmPerCallMs = (performance.now() - warmStarted) / 100;
    assertEquals(warmResponse, { value: fixture.changed });
    return {
      elapsedMs,
      afterConfirmationMs,
      unrelatedPendingAtResponse,
      warmPerCallMs,
      serviceDelayMs,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    fixture.releaseA.resolve();
    fixture.releaseB.resolve();
    await initializing;
    await fixture.close();
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await measureInitializeConfirmation()));
}
