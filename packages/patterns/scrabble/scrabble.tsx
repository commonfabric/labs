/**
 * Multiplayer Free-for-All Scrabble
 *
 * Shared board, bag, scoreboard, and event log are scoped to the space. Each
 * user's name, rack, and unsubmitted board tiles are scoped per user. The
 * viewer's name and avatar come from their shared profile
 * (`wish({ query: "#profile" })`): the wish's built-in UI lets them pick an
 * existing profile or create a new one, and joining snapshots the resolved
 * values into the shared player roster.
 */

import {
  type Cell,
  computed,
  dataFile,
  Default,
  handler,
  hasError,
  ifElse,
  NAME,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  resultOf,
  Stream,
  UI,
  wish,
  Writable,
} from "commonfabric";

export interface Letter {
  char: string;
  points: number;
  id: string;
  isBlank: boolean;
}

export interface PlacedTile {
  letter: Letter;
  row: number;
  col: number;
}

/** Live link to a player's profile cell — rendered first-class via the badge. */
export type ScrabbleProfileCell = Cell<{ name?: string; avatar?: string }>;

export interface Player {
  name: string;

  /** Avatar URL or glyph, snapshotted from the joiner's shared profile. */
  avatar?: string;

  /**
   * Live profile cell — present for profile-joined players (the scoreboard
   * renders it via `<cf-profile-badge>`), absent for headless name-only joins
   * (test seam), which fall back to `<cf-avatar>`.
   */
  profile?: ScrabbleProfileCell;
  color: string;
  score: number;
  joinedAt: number;
}

/** Outward snapshot of a player (no live profile cell — that stays internal). */
export type PlayerView = Omit<Player, "profile">;

/**
 * Shared player roster. Object-wrapped (not a bare `Writable<Player[]>`) so each
 * Player can carry a live `profile` cell: a bare array with a nested cell
 * unwraps to a weak object and breaks CTS handler-state / output typing — see
 * the profile-roster pattern + docs/common/patterns/multi-user-patterns.md.
 */
export interface PlayerRoster {
  list: Player[];
}

export interface GameEvent {
  id: string;
  type: "join" | "submit" | "word" | "system";
  player: string;
  details: string;
  timestamp: number;
}

interface TileInWord {
  char: string;
  points: number;
  row: number;
  col: number;
  isPlaced: boolean;
}

interface WordWithPositions {
  word: string;
  tiles: TileInWord[];
}

interface WordScore {
  word: string;
  score: number;
  breakdown: string;
}

interface TurnScore {
  total: number;
  wordScores: WordScore[];
  bingoBonus: boolean;
}

interface RackTileView extends Letter {
  index: number;
}

export const LETTER_POINTS: Record<string, number> = {
  A: 1,
  B: 3,
  C: 3,
  D: 2,
  E: 1,
  F: 4,
  G: 2,
  H: 4,
  I: 1,
  J: 8,
  K: 5,
  L: 1,
  M: 3,
  N: 1,
  O: 1,
  P: 3,
  Q: 10,
  R: 1,
  S: 1,
  T: 1,
  U: 1,
  V: 4,
  W: 4,
  X: 8,
  Y: 4,
  Z: 10,
  "": 0,
};

export const TILE_DISTRIBUTION: Record<string, number> = {
  A: 9,
  B: 2,
  C: 2,
  D: 4,
  E: 12,
  F: 2,
  G: 3,
  H: 2,
  I: 9,
  J: 1,
  K: 1,
  L: 4,
  M: 2,
  N: 6,
  O: 8,
  P: 2,
  Q: 1,
  R: 6,
  S: 4,
  T: 6,
  U: 4,
  V: 2,
  W: 2,
  X: 1,
  Y: 2,
  Z: 1,
  "": 2,
};

export const BOARD_SIZE = 15;
const CELL_SIZE = 32;
const CENTER = 7;
const PLAYER_COLORS = [
  "#2563eb",
  "#dc2626",
  "#059669",
  "#7c3aed",
  "#c2410c",
  "#0f766e",
];

type BonusType = "none" | "DL" | "TL" | "DW" | "TW" | "star";

const BONUS_MAP: Map<string, BonusType> = (() => {
  const map = new Map<string, BonusType>();
  map.set("7,7", "star");
  [
    [0, 0],
    [0, 7],
    [0, 14],
    [7, 0],
    [7, 14],
    [14, 0],
    [14, 7],
    [14, 14],
  ].forEach(([r, c]) => map.set(`${r},${c}`, "TW"));
  [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [1, 13],
    [2, 12],
    [3, 11],
    [4, 10],
    [13, 1],
    [12, 2],
    [11, 3],
    [10, 4],
    [13, 13],
    [12, 12],
    [11, 11],
    [10, 10],
  ].forEach(([r, c]) => map.set(`${r},${c}`, "DW"));
  [
    [1, 5],
    [1, 9],
    [5, 1],
    [5, 5],
    [5, 9],
    [5, 13],
    [9, 1],
    [9, 5],
    [9, 9],
    [9, 13],
    [13, 5],
    [13, 9],
  ].forEach(([r, c]) => map.set(`${r},${c}`, "TL"));
  [
    [0, 3],
    [0, 11],
    [2, 6],
    [2, 8],
    [3, 0],
    [3, 7],
    [3, 14],
    [6, 2],
    [6, 6],
    [6, 8],
    [6, 12],
    [7, 3],
    [7, 11],
    [8, 2],
    [8, 6],
    [8, 8],
    [8, 12],
    [11, 0],
    [11, 7],
    [11, 14],
    [12, 6],
    [12, 8],
    [14, 3],
    [14, 11],
  ].forEach(([r, c]) => map.set(`${r},${c}`, "DL"));
  return map;
})();

