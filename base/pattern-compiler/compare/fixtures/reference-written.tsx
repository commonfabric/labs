/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

interface Room {
  name: string;
}

interface Selected {
  room?: Room;
}

// Writes a record that holds a value of its state unchanged: the written
// path `room` is a reference the body passes on (PL §3.9, "A handle a body
// passes on").
const select = handler<
  void,
  { first: Room; selected: Writable<Selected> }
>((_event, { first, selected }) => {
  selected.set({ room: first });
});

interface Input {
  first: Room;
  selected: Writable<Selected>;
}

interface Output {
  select: Stream<void>;
}

export default pattern<Input, Output>(({ first, selected }) => {
  return { select: select({ first, selected }) };
});
