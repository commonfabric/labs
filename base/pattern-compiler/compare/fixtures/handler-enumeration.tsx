/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

const file = handler<
  { title: string },
  { names: Writable<Record<string, unknown>>; last: Writable<string> }
>(
  ({ title }, { names, last }) => {
    const name = `${Object.keys(names.get() ?? {}).length + 1}`;
    names.key(name).set({ title });
    last.set(name);
  },
);

// A handler that is handed a record of references as a cell and reads
// which names the record holds, to choose the next: it reads no member of
// the record.
export default pattern<{ names: Writable<Record<string, unknown>> }>(
  ({ names }) => {
    const last = Writable.of("");
    return { last, file: file({ names, last }) };
  },
);
