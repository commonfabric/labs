import {
  assert,
  Default,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import WitnessedChain, { type RoomText } from "./witnessed-chain.tsx";

// Room stores live here rather than in the chain: each one admits only public
// values, so a publish into it is where the release rule gets its chance.
const publish = handler<void, { from: string; to: Writable<RoomText> }>(
  (_, { from, to }) => {
    to.set(from);
  },
);

interface Rooms {
  roomTally: Writable<Default<RoomText, "">>;
  roomRelay: Writable<Default<RoomText, "">>;
  roomAppended: Writable<Default<RoomText, "">>;
  roomForged: Writable<Default<RoomText, "">>;
}

export default pattern<Rooms>(
  ({ roomTally, roomRelay, roomAppended, roomForged }) => {
    const ballot = WitnessedChain(
      {} as Parameters<typeof WitnessedChain>[0],
    );

    return {
      [TESTS]: [
        { action: ballot.submit, event: { vote: "approve" } },
        { action: ballot.submit, event: { vote: "reject" } },
        { action: ballot.commit },
        { assertion: assert(() => ballot.tally === "1") },
        // The honest chain: commit wrote everything the tally read.
        { action: publish({ from: ballot.tally, to: roomTally }) },
        { assertion: assert(() => roomTally.get() === "1") },
        // An unendorsed copy between commit and the tally is refused.
        { action: publish({ from: ballot.relayTally, to: roomRelay }) },
        { assertion: assert(() => roomRelay.get() === "") },
        // A vote added beside the committed ones by other code is refused.
        { action: ballot.append },
        { assertion: assert(() => ballot.tally === "2") },
        { action: publish({ from: ballot.tally, to: roomAppended }) },
        { assertion: assert(() => roomAppended.get() === "") },
        // A vote list written whole by other code is refused.
        { action: ballot.forge },
        { action: publish({ from: ballot.tally, to: roomForged }) },
        { assertion: assert(() => roomForged.get() === "") },
      ],
      // Each refused publish logs the CFC refusal; the refusals are the point.
      allowConsoleWarnings: true,
      ballot,
    };
  },
);
