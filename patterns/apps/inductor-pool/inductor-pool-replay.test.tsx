/**
 * The released function run over inputs other code chose is not released.
 * A probe copies the pool's contributions, doubles each under a made-up
 * pseudonym and seals the copies with a threshold of its own, and hands them
 * to `releaseConsensus`. The function computes the victim's rule as released,
 * but the policy's input witness sees contributions `submitContribution` did
 * not write, so a public store refuses the result.
 *
 * Pattern under test: ./inductor-pool.tsx. The honest release reaching a
 * public store is in ./inductor-pool-multi-user.test.tsx.
 */
import {
  assert,
  computed,
  type Default,
  handler,
  NAME,
  pattern,
  type Stream,
  TESTS,
  UI,
  type VNode,
  type Writable,
} from "commonfabric";
import {
  INVOICE,
  type OpenPublic,
  type Untouched,
} from "./inductor-pool-test-fixture.ts";
import InductorPool, {
  type Contribution,
  releaseConsensus,
  type ReleasedRule,
  type StoredContribution,
} from "./inductor-pool.tsx";

/** Copies rules into `to`, as a release into a public store would. */
const publishRules = handler<
  void,
  { from: ReleasedRule[]; to: Writable<ReleasedRule[]> }
>((_, { from, to }) => {
  to.set(
    (from ?? []).map((rule) => ({
      field: rule.field,
      pattern: rule.pattern,
      predicts: rule.predicts,
      key: rule.key,
      count: rule.count,
    })),
  );
});

interface ProbeInput {
  contributions: StoredContribution[];
  leaked: Writable<Default<OpenPublic, Untouched>>;
}

interface ProbeOutput {
  [NAME]: string;
  [UI]: VNode;
  released: ReleasedRule[];
  leaked: OpenPublic;
  publish: Stream<void>;
}

const ReplayProbe = pattern<ProbeInput, ProbeOutput>(
  ({ contributions, leaked }) => {
    // Each contribution twice, under a second pseudonym, sealed with the
    // lowest threshold there is and the probe's own secret.
    const forged = computed((): Contribution[] =>
      (contributions ?? []).flatMap((contribution) =>
        [contribution.pseudonym, `${contribution.pseudonym}-twin`].map(
          (pseudonym) => ({
            pseudonym,
            rules: (contribution.rules ?? []).map((rule) => ({ ...rule })),
            seal: { secret: "chosen", thresholdCenter: 2, jitter: 0 },
          }),
        )
      )
    );
    const released = releaseConsensus(forged);
    return {
      [NAME]: "Replay probe",
      [UI]: <div />,
      released,
      leaked,
      publish: publishRules({ from: released, to: leaked }),
    };
  },
);

export default pattern(() => {
  const pool = InductorPool(
    {
      goal: "Is this email a bill?",
      thresholdCenter: 15,
      jitter: 5,
    } as Parameters<typeof InductorPool>[0],
  );
  const probe = ReplayProbe(
    { contributions: pool.contributions } as Parameters<typeof ReplayProbe>[0],
  );
  return {
    [TESTS]: [
      {
        action: pool.submit,
        event: { pseudonym: "victim", rules: [INVOICE] },
      },
      { assertion: assert(() => pool.releasedCount === 0) },
      // The released function, fed the forgery, computes the victim's rule
      // as released...
      {
        assertion: assert(() =>
          probe.released.length === 1 &&
          probe.released[0]?.pattern === "invoice" &&
          probe.released[0]?.count === 2
        ),
      },
      // ...but its inputs are not the pool's own contributions, so a public
      // store refuses it.
      { action: probe.publish },
      {
        assertion: assert(() =>
          probe.leaked.length === 1 && probe.leaked[0]?.key === "untouched"
        ),
      },
    ],
    // The refused publish logs the CFC refusal; the refusal is the point.
    allowConsoleWarnings: true,
    pool,
    probe,
  };
});
