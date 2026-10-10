/**
 * Word search generation: lay a list of words into a letter grid along a chosen
 * set of directions, then fill the rest with random letters.
 *
 * Every hidden word can be found exactly once. The filler alone would spell a
 * short word again in about a third of puzzles, and an answer key that marks
 * one of two copies is wrong, so both placement and fill refuse any letter that
 * would complete a second run of a word. A run is identified by the cells it
 * covers, so a palindrome read both ways is one run, and a word spelled inside
 * another ("CAT" in "CATALOG") is found there rather than hidden twice.
 *
 * Generation is a pure function of its options. Randomness comes from a seeded
 * generator rather than `Math.random()`, for two reasons: a pattern recomputes
 * reactively, and an unseeded puzzle would reshuffle under the reader on every
 * recompute; and a printed puzzle has to agree with its own answer key. A new
 * puzzle is a new seed.
 */

/** A step through the grid: one row and one column delta, each -1, 0 or 1. */
export interface Direction {
  dRow: number;
  dCol: number;
}

/**
 * Which ways words may run. The two switches are independent and each doubles
 * the set, so every combination is meaningful and none is empty:
 *
 * | diagonals | backwards | directions                      |
 * | --------- | --------- | ------------------------------- |
 * | no        | no        | → ↓                             |
 * | yes       | no        | → ↓ ↘ ↗                         |
 * | no        | yes       | → ↓ ← ↑                         |
 * | yes       | yes       | all eight                       |
 *
 * "Forwards" means a word reads left to right, or top to bottom when it is
 * vertical; `backwards` adds the reverse of every forward direction.
 */
export interface DirectionOptions {
  diagonals: boolean;
  backwards: boolean;
}

export interface WordSearchOptions extends DirectionOptions {
  /** Words to hide, as written. Repeats (after normalizing) are merged. */
  words: readonly string[];
  rows: number;
  cols: number;
  /** Any integer; the same seed and options give the same puzzle. */
  seed: number;
}

/** Where one word sits: its first letter's cell and the direction it runs. */
export interface Placement extends Direction {
  /** The letters in the grid, from `normalizeWord`. */
  word: string;
  /** The word as it was written, for the list a solver reads. */
  label: string;
  row: number;
  col: number;
}

/** A word left out of the puzzle, and why. */
export interface Skipped {
  label: string;
  /**
   * `too-short`: fewer than `MIN_WORD_LENGTH` letters A–Z after normalizing.
   * `no-room`: no run of the grid could take it without repeating a word.
   */
  reason: "too-short" | "no-room";
}

export interface WordSearch {
  rows: number;
  cols: number;
  /** One string of `cols` letters per row. */
  grid: string[];
  placements: Placement[];
  skipped: Skipped[];
}

export const MIN_SIZE = 4;
export const MAX_SIZE = 30;
/** A one-letter word would be found in every cell that holds its letter. */
export const MIN_WORD_LENGTH = 2;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The directions `options` allows, forwards first. */
export const directionsFor = (options: DirectionOptions): Direction[] => {
  const forwards: Direction[] = [
    { dRow: 0, dCol: 1 },
    { dRow: 1, dCol: 0 },
    ...(options.diagonals ? [{ dRow: 1, dCol: 1 }, { dRow: -1, dCol: 1 }] : []),
  ];
  return options.backwards
    ? [...forwards, ...forwards.map((d) => ({ dRow: -d.dRow, dCol: -d.dCol }))]
    : forwards;
};

/** `text` with combining accents removed: "Café" becomes "Cafe". */
export const stripAccents = (text: string): string =>
  text.normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * The letters of `word` as they go in the grid: accents dropped, upper case,
 * and anything that is not A–Z removed, so "Café au lait" becomes "CAFEAULAIT".
 */
export const normalizeWord = (word: string): string =>
  stripAccents(word).toUpperCase().replace(/[^A-Z]/g, "");

/**
 * Split free text into words: one per line or comma-separated item, so a
 * phrase on its own line stays one entry.
 */
export const parseWordList = (text: string): string[] =>
  text.split(/[\n,]/).map((w) => w.trim()).filter((w) => w !== "");

