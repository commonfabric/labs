/** The reading shelf supports manual additions while its agent is unavailable. */

import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByExactText,
  hasText,
  propValue,
} from "../test/vnode-helpers.ts";
import Library from "./library.tsx";

export default pattern(() => {
  const library = Library({});
  const startsEmpty = assert(() =>
    library.reading.books.length === 0 &&
    library.reading.favoriteAuthors.length === 0 &&
    library.invitations.get().length === 0
  );
  const missingProfileDisablesInvitation = assert(() =>
    propValue(
      findElementByExactText(
        library[UI],
        "cf-button",
        "Ask for recommendations",
      ),
      "disabled",
    ) === true
  );
  const createWithoutProfile = action(() => library.createInvitation.send());
  const noInvitationWithoutProfile = assert(() =>
    library.invitations.get().length === 0
  );
  const addBook = action(() =>
    library.addBook.send({
      title: "  Solaris ",
      author: " Stanisław Lem ",
    })
  );
  const bookVisible = assert(() =>
    library.reading.books.length === 1 &&
    library.reading.books[0].title === "Solaris" &&
    library.reading.books[0].author === "Stanisław Lem" &&
    hasText(library[UI], "Solaris")
  );
  const addAuthor = action(() =>
    library.addAuthor.send({ name: " Ursula K. Le Guin " })
  );
  const authorVisible = assert(() =>
    library.reading.favoriteAuthors.length === 1 &&
    library.reading.favoriteAuthors[0] === "Ursula K. Le Guin" &&
    hasText(library[UI], "Ursula K. Le Guin")
  );
  const emptyInputs = action(() => {
    library.addBook.send({ title: " ", author: "" });
    library.addAuthor.send({ name: " " });
  });
  const noEmptyEntries = assert(() =>
    library.reading.books.length === 1 &&
    library.reading.favoriteAuthors.length === 1
  );
  const duplicateAuthor = action(() =>
    library.addAuthor.send({ name: "Ursula K. Le Guin" })
  );
  const uniqueAuthors = assert(() =>
    library.reading.favoriteAuthors.length === 1
  );
  return {
    [TESTS]: [
      { assertion: startsEmpty },
      { assertion: missingProfileDisablesInvitation },
      { action: createWithoutProfile },
      { assertion: noInvitationWithoutProfile },
      { action: addBook },
      { assertion: bookVisible },
      { action: addAuthor },
      { assertion: authorVisible },
      { action: emptyInputs },
      { assertion: noEmptyEntries },
      { action: duplicateAuthor },
      { assertion: uniqueAuthors },
    ],
  };
});
