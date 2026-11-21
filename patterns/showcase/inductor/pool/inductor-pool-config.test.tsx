/**
 * The threshold is fixed when the pool's first contribution seals it. A
 * contributor who can write the pool's configuration lowers it afterwards,
 * and the write lands, but the release still uses the sealed threshold, so
 * two contributors stay below it.
 *
 * Pattern under test: ./inductor-pool.tsx
 */
import {
  assert,
  handler,
  multiUserTest,
  pattern,
  TESTS,
  type Writable,
} from "commonfabric";
import { INVOICE } from "./inductor-pool-test-fixture.ts";
import InductorPool, { type InductorPoolOutput } from "./inductor-pool.tsx";

interface Setup {
  pool: InductorPoolOutput;
}

export const setup = pattern<Record<string, never>, Setup>(() => ({
  pool: InductorPool(
    {
      goal: "Is this email a bill?",
      thresholdCenter: 15,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  ),
}));

/** Sets the pool's threshold as low as it goes. */
const lowerThreshold = handler<
  void,
  { thresholdCenter: Writable<number>; jitter: Writable<number> }
>((_, { thresholdCenter, jitter }) => {
  thresholdCenter.set(1);
  jitter.set(0);
});

export const alice = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    {
      action: setup.pool.submit,
      event: { pseudonym: "alice-bills", rules: [INVOICE] },
    },
    { label: "alice-submitted" },
  ],
}));

export const bob = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "alice-submitted" },
    {
      action: lowerThreshold({
        thresholdCenter: setup.pool.thresholdCenter,
        jitter: setup.pool.jitter,
      }),
    },
    { assertion: assert(() => setup.pool.thresholdCenter === 1) },
    {
      action: setup.pool.submit,
      event: { pseudonym: "bob-bills", rules: [INVOICE] },
    },
    // Two hold `invoice`, under the 15 the first contribution sealed.
    {
      assertion: assert(() =>
        setup.pool.contributions.length === 2 &&
        (setup.pool.consensus ?? []).length === 0 &&
        setup.pool.releasedCount === 0
      ),
    },
  ],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