/** mulberry32: a small, well-mixed 32-bit generator. Returns [0, 1). */
const seededRandom = (seed: number): () => number => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** `items` in an order drawn from `random` (Fisher–Yates). */
const shuffled = <T>(items: readonly T[], random: () => number): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const checkSize = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < MIN_SIZE || value > MAX_SIZE) {
    throw new RangeError(
      `${name} must be an integer from ${MIN_SIZE} to ${MAX_SIZE}, got ${value}`,
    );
  }
};

/** A grid being built: `null` marks a cell nothing has been written to. */
interface Board {
  rows: number;
  cols: number;
  cells: (string | null)[];
  directions: Direction[];
}

/** The cells `word` would cover from (row, col) along `d`, or null if it runs off the grid. */
const runCells = (
  board: Board,
  word: string,
  row: number,
  col: number,
  d: Direction,
): number[] | null => {
  const endRow = row + d.dRow * (word.length - 1);
  const endCol = col + d.dCol * (word.length - 1);
  // Both ends on the grid: a start off it would wrap into another row.
  const onGrid = (r: number, c: number) =>
    r >= 0 && r < board.rows && c >= 0 && c < board.cols;
  if (!onGrid(row, col) || !onGrid(endRow, endCol)) return null;
  return Array.from(
    { length: word.length },
    (_, i) => (row + d.dRow * i) * board.cols + col + d.dCol * i,
  );
};

const spells = (board: Board, word: string, cells: number[]): boolean =>
  cells.every((cell, i) => board.cells[cell] === word[i]);

/** A run's identity: the cells it covers, in either reading order. */
const runKey = (cells: number[]): string =>
  [...cells].sort((a, b) => a - b).join(",");

/**
 * Every run of `word` the board already spells, one per set of cells, so a
 * palindrome read both ways is one run. `through`, when given, limits the
 * search to runs that cover that cell.
 */
const runsOf = (
  board: Board,
  word: string,
  through?: number,
): Map<string, Omit<Placement, "word" | "label">> => {
  const runs = new Map<string, Omit<Placement, "word" | "label">>();
  const starts = through === undefined
    ? board.cells.map((_, cell) => ({ cell, offsets: [0] }))
    : [{
      cell: through,
      offsets: [...word].flatMap((letter, i) =>
        letter === board.cells[through] ? [i] : []
      ),
    }];
  for (const { cell, offsets } of starts) {
    for (const d of board.directions) {
      for (const offset of offsets) {
        const row = Math.floor(cell / board.cols) - d.dRow * offset;
        const col = (cell % board.cols) - d.dCol * offset;
        const cells = runCells(board, word, row, col, d);
        if (cells === null || !spells(board, word, cells)) continue;
        const key = runKey(cells);
        if (!runs.has(key)) runs.set(key, { row, col, ...d });
      }
    }
  }
  return runs;
};

