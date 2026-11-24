/**
 * Story Weaver pattern tests.
 *
 * The board rules are checked as pure functions first. The pattern is then
 * driven through the core loop: start a story, get options for the first level
 * (answered by `llmMocks`), pin one, ask the next level for options, branch,
 * and change the synopsis so a pin goes stale.
 *
 * Run: deno task cf test patterns/apps/story-weaver/story-weaver.test.tsx --verbose
 */
import { action, assert, FS, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  findNodeByProp,
  hasText,
  innermostNode,
  typeInto,
} from "../../tools/test-support/vnode-helpers.ts";
import StoryWeaver, { type Level, type Spindle } from "./story-weaver.tsx";
import {
  boardPaths,
  boardView,
  buildPrompt,
  demoteHeadings,
  pinsLostByBranch,
  storyMarkdown,
  withBranch,
  withCardPin,
  withLastLevelRemoved,
  withPinned,
  withRespin,
} from "./story-logic.ts";

const SYNOPSIS = "A lighthouse keeper finds a door in the sea.";
const WIDE_SYNOPSIS = "Two sisters share one lighthouse.";

export const llmMocks = [
  {
    when: { lastMessageContains: SYNOPSIS },
    object: {
      options: [
        { content: "Mara, the keeper, fears the tide." },
        { content: "Two keepers share one lamp." },
        { content: "The sea itself narrates." },
        { content: "A child arrives by boat." },
      ],
    },
  },
  {
    when: {
      lastMessageContains:
        "Mara, the keeper, fears the tide.\n\nWrite detailed",
    },
    object: {
      options: [
        { content: "Chapter one: the door opens." },
        { content: "Chapter one: the storm." },
      ],
    },
  },
  // The wide board's own story, so the two boards never answer each other.
  {
    when: {
      lastMessageContains: `${WIDE_SYNOPSIS}\n\nName them.\n\nThis is part 1`,
    },
    object: {
      options: [{ content: "Ada keeps the lamp." }, {
        content: "Bea keeps the log.",
      }],
    },
  },
  {
    when: {
      lastMessageContains: `${WIDE_SYNOPSIS}\n\nName them.\n\nThis is part 2`,
    },
    object: {
      options: [{ content: "Cy rows out." }, { content: "Di stays home." }],
    },
  },
  {
    when: { lastMessageContains: "Cy rows out.\n\nWrite detailed" },
    object: { options: [{ content: "Cy's chapter: the crossing." }] },
  },
  {
    when: { lastMessageContains: "Ada keeps the lamp.\n\nWrite detailed" },
    object: { options: [{ content: "Ada's chapter: the lamp." }] },
  },
  {
    when: { lastMessageContains: "Summarize the above" },
    object: { summary: "A keeper who fears the tide." },
  },
  // Every other request fails, as an unanswered one did before `cf test`
  // answered every request: these steps check what the pattern does without
  // the answer.
  { error: "Not answered in this test.", repeat: true },
];

const LEVELS: Level[] = [
  { title: "Characters", prompt: "Name them.", branch: 2 },
  { title: "Chapters", prompt: "Write chapters.", branch: 1 },
];

/** An option's text renders as the `content` of a cf-markdown. */
const showsMarkdown = (ui: unknown, text: string): boolean =>
  findNodeByProp(ui, "content", text) !== undefined;

const pinned = (path: string, text: string, parent: string): Spindle =>
  withPinned([], path, 0, text, parent)[0];

