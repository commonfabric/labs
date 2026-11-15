## `apps/codenames-helper/codenames-helper.tsx`

A spymaster's companion for playing the word game Codenames in person with the
physical cards. Setup: type the 25 board words into the grid and give each card
its key-card color (tap a card, then a color), or photograph the board and the
key card and apply what an LLM reads from each after checking it. The color
counts flag a key that is not 9/8/7/1. Play: tap a card when it is guessed to
mark it out of play (tap again to undo), and ask for one-word clue ideas that
connect your team's remaining words while avoiding the rest (ask again for
different ideas). Board logic is pure functions in `board.ts`.

**Keywords:** game companion, board game, word game, spymaster, LLM,
generateObject, image input, 5x5 grid

### Input Schema

```ts
type Team = "red" | "blue";
type Owner = "red" | "blue" | "neutral" | "assassin" | "unassigned";
type Mode = "setup" | "play";

interface BoardCard {
  word: string; // upper case, "" until entered
  owner: Owner; // key-card color
  revealed: boolean; // guessed, out of play
}

interface CodenamesHelperInput {
  board?: PerSpace<Writable<BoardCard[] | Default<[]>>>; // padded to 25
  myTeam?: PerUser<Writable<Team | Default<"red">>>; // each spymaster's own
  mode?: PerSpace<Writable<Mode | Default<"setup">>>;
}
```

### Output Schema

```ts
interface CodenamesHelperOutput {
  board: BoardCard[]; // always 25, row-major
  myTeam: Team;
  mode: Mode;
  selectedIndex: number; // card picked for coloring, or -1
  inPlay: Record<Owner, number>;
  keyWarnings: string[];
  clueRequest: string; // board prompt clue ideas were last requested for
  tapCard: Stream<{ index: number }>;
  assignOwner: Stream<{ owner: Owner }>;
  setWord: Stream<{ index: number; word: string }>;
  applyPhotoReading: Stream<{ reading: PhotoReading; photoId?: string }>;
  clearColors: Stream<void>;
  resetBoard: Stream<void>;
  startPlay: Stream<void>;
  editBoard: Stream<void>;
  requestClues: Stream<void>;
}
```

<!-- demo-list: `apps/codenames-helper/` (a spymaster's companion for in-person Codenames, with photo reading and clue ideas) -->
