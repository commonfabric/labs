/**
 * Story Weaver's board controls, pressed as a person presses them: Inspire
 * me and picking an idea, the branch steppers and their confirmation, adding,
 * editing and removing levels, a spindle's own instruction, Respin, and
 * unpinning a pin the options on show no longer include.
 *
 * Every options and summary request fails here, so a pinned card shows its pin
 * beside the failure rather than among the options.
 *
 * Run: deno task cf test patterns/apps/story-weaver/main.test.tsx --verbose
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findNodeByProp,
  hasText,
  propValue,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";
import StoryWeaver, { type Level, type Spindle } from "./main.tsx";
import { withPinned } from "./story-logic.ts";

const SYNOPSIS = "A ferry pilot inherits a drowned town.";
const IDEA_TITLE = "The Tide Clock";
const IDEA_SYNOPSIS = "A clockmaker builds a clock that runs on tides.";

export const llmMocks = [
  {
    when: { systemContains: "story development" },
    object: { ideas: [{ title: IDEA_TITLE, synopsis: IDEA_SYNOPSIS }] },
  },
  { error: "Not answered in this test.", repeat: true },
];

const LEVELS: Level[] = [
  { title: "Characters", prompt: "Name them.", branch: 1 },
  { title: "Chapters", prompt: "Write chapters.", branch: 1 },
];

const recordAt = (
  spindles: readonly Spindle[],
  path: string,
): Spindle | undefined => spindles.find((s) => s.path === path);

export default pattern(() => {
  const board = StoryWeaver({
    title: "Tide Book",
    synopsis: SYNOPSIS,
    levels: LEVELS,
    spindles: withPinned([], "0", 0, "Ada pilots the ferry.", SYNOPSIS),
  });

  const assert_named_after_title = assert(() => board[NAME] === "📖 Tide Book");

  // --- Inspire me -----------------------------------------------------------

  const assert_no_ideas_yet = assert(() =>
    !hasText(board[UI], "Story ideas") && !hasText(board[UI], IDEA_TITLE)
  );
  const assert_idea_offered = assert(() =>
    hasText(board[UI], "Story ideas") && hasText(board[UI], IDEA_SYNOPSIS)
  );
  // Choosing an idea fills the draft and closes the panel; the committed
  // synopsis waits for Update synopsis.
  const assert_idea_drafted = assert(() =>
    board.synopsisDraft === IDEA_SYNOPSIS &&
    board.synopsis === SYNOPSIS &&
    !hasText(board[UI], "Story ideas")
  );

  // --- Branch steppers ------------------------------------------------------

  const assert_raised_branch = assert(() =>
    board.levels[0].branch === 2 &&
    board.levels[1].branch === 1 &&
    board.board[0].join() === "0,1"
  );
  const action_pin_second = action(() =>
    board.pin.send({ path: "1", option: 0, text: "Bo rows the dinghy." })
  );
  const assert_lowering_asks = assert(() =>
    board.levels[0].branch === 2 &&
    hasText(
      board[UI],
      "Lowering to 1 removes 1 pinned spindle and everything under it.",
    )
  );
  const assert_lowered = assert(() =>
    board.levels[0].branch === 1 &&
    board.board[0].join() === "0" &&
    recordAt(board.spindles, "1") === undefined &&
    recordAt(board.spindles, "0")?.pinnedText === "Ada pilots the ferry." &&
    !hasText(board[UI], "Lowering to")
  );

  // --- Adding and removing levels -------------------------------------------

  // The form's placeholders suggest the next level.
  const action_fill_new_level = action(() => {
    typeInto(board[UI], "Scenes", "Storms");
    typeInto(
      board[UI],
      "Break this chapter into detailed scenes.",
      "List them.",
    );
  });
  const assert_level_added = assert(() => {
    const titleInput = findNodeByProp(board[UI], "placeholder", "Beats");
    return board.levels.length === 3 &&
      board.levels[2].title === "Storms" &&
      board.levels[2].prompt === "List them." &&
      board.levels[2].branch === 1 &&
      propValue(titleInput, "$value") === "";
  });
  // No pin sits on the new level, so it goes without asking.
  const assert_empty_level_removed = assert(() =>
    board.levels.length === 2 &&
    board.levels[1].title === "Chapters" &&
    !hasText(board[UI], "Removing this level")
  );
  const action_pin_chapter = action(() =>
    board.pin.send({ path: "0.0", option: 2, text: "The town surfaces." })
  );
  const assert_removing_asks = assert(() =>
    board.levels.length === 2 &&
    hasText(board[UI], "Removing this level removes 1 pinned spindle.")
  );
  const assert_pinned_level_removed = assert(() =>
    board.levels.length === 1 &&
    board.levels[0].title === "Characters" &&
    recordAt(board.spindles, "0.0") === undefined &&
    !hasText(board[UI], "Removing this level")
  );

  // --- Editing a level ------------------------------------------------------

  const action_edit_level_fields = action(() => {
    typeInto(board[UI], "Level title", "Cast");
    typeInto(
      board[UI],
      "What should each spindle at this level write?",
      "List the cast.",
    );
  });
  const assert_level_edited = assert(() =>
    board.levels.length === 1 &&
    board.levels[0].title === "Cast" &&
    board.levels[0].prompt === "List the cast." &&
    !hasText(board[UI], "Save level")
  );

  // --- A pin the options on show do not include -----------------------------

  const assert_pin_aside = assert(() =>
    hasText(board[UI], "📌 Pinned") &&
    hasText(board[UI], "Couldn't generate options")
  );
  const assert_unpinned = assert(() =>
    recordAt(board.spindles, "0")?.pinned === -1 &&
    recordAt(board.spindles, "0")?.pinnedText === "" &&
    !hasText(board[UI], "📌 Pinned")
  );

  // --- A spindle's own instruction, and Respin ------------------------------

  const action_write_instruction = action(() =>
    typeInto(
      board[UI],
      "An extra instruction for this spindle only",
      "  Keep it short.  ",
    )
  );
  const assert_instruction_saved = assert(() =>
    recordAt(board.spindles, "0")?.extraPrompt === "Keep it short." &&
    hasText(board[UI], "Instruction: Keep it short.") &&
    hasText(board[UI], "Edit instruction") &&
    !hasText(board[UI], "Add instruction")
  );
  const assert_not_respun = assert(() =>
    recordAt(board.spindles, "0")?.respins === 0
  );
  const assert_respun = assert(() =>
    recordAt(board.spindles, "0")?.respins === 1 &&
    recordAt(board.spindles, "0")?.extraPrompt === "Keep it short."
  );

  return {
    [TESTS]: [
      { assertion: assert_named_after_title },

      { assertion: assert_no_ideas_yet },
      { press: board[UI], control: "✨ Inspire me" },
      { settle: true },
      { assertion: assert_idea_offered },
      { press: board[UI], control: IDEA_TITLE },
      { assertion: assert_idea_drafted },

      { press: board[UI], control: "+", within: "Characters" },
      { assertion: assert_raised_branch },
      { action: action_pin_second },
      { press: board[UI], control: "−", within: "Characters" },
      { assertion: assert_lowering_asks },
      { press: board[UI], control: "Remove them" },
      { assertion: assert_lowered },

      { action: action_fill_new_level },
      { press: board[UI], control: "+ Add level" },
      { assertion: assert_level_added },
      { press: board[UI], control: "Remove level" },
      { assertion: assert_empty_level_removed },
      { action: action_pin_chapter },
      { press: board[UI], control: "Remove level" },
      { assertion: assert_removing_asks },
      { press: board[UI], control: "Remove them" },
      { assertion: assert_pinned_level_removed },

      { press: board[UI], control: "Edit level" },
      { action: action_edit_level_fields },
      { press: board[UI], control: "Save level" },
      { assertion: assert_level_edited },

      { settle: true },
      { assertion: assert_pin_aside },
      { press: board[UI], control: "Unpin" },
      { assertion: assert_unpinned },

      { press: board[UI], control: "Add instruction" },
      { action: action_write_instruction },
      { press: board[UI], control: "Save instruction" },
      { assertion: assert_instruction_saved },
      { assertion: assert_not_respun },
      { press: board[UI], control: "🔄 Respin" },
      { assertion: assert_respun },
    ],
    // Every options and summary request fails, and each failure warns.
    allowConsoleWarnings: true,
    board,
  };
});
