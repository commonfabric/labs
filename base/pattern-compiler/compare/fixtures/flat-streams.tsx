/// <cts-enable />
import { handler, pattern, UI, Writable } from "commonfabric";

interface Item {
  title: string;
}

const pick = handler<unknown, { title: string; chosen: Writable<string> }>(
  (_, { title, chosen }) => {
    chosen.set(title);
  },
);

// A binding of the body of a `flatMap` callback. Each position of the
// result has the key of the source element and a part formed from the
// member (ruling Z22), and every member of one segment holds the stream
// of the one source key (ruling Z43). The first list is over
// records, which a test gives as references to cells, and the second
// over plain values in place. Each segment is an array of plain values
// that the callback writes. The executor's tests run this fixture. It is
// not compared with today's runtime.
export default pattern<{ items: Item[]; tags: string[] }>(
  ({ items, tags }) => {
    const chosen = Writable.of("");
    return {
      [UI]: (
        <div>
          <ul>
            {items.flatMap((item) => {
              const choose = pick({ title: item.title, chosen });
              return [
                <li onClick={choose}>{item.title}</li>,
                <li onClick={choose}>again</li>,
              ];
            })}
          </ul>
          <ol>
            {tags.flatMap((tag) => [
              <li onClick={pick({ title: tag, chosen })}>{tag}</li>,
            ])}
          </ol>
        </div>
      ),
      chosen,
    };
  },
);