const BOARD_CELLS = Array.from({ length: BOARD_SIZE * BOARD_SIZE }, (_, i) => {
  const row = Math.floor(i / BOARD_SIZE);
  const col = i % BOARD_SIZE;
  return {
    row,
    col,
    bonus: BONUS_MAP.get(`${row},${col}`) ?? "none",
  };
});

const BONUS_COLORS: Record<BonusType, { bg: string; text: string }> = {
  none: { bg: "#d4c4a8", text: "#665a48" },
  DL: { bg: "#a8d4e6", text: "#075985" },
  TL: { bg: "#4a90d9", text: "#ffffff" },
  DW: { bg: "#f5b7b1", text: "#991b1b" },
  TW: { bg: "#dc2626", text: "#ffffff" },
  star: { bg: "#f5b7b1", text: "#991b1b" },
};

const BONUS_LABELS: Record<BonusType, string> = {
  none: "",
  DL: "DL",
  TL: "TL",
  DW: "DW",
  TW: "TW",
  star: "*",
};

const VALID_WORDS = new Set(
  dataFile("words.txt").split("\n").filter((word) => word.length > 0),
);

type BoardCell = Writable<PlacedTile[] | Default<[]>>;
type BagCell = Writable<Letter[] | Default<[]>>;
type BagIndexCell = Writable<number | Default<0>>;
const DEFAULT_PLAYER_ROSTER: PlayerRoster = { list: [] };
type PlayersCell = Writable<
  PlayerRoster | Default<typeof DEFAULT_PLAYER_ROSTER>
>;
type EventsCell = Writable<GameEvent[] | Default<[]>>;
type RackCell = Writable<Letter[] | Default<[]>>;
type PlacedCell = Writable<PlacedTile[] | Default<[]>>;
type NameCell = Writable<string | Default<"">>;
type MessageCell = Writable<string | Default<"">>;

export interface GameInput {
  gameName?: PerSpace<string | Default<"Scrabble Match">>;
  board?: PerSpace<BoardCell>;
  bag?: PerSpace<BagCell>;
  bagIndex?: PerSpace<BagIndexCell>;
  players?: PerSpace<PlayerRoster | Default<typeof DEFAULT_PLAYER_ROSTER>>;
  gameEvents?: PerSpace<EventsCell>;
  rack?: PerUser<RackCell>;
  placed?: PerUser<PlacedCell>;
  myName?: PerUser<NameCell>;
  message?: PerSession<MessageCell>;
}

export interface GameOutput {
  myName: string;
  board: readonly PlacedTile[];
  bag: readonly Letter[];
  bagIndex: number;
  players: readonly PlayerView[];
  gameEvents: readonly GameEvent[];
  rack: readonly Letter[];
  placed: readonly PlacedTile[];
  message: string;
  joinGame: Stream<void>;
  joinWithName: Stream<string>;
  placeTile: Stream<{ letterId: string; row: number; col: number }>;
  submitTurn: Stream<void>;
  clearBoard: Stream<void>;
  resetGame: Stream<void>;
}

export function createTileBag(): Letter[] {
  const bag: Letter[] = [];
  let tileId = Date.now();
  Object.entries(TILE_DISTRIBUTION).forEach(([letter, count]) => {
    Array.from({ length: count }).forEach(() => {
      const isBlank = letter === "";
      bag.push({
        char: isBlank ? "" : letter,
        points: isBlank ? 0 : LETTER_POINTS[letter],
        id: `tile-${tileId++}`,
        isBlank,
      });
    });
  });
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = bag[i];
    bag[i] = bag[j];
    bag[j] = tmp;
  }
  return bag;
}

export function drawTilesFromBag(
  bag: readonly Letter[],
  bagIndex: number,
  count: number,
): Letter[] {
  return bag.slice(bagIndex, bagIndex + count).map((letter) => ({
    char: letter.char,
    points: letter.points,
    id: letter.id,
    isBlank: letter.isBlank,
  }));
}

export function getRandomColor(index: number): string {
  return PLAYER_COLORS[index % PLAYER_COLORS.length];
}

export function getInitials(name: string): string {
  if (!name.trim()) return "?";
  return name.trim().split(/\s+/).map((word) => word[0]).join("").toUpperCase()
    .slice(0, 2);
}

function trimmedName(name: string | undefined): string {
  return (name ?? "").trim();
}

function buildBoardSet(tiles: readonly PlacedTile[]): Set<string> {
  return new Set(tiles.map((tile) => `${tile.row},${tile.col}`));
}

function buildTileMap(tiles: readonly PlacedTile[]): Map<string, Letter> {
  return new Map(tiles.map((tile) => [`${tile.row},${tile.col}`, tile.letter]));
}

function getWordAt(
  row: number,
  col: number,
  direction: "horizontal" | "vertical",
  placedMap: Map<string, Letter>,
  committedMap: Map<string, Letter>,
): string {
  const getLetterAt = (r: number, c: number): Letter | undefined =>
    placedMap.get(`${r},${c}`) ?? committedMap.get(`${r},${c}`);
  const dRow = direction === "vertical" ? 1 : 0;
  const dCol = direction === "horizontal" ? 1 : 0;
  let startRow = row;
  let startCol = col;
  while (
    startRow - dRow >= 0 && startCol - dCol >= 0 &&
    getLetterAt(startRow - dRow, startCol - dCol)
  ) {
    startRow -= dRow;
    startCol -= dCol;
  }

  let word = "";
  let r = startRow;
  let c = startCol;
  while (r < BOARD_SIZE && c < BOARD_SIZE) {
    const letter = getLetterAt(r, c);
    if (!letter) break;
    word += letter.char;
    r += dRow;
    c += dCol;
  }
  return word;
}

