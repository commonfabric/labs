/** Invitation drafts are reviewed privately before any shared list changes. */

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
import { type LibrarySeed, prioritizeCandidateBooks } from "./agents.tsx";
import Invitation from "./main.tsx";
import type { Profile } from "./views.tsx";

export default pattern(() => {
  const originator = new Writable<Profile>({ name: "Book lover" });
  const invitation = Invitation({ originatorProfile: originator });
  const shelf = new Writable<LibrarySeed>({
    books: [{
      title: "The Left Hand of Darkness",
      author: "Ursula K. Le Guin",
    }],
    favoriteAuthors: ["Ursula K. Le Guin"],
  });
  const empty = assert(() =>
    invitation.selected.get()?.books.length === 0 &&
    invitation.recommended.get()?.length === 0 &&
    invitation.received.get().length === 0
  );
  const namesItself = assert(() => invitation[NAME] === "Recommend me a book");
  const checkingOwner = assert(() =>
    hasText(invitation[UI], "Checking invitation…")
  );
  // With no reviewed shelf staged, publishing changes nothing.
  const reviewManual = action(() => {
    invitation.review.send({
      books: [{ title: "  Solaris  ", author: "" }],
    });
    invitation.publishReviewed.send();
  });
  const manualStaged = assert(() =>
    invitation.library.value?.get() === undefined &&
    invitation.selected.get()?.books.length === 1 &&
    invitation.selected.get()?.books[0].title === "Solaris" &&
    invitation.selected.get()?.books[0].author === "" &&
    invitation.recommended.get()?.length === 0 &&
    invitation.received.get().length === 0
  );
  const noConfirmedSnapshot = action(() => invitation.clearSelection.send());
  const notSubmitted = assert(() =>
    invitation.selected.get()?.books.length === 0 &&
    invitation.recommended.get()?.length === 0 &&
    invitation.received.get().length === 0
  );
  const reviewBooks = action(() =>
    invitation.review.send({
      books: [
        { title: "  Kindred  ", author: "  Octavia E. Butler " },
        { title: " ", author: "Empty title" },
      ],
    })
  );
  const selectedFields = assert(() =>
    invitation.selected.get()?.books.length === 1 &&
    invitation.selected.get()?.books[0].title === "Kindred" &&
    invitation.selected.get()?.books[0].author === "Octavia E. Butler"
  );
  const shelfAwareCandidates = assert(() => {
    const candidates = prioritizeCandidateBooks(
      [{ title: "Solaris", author: "Stanisław Lem", reason: "Own context" }, {
        title: " the left hand OF DARKNESS ",
        author: "ursula k. le guin",
        reason: "Already present",
      }, {
        title: "The Dispossessed",
        author: "Ursula K. Le Guin",
        reason: "Favorite author",
      }, {
        title: "Solaris",
        author: "Stanisław Lem",
        reason: "Duplicate proposal",
      }],
      {
        books: [{
          title: "The Left Hand of Darkness",
          author: "Ursula K. Le Guin",
        }],
        favoriteAuthors: ["ursula k. le guin"],
      },
    );
    return candidates.map((candidate) => candidate.title).join(",") ===
      "The Dispossessed,Solaris";
  });
  const publishStaged = action(() => {
    invitation.reviewedLibrary.set({ value: shelf });
    invitation.publishReviewed.send();
  });
  const shelfPublished = assert(() =>
    invitation.library.value?.get()?.favoriteAuthors[0] ===
      "Ursula K. Le Guin" &&
    invitation.reviewedLibrary.get()?.value === undefined
  );
  const visitorArrives = action(() => answerOwnerCheck(invitation[UI], false));
  const visitorSeesTaste = assert(() => {
    const ui = readValue(invitation[UI]);
    return hasText(ui, "Recommend me a book") &&
      hasText(ui, "Ursula K. Le Guin") &&
      !hasText(ui, "The Left Hand of Darkness");
  });
  const showBooks = action(() => clickButton(invitation[UI], "Show all books"));
  const visitorSeesPublishedBooks = assert(() =>
    hasText(invitation[UI], "The Left Hand of Darkness")
  );
  const ownerArrives = action(() => answerOwnerCheck(invitation[UI], true));
  const ownerSeesEmptyInbox = assert(() => {
    const ui = readValue(invitation[UI]);
    return hasText(ui, "Your next chapter") &&
      hasText(ui, "No recommendations yet.");
  });
  return {
    [TESTS]: [
      { assertion: empty },
      { assertion: namesItself },
      { assertion: checkingOwner },
      { action: reviewManual },
      { assertion: manualStaged },
      { action: noConfirmedSnapshot },
      { assertion: notSubmitted },
      { action: reviewBooks },
      { assertion: selectedFields },
      { assertion: shelfAwareCandidates },
      { action: publishStaged },
      { assertion: shelfPublished },
      { action: visitorArrives },
      { assertion: visitorSeesTaste },
      { action: showBooks },
      { assertion: visitorSeesPublishedBooks },
      { action: ownerArrives },
      { assertion: ownerSeesEmptyInbox },
    ],
  };
});