export const generateWordSearch = (options: WordSearchOptions): WordSearch => {
  const { rows, cols } = options;
  checkSize("rows", rows);
  checkSize("cols", cols);
  const random = seededRandom(options.seed);
  const board: Board = {
    rows,
    cols,
    cells: new Array(rows * cols).fill(null),
    directions: directionsFor(options),
  };

  // The first spelling of each word names it; later repeats merge into it.
  const entries = new Map<string, string>();
  const skipped: Skipped[] = [];
  for (const raw of options.words) {
    const label = raw.trim();
    const word = normalizeWord(label);
    if (word.length < MIN_WORD_LENGTH) {
      skipped.push({ label, reason: "too-short" });
    } else if (!entries.has(word)) {
      entries.set(word, label);
    }
  }
  // Longest first: long words have the fewest places to go, so they get the
  // emptiest grid, and a short word spelled inside a long one is found there.
  // Ties break alphabetically so the order is deterministic.
  const words = [...entries.keys()].sort((a, b) =>
    b.length - a.length || (a < b ? -1 : a > b ? 1 : 0)
  );
  // Letters just written to `cells` repeat no word. A run through one of
  // them is new, since every earlier run lay wholly on earlier letters, so it
  // is allowed only inside `own`, the cells of the word being placed: that
  // word's own run, or a shorter word it spells ("CAT" in "CATALOG"), and then
  // only if it is that word's one run on the whole board.
  const repeatsNothing = (cells: number[], own: number[] = []) => {
    const ownKey = runKey(own);
    return cells.every((cell) =>
      words.every((w) =>
        [...runsOf(board, w, cell).keys()].every((key) =>
          key === ownKey ||
          (key.split(",").every((c) => own.includes(Number(c))) &&
            runsOf(board, w).size === 1)
        )
      )
    );
  };

  const placements: Placement[] = [];
  for (const word of words) {
    const label = entries.get(word)!;
    const [existing] = runsOf(board, word).values();
    if (existing) {
      placements.push({ word, label, ...existing });
      continue;
    }
    // Try every legal run in a seeded order, so a word that fits anywhere is
    // placed: this is an exhaustive search, not a bounded number of tries.
    const candidates = board.directions.flatMap((d) =>
      board.cells.flatMap((_, cell) => {
        const row = Math.floor(cell / cols);
        const col = cell % cols;
        const cells = runCells(board, word, row, col, d);
        return cells !== null &&
            cells.every((c, i) =>
              board.cells[c] === null || board.cells[c] === word[i]
            )
          ? [{ row, col, d, cells }]
          : [];
      })
    );
    const chosen = shuffled(candidates, random).find(({ cells }) => {
      const written = cells.filter((c) => board.cells[c] === null);
      written.forEach((c) => (board.cells[c] = word[cells.indexOf(c)]));
      if (repeatsNothing(written, cells)) return true;
      written.forEach((c) => (board.cells[c] = null));
      return false;
    });
    if (chosen) {
      placements.push({
        word,
        label,
        row: chosen.row,
        col: chosen.col,
        ...chosen.d,
      });
    } else {
      skipped.push({ label, reason: "no-room" });
    }
  }

  // From here only the placed words are protected: a word skipped for want
  // of room is not hidden, so spelling it by chance repeats nothing.
  const placed = new Set(placements.map((p) => p.word));
  for (let i = words.length - 1; i >= 0; i--) {
    if (!placed.has(words[i])) words.splice(i, 1);
  }

  // Each empty cell takes the first letter, in a seeded order, that completes
  // no run of any word through it: such a run would be a second copy, since a
  // placed word's own run never covers an empty cell. Rarely, among many
  // similar words, every letter completes one. Then the letter completing the
  // fewest is used, and the words it repeats leave the puzzle as `no-room`:
  // their letters stay as filler, which is harmless once nobody looks for them.
  const dropped = new Set<string>();
  board.cells.forEach((value, cell) => {
    if (value !== null) return;
    const order = shuffled([...ALPHABET], random);
    const safe = order.find((letter) => {
      board.cells[cell] = letter;
      return repeatsNothing([cell]);
    });
    if (safe !== undefined) return;
    const least = order.map((letter) => {
      board.cells[cell] = letter;
      return {
        letter,
        repeats: words.filter((w) => runsOf(board, w, cell).size > 0),
      };
    }).reduce((a, b) => b.repeats.length < a.repeats.length ? b : a);
    board.cells[cell] = least.letter;
    for (const w of least.repeats) {
      words.splice(words.indexOf(w), 1);
      dropped.add(w);
    }
  });
  for (const word of dropped) {
    skipped.push({ label: entries.get(word)!, reason: "no-room" });
  }

  const grid = Array.from(
    { length: rows },
    (_, r) => board.cells.slice(r * cols, (r + 1) * cols).join(""),
  );
  return {
    rows,
    cols,
    grid,
    placements: placements.filter((p) => !dropped.has(p.word)),
    skipped,
  };
};

/** The cells a placement covers, as `row * cols + col` indices. */
export const placementCells = (
  placement: Placement,
  cols: number,
): number[] =>
  Array.from(
    { length: placement.word.length },
    (_, i) =>
      (placement.row + placement.dRow * i) * cols + placement.col +
      placement.dCol * i,
  );
