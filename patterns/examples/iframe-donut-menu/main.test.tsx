/**
 * Reads the donut menu's `[FS]` text, which lists the menu for whatever reads
 * what the pattern holds rather than its frame.
 */

import { assert, FS, pattern, TESTS } from "commonfabric";
import DonutMenu from "./main.tsx";

export default pattern(() => {
  const menu = DonutMenu({});

  const assert_titles_the_menu = assert(() =>
    menu[FS].frontmatter.title === "Donut menu"
  );
  const assert_lists_the_menu_with_no_favorite = assert(() =>
    menu[FS].content === "- Glazed\n- Chocolate"
  );
  const assert_starts_with_no_favorite = assert(() =>
    menu.state.favorite === null
  );

  return {
    [TESTS]: [
      { assertion: assert_titles_the_menu },
      { assertion: assert_lists_the_menu_with_no_favorite },
      { assertion: assert_starts_with_no_favorite },
    ],
  };
});
