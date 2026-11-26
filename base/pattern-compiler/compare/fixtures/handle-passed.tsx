/// <cts-enable />
import {
  handler,
  navigateTo,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

interface ChildInput {
  mine: Writable<string>;
  other: Writable<string>;
}

const Child = pattern<ChildInput, object>(({ mine, other }) => ({
  mine,
  other,
}));

// Writes through `mine` and passes both handles on to a child. It reads
// through neither (ruling U1; the form of `joinAsP1` in
// `patterns/showcase/battleship/multiplayer/repro-minimal.tsx`).
const join = handler<
  void,
  { mine: Writable<string>; other: Writable<string> }
>((_event, { mine, other }) => {
  mine.set("joined");
  return navigateTo(Child({ mine, other }));
});

interface Input {
  mine: Writable<string>;
  other: Writable<string>;
}

interface Output {
  join: Stream<void>;
}

export default pattern<Input, Output>(({ mine, other }) => {
  return { join: join({ mine, other }) };
});
