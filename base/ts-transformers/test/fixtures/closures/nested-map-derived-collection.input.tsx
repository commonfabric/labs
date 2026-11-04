import { pattern, UI } from "commonfabric";

interface Vote {
  optionId: string;
  voterName: string;
}
interface Option {
  id: string;
}
interface OptionTally {
  option: Option;
  voters: Array<{ name: string }>;
}

// FIXTURE: nested-map-derived-collection
// Verifies (CT-1778): a reactive collection produced by a non-reactive-origin helper
// over reactive parameters — `tallyOptions(options, votes): OptionTally[]` — is
// recognized as reactive at array-method-decision time, so a nested `.map` over a
// per-item field (`tally.voters.map(...)`) lowers to `.mapWithPattern` instead of being
// emitted raw (which throws "Reactive.map(fn) is no longer supported" at runtime,
// because the receiver is a Reactive). Before the fix the inner map raced the helper
// result's late lift-wrap registration and stayed raw.
//
// Covers both shapes:
//   - direct receiver: `ranked = tallyOptions(options, votes)`
//   - chained derivation: `enriched = enrichTallies(ranked)` (a derived const passed to
//     another helper), exercising the recursive provenance walk through const args.
const tallyOptions = (options: Option[], votes: Vote[]): OptionTally[] =>
  options.map((option): OptionTally => ({
    option,
    voters: votes.map((v) => ({ name: v.voterName })),
  }));

const enrichTallies = (tallies: OptionTally[]): OptionTally[] =>
  tallies.map((t): OptionTally => ({ option: t.option, voters: t.voters }));

export default pattern<{ votes: Vote[]; options: Option[] }>(
  ({ votes, options }) => {
    const ranked = tallyOptions(options, votes);
    const enriched = enrichTallies(ranked);
    return {
      [UI]: (
        <div>
          <div>
            {ranked.map((tally) => (
              <div>{tally.voters.map((voter) => <span>{voter.name}</span>)}</div>
            ))}
          </div>
          <div>
            {enriched.map((tally) => (
              <div>{tally.voters.map((voter) => <span>{voter.name}</span>)}</div>
            ))}
          </div>
        </div>
      ),
    };
  },
);
