/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

interface Entry {
  text: string;
}

interface Input {
  label: string;
  count: Writable<number>;
  items: Writable<Entry[]>;
}

// Reads two inputs and writes one of them, and pushes an object onto an
// input list, which the runtime stores in a document of its own.
const add = handler<
  unknown,
  { label: string; count: Writable<number>; items: Writable<Entry[]> }
>((_event, { label, count, items }) => {
  count.set(count.get() + 1);
  items.push({ text: label });
});

interface Output {
  count: number;
  items: Entry[];
  add: Stream<unknown>;
}

export default pattern<Input, Output>(({ label, count, items }) => {
  return { count, items, add: add({ label, count, items }) };
});
