/// <cts-enable />
import { action, handler, pattern, Writable } from "commonfabric";

interface Position {
  lat: number;
  lng: number;
}

interface Stop {
  title: string;
  position: Position;
}

const stopOf = (title: string): Stop => ({
  title,
  position: { lat: title.length, lng: 7 },
});

// A record a handler pushes onto a list.
const add = handler<{ title: string }, { stops: Writable<Stop[]> }>(
  (event, { stops }) => {
    stops.push(stopOf(event.title));
  },
);

// A record a handler writes as a member of the whole list.
const append = handler<{ title: string }, { stops: Writable<Stop[]> }>(
  (event, { stops }) => {
    stops.set([...stops.get(), stopOf(event.title)]);
  },
);

// The last record leaves the list.
const removeLast = handler<
  Record<string, never>,
  { stops: Writable<Stop[]> }
>(
  (_, { stops }) => {
    stops.set(stops.get().slice(0, -1));
  },
);

// A string a handler pushes onto a list.
const name = handler<{ name: string }, { names: Writable<string[]> }>(
  (event, { names }) => {
    names.push(event.name);
  },
);

export default pattern<{ note: string }>(({ note }) => {
  const stops = Writable.of<Stop[]>([]);
  const names = Writable.of<string[]>([]);
  const center = Writable.of<Position>({ lat: 0, lng: 0 });
  return {
    note,
    center,
    names,
    // The handler of a row stores a member of its element in a cell.
    rows: stops.map((stop) => ({
      title: stop.title,
      go: action(() => {
        center.set(stop.position);
      }),
    })),
    labels: names.map((label) => label + "!"),
    add: add({ stops }),
    append: append({ stops }),
    removeLast: removeLast({ stops }),
    name: name({ names }),
  };
});