function findAllWords(
  placedTiles: readonly PlacedTile[],
  committedTiles: readonly PlacedTile[],
): string[] {
  if (placedTiles.length === 0) return [];
  const placedMap = buildTileMap(placedTiles);
  const committedMap = buildTileMap(committedTiles);
  const words = new Set<string>();
  placedTiles.forEach((tile) => {
    const horizontal = getWordAt(
      tile.row,
      tile.col,
      "horizontal",
      placedMap,
      committedMap,
    );
    const vertical = getWordAt(
      tile.row,
      tile.col,
      "vertical",
      placedMap,
      committedMap,
    );
    if (horizontal.length >= 2) words.add(horizontal);
    if (vertical.length >= 2) words.add(vertical);
  });
  return Array.from(words);
}

function isTilePartOfWord(
  row: number,
  col: number,
  placedMap: Map<string, Letter>,
  committedMap: Map<string, Letter>,
): boolean {
  return getWordAt(row, col, "horizontal", placedMap, committedMap).length >=
      2 ||
    getWordAt(row, col, "vertical", placedMap, committedMap).length >= 2;
}

function findAllWordsWithPositions(
  placedTiles: readonly PlacedTile[],
  committedTiles: readonly PlacedTile[],
): WordWithPositions[] {
  if (placedTiles.length === 0) return [];
  const placedMap = buildTileMap(placedTiles);
  const committedMap = buildTileMap(committedTiles);
  const getTileAt = (
    r: number,
    c: number,
  ): { letter: Letter; isPlaced: boolean } | undefined => {
    const placedLetter = placedMap.get(`${r},${c}`);
    if (placedLetter) return { letter: placedLetter, isPlaced: true };
    const committedLetter = committedMap.get(`${r},${c}`);
    if (committedLetter) {
      return { letter: committedLetter, isPlaced: false };
    }
    return undefined;
  };
  const getWordWithPositions = (
    startRow: number,
    startCol: number,
    direction: "horizontal" | "vertical",
  ): WordWithPositions | null => {
    const dRow = direction === "vertical" ? 1 : 0;
    const dCol = direction === "horizontal" ? 1 : 0;
    let row = startRow;
    let col = startCol;
    while (
      row - dRow >= 0 && col - dCol >= 0 &&
      getTileAt(row - dRow, col - dCol)
    ) {
      row -= dRow;
      col -= dCol;
    }

    const tiles: TileInWord[] = [];
    while (row < BOARD_SIZE && col < BOARD_SIZE) {
      const tile = getTileAt(row, col);
      if (!tile) break;
      tiles.push({
        char: tile.letter.char,
        points: tile.letter.points,
        row,
        col,
        isPlaced: tile.isPlaced,
      });
      row += dRow;
      col += dCol;
    }
    if (tiles.length < 2) return null;
    return { word: tiles.map((tile) => tile.char).join(""), tiles };
  };

  const words = new Map<string, WordWithPositions>();
  placedTiles.forEach((tile) => {
    const horizontal = getWordWithPositions(tile.row, tile.col, "horizontal");
    if (horizontal) {
      words.set(
        `H:${horizontal.tiles[0].row},${
          horizontal.tiles[0].col
        }:${horizontal.word}`,
        horizontal,
      );
    }
    const vertical = getWordWithPositions(tile.row, tile.col, "vertical");
    if (vertical) {
      words.set(
        `V:${vertical.tiles[0].row},${vertical.tiles[0].col}:${vertical.word}`,
        vertical,
      );
    }
  });
  return Array.from(words.values());
}

function isValidWord(word: string): boolean {
  return word.length >= 2 && VALID_WORDS.has(word.toUpperCase());
}

function calculateWordScore(wordData: WordWithPositions): WordScore {
  const wordMultiplier = wordData.tiles.reduce((multiplier, tile) => {
    if (!tile.isPlaced) return multiplier;
    const bonus = BONUS_MAP.get(`${tile.row},${tile.col}`) ?? "none";
    if (bonus === "DW" || bonus === "star") return multiplier * 2;
    if (bonus === "TW") return multiplier * 3;
    return multiplier;
  }, 1);
  const baseScore = wordData.tiles.reduce((sum, tile) => {
    if (!tile.isPlaced) return sum + tile.points;
    const bonus = BONUS_MAP.get(`${tile.row},${tile.col}`) ?? "none";
    if (bonus === "DL") return sum + tile.points * 2;
    if (bonus === "TL") return sum + tile.points * 3;
    return sum + tile.points;
  }, 0);
  const score = baseScore * wordMultiplier;
  return {
    word: wordData.word,
    score,
    breakdown: `${wordData.word}: ${score}`,
  };
}

function calculateTurnScore(
  placedTiles: readonly PlacedTile[],
  committedTiles: readonly PlacedTile[],
): TurnScore {
  const wordScores = findAllWordsWithPositions(placedTiles, committedTiles).map(
    calculateWordScore,
  );
  const total = wordScores.reduce((sum, word) => sum + word.score, 0);
  const bingoBonus = placedTiles.length === 7;
  return { total: total + (bingoBonus ? 50 : 0), wordScores, bingoBonus };
}

function getDraggedLetterId(sourceCell: { get?: () => unknown } | undefined) {
  const source = sourceCell?.get?.();
  if (!source || typeof source !== "object") return undefined;
  if ("id" in source && typeof source.id === "string") return source.id;
  if (
    "letter" in source && source.letter && typeof source.letter === "object" &&
    "id" in source.letter && typeof source.letter.id === "string"
  ) {
    return source.letter.id;
  }
  return undefined;
}

