/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

interface Pin {
  id: string;
  title: string;
}

// The record of a key is written when it holds nothing, and it is a
// member of the list once however often the handler runs.
const pin = handler<{ id: string; title: string }, { pins: Writable<Pin[]> }>(
  (event, { pins }) => {
    const record = pins.elementById(event.id);
    if (record.get() === undefined) {
      record.set({ id: event.id, title: event.title });
    }
    pins.addUnique(record);
  },
);

// The record leaves the list, and is cleared, so that a later `pin` of
// the same key starts from nothing.
const unpin = handler<{ id: string }, { pins: Writable<Pin[]> }>(
  (event, { pins }) => {
    pins.removeByValue(pins.elementById(event.id));
    const record: Writable<Pin | undefined> = pins.elementById(event.id);
    record.set(undefined);
  },
);

// A cell constructed with `new` in a function body.
const draft = handler<{ title: string }, { last: Writable<string> }>(
  (event, { last }) => {
    const made = new Writable<Pin>({ id: "draft", title: event.title });
    last.set(made.get().title + "!");
  },
);

export default pattern<{ note: string }>(({ note }) => {
  const pins = Writable.of<Pin[]>([]);
  const last = Writable.of("");
  return {
    note,
    pins,
    last,
    pin: pin({ pins }),
    unpin: unpin({ pins }),
    draft: draft({ last }),
  };
});