export default pattern(() => {
  const levels = new Writable<Level[]>([
    { title: "Characters & Themes", prompt: "Name them.", branch: 1 },
    {
      title: "Chapters",
      prompt: "Write detailed chapter summaries.",
      branch: 1,
    },
  ]);
  const board = StoryWeaver({ levels });

  // A second board, two spindles wide at the first level, for the cards
  // that change spindle when an earlier parent is pinned.
  const wideLevels = new Writable<Level[]>([
    { title: "Characters & Themes", prompt: "Name them.", branch: 2 },
    {
      title: "Chapters",
      prompt: "Write detailed chapter summaries.",
      branch: 1,
    },
  ]);
  const wide = StoryWeaver({
    levels: wideLevels,
    synopsis: new Writable(WIDE_SYNOPSIS),
  });

  // --- Pure rules -----------------------------------------------------------

  const assert_no_board_before_synopsis = assert(() =>
    boardPaths(LEVELS, "", []).every((paths) => paths.length === 0)
  );
  const assert_branch_and_pin_shape_board = assert(() => {
    const paths = boardPaths(LEVELS, "seed", [pinned("1", "Bo", "seed")]);
    return paths[0].join() === "0,1" && paths[1].join() === "1.0";
  });
  const assert_prompt_names_part = assert(() => {
    const prompt = buildPrompt("seed", LEVELS[0], {
      extraPrompt: "Be brief.",
      respins: 2,
    }, 1);
    return prompt.startsWith("seed\n\nName them.\n\nBe brief.") &&
      prompt.includes("part 2 of 2") &&
      prompt.endsWith("[Generation attempt: 2]");
  });
  const assert_pin_twice_unpins = assert(() => {
    const once = withPinned([], "0", 1, "x", "seed");
    const twice = withPinned(once, "0", 1, "x", "seed");
    return once[0].pinned === 1 && twice[0].pinned === -1 &&
      twice[0].pinnedText === "";
  });
  const assert_respin_drops_pin = assert(() => {
    const next = withRespin([pinned("0", "x", "seed")], "0")[0];
    return next.pinned === -1 && next.respins === 1;
  });
  const assert_lower_branch_cuts_subtree = assert(() => {
    const records = [
      pinned("0", "a", "seed"),
      pinned("1", "b", "seed"),
      pinned("1.0", "c", "b"),
    ];
    const next = withBranch(LEVELS, records, 0, 1);
    const hidden = [pinned("1.0", "c", "b")];
    return pinsLostByBranch(LEVELS, "seed", records, 0, 1) === 2 &&
      pinsLostByBranch(LEVELS, "seed", hidden, 0, 1) === 0 &&
      next.levels[0].branch === 1 &&
      next.spindles.map((s) => s.path).join() === "0";
  });
  // `setBranch` is a public stream: a branch that is not a number becomes 1.
  const assert_branch_not_a_number = assert(() =>
    withBranch(LEVELS, [], 0, Number("x")).levels[0].branch === 1
  );
  const assert_stale_carries_down = assert(() => {
    const view = boardView(LEVELS, "new seed", [
      pinned("0", "a", "seed"),
      pinned("0.0", "b", "a"),
    ]);
    // The child's own parent did not change, so its card points up instead.
    return view[0].spindles[0].stale && !view[0].spindles[0].staleAbove &&
      view[1].spindles[0].stale && view[1].spindles[0].staleAbove;
  });
  const assert_remove_level_drops_its_spindles = assert(() => {
    const next = withLastLevelRemoved(LEVELS, [
      pinned("0", "a", "seed"),
      pinned("0.0", "b", "a"),
    ]);
    return next.levels.length === 1 && next.spindles.length === 1;
  });
  const assert_story_markdown_lists_pins = assert(() => {
    const md = storyMarkdown("T", LEVELS, "seed", [pinned("1", "Bo", "seed")]);
    return md.includes("## Characters") &&
      md.includes("### Characters · 2 of 2\n\nBo") &&
      !md.includes("## Chapters");
  });

  const assert_story_markdown_nests_headings = assert(() => {
    const md = storyMarkdown("T", LEVELS, "seed", [
      pinned("1", "# Bo\n\n```\n# not a heading\n```", "seed"),
    ]);
    return md.includes("### Characters · 2 of 2\n\n#### Bo") &&
      md.includes("\n# not a heading\n") &&
      demoteHeadings("##### Deep", 3) === "###### Deep";
  });

  const assert_click_must_match_current_request_and_pin = assert(() => {
    const prompt = boardView(LEVELS, "sea", [])[0].spindles[0].activePrompt;
    const click = { path: "0", prompt, option: 0, text: "Bea", unpin: false };
    const chosen = withCardPin(LEVELS, "sea", [], click);
    if (chosen?.[0]?.pinnedText !== "Bea") return false;
    const unpin = { ...click, unpin: true };
    return withCardPin(LEVELS, "land", [], click) === undefined &&
      withCardPin(LEVELS, "sea", [], { ...click, path: "1" }) === undefined &&
      withCardPin(LEVELS, "sea", chosen, click) === undefined &&
      withCardPin(LEVELS, "sea", [], unpin) === undefined &&
      withCardPin(LEVELS, "sea", chosen, unpin)?.[0]?.pinnedText === "";
  });

  // --- Through the pattern --------------------------------------------------

  const assert_starts_empty = assert(() =>
    board.title === "My Story Weaver" &&
    board.synopsis === "" &&
    board.board.every((paths) => paths.length === 0) &&
    hasText(board[UI], "Start the story to generate options here.")
  );

  const action_write_synopsis = action(() =>
    typeInto(
      board[UI],
      "Enter your story synopsis or seed idea...",
      SYNOPSIS,
    )
  );
  const action_start = action(() => clickButton(board[UI], "Start story →"));
  const assert_started = assert(() =>
    board.synopsis === SYNOPSIS &&
    board.board[0].join() === "0" &&
    board.board[1].length === 0
  );

  // The first level's options arrive from the mock; pin the first one.
  const assert_options_shown = assert(() =>
    showsMarkdown(board[UI], "Two keepers share one lamp.")
  );
  const action_pin_first = action(() => clickButton(board[UI], "📌 Pin"));
  const assert_pinned_opens_next_level = assert(() =>
    board.spindles.some((s) =>
      s.path === "0" && s.pinnedText === "Mara, the keeper, fears the tide."
    ) &&
    board.board[1].join() === "0.0" &&
    hasText(board[UI], "Ready to generate options")
  );
  const assert_summary_shown = assert(() =>
    hasText(board[UI], "A keeper who fears the tide.")
  );

  // The next level waits for a click, then shows its options.
  const action_generate = action(() =>
    clickButton(board[UI], "Generate options")
  );
  const assert_next_level_options = assert(() =>
    showsMarkdown(board[UI], "Chapter one: the storm.")
  );
  const action_pin_chapter = action(() =>
    board.pin.send({
      path: "0.0",
      option: 1,
      text: "Chapter one: the storm.",
    })
  );

  // Three chapters per character: siblings appear, unasked.
  const action_branch_chapters = action(() =>
    board.setBranch.send({ level: 1, branch: 3 })
  );
  const assert_branched = assert(() =>
    board.board[1].join() === "0.0,0.1,0.2" &&
    hasText(board[UI], "Chapters · 3 of 3")
  );

  // Changing the synopsis marks the first level's pin stale.
  const action_new_synopsis = action(() => {
    typeInto(
      board[UI],
      "Enter your story synopsis or seed idea...",
      "A diver finds a lighthouse on the seabed.",
    );
    clickButton(board[UI], "Update synopsis");
  });
  const assert_stale = assert(() =>
    board.synopsis === "A diver finds a lighthouse on the seabed." &&
    hasText(board[UI], "Stale: the text above changed") &&
    hasText(board[UI], "📌 Pinned")
  );

  const assert_fs_projection = assert(() =>
    board[FS].content.includes("# My Story Weaver") &&
    board[FS].content.includes("## Characters & Themes") &&
    board[FS].content.includes("Chapter one: the storm.")
  );

  // Adding and removing a level.
  const action_add_level = action(() =>
    board.addLevel.send({ title: "", prompt: "" })
  );
  const assert_level_added = assert(() =>
    board.levels.length === 3 && board.levels[2].title === "Scenes"
  );
  const action_remove_level = action(() => board.removeLastLevel.send());
  const assert_level_removed = assert(() => board.levels.length === 2);

  // Pinning "0" inserts Ada's card at the position where Cy's card was.
  // Cy's request must stay on Cy's card while Ada's request arrives.
  const action_wide_open_second = action(() => {
    wide.pin.send({
      path: "1",
      option: 0,
      text: "Cy rows out.",
    });
    wide.generate.send({ path: "1.0" });
    wide.generate.send({ path: "0.0" });
  });
  const assert_wide_second_child = assert(() =>
    wide.board[1].join() === "1.0" &&
    showsMarkdown(wide[UI], "Cy's chapter: the crossing.")
  );
  const action_wide_pin_first = action(() =>
    wide.pin.send({
      path: "0",
      option: 0,
      text: "Ada keeps the lamp.",
    })
  );
  const assert_wide_no_borrowed_options = assert(() => {
    const adaCard = innermostNode(
      wide[UI],
      (node) =>
        hasText(node, "from “Ada keeps the lamp.”") &&
        hasText(node, "View prompt"),
    );
    return wide.board[1].join() === "0.0,1.0" && adaCard !== undefined &&
      !showsMarkdown(adaCard, "Cy's chapter: the crossing.");
  });
  const assert_wide_both_children = assert(() =>
    showsMarkdown(wide[UI], "Ada's chapter: the lamp.") &&
    showsMarkdown(wide[UI], "Cy's chapter: the crossing.")
  );

  // A client can still hold the rendered Pin button when the level's
  // instruction changes. Dispatch that click against the revised board.
  const action_click_superseded_pin = action(() => {
    clickButton(wide[UI], "📌 Pin");
    wideLevels.key(0).key("prompt").set("Name different characters.");
  });
  const assert_superseded_answer_not_pinned = assert(() =>
    wide.levels[0].prompt === "Name different characters." &&
    wide.spindles.find((s) => s.path === "0")?.pinnedText ===
      "Ada keeps the lamp." &&
    wide.spindles.find((s) => s.path === "1")?.pinnedText === "Cy rows out."
  );

  return {
    [TESTS]: [
      { assertion: assert_no_board_before_synopsis },
      { assertion: assert_branch_and_pin_shape_board },
      { assertion: assert_prompt_names_part },
      { assertion: assert_pin_twice_unpins },
      { assertion: assert_respin_drops_pin },
      { assertion: assert_lower_branch_cuts_subtree },
      { assertion: assert_branch_not_a_number },
      { assertion: assert_stale_carries_down },
      { assertion: assert_remove_level_drops_its_spindles },
      { assertion: assert_story_markdown_lists_pins },
      { assertion: assert_story_markdown_nests_headings },
      { assertion: assert_click_must_match_current_request_and_pin },
      { assertion: assert_starts_empty },
      { action: action_write_synopsis },
      { action: action_start },
      { assertion: assert_started },
      { settle: true },
      { assertion: assert_options_shown },
      { action: action_pin_first },
      { assertion: assert_pinned_opens_next_level },
      { settle: true },
      { assertion: assert_summary_shown },
      { action: action_generate },
      { settle: true },
      { assertion: assert_next_level_options },
      { action: action_pin_chapter },
      { action: action_branch_chapters },
      { assertion: assert_branched },
      { action: action_new_synopsis },
      { assertion: assert_stale },
      { assertion: assert_fs_projection },
      { action: action_add_level },
      { assertion: assert_level_added },
      { action: action_remove_level },
      { assertion: assert_level_removed },
      { settle: true },
      { action: action_wide_open_second },
      { settle: true },
      { assertion: assert_wide_second_child },
      { action: action_wide_pin_first },
      { assertion: assert_wide_no_borrowed_options },
      { settle: true },
      { assertion: assert_wide_both_children },
      { action: action_click_superseded_pin },
      { assertion: assert_superseded_answer_not_pinned },
    ],
    allowConsoleWarnings: true,
    board,
    wide,
  };
});
