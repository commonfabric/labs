/** Demands remote linked votes and profiles inside reactive option-row filters. */

import { NAME, pattern, UI } from "commonfabric";
import { cast, type Input, rename, retract } from "./model.ts";

export default pattern<Input>(({ options, votes, profiles }) => {
  const rows = options.map((option) => {
    const matched = votes.filter((vote) => vote.optionId === option.id);
    return {
      id: option.id,
      colors: matched.map((vote) => vote.color),
      names: matched.map((vote) => vote.voter.name),
    };
  });
  return {
    [NAME]: "Nested vote filters",
    [UI]: (
      <div>
        {rows.map((row) => (
          <div data-row={row.id} title={row.names.join(",")}>
            {row.id}: {row.colors.join(",")}
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
