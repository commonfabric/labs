/**
 * Two people, each with their own lo-fi inductor for the same goal, publish
 * to one pool whose threshold is exactly five, the lowest a pool may seal;
 * three more contributors send `invoice` to the pool directly. The rule all
 * five hold is released with its count; the rules only one holds are not;
 * and an inductor with no held-out items is offered none of it. Then Alice
 * unpublishes, which takes only her contribution out: the rule falls to four
 * and is not released, and publishing again brings it back to five. Last,
 * Alice asks a new question, which withdraws her contribution for the old
 * one.
 *
 * Patterns under test: ./lofi-inductor.tsx publishing into
 * ../pool/inductor-pool.tsx
 */
import { action, assert, multiUserTest, pattern, TESTS } from "commonfabric";
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
  // Each send comes from an action rather than naming the stream as the
  // step's: a step's `inductor.publish` compiles to a computed that holds the
  // stream, and with server execution off nothing reads that computed before
  // the send, so the send would find no handler.
  const publish = action(() => inductor.publish.send());
  const unpublish = action(() => inductor.unpublish.send());
  const askAnotherQuestion = action(() => {
    inductor.setGoal.send({ goal: "Is this email a newsletter?" });
  });
  return {
    [TESTS]: [
      { action: publish },
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
      { action: unpublish },
      {
        assertion: assert(() =>
          (setup.pool.consensus ?? []).length === 0 &&
          inductor.published === null && inductor.pseudonym !== ""
        ),
      },
      // The other four stayed: Alice's return makes five again.
      { action: publish },
      { assertion: assert(() => invoiceReleased(setup.pool)) },
      { action: askAnotherQuestion },
      {
        assertion: assert(() =>
          (setup.pool.consensus ?? []).length === 0 &&
          inductor.pseudonym === "" && inductor.rules.length === 0
        ),
      },
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
  // Sent from an action, as Alice's is, so that it reaches the stream
  // without server execution.
  const publish = action(() => inductor.publish.send());
  return {
    [TESTS]: [
      { await: "alice-published" },
      { action: publish },
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
