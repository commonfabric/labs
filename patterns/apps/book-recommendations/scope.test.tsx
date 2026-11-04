import {
  action,
  assert,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import BookRecommendations, {
  type BookRecommendationsOutput,
} from "./main.tsx";
import type { Book } from "./view.tsx";

interface Setup {
  reader: BookRecommendationsOutput;
}

export const setup = pattern(() => ({ reader: BookRecommendations({}) }));

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const book = new Writable.perUser<Book>({
    title: "The Dispossessed",
    author: "Ursula K. Le Guin",
  });
  const save = action(() => {
    setup.reader.finishedBooks.push(book);
    setup.reader.favoriteAuthors.push("Ursula K. Le Guin");
  });
  const sees_own_reader = assert(() =>
    setup.reader.finishedBooks.get().length === 1 &&
    setup.reader.finishedBooks.get()[0].equals(book) &&
    setup.reader.favoriteAuthors.get().length === 1 &&
    setup.reader.favoriteAuthors.get()[0] === "Ursula K. Le Guin"
  );
  return {
    [TESTS]: [
      { action: save },
      { label: "alice-saved" },
      { await: "bob-saved" },
      { assertion: sees_own_reader },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const book = new Writable.perUser<Book>({
    title: "Parable of the Sower",
    author: "Octavia E. Butler",
  });
  const save = action(() => {
    setup.reader.finishedBooks.push(book);
    setup.reader.favoriteAuthors.push("Octavia E. Butler");
  });
  const sees_own_reader = assert(() =>
    setup.reader.finishedBooks.get().length === 1 &&
    setup.reader.finishedBooks.get()[0].equals(book) &&
    setup.reader.favoriteAuthors.get().length === 1 &&
    setup.reader.favoriteAuthors.get()[0] === "Octavia E. Butler"
  );
  return {
    [TESTS]: [
      { action: save },
      { label: "bob-saved" },
      { await: "alice-saved" },
      { assertion: sees_own_reader },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
