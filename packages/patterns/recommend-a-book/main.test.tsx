/** Invitation drafts are reviewed privately before any shared list changes. */

import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import { prioritizeCandidateBooks } from "./agents.tsx";
import Invitation from "./main.tsx";
import type { Profile } from "./views.tsx";

export default pattern(() => {
  const originator = new Writable<Profile>({ name: "Book lover" });
  const invitation = Invitation({ originatorProfile: originator });
  const empty = assert(() =>
    invitation.selected.get()?.books.length === 0 &&
    invitation.recommended.get()?.length === 0 &&
    invitation.received.get().length === 0
  );
  const reviewManual = action(() =>
    invitation.review.send({
      books: [{ title: "  Solaris  ", author: "" }],
    })
  );
  const manualStaged = assert(() =>
    invitation.selected.get()?.books.length === 1 &&
    invitation.selected.get()?.books[0].title === "Solaris" &&
    invitation.selected.get()?.books[0].author === "" &&
    invitation.recommended.get()?.length === 0 &&
    invitation.received.get().length === 0
  );
  const noConfirmedSnapshot = action(() => invitation.acceptShared.send());
  const notSubmitted = assert(() =>
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
  return {
    [TESTS]: [
      { assertion: empty },
      { action: reviewManual },
      { assertion: manualStaged },
      { action: noConfirmedSnapshot },
      { assertion: notSubmitted },
      { action: reviewBooks },
      { assertion: selectedFields },
      { assertion: shelfAwareCandidates },
    ],
  };
});
