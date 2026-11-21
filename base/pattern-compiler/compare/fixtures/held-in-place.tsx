/// <cts-enable />
import { Cell, computed, handler, ifElse, pattern, UI } from "commonfabric";

interface Point {
  lat: number;
  lng: number;
}

interface Stop {
  title: string;
  position: Point;
}

const copyOf = ({ lat, lng }: Point): Point => ({ lat, lng });

const format = (value: number | undefined | null): string =>
  value != null ? value.toFixed(1) : "none";

const goTo = handler<
  { index: number },
  { stops: Stop[]; center: Cell<Point | null> }
>((event, { stops, center }) => {
  center.set(copyOf(stops[event.index].position));
});

const goToArea = handler<
  unknown,
  { area: Point; center: Cell<Point | null> }
>((_, { area, center }) => {
  center.set(copyOf(area));
});

// Values that the result holds in place where the plan's template is of a
// reference, of nothing, or of a collection's membership alone:
// `center` is the value of a cell, or a default, and the cell holds links to
// the positions `goTo` and `goToArea` copied it from; the text of the
// coordinate is computed through a function the plan has no template for;
// and the rows of the view are the result of a `map` whose element body
// reads the input `selected`.
export default pattern<
  {
    stops: Stop[];
    area: Point;
    selected: number;
    center: Cell<Point | null>;
  }
>(({ stops, area, selected, center }) => ({
  [UI]: (
    <div>
      <span>
        {computed(() => format((center.get() ?? { lat: 1, lng: 2 }).lat))}
      </span>
      {stops.map((stop, index) => (
        <span
          style={{
            color: ifElse(computed(() => selected === index), "blue", "gray"),
          }}
        >
          {stop.title}
        </span>
      ))}
    </div>
  ),
  center: computed(() => center.get() ?? { lat: 1, lng: 2 }),
  goTo: goTo({ stops, center }),
  goToArea: goToArea({ area, center }),
}));
