/** The invitation reads the shelf slot; integration tests cover publication and viewer UI. */

import { assert, pattern, TESTS, Writable } from "commonfabric";
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
  return { [TESTS]: [{ assertion: publishedShelf }] };
});
