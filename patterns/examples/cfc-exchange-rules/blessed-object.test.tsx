import { assert, pattern, TESTS } from "commonfabric";
import BlessedObject from "./blessed-object.tsx";

export default pattern(() => {
  const ballot = BlessedObject({} as Parameters<typeof BlessedObject>[0]);

  const assert_counts_computed = assert(() =>
    ballot.counts.approve === 2 && ballot.counts.reject === 1
  );
  const assert_counts_released = assert(() =>
    ballot.roomCounts.approve === 2 && ballot.roomCounts.reject === 1
  );
  const assert_hand_counts_refused = assert(() =>
    ballot.roomHandCounts.approve === -1 && ballot.roomHandCounts.reject === -1
  );

  return {
    [TESTS]: [
      { action: ballot.submit, event: { vote: "approve", note: "first" } },
      { action: ballot.submit, event: { vote: "approve", note: "second" } },
      { action: ballot.submit, event: { vote: "reject", note: "third" } },
      { assertion: assert_counts_computed },
      { action: ballot.publishCounts },
      { assertion: assert_counts_released },
      { action: ballot.publishHandCounts },
      { assertion: assert_hand_counts_refused },
    ],
    // The refused publish logs the CFC refusal; the refusal is the point.
    allowConsoleWarnings: true,
    ballot,
  };
});
