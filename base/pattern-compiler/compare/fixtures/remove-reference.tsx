/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

interface Stop {
  title: string;
  note: string;
}

const add = handler<
  { title: string },
  { note: string; stops: Writable<Stop[]> }
>(
  (event, { note, stops }) => {
    stops.push({ title: event.title, note });
  },
);

const dropFirst = handler<unknown, { stops: Writable<Stop[]> }>(
  (_, { stops }) => {
    stops.remove(stops.get()[0]);
  },
);

// A removal from an array of references: each record `add` pushes has a
// document of its own and holds the input `note`, and `dropFirst` removes
// the first, so the reference to the second then stands at the position
// before its own.
export default pattern<{ note: string }>(({ note }) => {
  const stops = Writable.of<Stop[]>([]);
  return {
    stops,
    add: add({ note, stops }),
    dropFirst: dropFirst({ stops }),
  };
});
