/// <cts-enable />
import { equals, handler, pattern, Writable } from "commonfabric";

interface Position {
  lat: number;
  lng: number;
}

interface Stop {
  title: string;
  done: boolean;
  position: Position;
}

// The handler of a row stores its element in one cell and a member of
// the element in another.
const pick = handler<
  unknown,
  { stop: Stop; selected: Writable<Stop | null>; center: Writable<Position> }
>((_, { stop, selected, center }) => {
  selected.set(stop);
  center.set(stop.position);
});

// One write through the element of a row.
const finish = handler<unknown, { stop: Writable<Stop> }>((_, { stop }) => {
  stop.key("done").set(true);
});

// Two writes through the element of a row, one after the other.
const finishAndRename = handler<unknown, { stop: Writable<Stop> }>(
  (_, { stop }) => {
    stop.key("done").set(true);
    stop.key("title").set("renamed");
  },
);

// A write of two members of the element of a row in one call.
const update = handler<unknown, { stop: Writable<Stop> }>((_, { stop }) => {
  stop.update({ done: true, title: "updated" });
});

// A state cell of a row.
const toggle = handler<unknown, { open: Writable<boolean> }>((_, { open }) => {
  open.set(!open.get());
});

const reverse = handler<
  unknown,
  { stops: Writable<Stop[]>; tags: Writable<string[]> }
>((_, { stops, tags }) => {
  stops.set(stops.get().toReversed());
  tags.set(tags.get().toReversed());
});

const removeFirst = handler<
  unknown,
  { stops: Writable<Stop[]>; tags: Writable<string[]> }
>((_, { stops, tags }) => {
  stops.set(stops.get().slice(1));
  tags.set(tags.get().slice(1));
});

const addTag = handler<{ tag: string }, { tags: Writable<string[]> }>(
  (event, { tags }) => {
    tags.push(event.tag);
  },
);

// The handler of a row over strings stores a reference to its element.
const choose = handler<
  unknown,
  { tag: Writable<string>; chosen: Writable<string | null> }
>((_, { tag, chosen }) => {
  chosen.set(tag);
});

export default pattern<
  { stops: Writable<Stop[]>; tags: Writable<string[]> }
>(({ stops, tags }) => {
  const selected = Writable.of<Stop | null>(null);
  const center = Writable.of<Position>({ lat: 0, lng: 0 });
  const chosen = Writable.of<string | null>(null);
  return {
    selected,
    center,
    chosen,
    rows: stops.map((stop) => {
      const open = Writable.of(false);
      return {
        title: stop.title,
        // The element and a member of it, passed on.
        stop,
        position: stop.position,
        isSelected: equals(selected, stop),
        // A member bound both ways.
        check: <cf-checkbox $checked={stop.done} />,
        open,
        pick: pick({ stop, selected, center }),
        finish: finish({ stop }),
        finishAndRename: finishAndRename({ stop }),
        update: update({ stop }),
        toggle: toggle({ open }),
      };
    }),
    words: tags.map((tag) => ({
      item: <li>{tag}</li>,
      choose: choose({ tag, chosen }),
    })),
    reverse: reverse({ stops, tags }),
    removeFirst: removeFirst({ stops, tags }),
    addTag: addTag({ tags }),
  };
});
