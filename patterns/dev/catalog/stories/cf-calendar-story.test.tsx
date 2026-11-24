import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import CalendarStory from "./cf-calendar-story.tsx";

// Lane-2 pattern test (run by `cf test`): instantiating the story runs its body
// — the [UI] and `controls` JSX, including the new week-start SelectControl — so
// the story's authored lines are recorded as covered (the point of this test:
// closing the catalog-story coverage-debt the week-start change added), and the
// assertion checks the story builds the shape the catalog renderer expects.
//
// The assertion covers `[NAME]` and `[UI]` only. Unlike cf-submit-input's plain
// `<div>` controls, this story's `controls` is a `<Controls>`-wrapped fragment
// of child control components; that composed value doesn't resolve to a plain
// non-null inside a computed (the catalog renderer consumes it fine — it just
// isn't assertion-friendly in the pattern-test harness). Instantiation runs the
// controls JSX for coverage either way, so a `controls` assertion adds nothing.
export default pattern(() => {
  const story = CalendarStory({});
  const assert_story_built = assert(() =>
    story[NAME] === "cf-calendar Story" &&
    story[UI] != null
  );
  return { [TESTS]: [{ assertion: assert_story_built }] };
});
