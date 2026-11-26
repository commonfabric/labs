/// <cts-enable />
import {
  type ArrayByKey,
  handler,
  lift,
  pattern,
  Writable,
} from "commonfabric";

interface Owner {
  login: string;
}

interface Repo {
  id: number;
  name: string;
  stars: number;
  owner: Owner;
}

const note = handler<{ text: string }, { noted: Writable<string> }>(
  (event, { noted }) => {
    noted.set(event.text);
  },
);

// The handler of a row stores its element in one cell and a member of
// the element in another.
const pick = handler<
  unknown,
  { repo: Repo; picked: Writable<Repo | null>; owner: Writable<Owner | null> }
>((_, { repo, picked, owner }) => {
  picked.set(repo);
  owner.set(repo.owner);
});

const RepoRow = pattern<{ repo: Repo }>(({ repo }) => {
  const noted = Writable.of("");
  return { name: repo.name, stars: repo.stars, noted, note: note({ noted }) };
});

// A plain array generated from scratch: one computation returns the
// whole array each time, as the result of an API call is.
const fetched = lift(
  (input: { names: string[]; bonus: number }): ArrayByKey<Repo, "id"> =>
    input.names.map((name, index) => ({
      id: index + 1,
      name,
      stars: name.length + input.bonus,
      owner: { login: `${name}-owner` },
    })),
);

// A plain array of numbers generated from scratch, with no declared key.
const counted = lift((input: { names: string[] }): number[] =>
  input.names.map((_, index) => index + 1)
);

interface Input {
  names: string[];
  bonus: number;
  minStars: number;
  saved: Writable<ArrayByKey<Repo, "id">>;
}

// Rulings Z37 and Z49: the array type `ArrayByKey<Repo, "id">` declares
// the key field of the plain values of the array. `repos` is a plain
// array generated from scratch, whose elements change `stars` with
// `bonus` between evaluations: an element with the same `id` is the same
// element, so the state cell of its row in `rows` stays, and so does the
// instance of `RepoRow` in `starred`, which is over the result of a
// `filter` and has the upstream key. `kept` is over plain values in
// place, which a test edits where they stand. A test also gives `saved`
// as an array of references, where the declaration changes nothing.
// Ruling Z44: the handler `pick` stores its element and a member of it,
// in `kept` over plain values in place and in `found` over the result of
// a `filter` of the plain array generated from scratch, and `pickedName`
// and `ownerLogin` read what it stored. `tallies` is over the result of
// a `filter` of `counts`, whose elements are whole values that are the
// numbers the `id` of the elements of `repos` are. `ArrayByKey` is no
// member of today's `commonfabric`, so the executor's tests run this
// fixture and it is not compared with today's runtime.
export default pattern<Input>(({ names, bonus, minStars, saved }) => {
  const repos = fetched({ names, bonus });
  const counts = counted({ names });
  const picked = Writable.of<Repo | null>(null);
  const owner = Writable.of<Owner | null>(null);
  return {
    picked,
    owner,
    pickedName: picked.name,
    ownerLogin: owner.login,
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
      return {
        name: repo.name,
        noted,
        note: note({ noted }),
        pick: pick({ repo, picked, owner }),
      };
    }),
    tallies: counts.filter((count) => count > 0).map((count) => {
      const noted = Writable.of("");
      return { count, noted };
    }),
    found: repos.filter((repo) => repo.stars >= minStars).map((repo) => ({
      name: repo.name,
      pick: pick({ repo, picked, owner }),
    })),
  };
});
