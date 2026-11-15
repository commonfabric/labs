/// <cts-enable />
import { handler, pattern, type Stream, Writable } from "commonfabric";

interface Point {
  lat: number;
  lng: number;
}

interface Area {
  center: Point;
}

interface Input {
  center: Writable<Point>;
  area: Writable<Area>;
}

// Stores what `center` holds in `area`. What a `get` returns of an object
// is a view of the cell, so the run stores a link to `center`.
const keep = handler<
  unknown,
  { center: Writable<Point>; area: Writable<Area> }
>((_event, { center, area }) => {
  area.set({ center: center.get() });
});

// Sets `center` to what `area` holds at `center`: a link to that position.
// After `keep` the position holds a link to `center`, and the two links
// are a cycle.
const go = handler<unknown, { center: Writable<Point>; area: Area }>(
  (_event, { center, area }) => {
    center.set(area.center);
  },
);

interface Output {
  center: Point;
  area: Area;
  keep: Stream<unknown>;
  go: Stream<unknown>;
}

export default pattern<Input, Output>(({ center, area }) => {
  return {
    center,
    area,
    keep: keep({ center, area }),
    go: go({ center, area }),
  };
});
