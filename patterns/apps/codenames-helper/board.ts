/**
 * Board logic for the Codenames helper: the 5×5 grid of word cards, the
 * spymaster's key colors, which cards are out of play, and the pure steps that
 * build the LLM prompts and read their answers back. Kept free of reactive
 * code so the pattern's views, its handlers and the tests share one source.
 */

export type Team = "red" | "blue";
export type Owner = "red" | "blue" | "neutral" | "assassin" | "unassigned";
export type Mode = "setup" | "play";

export interface BoardCard {
  /** The word on the card, upper case; "" until entered. */
  word: string;
  /** The key-card color for this position. */
  owner: Owner;
  /** Guessed by a player, so out of play. */
  revealed: boolean;
}

export const SIZE = 5;
export const CARD_COUNT = 25;

export const OWNERS: readonly Owner[] = [
  "red",
  "blue",
  "neutral",
  "assassin",
  "unassigned",
];

const EMPTY_CARD: BoardCard = {
  word: "",
  owner: "unassigned",
  revealed: false,
};

const isOwner = (value: unknown): value is Owner =>
  typeof value === "string" && (OWNERS as readonly string[]).includes(value);

const normalizeWord = (word: unknown): string =>
  typeof word === "string" ? word.trim().toUpperCase() : "";

/** Exactly 25 well-formed cards, whatever was stored: an empty or short
 * record is padded with blank cards and a long one is cut. */
export const normalizeBoard = (
  stored: readonly Partial<BoardCard>[] | undefined,
): BoardCard[] =>
  Array.from({ length: CARD_COUNT }, (_, i) => {
    const card = stored?.[i];
    return card
      ? {
        word: normalizeWord(card.word),
        owner: isOwner(card.owner) ? card.owner : "unassigned",
        revealed: card.revealed === true,
      }
      : { ...EMPTY_CARD };
  });

export const emptyBoard = (): BoardCard[] => normalizeBoard([]);

const inRange = (index: number): boolean =>
  Number.isInteger(index) && index >= 0 && index < CARD_COUNT;

const withCard = (
  board: readonly Partial<BoardCard>[],
  index: number,
  patch: Partial<BoardCard>,
): BoardCard[] =>
  normalizeBoard(board).map((card, i) =>
    i === index ? { ...card, ...patch } : card
  );

export const withWord = (
  board: readonly Partial<BoardCard>[],
  index: number,
  word: string,
): BoardCard[] =>
  inRange(index)
    ? withCard(board, index, { word: normalizeWord(word) })
    : normalizeBoard(board);

export const withOwner = (
  board: readonly Partial<BoardCard>[],
  index: number,
  owner: Owner,
): BoardCard[] =>
  inRange(index) && isOwner(owner)
    ? withCard(board, index, { owner })
    : normalizeBoard(board);

/** Marks a card guessed, or puts it back in play if it was a mis-tap. */
export const withRevealToggled = (
  board: readonly Partial<BoardCard>[],
  index: number,
): BoardCard[] => {
  const cards = normalizeBoard(board);
  return inRange(index)
    ? withCard(cards, index, { revealed: !cards[index].revealed })
    : cards;
};

export const withColorsCleared = (
  board: readonly Partial<BoardCard>[],
): BoardCard[] =>
  normalizeBoard(board).map((card) => ({ ...card, owner: "unassigned" }));

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

export type OwnerCounts = Record<Owner, number>;

export const ownerCounts = (
  cards: readonly { owner: string; revealed?: boolean }[],
  onlyInPlay = false,
): OwnerCounts => {
  const counts: OwnerCounts = {
    red: 0,
    blue: 0,
    neutral: 0,
    assassin: 0,
    unassigned: 0,
  };
  cards
    .filter((card) => !(onlyInPlay && card.revealed))
    .forEach((card) => {
      if (isOwner(card.owner)) counts[card.owner]++;
    });
  return counts;
};

/** The team that goes first holds nine cards, the other eight. */
export const startingTeam = (counts: OwnerCounts): Team | null =>
  counts.red === 9 && counts.blue === 8
    ? "red"
    : counts.blue === 9 && counts.red === 8
    ? "blue"
    : null;

/** What is off about a key: a real key has 9/8 team cards, 7 neutral and one
 * assassin. Empty when the key looks right. */
export const keyIssues = (counts: OwnerCounts): string[] => [
  ...(counts.assassin === 1
    ? []
    : [`Expected exactly 1 assassin, found ${counts.assassin}`]),
  ...(startingTeam(counts) && counts.neutral === 7 ? [] : [
    `Unusual colors: ${counts.red} red, ${counts.blue} blue, ${counts.neutral} neutral (expected 9/8 team cards and 7 neutral)`,
  ]),
];

