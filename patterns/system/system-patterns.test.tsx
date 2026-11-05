/**
 * Test Pattern: the untested system patterns
 *
 * These are load-bearing product patterns: an alternative home screen, the
 * space overview, the journal, and the mentionables inspector. Each finds its
 * data through wishes rather than through inputs, so in an empty space each
 * one has to come up with an empty view rather than fail.
 *
 * That empty view is what this pins down. Each pattern is built and its
 * rendered tree read, which is what runs the derived expressions inside it.
 */
import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import { hasText, textContent } from "../tools/test-support/vnode-helpers.ts";
import HomeBen from "./home/home-ben.tsx";
import Journal from "./journal/journal.tsx";
import MentionablesInspector from "./mentionables-inspector/mentionables-inspector.tsx";
import SpaceOverview from "./space-overview/space-overview.tsx";

export default pattern(() => {
  const home = HomeBen({});
  const spaceOverview = SpaceOverview({});
  const journal = Journal({});
  const mentionables = MentionablesInspector({});

  // The home screen composes the favorites manager, the journal, and the
  // space list, so its tree carries all three sections.
  const assert_home_shows_sections = assert(() =>
    textContent(home[UI]).length > 0 &&
    hasText(home[UI], "Journal")
  );

  const assert_space_overview_builds = assert(() =>
    textContent(spaceOverview[UI]).length > 0
  );

  const assert_journal_builds = assert(() =>
    journal[NAME] === "Journal" && textContent(journal[UI]).length > 0
  );

  // With nothing mentionable in the space the inspector lists nothing and
  // carries no text of its own, so its tree is built but empty.
  const assert_mentionables_inspector_is_empty = assert(() =>
    textContent(mentionables[UI]).trim() === ""
  );

  return {
    [TESTS]: [
      { assertion: assert_home_shows_sections },
      { assertion: assert_space_overview_builds },
      { assertion: assert_journal_builds },
      { assertion: assert_mentionables_inspector_is_empty },
    ],
  };
});
