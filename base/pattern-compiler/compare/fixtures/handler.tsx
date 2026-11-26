/// <cts-enable />
import {
  type Confidential,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

interface Input {
  secret: Confidential<string, ["alice"]>;
  note: string;
}

interface Entry {
  text: string;
}

const record = handler<
  { text: Confidential<string, ["erin"]>; extra: string },
  { secret: string; last: Writable<string>; log: Writable<Entry[]> }
>((event, { secret, last, log }) => {
  last.set(event.text + secret);
  log.push({ text: event.text });
});

interface Output {
  last: string;
  log: Entry[];
  note: string;
  record: Stream<{ text: string; extra: string }>;
}

export default pattern<Input, Output>(({ secret, note }) => {
  const last = Writable.of("");
  const log = Writable.of<Entry[]>([]);
  return { last, log, note, record: record({ secret, last, log }) };
});