function returnedLetters(tiles: readonly PlacedTile[]): Letter[] {
  return tiles.map((tile) => ({
    ...tile.letter,
    char: tile.letter.isBlank ? "" : tile.letter.char,
  }));
}

function joinPlayerByName(
  nameInput: string | undefined,
  avatar: string,
  profile: ScrabbleProfileCell | undefined,
  myName: NameCell,
  rack: RackCell,
  placed: PlacedCell,
  board: BoardCell,
  bag: BagCell,
  bagIndex: BagIndexCell,
  players: PlayersCell,
  gameEvents: EventsCell,
  message: MessageCell,
): boolean {
  const name = trimmedName(nameInput);
  if (!name) {
    message.set("Set up a profile to join.");
    return false;
  }

  const currentName = trimmedName(myName.get());
  const existingPlayers = players.get().list;
  const existingPlayer = existingPlayers.find((player) => player.name === name);
  if (existingPlayer) {
    if (currentName !== name) {
      message.set(`Name ${name} is already taken.`);
      return false;
    }
    if (rack.get().length === 0) {
      const currentBag = bag.get().length ? [...bag.get()] : createTileBag();
      if (bag.get().length === 0) bag.set(currentBag);
      const currentIndex = bagIndex.get();
      const drawn = drawTilesFromBag(currentBag, currentIndex, 7);
      rack.set(drawn);
      bagIndex.set(currentIndex + drawn.length);
    }
    message.set(`Welcome back, ${name}.`);
    return true;
  }

  if (currentName && currentName !== name) {
    message.set(`You already joined as ${currentName}.`);
    return false;
  }

  const currentBag = bag.get().length ? [...bag.get()] : createTileBag();
  if (bag.get().length === 0) {
    bag.set(currentBag);
    board.set([]);
    bagIndex.set(0);
  }

  const currentIndex = bagIndex.get();
  const drawn = drawTilesFromBag(currentBag, currentIndex, 7);
  const player: Player = {
    name,
    avatar: (avatar ?? "").trim(),
    ...(profile ? { profile } : {}),
    color: getRandomColor(existingPlayers.length),
    score: 0,
    joinedAt: Date.now(),
  };
  players.key("list").set([...existingPlayers, player]);
  myName.set(name);
  rack.set(drawn);
  placed.set([]);
  bagIndex.set(currentIndex + drawn.length);
  gameEvents.set([...gameEvents.get(), {
    id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "join",
    player: name,
    details: `${name} joined`,
    timestamp: Date.now(),
  }]);
  message.set(`Joined as ${name}.`);
  return true;
}

// Join with the viewer's resolved profile. `name`/`avatar` arrive as plain
// strings (named `computed` values auto-unwrap as handler state); `profile` is
// the viewer's live profile cell, stored on the Player so the scoreboard
// renders their identity first-class.
const joinGameHandler = handler<
  void,
  {
    name: string;
    avatar: string;
    profile: ScrabbleProfileCell | undefined;
    myName: NameCell;
    rack: RackCell;
    placed: PlacedCell;
    board: BoardCell;
    bag: BagCell;
    bagIndex: BagIndexCell;
    players: PlayersCell;
    gameEvents: EventsCell;
    message: MessageCell;
  }
>((
  _event,
  {
    name,
    avatar,
    profile,
    myName,
    rack,
    placed,
    board,
    bag,
    bagIndex,
    players,
    gameEvents,
    message,
  },
) => {
  joinPlayerByName(
    name,
    avatar,
    profile,
    myName,
    rack,
    placed,
    board,
    bag,
    bagIndex,
    players,
    gameEvents,
    message,
  );
});

const joinWithNameHandler = handler<
  string,
  {
    myName: NameCell;
    rack: RackCell;
    placed: PlacedCell;
    board: BoardCell;
    bag: BagCell;
    bagIndex: BagIndexCell;
    players: PlayersCell;
    gameEvents: EventsCell;
    message: MessageCell;
  }
>((
  name,
  { myName, rack, placed, board, bag, bagIndex, players, gameEvents, message },
) => {
  joinPlayerByName(
    name,
    "",
    undefined, // headless name-only join (test seam) has no profile cell
    myName,
    rack,
    placed,
    board,
    bag,
    bagIndex,
    players,
    gameEvents,
    message,
  );
});

const resetGameHandler = handler<
  void,
  {
    board: BoardCell;
    bag: BagCell;
    bagIndex: BagIndexCell;
    players: PlayersCell;
    gameEvents: EventsCell;
    rack: RackCell;
    placed: PlacedCell;
    message: MessageCell;
  }
>((
  _event,
  { board, bag, bagIndex, players, gameEvents, rack, placed, message },
) => {
  board.set([]);
  bag.set(createTileBag());
  bagIndex.set(0);
  players.key("list").set([]);
  gameEvents.set([]);
  rack.set([]);
  placed.set([]);
  message.set("Game reset. Join again to draw a fresh rack.");
});

const dropOnBoard = handler<
  any,
  {
    rack: RackCell;
    placed: PlacedCell;
    board: BoardCell;
    message: MessageCell;
  }
