/**
 * Three contributors, each in their own runtime and under their own
 * principal, share one pool whose threshold is exactly two. A rule two of
 * them hold is released with its count; a rule only one holds never appears;
 * no one can submit under another's pseudonym; and a contributor who
 * resubmits without a rule takes their count off it.
 *
 * Pattern under test: ./inductor-pool.tsx
 */
import { assert, multiUserTest, pattern, TESTS } from "commonfabric";
import { BILL, INVOICE, LUNCH } from "./inductor-pool-test-fixture.ts";
import InductorPool, { type InductorPoolOutput } from "./inductor-pool.tsx";

interface Setup {
  pool: InductorPoolOutput;
}

export const setup = pattern<Record<string, never>, Setup>(() => ({
  pool: InductorPool(
    {
      goal: "Is this email a bill?",
      thresholdCenter: 2,
      jitter: 0,
    } as Parameters<typeof InductorPool>[0],
  ),
}));

/**
 * Whether the release is exactly these patterns and counts.
 *
 * This reads `consensus`, the released function's output, not the public
 * `released` store. Copying an array of objects into that store is refused on
 * today's runtime once a confidential contribution sits beside it in the
 * pool's argument document (README.md, "CFC snags": the anchoring read in
 * `data-updating.ts` takes on the whole document's label). When that is
 * fixed, read `pool.released` here as well.
 */
function releasedIs(
  pool: InductorPoolOutput,
  expected: readonly (readonly [string, number])[],
): boolean {
  const released = pool.consensus ?? [];
  return released.length === expected.length &&
    expected.every(([pattern, count], i) =>
      released[i]?.pattern === pattern && released[i]?.count === count
    );
}

export const alice = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    {
      action: setup.pool.submit,
      event: { pseudonym: "alice-bills", rules: [INVOICE, LUNCH] },
    },
    // Alone, nothing is released.
    { assertion: assert(() => releasedIs(setup.pool, [])) },
    { label: "alice-submitted" },
    { await: "bob-submitted" },
    { await: "carol-submitted" },
    // Two hold `invoice`: released, with its count. `bill` (bob alone) and
    // `lunch` (alice alone) do not appear.
    { assertion: assert(() => releasedIs(setup.pool, [["invoice", 2]])) },
    { label: "alice-saw-release" },
    { await: "bob-resubmitted" },
    // Bob withdrew `invoice` and added `lunch`.
    { assertion: assert(() => releasedIs(setup.pool, [["lunch", 2]])) },
  ],
  // A release copy into `released` is refused and logged until the runtime
  // anchoring bug is fixed (see `releasedIs`).
  allowConsoleWarnings: true,
}));

export const bob = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "alice-submitted" },
    {
      action: setup.pool.submit,
      event: { pseudonym: "bob-bills", rules: [INVOICE, BILL] },
    },
    { assertion: assert(() => releasedIs(setup.pool, [["invoice", 2]])) },
    { label: "bob-submitted" },
    { await: "alice-saw-release" },
    {
      action: setup.pool.submit,
      event: { pseudonym: "bob-bills", rules: [LUNCH] },
    },
    { assertion: assert(() => releasedIs(setup.pool, [["lunch", 2]])) },
    { label: "bob-resubmitted" },
  ],
  // A release copy into `released` is refused and logged until the runtime
  // anchoring bug is fixed (see `releasedIs`).
  allowConsoleWarnings: true,
}));

export const carol = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "bob-submitted" },
    // Carol cannot submit under Bob's pseudonym, so cannot add to his count
    // or replace his set.
    {
      action: setup.pool.submit,
      event: { pseudonym: "bob-bills", rules: [BILL] },
    },
    { assertion: assert(() => releasedIs(setup.pool, [["invoice", 2]])) },
    { label: "carol-submitted" },
  ],
  expectRuntimeErrors: ["belongs to another contributor"],
  // A release copy into `released` is refused and logged until the runtime
  // anchoring bug is fixed (see `releasedIs`).
  allowConsoleWarnings: true,
}));

export default multiUserTest({ setup, participants: { alice, bob, carol } });
