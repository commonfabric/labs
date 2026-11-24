/**
 * Ring Loops as a piece: the iframe sequencer of `frame.tsx`, handed the
 * viewer's profile name so that a placed note can say who placed it, plus the
 * verbs through which a caller with no browser reads the rings and changes
 * them. A verb writes the same cells the guest writes, so an edit made through
 * one appears in every open browser.
 */

import {
  computed,
  currentPrincipal,
  type Default,
  handler,
  NAME,
  pattern,
  type PerUser,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import {
  DEFAULT_OUTPUT,
  DEFAULT_SETUP,
  type IframeOutputData,
  type IframeStateData,
  type PlacedNote,
  type RingLoopsSetup,
} from "./contract.ts";
import Frame from "./frame.tsx";
import {
  type Cell,
  cellKey,
  cellOf,
  checkedColor,
  checkedTempo,
  checkedVolume,
  defaultColor,
  laneLabel,
  liveNotes,
  type NoteAuthor,
  noteAuthorName,
  noteFor,
  type NoteSpec,
  type RingLayout,
  ringLayoutOf,
  type RingSetup,
  type RingView,
  ringViews,
  uniqueCells,
  validLayoutOf,
} from "./model.ts";

/** What a piece of Ring Loops is instantiated with. */
export interface RingLoopsInput {
  /** The rings and the scale. Left out, four rings in A minor pentatonic. */
  input?: Default<RingLoopsSetup, typeof DEFAULT_SETUP>;

  /** The caller's own color, volume, and muted rings. */
  output?: PerUser<Writable<Default<IframeOutputData, typeof DEFAULT_OUTPUT>>>;
}

/**
 * A loop sequencer several people play at once. Notes sit in cells on
 * concentric rings; each ring loops at its own length, so the rings drift
 * against each other. Everyone shares the notes and the tempo, and each
 * browser plays them from its own start. Read `rings` to see what is there,
 * then place and remove notes by ring id, step, and lane.
 */
export interface RingLoopsOutput {
  [NAME]: string;
  [UI]: VNode;

  /**
   * Every ring with its loop length in steps, what each of its lanes plays,
   * and the notes on it with who placed each. Start here. It is derived from
   * `state` when the piece runs: a caller that reads without running the
   * piece, as `cf cell get` does without `--step`, sees it as of the last run.
   */
  rings: RingView[];

  /**
   * The stored form, current on every read: `tempoBpm`, and the notes by cell
   * key, where `null` marks a removed note. `rings` is the same notes in a
   * form that says what each plays.
   */
  state: IframeStateData;

  /** The caller's own note color, playback volume, and muted rings. */
  output: IframeOutputData;

  /** Place one note. A note already in that cell is replaced. */
  addNote: Stream<AddNoteEvent, AddNoteResult>;

  /**
   * Place several notes in one call, all by the same author. Nothing is placed
   * unless every cell named is valid, and a cell named twice is placed once.
   */
  addNotes: Stream<AddNotesEvent, AddNotesResult>;

  /** Remove the note in one cell. */
  removeNote: Stream<RemoveNoteEvent, RemoveNoteResult>;

  /** Remove every note, or every note on one ring. This is for everyone. */
  clearNotes: Stream<ClearNotesEvent, ClearNotesResult>;

  /** Set the tempo everyone plays at. */
  setTempo: Stream<SetTempoEvent, SetTempoResult>;

  /** Set the caller's own playback volume. Nobody else's changes. */
  setVolume: Stream<SetVolumeEvent, SetVolumeResult>;
}

/** Who a verb's notes are attributed to, and the color they are drawn in. */
interface Attribution {
  /**
   * Name of the agent placing the notes, shown as their author. It is stored
   * without control characters and cut to at most 80 characters. Left out, the
   * notes carry the caller's profile name.
   */
  agentName?: string;

  /**
   * One of the eight note colors, as the hex string `output.color` holds.
   * Left out, a color is picked from the author's name.
   */
  color?: string;
}

/** The cell `addNote` places a note in, and who the note is by. */
interface AddNoteEvent extends Attribution {
  /** Id of the ring, as `rings` lists it. */
  ring: string;

  /** Step along the ring, from 0; a step is a sixteenth note. */
  step: number;

  /** Lane within the ring, from 0; `rings` lists what each lane plays. */
  lane: number;
}

/** What `addNote` placed. */
interface AddNoteResult {
  /** The note as stored. */
  note: PlacedNote;

  /** What the note plays: a drum sound, or a note name such as `A3`. */
  plays: string;

  /** Whether the cell already held a note, which this one replaced. */
  replaced: boolean;
}

/** The cells `addNotes` places notes in, and who the notes are by. */
interface AddNotesEvent extends Attribution {
  /** The cells to place notes in, each by ring id, step, and lane. */
  notes: NoteSpec[];
}

/** How many notes `addNotes` placed. */
interface AddNotesResult {
  /** How many cells received a note, counting a cell named twice once. */
  placed: number;

  /** How many of those replaced a note already in the cell. */
  replaced: number;
}

/** The cell `removeNote` empties. */
interface RemoveNoteEvent {
  /** Id of the ring, as `rings` lists it. */
  ring: string;

  /** Step along the ring, from 0. */
  step: number;

  /** Lane within the ring, from 0. */
  lane: number;
}

/** Whether `removeNote` found a note to remove. */
interface RemoveNoteResult {
  /** Whether the cell held a note. */
  removed: boolean;
}

/** Which ring `clearNotes` empties, or every ring. */
interface ClearNotesEvent {
  /** Id of the one ring to clear. Left out, every ring is cleared. */
  ring?: string;
}

/** How many notes `clearNotes` removed. */
interface ClearNotesResult {
  /** How many notes were removed. */
  removed: number;
}

/** The tempo `setTempo` stores. */
interface SetTempoEvent {
  /** Beats per minute, from 40 to 200. */
  bpm: number;
}

/** The tempo `setTempo` stored. */
interface SetTempoResult {
  /** The tempo now stored, in beats per minute. */
  tempoBpm: number;
}

/** The volume `setVolume` stores for the caller. */
interface SetVolumeEvent {
  /** Playback volume, from 0 for silence to 1 for full. */
  volume: number;
}

/** The volume `setVolume` stored for the caller. */
interface SetVolumeResult {
  /** The caller's volume now stored. */
  volume: number;
}

/** What a verb that edits notes is bound to. */
interface NoteVerbState {
  /** The shared notes and tempo, which the frame owns. */
  state: Writable<IframeStateData>;

  /** The rings and the scale of this piece. */
  setup: RingLoopsSetup;

  /** Profile name of the caller, or the empty string where none is known. */
  viewerName: string;

  /** The caller's own settings, whose color the notes take by default. */
  output: IframeOutputData;
}

/**
 * Returns who a verb's notes are by. The identifier is the principal the call
 * acts for, which the event cannot name, and the name is the agent's where the
 * event gives one. The color is the event's, else the caller's chosen one,
 * else one picked from the author.
 */
function authorOf(
  event: Attribution,
  viewerName: string,
  chosenColor: string | null,
): NoteAuthor {
  const name = noteAuthorName(event.agentName, viewerName);
  const id = currentPrincipal() ?? "unknown";
  return {
    id,
    name,
    color: event.color === undefined
      ? chosenColor ?? defaultColor(name || id)
      : checkedColor(event.color),
  };
}

/** Returns the key `cell` is stored under. */
function keyOf(layout: RingLayout, cell: Cell): string {
  return cellKey(layout.rings[cell.ringIndex].id, cell.step, cell.lane);
}

/** Returns whether the notes hold a note the layout can play under `key`. */
function isOccupied(
  layout: RingLayout,
  notes: Writable<Record<string, PlacedNote | null>>,
  key: string,
): boolean {
  return liveNotes(layout, { [key]: notes.key(key).get() }).length > 0;
}

/** Returns the rings as a reader sees them, or none for an invalid setup. */
function listRings(
  setup: RingSetup,
  notes: Readonly<Record<string, PlacedNote | null>>,
): RingView[] {
  const layout = validLayoutOf(setup);
  return layout === undefined
    ? []
    : ringViews(layout, liveNotes(layout, notes));
}

const addNote = handler<AddNoteEvent, NoteVerbState, AddNoteResult>(
  (event, { state, setup, viewerName, output }) => {
    const layout = ringLayoutOf(setup);
    const cell = cellOf(layout, event);
    const note = noteFor(
      layout,
      cell,
      authorOf(event, viewerName, output.color),
    );
    const notes = state.key("notes");
    const key = keyOf(layout, cell);
    const replaced = isOccupied(layout, notes, key);
    notes.key(key).set(note);
    return {
      note,
      plays: laneLabel(layout, layout.rings[cell.ringIndex], cell.lane),
      replaced,
    };
  },
);

const addNotes = handler<AddNotesEvent, NoteVerbState, AddNotesResult>(
  (event, { state, setup, viewerName, output }) => {
    const layout = ringLayoutOf(setup);
    // Every cell is checked ahead of the first write, so one bad cell leaves
    // the rings as they were.
    const cells = uniqueCells(
      layout,
      event.notes.map((spec) => cellOf(layout, spec)),
    );
    const author = authorOf(event, viewerName, output.color);
    const notes = state.key("notes");
    const replaced =
      cells.filter((cell) => isOccupied(layout, notes, keyOf(layout, cell)))
        .length;
    cells.forEach((cell) =>
      notes.key(keyOf(layout, cell)).set(noteFor(layout, cell, author))
    );
    return { placed: cells.length, replaced };
  },
);

const removeNote = handler<RemoveNoteEvent, NoteVerbState, RemoveNoteResult>(
  (event, { state, setup }) => {
    const layout = ringLayoutOf(setup);
    const notes = state.key("notes");
    const key = keyOf(layout, cellOf(layout, event));
    const removed = isOccupied(layout, notes, key);
    if (removed) notes.key(key).set(null);
    return { removed };
  },
);

const clearNotes = handler<ClearNotesEvent, NoteVerbState, ClearNotesResult>(
  (event, { state, setup }) => {
    const layout = ringLayoutOf(setup);
    const notes = state.key("notes");
    const live = liveNotes(layout, notes.get() ?? {});
    const { ring } = event;
    if (ring === undefined) {
      notes.set({});
      return { removed: live.length };
    }
    // Naming a cell on the ring is what checks that the ring exists.
    cellOf(layout, { ring, step: 0, lane: 0 });
    const onRing = live.filter(({ note }) => note.ringId === ring);
    onRing.forEach(({ note }) =>
      notes.key(cellKey(note.ringId, note.step, note.lane)).set(null)
    );
    return { removed: onRing.length };
  },
);

const setTempo = handler<
  SetTempoEvent,
  { state: Writable<IframeStateData> },
  SetTempoResult
>((event, { state }) => {
  const tempoBpm = checkedTempo(event.bpm);
  state.key("tempoBpm").set(tempoBpm);
  return { tempoBpm };
});

const setVolume = handler<
  SetVolumeEvent,
  { output: Writable<IframeOutputData> },
  SetVolumeResult
>((event, { output }) => {
  const volume = checkedVolume(event.volume);
  output.key("volume").set(volume);
  return { volume };
});

export default pattern<RingLoopsInput, RingLoopsOutput>(({ input, output }) => {
  const setup = input ?? DEFAULT_SETUP;
  // The wish resolves to the profile of whoever is running the piece, so each
  // viewer's guest is handed that viewer's own name.
  const profileName = wish<string>({ query: "#profileName" });
  const viewerName = computed(() => (profileName.result ?? "").trim());
  const frame = Frame({ input: { setup, viewerName }, output });
  // Destructuring binds each name to a link into the frame's result. Reading
  // `frame.state` here would put a derived copy of it in this piece's result
  // instead. Verbs and the running piece reach the frame's cell either way;
  // the copy misleads a caller that does not run the piece, which reads it
  // stale (`cf cell get` without `--step`) and writes into the copy rather
  // than through it (`cf cell set`).
  const { state, [UI]: view } = frame;
  const rings = computed(() => listRings(setup, state.notes));

  return {
    [NAME]: "Ring Loops",
    [UI]: view,
    rings,
    state,
    output,
    addNote: addNote({ state, setup, viewerName, output }),
    addNotes: addNotes({ state, setup, viewerName, output }),
    removeNote: removeNote({ state, setup, viewerName, output }),
    clearNotes: clearNotes({ state, setup, viewerName, output }),
    setTempo: setTempo({ state }),
    setVolume: setVolume({ output }),
  };
});
