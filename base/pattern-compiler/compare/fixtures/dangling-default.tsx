/// <cts-enable />
import { computed, handler, pattern, Writable } from "commonfabric";

interface Position {
  lat: number;
  lng: number;
}

interface Stop {
  title: string;
  position: Position;
}

// The handler of a row stores a member of its element, a reference by key
// over plain values in place.
const pick = handler<unknown, { stop: Stop; center: Writable<Position> }>(
  (_, { stop, center }) => {
    center.set(stop.position);
  },
);

// Copies what `center` reads into another cell.
const report = handler<
  unknown,
  { center: Writable<Position>; seen: Writable<Position | null> }
>((_, { center, seen }) => {
  seen.set({ lat: center.get().lat, lng: center.get().lng });
});

// A state cell that holds a reference by key, read through the result, by
// value code (`shownLat`) and by a handler (`report`) once no element has
// the key.
export default pattern<{ stops: Writable<Stop[]> }>(({ stops }) => {
  const center = Writable.of<Position>({ lat: 0, lng: 0 });
  const seen = Writable.of<Position | null>(null);
  return {
    center,
    seen,
    shownLat: computed(() => center.get().lat),
    rows: stops.map((stop) => ({ pick: pick({ stop, center }) })),
    report: report({ center, seen }),
  };
});
