/**
 * Two people, each with their own lo-fi inductor for the same goal, publish
 * to one pool whose threshold is exactly two. The rule both hold is released
 * with its count; the rule only one holds is not.
 *
 * Patterns under test: ./lofi-inductor.tsx publishing into
 * ../inductor-pool/inductor-pool.tsx
 */
import { assert, multiUserTest, pattern, TESTS } from "commonfabric";
import InductorPool, {
  type InductorPoolOutput,
} from "../inductor-pool/inductor-pool.tsx";
import { rule } from "./lofi-inductor-test-fixture.ts";
import LofiInductor from "./lofi-inductor.tsx";

const GOAL = "Is this email a bill?";

interface Setup {
  pool: InductorPoolOutput;
}

export const setup = pattern<Record<string, never>, Setup>(() => ({
  pool: InductorPool(
    {
      goal: GOAL,
      thresholdCenter: 2,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  ),
}));

/** Whether the pool's public result is exactly `invoice`, held by two. */
function invoiceReleased(pool: InductorPoolOutput): boolean {
  const released = pool.consensus ?? [];
  return released.length === 1 && released[0]?.pattern === "invoice" &&
    released[0]?.count === 2 && pool.releasedCount === 1;
}

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const inductor = LofiInductor({
    goal: GOAL,
    items: [],
    rules: [rule("subject", "invoice"), rule("subject", "lunch", false)],
    history: [],
    published: null,
    pool: setup.pool,
  });
  return {
    [TESTS]: [
      { action: inductor.publish },
      // Alone, nothing is released.
      {
        assertion: assert(() =>
          inductor.published?.pooled === true &&
          (setup.pool.consensus ?? []).length === 0
        ),
      },
      { label: "alice-published" },
      { await: "bob-published" },
      // Both hold `invoice`; only Alice holds `lunch`.
      { assertion: assert(() => invoiceReleased(setup.pool)) },
    ],
    inductor,
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const inductor = LofiInductor({
    goal: GOAL,
    items: [],
    rules: [rule("subject", "invoice"), rule("subject", "bill")],
    history: [],
    published: null,
    pool: setup.pool,
  });
  return {
    [TESTS]: [
      { await: "alice-published" },
      { action: inductor.publish },
      { assertion: assert(() => invoiceReleased(setup.pool)) },
      { label: "bob-published" },
    ],
    inductor,
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
