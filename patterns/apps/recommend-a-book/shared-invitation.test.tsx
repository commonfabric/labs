/** The invitation reads the shelf slot and renders it for visitor and owner. */

import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  answerOwnerCheck,
  clickButton,
  hasText,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import Invitation, { type LibrarySlot } from "./shared-invitation.tsx";
import type { Profile } from "./views.tsx";

export default pattern(() => {
  const originator = new Writable<Profile>({ name: "Book lover" });
  const library = new Writable<LibrarySlot>({
    value: {
      books: [{ title: "Kindred", author: "Octavia E. Butler" }],
      favoriteAuthors: ["Ursula K. Le Guin"],
    },
  });
  const invitation = Invitation({ originatorProfile: originator, library });
  const publishedShelf = assert(() =>
    invitation.library.key("value", "books").get()?.[0]?.title === "Kindred" &&
    invitation.library.key("value", "favoriteAuthors").get()?.[0] ===
      "Ursula K. Le Guin"
  );
  const namesItself = assert(() => invitation[NAME] === "Recommend me a book");
  const checkingOwner = assert(() =>
    hasText(invitation[UI], "Checking invitation…")
  );
  const review = action(() =>
    invitation.review.send({
      books: [
        { title: " Parable of the Sower ", author: " Octavia E. Butler " },
        { title: "  ", author: "No title" },
      ],
    })
  );
  const reviewed = assert(() =>
    invitation.selected.get()?.books.length === 1 &&
    invitation.selected.get()?.books[0].title === "Parable of the Sower" &&
    invitation.selected.get()?.books[0].author === "Octavia E. Butler"
  );
  const clear = action(() => invitation.clearSelection.send());
  const cleared = assert(() => invitation.selected.get()?.books.length === 0);
  const visitorArrives = action(() => answerOwnerCheck(invitation[UI], false));
  const visitorSeesTaste = assert(() => {
    const ui = readValue(invitation[UI]);
    return hasText(ui, "Recommend me a book") &&
      hasText(ui, "Ursula K. Le Guin") &&
      !hasText(ui, "Kindred");
  });
  const showBooks = action(() => clickButton(invitation[UI], "Show all books"));
  const visitorSeesShelf = assert(() => hasText(invitation[UI], "Kindred"));
  const ownerArrives = action(() => answerOwnerCheck(invitation[UI], true));
  const ownerSeesEmptyInbox = assert(() => {
    const ui = readValue(invitation[UI]);
    return hasText(ui, "Your next chapter") &&
      hasText(ui, "No recommendations yet.");
  });
  return {
    [TESTS]: [
      { assertion: publishedShelf },
      { assertion: namesItself },
      { assertion: checkingOwner },
      { action: review },
      { assertion: reviewed },
      { action: clear },
      { assertion: cleared },
      { action: visitorArrives },
      { assertion: visitorSeesTaste },
      { action: showBooks },
      { assertion: visitorSeesShelf },
      { action: ownerArrives },
      { assertion: ownerSeesEmptyInbox },
    ],
  };
});
