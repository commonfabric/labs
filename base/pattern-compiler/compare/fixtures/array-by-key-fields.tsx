/// <cts-enable />
import {
  type ArrayByKey,
  handler,
  lift,
  pattern,
  Writable,
} from "commonfabric";

interface Repo {
  owner: string;
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
  return {
    owner: repo.owner,
    name: repo.name,
    stars: repo.stars,
    noted,
    note: note({ noted }),
  };
});

// A plain array generated from scratch: one computation returns the
// whole array each time. `bonus` changes a member that is no key field
// of every element, and `reversed` the order of the elements.
const fetched = lift(
  (
    input: { names: string[]; bonus: number; reversed: boolean },
  ): ArrayByKey<Repo, "owner" | "name"> => {
    const repos = input.names.map((name, index) => ({
      owner: index % 2 === 0 ? "cf" : "x",
      name,
      stars: name.length + input.bonus,
    }));
    return input.reversed ? repos.toReversed() : repos;
  },
);

interface Input {
  names: string[];
  bonus: number;
  reversed: boolean;
  minStars: number;
  saved: Writable<ArrayByKey<Repo, "owner" | "name">>;
}

// Rulings Z45 and Z49: the array type `ArrayByKey<Repo, "owner" | "name">`
// declares two key fields, and an element has one key across them.
// `starred` is over the result of a `filter` of a plain array generated
// from scratch, and `kept` is over plain values in place. Each row is an
// instance of `RepoRow` called through `asInstance()`, whose state cell
// `noted` stays with the key when `stars` or the order of the elements
// changes. `ArrayByKey` is no member of today's `commonfabric`, so the
// executor's tests run this fixture and it is not compared with today's
// runtime.
export default pattern<Input>(
  ({ names, bonus, reversed, minStars, saved }) => {
    const repos = fetched({ names, bonus, reversed });
    return {
      starred: repos.filter((repo) => repo.stars >= minStars).map((repo) =>
        RepoRow.asInstance()({ repo })
      ),
      kept: saved.map((repo) => RepoRow.asInstance()({ repo })),
    };
  },
);
