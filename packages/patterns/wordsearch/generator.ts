/**
 * Word search generation: lay a list of words into a letter grid along a chosen
 * set of directions, then fill the rest with random letters.
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
  /** Words to hide. Normalized by `normalizeWord`; blanks and repeats drop. */
  words: readonly string[];
  rows: number;
  cols: number;
  /** Any integer; the same seed and options give the same puzzle. */
  seed: number;
}

/** Where one word sits: its first letter's cell and the direction it runs. */
export interface Placement extends Direction {
  word: string;
  row: number;
  col: number;
}

export interface WordSearch {
  rows: number;
  cols: number;
  /** One string of `cols` letters per row. */
  grid: string[];
  placements: Placement[];
  /**
   * Words that could not be placed: longer than the grid allows in every
   * permitted direction, or crowded out by words placed before them.
   */
  unplaced: string[];
}

export const MIN_SIZE = 4;
export const MAX_SIZE = 30;

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

/**
 * The letters of `word` as they go in the grid: accents dropped, upper case,
 * and anything that is not A–Z removed, so "Café au lait" becomes "CAFEAULAIT".
 */
export const normalizeWord = (word: string): string =>
  word.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
    .replace(/[^A-Z]/g, "");

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

const checkSize = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < MIN_SIZE || value > MAX_SIZE) {
    throw new RangeError(
      `${name} must be an integer from ${MIN_SIZE} to ${MAX_SIZE}, got ${value}`,
    );
  }
};

export const generateWordSearch = (options: WordSearchOptions): WordSearch => {
  const { rows, cols } = options;
  checkSize("rows", rows);
  checkSize("cols", cols);
  const random = seededRandom(options.seed);
  const directions = directionsFor(options);

  // Longest first: long words have the fewest places to go, so they get the
  // emptiest grid. Ties break alphabetically so the order is deterministic.
  const words = [...new Set(options.words.map(normalizeWord))]
    .filter((w) => w !== "")
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));

  const cells: (string | null)[] = new Array(rows * cols).fill(null);
  const placements: Placement[] = [];
  const unplaced: string[] = [];

  for (const word of words) {
    // Every legal spot, so a word that fits anywhere is placed: this is an
    // exhaustive search, not a bounded number of random tries.
    const candidates: Placement[] = [];
    for (const { dRow, dCol } of directions) {
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const endRow = row + dRow * (word.length - 1);
          const endCol = col + dCol * (word.length - 1);
          if (endRow < 0 || endRow >= rows || endCol < 0 || endCol >= cols) {
            continue;
          }
          let fits = true;
          for (let i = 0; i < word.length && fits; i++) {
            const existing = cells[(row + dRow * i) * cols + col + dCol * i];
            fits = existing === null || existing === word[i];
          }
          if (fits) candidates.push({ word, row, col, dRow, dCol });
        }
      }
    }
    if (candidates.length === 0) {
      unplaced.push(word);
      continue;
    }
    const chosen = candidates[Math.floor(random() * candidates.length)];
    for (let i = 0; i < word.length; i++) {
      cells[
        (chosen.row + chosen.dRow * i) * cols + chosen.col + chosen.dCol * i
      ] = word[i];
    }
    placements.push(chosen);
  }

  const filled = cells.map((c) =>
    c ?? ALPHABET[Math.floor(random() * ALPHABET.length)]
  );
  const grid = Array.from(
    { length: rows },
    (_, r) => filled.slice(r * cols, (r + 1) * cols).join(""),
  );
  return { rows, cols, grid, placements, unplaced };
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