// ---------------------------------------------------------------------------
// Photo reading: the LLM looks at a photo of the board or the key card.
// ---------------------------------------------------------------------------

export interface WordReading {
  row: number;
  col: number;
  word: string;
}

export interface ColorReading {
  row: number;
  col: number;
  color: "red" | "blue" | "neutral" | "assassin";
}

export interface PhotoReading {
  kind: "board" | "keycard" | "unknown";
  words?: WordReading[];
  colors?: ColorReading[];
  notes?: string;
}

export const PHOTO_SYSTEM_PROMPT =
  `You read photos taken while playing the word game Codenames in person.

A photo shows either:
1. The board: 25 word cards in a 5×5 grid.
2. The key card: a 5×5 grid of colored squares that tells the spymaster which
   positions are red, blue, neutral (beige/tan) or the assassin (black).

Decide which it is and set kind to "board", "keycard" or "unknown".
For a board, list all 25 words with their row and col (0-4, row 0 at the top,
col 0 at the left), in upper case.
For a key card, list all 25 colors with their row and col the same way.
Use notes for anything uncertain, such as a word you could not read.`;

export const PHOTO_USER_PROMPT =
  "Read this photo: is it the board or the key card? Extract every position.";

const cellIndex = (row: unknown, col: unknown): number =>
  typeof row === "number" && typeof col === "number" &&
    Number.isInteger(row) && Number.isInteger(col) &&
    row >= 0 && row < SIZE && col >= 0 && col < SIZE
    ? row * SIZE + col
    : -1;

/** The reading laid out as a 5×5 grid, row-major: a word reading fills
 * `word`, a key reading fills `owner`. */
export const readingGrid = (
  reading: PhotoReading | undefined,
): { word: string; owner: Owner }[] => {
  const grid = Array.from(
    { length: CARD_COUNT },
    () => ({ word: "", owner: "unassigned" as Owner }),
  );
  if (reading?.kind === "board") {
    (reading.words ?? []).forEach((w) => {
      const i = cellIndex(w?.row, w?.col);
      if (i >= 0) grid[i].word = normalizeWord(w.word);
    });
  }
  if (reading?.kind === "keycard") {
    (reading.colors ?? []).forEach((c) => {
      const i = cellIndex(c?.row, c?.col);
      if (i >= 0 && isOwner(c.color)) grid[i].owner = c.color;
    });
  }
  return grid;
};

export interface ReadingCheck {
  errors: string[];
  warnings: string[];
}

/** Whether a reading is complete enough to apply. Errors block applying;
 * warnings are shown so the person can fix the board by hand afterwards. */
export const checkReading = (
  reading: PhotoReading | undefined,
): ReadingCheck => {
  if (!reading) return { errors: ["No reading yet"], warnings: [] };
  if (reading.kind === "board") {
    const grid = readingGrid(reading);
    const words = grid.map((c) => c.word).filter((w) => w !== "");
    const duplicates = [
      ...new Set(words.filter((w, i) => words.indexOf(w) !== i)),
    ];
    return {
      errors: words.length === 0 ? ["No words were read"] : [],
      warnings: [
        ...(words.length < CARD_COUNT
          ? [`${CARD_COUNT - words.length} position(s) without a word`]
          : []),
        ...(duplicates.length > 0
          ? [`Duplicate words: ${duplicates.join(", ")}`]
          : []),
      ],
    };
  }
  if (reading.kind === "keycard") {
    const counts = ownerCounts(readingGrid(reading));
    return {
      errors: counts.assassin === 1
        ? []
        : [`Expected exactly 1 assassin, found ${counts.assassin}`],
      warnings: keyIssues(counts).filter((issue) =>
        !issue.includes("assassin")
      ),
    };
  }
  return {
    errors: ["This doesn't look like the board or the key card"],
    warnings: [],
  };
};

/** The board after applying a reading: a board photo sets the words it read,
 * a key card sets the colors it read. Positions it did not read are kept. */
export const applyReading = (
  board: readonly Partial<BoardCard>[],
  reading: PhotoReading | undefined,
): BoardCard[] => {
  const grid = readingGrid(reading);
  return normalizeBoard(board).map((card, i) => ({
    ...card,
    word: grid[i].word || card.word,
    owner: grid[i].owner === "unassigned" ? card.owner : grid[i].owner,
  }));
};

// ---------------------------------------------------------------------------
// Clue suggestions
// ---------------------------------------------------------------------------

export interface ClueIdea {
  clue: string;
  number: number;
  targetWords: string[];
  reasoning: string;
}

export interface ClueSuggestions {
  clues: ClueIdea[];
}

