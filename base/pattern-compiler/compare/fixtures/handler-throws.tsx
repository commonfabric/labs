/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

interface Input {
  label: string;
}

// Throws before its write while `last` holds no value, which is the state
// the pattern starts in: the runtime aborts the transaction of the event.
const record = handler<
  unknown,
  { label: string; last: Writable<string | undefined> }
>((_event, { label, last }) => {
  if (last.get() === undefined) throw new Error("nothing recorded yet");
  last.set(label);
});

interface Output {
  last: string | undefined;
  record: Stream<unknown>;
}

export default pattern<Input, Output>(({ label }) => {
  const last = Writable.of<string | undefined>(undefined);
  return { last, record: record({ label, last }) };
});