>((event, { rack, placed, board, message }) => {
  const sourceCell = event.detail?.sourceCell;
  const dropZoneRect = event.detail?.dropZoneRect;
  const pointerX = event.detail?.pointerX;
  const pointerY = event.detail?.pointerY;
  if (!sourceCell || !dropZoneRect) return;

  const letterId = getDraggedLetterId(sourceCell);
  if (!letterId) {
    message.set("Could not identify dragged tile.");
    return;
  }

  const cellWithGap = CELL_SIZE + 2;
  const col = Math.floor((pointerX - dropZoneRect.left) / cellWithGap);
  const row = Math.floor((pointerY - dropZoneRect.top) / cellWithGap);
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
    message.set("Drop outside board bounds.");
    return;
  }

  if (buildBoardSet(board.get()).has(`${row},${col}`)) {
    message.set("That square already has a submitted tile.");
    return;
  }

  const currentRack = rack.get();
  const currentPlaced = placed.get();
  const placedIndex = currentPlaced.findIndex((tile) =>
    tile.letter.id === letterId
  );

  if (placedIndex >= 0) {
    const occupied = currentPlaced.some((tile) =>
      tile.row === row && tile.col === col && tile.letter.id !== letterId
    );
    if (occupied) {
      message.set("That square already has one of your tiles.");
      return;
    }
    placed.set(
      currentPlaced.map((tile, index) =>
        index === placedIndex ? { ...tile, row, col } : tile
      ),
    );
    message.set("");
    return;
  }

  const rackIndex = currentRack.findIndex((letter) => letter.id === letterId);
  if (rackIndex < 0) {
    message.set("Tile not found in your rack.");
    return;
  }

  const rackLetter = currentRack[rackIndex];
  const sourceLetter: Letter = {
    char: rackLetter.char,
    points: rackLetter.points,
    id: rackLetter.id,
    isBlank: rackLetter.isBlank,
  };
  if (sourceLetter.isBlank && !sourceLetter.char) {
    const chosenChar = (globalThis as any).prompt?.(
      "Enter a letter for this blank tile (A-Z):",
    );
    if (!chosenChar || !/^[A-Za-z]$/.test(chosenChar)) {
      message.set("Invalid blank tile letter.");
      return;
    }
    sourceLetter.char = chosenChar.toUpperCase();
  }

  const occupied = currentPlaced.some((tile) =>
    tile.row === row && tile.col === col
  );
  if (occupied) {
    message.set("That square already has one of your tiles.");
    return;
  }

  rack.set(currentRack.filter((_, index) => index !== rackIndex));
  placed.set([...currentPlaced, { letter: sourceLetter, row, col }]);
  message.set("");
});

const placeTileOnBoard = handler<
  { letterId: string; row: number; col: number },
  {
    rack: RackCell;
    placed: PlacedCell;
    board: BoardCell;
    message: MessageCell;
  }
>(({ letterId, row, col }, { rack, placed, board, message }) => {
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
    message.set("Drop outside board bounds.");
    return;
  }
  if (buildBoardSet(board.get()).has(`${row},${col}`)) {
    message.set("That square already has a submitted tile.");
    return;
  }

  const currentRack = rack.get();
  const currentPlaced = placed.get();
  const rackIndex = currentRack.findIndex((letter) => letter.id === letterId);
  if (rackIndex < 0) {
    message.set("Tile not found in your rack.");
    return;
  }
  if (currentPlaced.some((tile) => tile.row === row && tile.col === col)) {
    message.set("That square already has one of your tiles.");
    return;
  }

  const rackLetter = currentRack[rackIndex];
  if (rackLetter.isBlank && !rackLetter.char) {
    message.set("Choose a blank tile letter before placing it.");
    return;
  }
  rack.set(currentRack.filter((_, index) => index !== rackIndex));
  placed.set([...currentPlaced, { letter: rackLetter, row, col }]);
  message.set("");
});

const returnToRack = handler<
  any,
  { rack: RackCell; placed: PlacedCell; message: MessageCell }
>((event, { rack, placed, message }) => {
  const sourceCell = event.detail?.sourceCell;
  if (!sourceCell) return;
  const letterId = getDraggedLetterId(sourceCell);
  if (!letterId) return;

  const currentPlaced = placed.get();
  const tile = currentPlaced.find((placedTile) =>
    placedTile.letter.id === letterId
  );
  if (!tile) return;

  const returnedLetter = {
    ...tile.letter,
    char: tile.letter.isBlank ? "" : tile.letter.char,
  };
  placed.set(
    currentPlaced.filter((placedTile) => placedTile.letter.id !== letterId),
  );
  rack.set([...rack.get(), returnedLetter]);
  message.set("");
});

const clearBoard = handler<
  void,
  { rack: RackCell; placed: PlacedCell; message: MessageCell }
>((_event, { rack, placed, message }) => {
  const currentPlaced = placed.get();
  if (currentPlaced.length === 0) return;
  rack.set([
    ...rack.get(),
    ...currentPlaced.map((tile) => ({
      ...tile.letter,
      char: tile.letter.isBlank ? "" : tile.letter.char,
    })),
  ]);
  placed.set([]);
  message.set("Cleared your unsubmitted tiles.");
});

const submitTurn = handler<
  void,
  {
    rack: RackCell;
    placed: PlacedCell;
    board: BoardCell;
    bag: BagCell;
    bagIndex: BagIndexCell;
    players: PlayersCell;
    gameEvents: EventsCell;
    myName: NameCell;
    message: MessageCell;
  }
