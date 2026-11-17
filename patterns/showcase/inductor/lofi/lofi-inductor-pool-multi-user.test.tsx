/**
 * Two people, each with their own lo-fi inductor for the same goal, publish
 * to one pool whose threshold is exactly five, the lowest a pool may seal;
 * three more contributors send `invoice` to the pool directly. The rule all
 * five hold is released with its count; the rules only one holds are not;
 * and an inductor with no held-out items is offered none of it.
 *
 * Patterns under test: ./lofi-inductor.tsx publishing into
 * ../pool/inductor-pool.tsx
 */
import { assert, multiUserTest, pattern, TESTS } from "commonfabric";
import { MIN_SEALED_THRESHOLD } from "../pool/consensus.ts";
import InductorPool, {
  type InductorPoolOutput,
} from "../pool/inductor-pool.tsx";
import { INVOICE_ONLY, rule } from "./lofi-inductor-test-fixture.ts";
import LofiInductor from "./lofi-inductor.tsx";

const GOAL = "Is this email a bill?";

interface Setup {
  pool: InductorPoolOutput;
}

export const setup = pattern<Record<string, never>, Setup>(() => ({
  pool: InductorPool(
    {
      goal: GOAL,
      thresholdCenter: MIN_SEALED_THRESHOLD,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  ),
}));

/** Whether the pool's public result is exactly `invoice`, held by five. */
function invoiceReleased(pool: InductorPoolOutput): boolean {
  const released = pool.consensus ?? [];
  return released.length === 1 && released[0]?.pattern === "invoice" &&
    released[0]?.count === 5 && pool.releasedCount === 1;
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
      { await: "erin-submitted" },
      // All five hold `invoice`; only Alice holds `lunch`, only Bob `bill`.
      { assertion: assert(() => invoiceReleased(setup.pool)) },
      // Alice's inductor reads the release, but none of her held-out items
      // (she has none) exercises it, so there is nothing to offer her.
      { assertion: assert(() => inductor.poolOffer === null) },
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
      { assertion: assert(() => (setup.pool.consensus ?? []).length === 0) },
      { label: "bob-published" },
    ],
    inductor,
  };
});

export const carol = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "bob-published" },
    {
      action: setup.pool.submit,
      event: { pseudonym: "carol-bills", rules: INVOICE_ONLY },
    },
    { label: "carol-submitted" },
  ],
}));

export const dave = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "carol-submitted" },
    {
      action: setup.pool.submit,
      event: { pseudonym: "dave-bills", rules: INVOICE_ONLY },
    },
    // Four hold `invoice`: one short.
    { assertion: assert(() => (setup.pool.consensus ?? []).length === 0) },
    { label: "dave-submitted" },
  ],
}));

export const erin = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "dave-submitted" },
    {
      action: setup.pool.submit,
      event: { pseudonym: "erin-bills", rules: INVOICE_ONLY },
    },
    { assertion: assert(() => invoiceReleased(setup.pool)) },
    { label: "erin-submitted" },
  ],
}));

export default multiUserTest({
  setup,
  participants: { alice, bob, carol, dave, erin },
});
