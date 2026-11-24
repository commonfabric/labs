/**
 * Test Pattern: the untested system patterns
 *
 * These are load-bearing product patterns: the space overview, the journal,
 * and the mentionables inspector. Each finds its data through wishes rather
 * than through inputs, so in an empty space each one has to come up with an
 * empty view rather than fail.
 *
 * That empty view is what this pins down. Each pattern is built and its
 * rendered tree read, which is what runs the derived expressions inside it.
 */
import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import { textContent } from "../tools/test-support/vnode-helpers.ts";
import Journal from "./journal/journal.tsx";
import MentionablesInspector from "./mentionables-inspector/mentionables-inspector.tsx";
import SpaceOverview from "./space-overview/space-overview.tsx";

export default pattern(() => {
  const spaceOverview = SpaceOverview({});
  const journal = Journal({});
  const mentionables = MentionablesInspector({});

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
      { assertion: assert_space_overview_builds },
      { assertion: assert_journal_builds },
      { assertion: assert_mentionables_inspector_is_empty },
    ],
  };
});
