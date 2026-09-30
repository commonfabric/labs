/** The live fixture starts with a complete, reviewable reading history. */

import { assert, pattern, TESTS, UI } from "commonfabric";
import { hasText } from "../test/vnode-helpers.ts";
import SeededLiveDemo from "./seeded-live-demo.tsx";

export default pattern(() => {
  const demo = SeededLiveDemo({});
  const seeded = assert(() =>
    demo.finishedBooks.get().length === 5 &&
    demo.finishedBooks.get()[0].get().title === "The Left Hand of Darkness" &&
    demo.finishedBooks.get()[4].get().title === "Never Let Me Go" &&
    demo.favoriteAuthors.get().join(",") ===
      "Ursula K. Le Guin,Octavia E. Butler,N. K. Jemisin" &&
    hasText(demo[UI], "Five books for you")
  );
  return { [TESTS]: [{ assertion: seeded }] };
});
