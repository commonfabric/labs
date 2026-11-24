/**
 * Codenames Helper tests.
 *
 * Mock model answers drive the photo and clue controls. The board rules are
 * also tested as pure functions and through the pattern's streams.
 *
 * Run: deno task cf test patterns/apps/codenames-helper/codenames-helper.test.tsx --verbose
 */
import { action, assert, FS, pattern, TESTS, UI, Writable } from "commonfabric";
import {
  clickButton,
  findElement,
  findNodeByProp,
  fireEvent,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import {
  applyReading,
  type BoardCard,
  buildCluePrompt,
  checkReading,
  cluesFrom,
  keyIssues,
  normalizeBoard,
  ownerCounts,
  type PhotoReading,
  withRevealToggled,
  withRound,
  withWord,
} from "./board.ts";
import CodenamesHelper, { type Mode, type Team } from "./codenames-helper.tsx";

const WORDS = Array.from({ length: 25 }, (_, i) => `WORD${i + 1}`);

const boardReading: PhotoReading = {
  kind: "board",
  words: WORDS.map((word, i) => ({
    row: Math.floor(i / 5),
    col: i % 5,
    word: word.toLowerCase(),
  })),
};

// 9 red, 8 blue, 7 neutral, 1 assassin, row-major.
const KEY: ("red" | "blue" | "neutral" | "assassin")[] = [
  ...Array(9).fill("red"),
  ...Array(8).fill("blue"),
  ...Array(7).fill("neutral"),
  "assassin",
];

const keyReading: PhotoReading = {
  kind: "keycard",
  colors: KEY.map((color, i) => ({
    row: Math.floor(i / 5),
    col: i % 5,
    color,
  })),
};

// The model requests the steps below make, answered so the test never
// reaches a model (CI blocks live calls).
export const llmMocks = [
  {
    when: { lastMessageContains: "Team: RED" },
    object: {
      clues: [{
        clue: "ocean",
        number: 2,
        targetWords: ["WORD2", "WORD3"],
        reasoning: "both are at sea",
      }],
    },
  },
  {
    when: { lastMessageContains: "Team: BLUE" },
    object: {
      clues: [{
        clue: "forest",
        number: 2,
        targetWords: ["WORD10", "WORD11"],
        reasoning: "both grow there",
      }],
    },
  },
  // A request re-sent when the board changes under an open request.
  { when: { lastMessageContains: "Team:" }, object: { clues: [] } },
  // The placeholder photo the steps add is read once.
  {
    when: { lastMessageContains: "Read this photo" },
    object: { kind: "unknown", notes: "test photo" },
  },
];

export default pattern(() => {
  const board = new Writable<BoardCard[]>([]);
  const myTeam = new Writable<Team>("red");
  const mode = new Writable<Mode>("setup");
  const helper = CodenamesHelper({ board, myTeam, mode });

  // --- Pure rules -----------------------------------------------------------

  const assert_normalize_pads_to_25 = assert(() => {
    const cards = normalizeBoard([{ word: " cat ", owner: "red" }]);
    return cards.length === 25 && cards[0].word === "CAT" &&
      cards[0].owner === "red" && cards[24].owner === "unassigned";
  });
  const assert_bad_owner_is_unassigned = assert(() =>
    normalizeBoard([{ word: "x", owner: "purple" as never }])[0].owner ===
      "unassigned"
  );
  const assert_out_of_range_word_ignored = assert(() =>
    withWord([], 25, "nope").every((c) => c.word === "")
  );
  const assert_reveal_toggles_back = assert(() => {
    const once = withRevealToggled([], 3);
    return once[3].revealed && !withRevealToggled(once, 3)[3].revealed;
  });
  const assert_real_key_has_no_issues = assert(() =>
    keyIssues(ownerCounts(KEY.map((owner) => ({ owner })))).length === 0
  );
  const assert_two_assassins_flagged = assert(() =>
    keyIssues(
      ownerCounts([...KEY.slice(0, 24), "assassin", "assassin"].map((o) => ({
        owner: o,
      }))),
    ).some((issue) => issue.includes("assassin"))
  );
  const assert_board_reading_checks_clean = assert(() => {
    const check = checkReading(boardReading);
    return check.errors.length === 0 && check.warnings.length === 0;
  });
  const assert_partial_board_reading_warns = assert(() => {
    const check = checkReading({
      kind: "board",
      words: [{ row: 0, col: 0, word: "A" }, { row: 0, col: 1, word: "a" }],
    });
    return check.errors.length === 0 &&
      check.warnings.some((w) => w.includes("23 position")) &&
      check.warnings.some((w) => w.includes("Duplicate words: A"));
  });
  const assert_keycard_without_assassin_blocks = assert(() =>
    checkReading({
      kind: "keycard",
      colors: [{ row: 0, col: 0, color: "red" }],
    }).errors.length === 1
  );
  const assert_unknown_photo_blocks = assert(() =>
    checkReading({ kind: "unknown" }).errors.length === 1
  );
  const assert_reading_ignores_off_grid = assert(() =>
    applyReading([], {
      kind: "board",
      words: [{ row: 5, col: 0, word: "OFF" }, { row: 4, col: 4, word: "on" }],
    }).map((c) => c.word).join("") === "ON"
  );
  const assert_clue_prompt_skips_revealed = assert(() => {
    const cards = applyReading(applyReading([], boardReading), keyReading);
    const prompt = buildCluePrompt(withRevealToggled(cards, 0), "red");
    return !prompt.includes("WORD1,") && prompt.includes("WORD2") &&
      prompt.includes("ASSASSIN (never hint at this): WORD25");
  });
  const assert_clue_prompt_empty_without_words = assert(() =>
    buildCluePrompt([], "blue") === ""
  );
  const assert_clues_filtered = assert(() => {
    const clues = cluesFrom({
      clues: [
        {
          clue: "ocean",
          number: 2,
          targetWords: ["wave", "ship"],
          reasoning: "",
        },
        { clue: "two words", number: 2, targetWords: ["a"], reasoning: "" },
        { clue: "empty", number: 1, targetWords: [], reasoning: "" },
      ],
    });
    return clues.length === 1 && clues[0].clue === "OCEAN" &&
      clues[0].targetWords[1] === "SHIP";
  });
  const assert_round_varies_prompt = assert(() =>
    withRound("P", 0) === "P" && withRound("", 3) === "" &&
    withRound("P", 1).startsWith("P\n\nAsk 2") &&
    withRound("P", 1) !== withRound("P", 2)
  );
  const assert_clues_keep_only_team_targets = assert(() => {
    // A model named a word not on the board (JOBS) and suggested a board word
    // as a clue; only the team's in-play words count as targets.
    const board = normalizeBoard([
      { word: "apple", owner: "red" },
      { word: "bank", owner: "red", revealed: true },
      { word: "berlin", owner: "blue" },
    ]);
    const clues = cluesFrom(
      {
        clues: [
          {
            clue: "steve",
            number: 2,
            targetWords: ["jobs", "apple", "bank"],
            reasoning: "",
          },
          { clue: "wall", number: 1, targetWords: ["berlin"], reasoning: "" },
          { clue: "berlin", number: 1, targetWords: ["apple"], reasoning: "" },
        ],
      },
      board,
      "red",
    );
    return clues.length === 1 && clues[0].clue === "STEVE" &&
      clues[0].number === 1 && clues[0].targetWords.join() === "APPLE";
  });
  const assert_clues_from_nothing = assert(() =>
    cluesFrom(undefined).length === 0
  );

  // --- Through the pattern --------------------------------------------------

  const assert_starts_blank = assert(() =>
    helper.board.length === 25 &&
    helper.board.every((c) => c.word === "" && c.owner === "unassigned") &&
    helper.mode === "setup" &&
    helper.selectedIndex === -1
  );

  // Type a word, then color it: tap the card, pick a color.
  const action_type_word = action(() =>
    helper.setWord.send({ index: 0, word: "apple" })
  );
  // Focusing a card's word input selects the card, as Tab does for a
  // keyboard user.
  const action_select_first = action(() =>
    fireEvent(
      findNodeByProp(helper[UI], "placeholder", "1"),
      "oncf-focus",
      {},
      "the first card's word input",
    )
  );
  const assert_first_selected = assert(() =>
    helper.board[0].word === "APPLE" && helper.selectedIndex === 0
  );
  const action_click_red = action(() => clickButton(helper[UI], "Red"));
  const assert_first_colored = assert(() =>
    helper.board[0].owner === "red" && helper.selectedIndex === -1
  );
  const action_color_without_selection = action(() =>
    helper.assignOwner.send({ owner: "blue" })
  );
  const assert_no_selection_no_change = assert(() =>
    helper.board.filter((c) => c.owner === "blue").length === 0
  );

  // Photos: apply a board reading and a key reading.
  const action_apply_board_photo = action(() =>
    helper.applyPhotoReading.send({ reading: boardReading })
  );
  const action_apply_key_photo = action(() =>
    helper.applyPhotoReading.send({ reading: keyReading })
  );
  const assert_photos_applied = assert(() =>
    helper.board[0].word === "WORD1" &&
    helper.board[24].word === "WORD25" &&
    helper.board[24].owner === "assassin" &&
    helper.keyWarnings.length === 0 &&
    helper.inPlay.red === 9 && helper.inPlay.blue === 8
  );
  const action_apply_bad_reading = action(() =>
    helper.applyPhotoReading.send({ reading: { kind: "unknown" } })
  );
  const assert_bad_reading_ignored = assert(() =>
    helper.board[0].word === "WORD1"
  );

  // A photo upload shows a reading card; Discard hides it. The image has no
  // `timestamp`: a live cf-image-input upload reaches the handler without one.
  const action_upload_photo = action(() =>
    fireEvent(findElement(helper[UI], "cf-image-input"), "oncf-change", {
      detail: {
        images: [{
          id: "photo-1",
          name: "board.jpg",
          url: "",
          data: "data:image/png;base64,AAAA",
          size: 4,
          type: "image/png",
        }],
      },
    })
  );
  const assert_photo_card_shown = assert(() =>
    hasText(helper[UI], "Discard") && hasText(helper[UI], "hoto 1")
  );
  const action_click_unusable_photo = action(() =>
    clickButton(helper[UI], "Apply to board")
  );
  const assert_photo_not_applied = assert(() =>
    helper.board[0].word === "WORD1" && hasText(helper[UI], "Discard") &&
    !hasText(helper[UI], "applied to the board")
  );
  const action_discard_photo = action(() => clickButton(helper[UI], "Discard"));
  const assert_photo_hidden = assert(() => !hasText(helper[UI], "Discard"));

  // Clear colors keeps the words.
  const action_clear_colors = action(() =>
    clickButton(helper[UI], "Clear colors")
  );
  const assert_colors_cleared = assert(() =>
    helper.board.every((c) => c.owner === "unassigned") &&
    helper.board[3].word === "WORD4"
  );
  const action_reapply_key = action(() =>
    helper.applyPhotoReading.send({ reading: keyReading })
  );

  // Play: taps mark cards guessed and can be undone.
  const action_start_play = action(() =>
    clickButton(helper[UI], "Start playing")
  );
  const action_reveal_two = action(() => {
    helper.tapCard.send({ index: 0 });
    helper.tapCard.send({ index: 9 });
  });
  const assert_revealed = assert(() =>
    helper.mode === "play" &&
    helper.board[0].revealed && helper.board[9].revealed &&
    helper.inPlay.red === 8 && helper.inPlay.blue === 7 &&
    helper.selectedIndex === -1
  );
  // A played card is a button: clicking (or Enter on) it toggles the reveal.
  const action_undo_reveal = action(() => clickButton(helper[UI], "WORD10"));
  const assert_undone = assert(() =>
    !helper.board[9].revealed && helper.inPlay.blue === 8
  );

  // Clue ideas are requested on demand, for the remaining words.
  const assert_no_request_yet = assert(() => helper.clueRequest === "");
  const action_request_clues = action(() =>
    clickButton(helper[UI], "Suggest clues")
  );
  const assert_request_made = assert(() =>
    helper.clueRequest.startsWith("Team: RED") &&
    !helper.clueRequest.includes("WORD1,") &&
    helper.clueRequest.includes("WORD2")
  );
  const assert_red_clue_shown = assert(() =>
    hasText(helper[UI], "OCEAN") && hasText(helper[UI], "WORD2, WORD3")
  );
  const action_switch_team = action(() => myTeam.set("blue"));
  const action_request_again = action(() => helper.requestClues.send());
  const assert_blue_request = assert(() =>
    helper.clueRequest.startsWith("Team: BLUE") &&
    hasText(helper[UI], "FOREST") && !hasText(helper[UI], "OCEAN")
  );

  const assert_fs_projection = assert(() =>
    helper[FS].content.includes("~~WORD1 (red)~~") &&
    helper[FS].content.includes("WORD25 (ASSASSIN)") &&
    helper[FS].content.includes("In play: 8 red, 8 blue")
  );

  // New board wipes everything and returns to setup.
  const action_new_board = action(() => clickButton(helper[UI], "New board"));
  const assert_reset = assert(() =>
    helper.mode === "setup" &&
    helper.clueRequest === "" &&
    helper.board.every((c) =>
      c.word === "" && c.owner === "unassigned" && !c.revealed
    )
  );

  return {
    // With server execution off (as in CI), wiring the per-user `myTeam`
    // input logs the runtime's scoped-link WARN (data-updating.ts, "Storing a
    // user-scoped link…", pending review per #4561). Model calls are mocked
    // above, so no other warning is expected.
    allowConsoleWarnings: true,
    [TESTS]: [
      { assertion: assert_normalize_pads_to_25 },
      { assertion: assert_bad_owner_is_unassigned },
      { assertion: assert_out_of_range_word_ignored },
      { assertion: assert_reveal_toggles_back },
      { assertion: assert_real_key_has_no_issues },
      { assertion: assert_two_assassins_flagged },
      { assertion: assert_board_reading_checks_clean },
      { assertion: assert_partial_board_reading_warns },
      { assertion: assert_keycard_without_assassin_blocks },
      { assertion: assert_unknown_photo_blocks },
      { assertion: assert_reading_ignores_off_grid },
      { assertion: assert_clue_prompt_skips_revealed },
      { assertion: assert_clue_prompt_empty_without_words },
      { assertion: assert_clues_filtered },
      { assertion: assert_clues_keep_only_team_targets },
      { assertion: assert_clues_from_nothing },
      { assertion: assert_round_varies_prompt },
      { assertion: assert_starts_blank },
      { action: action_type_word },
      { action: action_select_first },
      { assertion: assert_first_selected },
      { action: action_click_red },
      { assertion: assert_first_colored },
      { action: action_color_without_selection },
      { assertion: assert_no_selection_no_change },
      { action: action_apply_board_photo },
      { action: action_apply_key_photo },
      { assertion: assert_photos_applied },
      { action: action_apply_bad_reading },
      { assertion: assert_bad_reading_ignored },
      { action: action_upload_photo },
      { assertion: assert_photo_card_shown },
      { action: action_click_unusable_photo },
      { assertion: assert_photo_not_applied },
      { action: action_discard_photo },
      { assertion: assert_photo_hidden },
      { action: action_clear_colors },
      { assertion: assert_colors_cleared },
      { action: action_reapply_key },
      { action: action_start_play },
      { action: action_reveal_two },
      { assertion: assert_revealed },
      { action: action_undo_reveal },
      { assertion: assert_undone },
      { assertion: assert_no_request_yet },
      { action: action_request_clues },
      { assertion: assert_request_made },
      { settle: true },
      { assertion: assert_red_clue_shown },
      { action: action_switch_team },
      { action: action_request_again },
      { settle: true },
      { assertion: assert_blue_request },
      { assertion: assert_fs_projection },
      { action: action_new_board },
      { assertion: assert_reset },
    ],
    helper,
  };
});