export const CLUE_SYSTEM_PROMPT =
  `You help a Codenames spymaster think of clues while playing in person.

Rules for a clue:
1. ONE word only: no hyphens, spaces or compound words, and not a word on the
   board or a form of one.
2. It connects 2-4 of the team's words that are still in play.
3. It must not lead guessers to the opponent's words, neutral words, and above
   all never to the assassin.
Be creative with connections (categories, synonyms, phrases, culture).
Suggest 3 clues, each with its target words and a short reason.`;

const wordsOf = (
  cards: readonly BoardCard[],
  owner: Owner,
): string[] =>
  cards
    .filter((c) => c.owner === owner && !c.revealed && c.word !== "")
    .map((c) => c.word);

/** The clue request for `team`, from the cards still in play; "" when the
 * team has no words left, so no request is made. */
export const buildCluePrompt = (
  board: readonly Partial<BoardCard>[],
  team: Team,
): string => {
  const cards = normalizeBoard(board);
  const mine = wordsOf(cards, team);
  if (mine.length === 0) return "";
  const list = (words: string[]) => words.length ? words.join(", ") : "(none)";
  return [
    `Team: ${team.toUpperCase()}`,
    "",
    `MY TEAM'S WORDS (connect these): ${list(mine)}`,
    `OPPONENT'S WORDS (avoid): ${
      list(wordsOf(cards, team === "red" ? "blue" : "red"))
    }`,
    `NEUTRAL WORDS (avoid): ${list(wordsOf(cards, "neutral"))}`,
    `ASSASSIN (never hint at this): ${list(wordsOf(cards, "assassin"))}`,
  ].join("\n");
};

/** The clue request for the `round`th ask about the same board: later asks
 * want different ideas, and differ in text so they are not served from the
 * cache. */
export const withRound = (prompt: string, round: number): string =>
  prompt === "" || round <= 0
    ? prompt
    : `${prompt}\n\nAsk ${
      round + 1
    }: suggest different clues from the obvious ones.`;

/** The usable clues in an LLM answer: one-word clues with a number and at
 * least one target. Given the board and team, a target that is not one of the
 * team's words still in play is dropped (models sometimes name a word that is
 * not on the board), the number counts the targets left, and a clue that is
 * itself a board word is dropped. */
export const cluesFrom = (
  result: Partial<ClueSuggestions> | undefined,
  board?: readonly Partial<BoardCard>[],
  team?: Team,
): ClueIdea[] => {
  const cards = board && team ? normalizeBoard(board) : undefined;
  const mine = cards && team ? new Set(wordsOf(cards, team)) : undefined;
  const onBoard = new Set(cards?.map((c) => c.word).filter((w) => w !== ""));
  return (Array.isArray(result?.clues) ? result.clues : [])
    .filter((c) =>
      typeof c?.clue === "string" && c.clue.trim() !== "" &&
      !/\s/.test(c.clue.trim()) && Array.isArray(c.targetWords)
    )
    .map((c) => {
      const targets = c.targetWords.map(normalizeWord)
        .filter((w) => w !== "" && (!mine || mine.has(w)));
      return {
        clue: c.clue.trim().toUpperCase(),
        number: mine
          ? targets.length
          : typeof c.number === "number"
          ? c.number
          : targets.length,
        targetWords: targets,
        reasoning: typeof c.reasoning === "string" ? c.reasoning : "",
      };
    })
    .filter((c) => c.targetWords.length > 0 && !onBoard.has(c.clue));
};

// ---------------------------------------------------------------------------
// Text projection
// ---------------------------------------------------------------------------

const OWNER_TAG: Record<Owner, string> = {
  red: "red",
  blue: "blue",
  neutral: "neutral",
  assassin: "ASSASSIN",
  unassigned: "?",
};

/** The board as a markdown table, one cell per card: word, key color, and
 * a strike-through when guessed. */
export const boardMarkdown = (
  board: readonly Partial<BoardCard>[],
  team: Team,
  mode: Mode,
): string => {
  const cards = normalizeBoard(board);
  const left = ownerCounts(cards, true);
  const rows = Array.from({ length: SIZE }, (_, r) =>
    "| " +
    cards.slice(r * SIZE, r * SIZE + SIZE).map((c) => {
      const text = `${c.word || "—"} (${OWNER_TAG[c.owner]})`;
      return c.revealed ? `~~${text}~~` : text;
    }).join(" | ") +
    " |");
  return [
    "# Codenames board",
    "",
    `My team: ${team} · Mode: ${mode} · In play: ${left.red} red, ${left.blue} blue`,
    "",
    "| A | B | C | D | E |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
};
