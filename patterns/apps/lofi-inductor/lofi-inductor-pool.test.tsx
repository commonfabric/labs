/**
 * Publishing reaches a pool only when the pool is for the inductor's goal:
 * the matching pool stores one contribution under the pseudonym the first
 * publish mints, and replaces it when the inductor republishes, and a pool for another
 * goal receives nothing. The goal matches ignoring case and space, the view
 * says the rules were sent, and an inductor with no rules publishes nothing.
 *
 * Patterns under test: ./lofi-inductor.tsx publishing into
 * ../inductor-pool/inductor-pool.tsx. Release across contributors is in
 * ./lofi-inductor-pool-multi-user.test.tsx.
 */
import { assert, pattern, TESTS, UI } from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import InductorPool from "../inductor-pool/inductor-pool.tsx";
import { INVOICE_ONLY } from "./lofi-inductor-test-fixture.ts";
import LofiInductor from "./lofi-inductor.tsx";

const GOAL = "Is this email a bill?";
const OTHER_GOAL = "Is this email a newsletter?";

export default pattern(() => {
  const billPool = InductorPool(
    {
      goal: GOAL,
      thresholdCenter: 2,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  );
  const newsletterPool = InductorPool(
    {
      goal: OTHER_GOAL,
      thresholdCenter: 2,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  );
  // The goal matches the pool's, but for case and space.
  const matching = LofiInductor({
    goal: `  ${GOAL.toUpperCase().replace(" ", "   ")} `,
    items: [],
    rules: INVOICE_ONLY,
    history: [],
    published: null,
    pool: billPool,
  });
  const mismatched = LofiInductor({
    goal: GOAL,
    items: [],
    rules: INVOICE_ONLY,
    history: [],
    published: null,
    pool: newsletterPool,
  });

  // With no rules, there is nothing to publish.
  const empty = LofiInductor({
    goal: GOAL,
    items: [],
    rules: [],
    history: [],
    published: null,
    pool: billPool,
  });

  return {
    [TESTS]: [
      { assertion: assert(() => billPool.contributions.length === 0) },
      { action: matching.publish },
      // One contribution, under a pseudonym the publish minted, holding its
      // rules. One contributor is below threshold, so nothing is public.
      {
        assertion: assert(() =>
          matching.published?.pooled === true &&
          /^p-[0-9a-z]+$/.test(matching.pseudonym) &&
          billPool.contributions.length === 1 &&
          /^p-[0-9a-z]+$/.test(billPool.contributions[0]?.pseudonym ?? "") &&
          billPool.contributions[0]?.rules.length === 1 &&
          billPool.contributions[0]?.rules[0]?.pattern === "invoice" &&
          billPool.consensus.length === 0
        ),
      },
      // The view says the rules were sent: whether the pool took them is not
      // something the piece can see.
      { render: matching[UI] },
      {
        assertion: assert(() =>
          hasText(matching[UI], "Sent 1 rules to the pool for")
        ),
      },
      // Republishing replaces the contribution, under the pseudonym the
      // piece kept. (A first publish runs twice under server execution, and
      // the run that did not commit can send a pseudonym of its own; the
      // pool binds the principal, so it replaces rather than adds either way.)
      { action: matching.publish },
      {
        assertion: assert(() =>
          billPool.contributions.length === 1 &&
          billPool.contributions[0]?.pseudonym === matching.pseudonym
        ),
      },

      // A pool for another goal receives nothing. The publish still mints
      // the inductor's pseudonym, for when a pool for its goal appears.
      { assertion: assert(() => mismatched.pseudonym === "") },
      { action: mismatched.publish },
      {
        assertion: assert(() =>
          mismatched.published?.goal === GOAL &&
          mismatched.published?.pooled === false &&
          /^p-[0-9a-z]+$/.test(mismatched.pseudonym) &&
          newsletterPool.contributions.length === 0 &&
          billPool.contributions.length === 1
        ),
      },

      // An inductor with no rules publishes nothing, and mints nothing.
      { action: empty.publish },
      {
        assertion: assert(() =>
          empty.published === null && empty.pseudonym === "" &&
          billPool.contributions.length === 1
        ),
      },
    ],
    billPool,
    newsletterPool,
    empty,
    matching,
    mismatched,
  };
});
