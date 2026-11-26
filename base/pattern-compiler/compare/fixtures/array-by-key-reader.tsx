/// <cts-enable />
import {
  type ArrayByKey,
  handler,
  lift,
  pattern,
  Writable,
} from "commonfabric";

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

// A reader whose parameter is typed as a plain array: it declares no
// key, and each row has a state cell.
const Rows = pattern<{ repos: Repo[] }>(({ repos }) => ({
  rows: repos.map((repo) => {
    const noted = Writable.of("");
    return { name: repo.name, stars: repo.stars, noted, note: note({ noted }) };
  }),
}));

// A plain array generated from scratch, whose type declares the key.
const fetched = lift(
  (input: { names: string[]; bonus: number }): ArrayByKey<Repo, "id"> =>
    input.names.map((name, index) => ({
      id: index + 1,
      name,
      stars: name.length + input.bonus,
    })),
);

interface Input {
  names: string[];
  bonus: number;
  saved: Writable<ArrayByKey<Repo, "id">>;
  loose: Writable<Repo[]>;
}

// Ruling Z52 and `plan-and-label-templates.md` §8, question 143: `Rows`
// declares no key and forms keys with the key fields of the array it is
// given. `inPlace` gives it an array of plain values in place, `scratch`
// a plain array generated from scratch, and `derived` the result of a
// `filter`, in each of which `Rows` is compiled in. `made` and
// `madeScratch` give the same two arrays to an instance of `Rows` that
// is called through `asInstance()`, which reads its argument through a
// link. `madeDerived` and `madeKept` give such an instance the result of
// a `filter`, over the plain array generated from scratch and over the
// plain values in place. `loose` declares no key, so its rows are keyed
// by the whole value. `ArrayByKey` is no member of today's `commonfabric`, so the
// executor's tests run this fixture and it is not compared with today's
// runtime.
export default pattern<Input>(({ names, bonus, saved, loose }) => {
  const repos = fetched({ names, bonus });
  return {
    inPlace: Rows({ repos: saved }),
    scratch: Rows({ repos }),
    derived: Rows({ repos: repos.filter((repo) => repo.stars > 0) }),
    none: Rows({ repos: loose }),
    made: Rows.asInstance()({ repos: saved }),
    madeScratch: Rows.asInstance()({ repos }),
    madeDerived: Rows.asInstance()({
      repos: repos.filter((repo) => repo.stars > 0),
    }),
    madeKept: Rows.asInstance()({
      repos: saved.filter((repo) => repo.stars > 0),
    }),
  };
});
