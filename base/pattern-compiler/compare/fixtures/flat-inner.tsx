/// <cts-enable />
import { handler, pattern, UI, Writable } from "commonfabric";

interface Part {
  title: string;
}

interface Group {
  name: string;
  parts: Part[];
}

interface Shelf {
  name: string;
  tags: string[];
}

const add = handler<
  { name: string; titles: string[] },
  { groups: Writable<Group[]> }
>(({ name, titles }, { groups }) => {
  groups.push({ name, parts: titles.map((title) => ({ title })) });
});

const pick = handler<
  unknown,
  { group: string; title: string; chosen: Writable<string> }
>((_, { group, title, chosen }) => {
  chosen.set(`${group}/${title}`);
});

// Ruling Z43: a `flatMap` whose callback returns an inner `map` that
// binds a handler. The binding has the `element` step of the `flatMap`
// and that of the inner `map`, and the result of the `flatMap` has one
// level of positions: each holds the link to the stream that value code
// placed there, for the two keys of the cone instance that called
// `host.stream`. The first list is over the records a handler pushed,
// which are references to cells, as are their parts. The second is over
// plain values in place, whose inner arrays are plain values in place.
export default pattern<{ shelves: Shelf[] }>(({ shelves }) => {
  const groups = Writable.of<Group[]>([]);
  const chosen = Writable.of("");
  return {
    [UI]: (
      <div>
        <ul>
          {groups.flatMap((group) =>
            group.parts.map((part) => (
              <li
                onClick={pick({ group: group.name, title: part.title, chosen })}
              >
                {part.title}
              </li>
            ))
          )}
        </ul>
        <ol>
          {shelves.flatMap((shelf) =>
            shelf.tags.map((tag) => (
              <li onClick={pick({ group: shelf.name, title: tag, chosen })}>
                {tag}
              </li>
            ))
          )}
        </ol>
      </div>
    ),
    add: add({ groups }),
    chosen,
  };
});
