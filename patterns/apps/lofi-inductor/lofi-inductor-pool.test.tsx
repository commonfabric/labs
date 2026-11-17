/**
 * Publishing reaches a pool only when the pool is for the inductor's goal:
 * the matching pool stores one contribution under the inductor's pseudonym,
 * and again under the same one when it republishes, and a pool for another
 * goal receives nothing. The first publish mints the pseudonym.
 *
 * Patterns under test: ./lofi-inductor.tsx publishing into
 * ../inductor-pool/inductor-pool.tsx. Release across contributors is in
 * ./lofi-inductor-pool-multi-user.test.tsx.
 */
import { assert, pattern, TESTS } from "commonfabric";
import InductorPool from "../inductor-pool/inductor-pool.tsx";
import { INVOICE_ONLY } from "./lofi-inductor-test-fixture.ts";
import LofiInductor from "./lofi-inductor.tsx";

const GOAL = "Is this email a bill?";
const OTHER_GOAL = "Is this email a newsletter?";
const PSEUDONYM = "p-bills-test";

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
  // The goal matches the pool's, but for surrounding space. Its pseudonym
  // is given: one minted in the same event that sends it to a pool makes
  // the test flaky (README.md, "Known runtime issues", 3).
  const matching = LofiInductor({
    goal: `  ${GOAL} `,
    items: [],
    rules: INVOICE_ONLY,
    history: [],
    published: null,
    pseudonym: PSEUDONYM,
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

  return {
    [TESTS]: [
      { assertion: assert(() => billPool.contributions.length === 0) },
      { action: matching.publish },
      // One contribution, under the inductor's pseudonym, holding its rules.
      // One contributor is below threshold, so nothing is public.
      {
        assertion: assert(() =>
          matching.published?.pooled === true &&
          matching.pseudonym === PSEUDONYM &&
          billPool.contributions.length === 1 &&
          billPool.contributions[0]?.pseudonym === PSEUDONYM &&
          billPool.contributions[0]?.rules.length === 1 &&
          billPool.contributions[0]?.rules[0]?.pattern === "invoice" &&
          billPool.consensus.length === 0
        ),
      },
      // Republishing keeps the pseudonym, so it replaces the contribution.
      { action: matching.publish },
      {
        assertion: assert(() =>
          billPool.contributions.length === 1 &&
          billPool.contributions[0]?.pseudonym === PSEUDONYM
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
    ],
    billPool,
    newsletterPool,
    matching,
    mismatched,
  };
});
