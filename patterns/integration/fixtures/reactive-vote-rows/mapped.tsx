/** Renders reactive rows over ranked tallies containing resolved voter profiles. */

import { computed, NAME, pattern, UI } from "commonfabric";
import { cast, type Input, rename, retract } from "./model.ts";

export default pattern<Input>(({ options, votes, profiles }) => {
  const ranked = computed(() =>
    options.map((option) => ({
      id: option.id,
      voters: votes.filter((vote) => vote.optionId === option.id).map((
        vote,
      ) => ({
        name: vote.voter.name,
        color: vote.color,
      })),
    })).sort((left, right) => right.voters.length - left.voters.length)
  );
  const rows = ranked.map((tally) => ({
    id: tally.id,
    color: tally.voters.map((voter) => voter.color).join(","),
    names: tally.voters.map((voter) => voter.name).join(","),
  }));
  return {
    [NAME]: "Reactive vote rows",
    [UI]: (
      <div>
        {ranked.map((tally) => (
          <div
            data-row={tally.id}
            data-tally-colors={tally.voters.map((voter) => voter.color).join(
              ",",
            )}
            title={tally.voters.map((voter) => voter.name).join(",")}
          >
            {tally.id}:{" "}
            {tally.voters.map((voter) => (
              <span data-swatch={voter.name} title={voter.name}>
                {voter.color}
              </span>
            ))}
          </div>
        ))}
      </div>
    ),
    rows,
    cast: cast({ votes, profiles }),
    rename: rename({ profiles }),
    retract: retract({ votes }),
  };
});