>((
  _event,
  { rack, placed, board, bag, bagIndex, players, gameEvents, myName, message },
) => {
  const name = trimmedName(myName.get());
  const currentPlaced = placed.get();
  const currentBoard = board.get();
  if (!name) {
    message.set("Join before submitting a word.");
    return;
  }
  if (currentPlaced.length === 0) {
    message.set("Place tiles before submitting.");
    return;
  }

  const boardSet = buildBoardSet(currentBoard);
  const conflictingTiles = currentPlaced.filter((tile) =>
    boardSet.has(`${tile.row},${tile.col}`)
  );
  if (conflictingTiles.length > 0) {
    const validTiles = currentPlaced.filter((tile) =>
      !boardSet.has(`${tile.row},${tile.col}`)
    );
    rack.set([...rack.get(), ...returnedLetters(conflictingTiles)]);
    placed.set(validTiles);
    message.set("Some squares were taken. Conflicting tiles returned.");
    return;
  }

  if (
    currentBoard.length === 0 &&
    !currentPlaced.some((tile) => tile.row === CENTER && tile.col === CENTER)
  ) {
    rack.set([...rack.get(), ...returnedLetters(currentPlaced)]);
    placed.set([]);
    message.set("The first word must cover the center star.");
    return;
  }

  if (currentBoard.length > 0) {
    const committed = buildBoardSet(currentBoard);
    const connects = currentPlaced.some((tile) =>
      [
        `${tile.row - 1},${tile.col}`,
        `${tile.row + 1},${tile.col}`,
        `${tile.row},${tile.col - 1}`,
        `${tile.row},${tile.col + 1}`,
      ].some((position) => committed.has(position))
    );
    if (!connects) {
      rack.set([...rack.get(), ...returnedLetters(currentPlaced)]);
      placed.set([]);
      message.set("Tiles must connect to an existing word.");
      return;
    }
  }

  const allWords = findAllWords(currentPlaced, currentBoard);
  const invalidWords = allWords.filter((word) => !isValidWord(word));
  if (invalidWords.length > 0 || allWords.length === 0) {
    rack.set([...rack.get(), ...returnedLetters(currentPlaced)]);
    placed.set([]);
    message.set(
      invalidWords.length
        ? `Invalid words: ${invalidWords.join(", ")}.`
        : "No valid word formed.",
    );
    return;
  }

  const placedMap = buildTileMap(currentPlaced);
  const committedMap = buildTileMap(currentBoard);
  const tilesInWords = currentPlaced.filter((tile) =>
    isTilePartOfWord(tile.row, tile.col, placedMap, committedMap)
  );
  const orphanTiles = currentPlaced.filter((tile) =>
    !isTilePartOfWord(tile.row, tile.col, placedMap, committedMap)
  );
  if (orphanTiles.length > 0) {
    rack.set([...rack.get(), ...returnedLetters(orphanTiles)]);
  }

  const turnScore = calculateTurnScore(tilesInWords, currentBoard);
  // Snapshot the tiles as plain values: `placed.get()` elements keep their
  // cell identity in the USER-scoped placed doc, so writing them into the
  // shared board directly would store user-scoped links — which every other
  // player resolves into their own (empty) placed instance, and which dangle
  // even for the author once `placed.set([])` below clears the doc (scope
  // pitfall 6; flagged by the runtime's scope-isolation write guard).
  board.set([
    ...currentBoard,
    ...tilesInWords.map((tile) => ({
      ...tile,
      // Deep-copy: the nested Letter object also keeps its identity in the
      // user-scoped doc; a shallow spread would still store a user-scoped
      // link for the `letter` field.
      letter: { ...tile.letter },
    })),
  ]);
  placed.set([]);

  const currentBag = bag.get();
  const currentIndex = bagIndex.get();
  const tilesToDraw = Math.min(tilesInWords.length, 7 - rack.get().length);
  const drawn = drawTilesFromBag(currentBag, currentIndex, tilesToDraw);
  if (drawn.length > 0) {
    rack.set([...rack.get(), ...drawn]);
    bagIndex.set(currentIndex + drawn.length);
  }

  players.key("list").set(
    players.get().list.map((player) =>
      player.name === name
        ? { ...player, score: player.score + turnScore.total }
        : player
    ),
  );
  const words = turnScore.wordScores.map((word) => word.word).join(", ");
  const bonus = turnScore.bingoBonus ? " + bingo" : "";
  gameEvents.set([...gameEvents.get(), {
    id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "word",
    player: name,
    details: `${name}: ${words} (+${turnScore.total}${bonus})`,
    timestamp: Date.now(),
  }]);
  message.set(
    `Scored ${turnScore.total}: ${
      turnScore.wordScores.map((word) => word.breakdown).join("; ")
    }${bonus}`,
  );
});

// Stable empty fallbacks for the output snapshots below — fresh `[]` per
// recompute would make the computed results non-idempotent.
const EMPTY_TILES: PlacedTile[] = [];
const EMPTY_LETTERS: Letter[] = [];
const EMPTY_PLAYERS: PlayerView[] = [];
const EMPTY_EVENTS: GameEvent[] = [];

