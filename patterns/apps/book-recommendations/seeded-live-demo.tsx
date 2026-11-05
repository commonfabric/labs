/** A live demonstration of recommendations over five held reading-history books. */
import { pattern, Writable } from "commonfabric";
import BookRecommendations from "./main.tsx";
import type { Book } from "./view.tsx";

export default pattern(() => {
  const books = [
    new Writable<Book>({
      title: "The Left Hand of Darkness",
      author: "Ursula K. Le Guin",
    }),
    new Writable<Book>({ title: "Kindred", author: "Octavia E. Butler" }),
    new Writable<Book>({ title: "Piranesi", author: "Susanna Clarke" }),
    new Writable<Book>({
      title: "The Fifth Season",
      author: "N. K. Jemisin",
    }),
    new Writable<Book>({
      title: "Never Let Me Go",
      author: "Kazuo Ishiguro",
    }),
  ];
  return BookRecommendations({
    finishedBooks: books,
    favoriteAuthors: [
      "Ursula K. Le Guin",
      "Octavia E. Butler",
      "N. K. Jemisin",
    ],
  });
});
