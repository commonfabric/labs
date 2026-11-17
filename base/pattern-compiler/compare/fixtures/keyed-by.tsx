/// <cts-enable />
import { handler, type KeyedBy, lift, pattern, Writable } from "commonfabric";

interface Repo {
  id: number;
  name: string;
  stars: number;
}

const note = handler<{ text: string }, { noted: Writable<string> }>(
  (event, { noted }) => {
    noted.set(event.text);
  },
);

const RepoRow = pattern<{ repo: Repo }>(({ repo }) => {
  const noted = Writable.of("");
  return { name: repo.name, stars: repo.stars, noted, note: note({ noted }) };
});

// A plain array generated from scratch: one computation returns the
// whole array each time, as the result of an API call is.
const fetched = lift(
  (input: { names: string[]; bonus: number }): KeyedBy<Repo, "id">[] =>
    input.names.map((name, index) => ({
      id: index + 1,
      name,
      stars: name.length + input.bonus,
    })),
);

interface Input {
  names: string[];
  bonus: number;
  minStars: number;
  saved: Writable<KeyedBy<Repo, "id">[]>;
}

// Rulings Z37 and Z38: the element type `KeyedBy<Repo, "id">` declares
// the key field of a plain value. `repos` is a plain array generated
// from scratch, whose elements change `stars` with `bonus` between
// evaluations: an element with the same `id` is the same element, so
// the state cell of its row in `rows` stays, and so does the instance
// of `RepoRow` in `starred`, which is over the result of a `filter` and
// has the upstream key. `kept` is over plain values in place, which a
// test edits where they stand. A test also gives `saved` as an array of
// references, where the marker changes nothing. `KeyedBy` is no member
// of today's `commonfabric`, so the executor's tests run this fixture
// and it is not compared with today's runtime.
export default pattern<Input>(({ names, bonus, minStars, saved }) => {
  const repos = fetched({ names, bonus });
  return {
    rows: repos.map((repo) => {
      const noted = Writable.of("");
      return {
        name: repo.name,
        stars: repo.stars,
        noted,
        note: note({ noted }),
      };
    }),
    starred: repos.filter((repo) => repo.stars >= minStars).map((repo) =>
      RepoRow.asInstance()({ repo })
    ),
    kept: saved.map((repo) => {
      const noted = Writable.of("");
      return { name: repo.name, noted, note: note({ noted }) };
    }),
  };
});
