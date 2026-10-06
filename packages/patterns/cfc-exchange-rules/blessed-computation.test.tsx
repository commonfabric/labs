import { assert, pattern, TESTS } from "commonfabric";
import BlessedComputation from "./blessed-computation.tsx";

export default pattern(() => {
  const ballot = BlessedComputation(
    {} as Parameters<typeof BlessedComputation>[0],
  );

  const assert_tally_computed = assert(() => ballot.tally === "2-1");
  const assert_tally_released = assert(() => ballot.roomTally === "2-1");
  const assert_other_function_refused = assert(() => ballot.roomEcho === "");
  const assert_raw_brief_refused = assert(() => ballot.roomNote === "");

  return {
    [TESTS]: [
      { action: ballot.submit, event: { vote: "approve", note: "first" } },
      { action: ballot.submit, event: { vote: "approve", note: "second" } },
      { action: ballot.submit, event: { vote: "reject", note: "third" } },
      { assertion: assert_tally_computed },
      { action: ballot.publishTally },
      { assertion: assert_tally_released },
      { action: ballot.publishEcho },
      { assertion: assert_other_function_refused },
      { action: ballot.publishFirstNote },
      { assertion: assert_raw_brief_refused },
    ],
    // Each refused publish logs the CFC refusal; the refusals are the point.
    allowConsoleWarnings: true,
    ballot,
  };
});