const ScrabbleGame = pattern<GameInput, GameOutput>(
  (
    {
      gameName,
      board,
      bag,
      bagIndex,
      players,
      gameEvents,
      rack,
      placed,
      myName,
      message,
    },
  ) => {
    const cellWithGap = CELL_SIZE + 2;

    // Resolve THIS viewer's shared profile. The `#profile` wish's built-in UI
    // covers the whole lifecycle: a create surface when the viewer has no
    // profile, a link when they have one, and a picker (with inline create)
    // when they have several. The field targets give the snapshot strings.
    const profileWish = wish<{ name?: string; avatar?: string }>({
      query: "#profile",
    });
    const profileNameWish = wish<string>({ query: "#profileName" });
    const profileAvatarWish = wish<string>({ query: "#profileAvatar" });
    const profile = resultOf(profileWish.result);

    const profileName = hasError(profileNameWish.result)
      ? ""
      : resultOf(profileNameWish.result);
    const profileAvatar = hasError(profileAvatarWish.result)
      ? ""
      : resultOf(profileAvatarWish.result);
    const hasProfile = computed(() => profileName.trim() !== "");
    // The button is the JOIN action; the adjacent `#profile` wish UI is the
    // create/pick surface. Label it as such (a disabled "Join" until the viewer
    // has a profile) rather than mislabeling the button "Create a profile…".
    const joinLabel = computed(() =>
      hasProfile ? `Join as ${profileName}` : "Join"
    );

    const joined = computed(() =>
      (players.list ?? []).some((player) =>
        player.name === trimmedName(myName.get())
      )
    );
    const rackCount = rack.get().length;
    const bagCount = Math.max(0, bag.get().length - bagIndex.get());
    const rackTiles = computed<RackTileView[]>(() =>
      rack.get().map((letter, index) => ({ ...letter, index }))
    );
    const joinGame = joinGameHandler({
      name: profileName,
      avatar: profileAvatar,
      profile,
      myName,
      rack,
      placed,
      board,
      bag,
      bagIndex,
      players,
      gameEvents,
      message,
    });
    const joinWithName = joinWithNameHandler({
      myName,
      rack,
      placed,
      board,
      bag,
      bagIndex,
      players,
      gameEvents,
      message,
    });
    const placeTile = placeTileOnBoard({ rack, placed, board, message });
    const resetGame = resetGameHandler({
      board,
      bag,
      bagIndex,
      players,
      gameEvents,
      rack,
      placed,
      message,
    });
    const submitWord = submitTurn({
      rack,
      placed,
      board,
      bag,
      bagIndex,
      players,
      gameEvents,
      myName,
      message,
    });
    const clearPlaced = clearBoard({ rack, placed, message });

    return {
      [NAME]: `Scrabble: ${gameName}`,
      [UI]: (
        <div
          style={{
            display: "flex",
            height: "100%",
            minHeight: "720px",
            backgroundColor: "#2d5016",
            color: "#fff",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              padding: "16px",
              overflow: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "12px",
                gap: "16px",
              }}
            >
              <h2 style={{ margin: 0, fontSize: "24px" }}>{gameName}</h2>
              {joined
                ? (
                  <cf-hstack gap="2" align="center">
                    <span style={{ color: "#d9f99d", fontSize: "14px" }}>
                      Playing as
                    </span>
                    {/* The viewer's own identity, first-class (CT-1761). */}
                    <cf-profile-badge
                      variant="chip"
                      $profile={profile}
                    />
                  </cf-hstack>
                )
                : (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      width: "min(420px, 100%)",
                    }}
                  >
                    {
                      /* Built-in profile UI: create a profile when there is
                        none, pick between existing profiles otherwise. */
                    }
                    <div style={{ flex: 1 }}>{profileWish[UI]}</div>
                    <cf-button
                      onClick={joinGame}
                      disabled={computed(() => !hasProfile)}
                    >
                      {joinLabel}
                    </cf-button>
                  </div>
                )}
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "center",
                marginBottom: "16px",
              }}
            >
              <div
                style={{
                  display: "inline-block",
                  backgroundColor: "#1a3009",
                  borderRadius: "8px",
                }}
              >
                <cf-drop-zone
                  accept="letter,board-tile"
                  oncf-drop={dropOnBoard({ rack, placed, board, message })}
                >
                  <div style={{ position: "relative" }}>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          `repeat(${BOARD_SIZE}, ${CELL_SIZE}px)`,
                        gap: "2px",
                      }}
                    >
                      {BOARD_CELLS.map((cell) => {
                        const colors = BONUS_COLORS[cell.bonus];
                        return (
                          <div
                            style={{
                              width: `${CELL_SIZE}px`,
                              height: `${CELL_SIZE}px`,
                              boxSizing: "border-box",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              backgroundColor: colors.bg,
                              color: colors.text,
                              border: "1px solid #8b7355",
                              borderRadius: "3px",
                              fontSize: "10px",
                              fontWeight: "bold",
                            }}
                          >
                            {BONUS_LABELS[cell.bonus]}
                          </div>
                        );
                      })}
                    </div>

                    {board.map((tile) => {
                      const leftPx = `${tile.col * cellWithGap}px`;
                      const topPx = `${tile.row * cellWithGap}px`;
                      return (
                        <div
                          style={{
                            position: "absolute",
                            left: leftPx,
                            top: topPx,
                            width: `${CELL_SIZE}px`,
                            height: `${CELL_SIZE}px`,
                            boxSizing: "border-box",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: "#e0d4b8",
                            color: "#333",
                            border: "2px solid #6b5a45",
                            borderRadius: "3px",
                            fontSize: "18px",
                            fontWeight: "bold",
                            userSelect: "none",
                          }}
                        >
                          {tile.letter.isBlank
                            ? tile.letter.char.toLowerCase()
                            : tile.letter.char}
                          {!tile.letter.isBlank && (
                            <span
                              style={{
                                position: "absolute",
                                bottom: "2px",
                                right: "3px",
                                fontSize: "8px",
                              }}
                            >
                              {tile.letter.points}
                            </span>
                          )}
                        </div>
                      );
                    })}

                    {placed.map((tile) => {
                      const leftPx = `${tile.col * cellWithGap}px`;
                      const topPx = `${tile.row * cellWithGap}px`;
                      return (
                        <cf-drag-source
                          $cell={tile}
                          type="board-tile"
                          style={{
                            position: "absolute",
                            left: leftPx,
                            top: topPx,
                          }}
                        >
                          <div
                            style={{
                              width: `${CELL_SIZE}px`,
                              height: `${CELL_SIZE}px`,
                              boxSizing: "border-box",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              backgroundColor: "#f5e6c8",
                              color: "#333",
                              border: "2px solid #fbbf24",
                              borderRadius: "3px",
                              fontSize: "18px",
                              fontWeight: "bold",
                              cursor: "grab",
                              userSelect: "none",
                            }}
                          >
                            {tile.letter.isBlank
                              ? tile.letter.char.toLowerCase()
                              : tile.letter.char}
                          </div>
                        </cf-drag-source>
                      );
                    })}
                  </div>
                </cf-drop-zone>
              </div>
            </div>

            <div
              style={{
                padding: "16px",
                backgroundColor: "#8b4513",
                borderRadius: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "8px",
                }}
              >
                <strong>Your Rack ({rackCount})</strong>
                <span style={{ color: "#fde68a", fontSize: "14px" }}>
                  Bag: {bagCount} tiles
                </span>
              </div>
              <cf-drop-zone
                accept="board-tile"
                oncf-drop={returnToRack({ rack, placed, message })}
              >
                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    minHeight: "50px",
                    backgroundColor: "#6b3410",
                    padding: "8px",
                    borderRadius: "4px",
                    flexWrap: "wrap",
                  }}
                >
                  {rackTiles.map((letter) => (
                    <cf-drag-source
                      $cell={rack.key(letter.index)}
                      type="letter"
                    >
                      <div
                        style={{
                          width: "44px",
                          height: "44px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: letter.isBlank
                            ? "#e8dcc8"
                            : "#f5e6c8",
                          border: letter.isBlank
                            ? "2px dashed #8b7355"
                            : "2px solid #8b7355",
                          borderRadius: "4px",
                          fontSize: "22px",
                          fontWeight: "bold",
                          color: "#333",
                          cursor: "grab",
                          userSelect: "none",
                          position: "relative",
                        }}
                      >
                        {letter.isBlank ? "" : letter.char}
                        {!letter.isBlank && (
                          <span
                            style={{
                              position: "absolute",
                              bottom: "2px",
                              right: "4px",
                              fontSize: "10px",
                            }}
                          >
                            {letter.points}
                          </span>
                        )}
                      </div>
                    </cf-drag-source>
                  ))}
                </div>
              </cf-drop-zone>
              <div
                style={{
                  marginTop: "10px",
                  display: "flex",
                  gap: "8px",
                  alignItems: "center",
                  justifyContent: "center",
                  flexWrap: "wrap",
                }}
              >
                <cf-button onClick={submitWord} disabled={!joined}>
                  Submit Word
                </cf-button>
                <cf-button
                  variant="secondary"
                  onClick={clearPlaced}
                  disabled={!joined}
                >
                  Clear Board
                </cf-button>
                <cf-button variant="secondary" onClick={resetGame}>
                  Reset
                </cf-button>
              </div>
              <div
                style={{
                  marginTop: "8px",
                  minHeight: "20px",
                  textAlign: "center",
                  color: "#fef3c7",
                  fontSize: "14px",
                }}
              >
                {message}
              </div>
            </div>
          </div>

          <aside
            style={{
              width: "160px",
              padding: "16px",
              backgroundColor: "#1a3009",
              borderLeft: "1px solid #4a7c23",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            <strong style={{ textAlign: "center", color: "#d9f99d" }}>
              Players
            </strong>
            {players.list.map((player) => (
              <div
                style={{
                  padding: "10px",
                  backgroundColor: player.color,
                  borderRadius: "8px",
                  textAlign: "center",
                  border: player.name === myName.get()
                    ? "3px solid #fbbf24"
                    : "3px solid transparent",
                }}
              >
                <div style={{ display: "flex", justifyContent: "center" }}>
                  {
                    /* Profile-joined players render first-class via the trusted
                      `circle` badge (avatar + seal ring, navigable); headless
                      name-only joins (no profile cell) fall back to cf-avatar. */
                  }
                  {ifElse(
                    computed(() => player.profile !== undefined),
                    <cf-profile-badge
                      variant="circle"
                      size="sm"
                      $profile={player.profile}
                    />,
                    <cf-avatar
                      src={player.avatar}
                      name={player.name}
                      size="sm"
                    />,
                  )}
                </div>
                <div
                  style={{
                    fontSize: "13px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {player.name}
                </div>
                <div style={{ fontSize: "24px", fontWeight: 800 }}>
                  {player.score}
                </div>
              </div>
            ))}
            <strong
              style={{
                marginTop: "auto",
                textAlign: "center",
                color: "#d9f99d",
                borderTop: "1px solid #4a7c23",
                paddingTop: "10px",
              }}
            >
              Recent
            </strong>
            <div style={{ fontSize: "11px", color: "#cbd5e1" }}>
              {gameEvents.map((event) => (
                <div style={{ marginBottom: "5px" }}>{event.details}</div>
              ))}
            </div>
          </aside>
        </div>
      ),
      // Output snapshots readable from OTHER runtimes (multi-user tests,
      // remote viewers): raw scoped cells read as undefined in runtimes that
      // didn't write them, and a computed that RETURNS undefined is
      // indistinguishable from "not yet computed" for cross-runtime readers —
      // so every snapshot yields a real, stable value (the shared EMPTY
      // constants keep the fallback idempotent across recomputes).
      myName: computed(() => trimmedName(myName.get())),
      board: computed(() => board.get() ?? EMPTY_TILES),
      bag: computed(() => bag.get() ?? EMPTY_LETTERS),
      bagIndex: computed(() => bagIndex.get() ?? 0),
      // Strip the internal live `profile` cell so the outward snapshot matches
      // the declared `PlayerView` contract (plain name/score/etc.) — external
      // readers never receive a cross-space profile link.
      players: computed(() =>
        (players.list ?? EMPTY_PLAYERS).map(
          ({ profile: _profile, ...player }) => player,
        )
      ),
      gameEvents: computed(() => gameEvents.get() ?? EMPTY_EVENTS),
      rack: computed(() => rack.get() ?? EMPTY_LETTERS),
      placed: computed(() => placed.get() ?? EMPTY_TILES),
      message: computed(() => message.get() ?? ""),
      joinGame,
      joinWithName,
      placeTile,
      submitTurn: submitWord,
      clearBoard: clearPlaced,
      resetGame,
    };
  },
);

export default ScrabbleGame;
