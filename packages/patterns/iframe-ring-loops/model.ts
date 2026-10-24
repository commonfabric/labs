/**
 * Pure logic of Ring Loops, shared by the guest and by the pattern's verbs:
 * checking the rings a setup describes, mapping a pointer position or a
 * caller's words to a cell, the step clock the audio scheduler reads, and the
 * pitch each lane sounds at. Nothing here touches the DOM, the audio graph, or
 * a cell, so all of it runs under `deno test`.
 */

import { normalizePresenceParticipantName } from "../shared-note/participant-name.ts";
import type { PlacedNote, RingSpec, RingVoice } from "./contract.ts";

/** Steps a beat divides into, which makes a step a sixteenth note. */
export const STEPS_PER_BEAT = 4;

/** Slowest tempo the shared control offers, in beats per minute. */
export const MIN_TEMPO_BPM = 40;

/** Fastest tempo the shared control offers, in beats per minute. */
export const MAX_TEMPO_BPM = 200;

/** Tempo played when the stored one is not a number. */
export const FALLBACK_TEMPO_BPM = 96;

/** Most rings an input may describe. */
export const MAX_RINGS = 6;

/** Longest loop a ring may have, in beats. */
export const MAX_RING_BEATS = 16;

/** Most lanes a ring's band may hold. */
export const MAX_LANES = 8;

/** Colors a participant chooses from for the notes they place. */
export const NOTE_COLORS: readonly string[] = [
  "#ff6b6b",
  "#ffa94d",
  "#ffd43b",
  "#69db7c",
  "#38d9a9",
  "#4dabf7",
  "#9775fa",
  "#f783ac",
];

/** Drum sounds, in the order a drum ring's lanes play them from the inside. */
export const DRUM_SOUNDS = ["kick", "snare", "hat", "clap", "tom"] as const;

/** One sound of the drum kit. */
export type DrumSound = typeof DRUM_SOUNDS[number];

/** Radius of the empty hub at the center, where the outer edge is at 1. */
const HUB_RADIUS = 0.12;

/** Radial space left between two neighboring rings. */
const RING_GAP = 0.02;

const TAU = 2 * Math.PI;

const VOICES: readonly RingVoice[] = ["drums", "bass", "pluck", "bell"];

const NOTE_NAMES = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
];

/** A checked ring, with its loop length counted in steps. */
export interface Ring {
  /** Identifier that placed notes name the ring by. */
  readonly id: string;

  /** Name shown beside the ring's mute control. */
  readonly label: string;

  /** Instrument the ring's notes sound on. */
  readonly voice: RingVoice;

  /** Steps in one turn of the ring's hand. */
  readonly steps: number;

  /** Semitones added to the root for this ring's lanes. */
  readonly transpose: number;
}

/** The rings of a checked input, and the pitches their lanes share. */
export interface RingLayout {
  /** Rings from the innermost outward. */
  readonly rings: readonly Ring[];

  /** Lanes in every ring's band. */
  readonly lanes: number;

  /** Semitones each lane sits above the root. */
  readonly scale: readonly number[];

  /** MIDI note number of the lowest lane of an untransposed ring. */
  readonly rootMidi: number;
}

/** Radial extent of one ring, where the outermost ring's edge is at 1. */
export interface RingBand {
  /** Radius of the band's inner edge. */
  readonly inner: number;

  /** Radius of the band's outer edge. */
  readonly outer: number;
}

/** One cell of a ring: a step along it, in one of its lanes. */
export interface Cell {
  /** Index of the ring in the layout, from the innermost. */
  readonly ringIndex: number;

  /** Step along the ring, clockwise from the top. */
  readonly step: number;

  /** Lane within the band, from 0 at its inner edge. */
  readonly lane: number;
}

/** A direction the keyboard moves the selection from one cell to the next. */
export type CellMove = "clockwise" | "anticlockwise" | "outward" | "inward";

/** The annular sector a cell occupies, in radii and fractions of a turn. */
export interface CellShape extends RingBand {
  /** Where the cell begins, clockwise from the top; a note sounds here. */
  readonly startTurn: number;

  /** Where the cell ends, clockwise from the top. */
  readonly endTurn: number;
}

/** A placed note that fits the layout, with the index of its ring. */
export interface LiveNote {
  /** Index of the note's ring in the layout. */
  readonly ringIndex: number;

  /** The note as stored. */
  readonly note: PlacedNote;
}

/**
 * One write to the shared notes: the key of a cell, and what to store there.
 */
export interface CellEdit {
  /** Key of the cell in the shared notes record. */
  readonly key: string;

  /** Note to store, or `null` to remove the one that is there. */
  readonly value: PlacedNote | null;
}

/**
 * A running step clock: the step position held at one instant of audio time.
 */
export interface Transport {
  /** Step position at `anchorTime`. */
  readonly anchorStep: number;

  /** Audio time, in seconds, at which the clock is at `anchorStep`. */
  readonly anchorTime: number;

  /** Tempo the clock advances at, in beats per minute. */
  readonly tempoBpm: number;
}

/**
 * The part of a setup that decides the rings, read-only so that a frozen
 * snapshot of a `RingLoopsSetup` is one as much as a mutable copy is.
 */
export interface RingSetup {
  /** Rings from the innermost outward. */
  readonly rings: readonly Readonly<RingSpec>[];

  /** MIDI note number of the lowest lane of an untransposed ring. */
  readonly rootMidi: number;

  /** Semitones each lane sits above the root. */
  readonly scale: readonly number[];
}

/** Who is placing a note, as the note records them. */
export interface NoteAuthor {
  /** Opaque identifier of the author. */
  readonly id: string;

  /** Name the author goes by, or the empty string where none is known. */
  readonly name: string;

  /** CSS color the author's notes are drawn in. */
  readonly color: string;
}

/** A cell as a caller names it: by the ring's identifier, a step and a lane. */
export interface NoteSpec {
  /** Identifier of the ring, such as `drums`. */
  readonly ring: string;

  /** Step along the ring, from 0 at the top; a step is a sixteenth note. */
  readonly step: number;

  /** Lane within the ring, from 0 at its inner edge; picks what plays. */
  readonly lane: number;
}

/** One placed note, as a ring's listing shows it. */
export interface NoteView {
  /** Step along the ring, from 0 at the top; a step is a sixteenth note. */
  readonly step: number;

  /** Lane within the ring, from 0 at its inner edge. */
  readonly lane: number;

  /** What the note plays: a drum sound, or a note name such as `A3`. */
  readonly plays: string;

  /** Name of whoever placed the note. */
  readonly by: string;
}

/** One ring with everything on it, for a reader with no canvas. */
export interface RingView {
  /** Identifier to name the ring by when adding or removing a note. */
  readonly id: string;

  /** Name the ring is shown under. */
  readonly label: string;

  /** Instrument the ring's notes sound on. */
  readonly voice: RingVoice;

  /** Steps in one loop of the ring; valid steps run from 0 to one less. */
  readonly steps: number;

  /** What each lane plays, by lane number from 0. */
  readonly lanes: readonly string[];

  /** Notes on the ring, in the order its hand reaches them. */
  readonly notes: readonly NoteView[];
}

/** How many notes one author has on the rings. */
export interface AuthorTally {
  /** Name the author's notes carry. */
  readonly name: string;

  /** Color most of the author's notes are drawn in. */
  readonly color: string;

  /** Number of the author's notes on the rings. */
  readonly count: number;
}

/**
 * Checks `setup` and returns its rings with loop lengths counted in steps.
 *
 * @throws {TypeError} When the rings or the scale are missing or hold a value
 *   of the wrong kind, or when two rings share an identifier.
 * @throws {RangeError} When the ring count, the lane count, or a ring's beats
 *   fall outside what the canvas can draw, or a pitched ring would play a note
 *   outside MIDI 0 to 127.
 */
export function ringLayoutOf(setup: RingSetup): RingLayout {
  const { rings, scale, rootMidi } = setup;
  if (!Array.isArray(rings) || !Array.isArray(scale)) {
    throw new TypeError("The setup needs a list of rings and a scale.");
  }
  if (rings.length < 1 || rings.length > MAX_RINGS) {
    throw new RangeError(
      `The setup needs 1 to ${MAX_RINGS} rings and has ${rings.length}.`,
    );
  }
  if (scale.length < 1 || scale.length > MAX_LANES) {
    throw new RangeError(
      `The scale needs 1 to ${MAX_LANES} steps and has ${scale.length}.`,
    );
  }
  if (!Number.isFinite(rootMidi) || !scale.every(Number.isFinite)) {
    throw new TypeError("The root and every scale step must be numbers.");
  }

  const seen = new Set<string>();
  const layout = {
    rings: rings.map((ring, index) => {
      const ordinal = index + 1;
      if (typeof ring.id !== "string" || seen.has(ring.id)) {
        throw new TypeError(
          `Ring ${ordinal} needs an id no other ring has.`,
        );
      }
      seen.add(ring.id);
      if (!VOICES.includes(ring.voice)) {
        throw new TypeError(`Ring ${ordinal} names an unknown voice.`);
      }
      if (
        !Number.isInteger(ring.beats) || ring.beats < 1 ||
        ring.beats > MAX_RING_BEATS
      ) {
        throw new RangeError(
          `Ring ${ordinal} needs a whole number of beats from 1 to ${MAX_RING_BEATS}.`,
        );
      }
      if (!Number.isFinite(ring.transpose)) {
        throw new TypeError(`Ring ${ordinal} needs a numeric transposition.`);
      }
      return {
        id: ring.id,
        label: ring.label,
        voice: ring.voice,
        steps: ring.beats * STEPS_PER_BEAT,
        transpose: ring.transpose,
      };
    }),
    lanes: scale.length,
    scale: [...scale],
    rootMidi,
  };
  for (const [index, ring] of layout.rings.entries()) {
    if (ring.voice === "drums") continue;
    const pitches = scale.map((offset) => rootMidi + ring.transpose + offset);
    if (pitches.some((midi) => midi < 0 || midi > 127)) {
      throw new RangeError(
        `Ring ${index + 1} would play outside MIDI notes 0 to 127.`,
      );
    }
  }
  return layout;
}

/**
 * Returns the layout of `setup`, or `undefined` where `ringLayoutOf()` would
 * refuse it.
 */
export function validLayoutOf(setup: RingSetup): RingLayout | undefined {
  try {
    return ringLayoutOf(setup);
  } catch (cause) {
    if (cause instanceof TypeError || cause instanceof RangeError) {
      return undefined;
    }
    throw cause;
  }
}

/** Returns the band of each of `count` rings, from the innermost outward. */
export function ringBands(count: number): RingBand[] {
  const width = (1 - HUB_RADIUS - RING_GAP * (count - 1)) / count;
  return Array.from({ length: count }, (_, index) => {
    const inner = HUB_RADIUS + index * (width + RING_GAP);
    return { inner, outer: inner + width };
  });
}

/**
 * Returns the cell next to `cell` in direction `move`. Along a ring the step
 * wraps around. Outward and inward, a move past the edge of the band lands in
 * the neighboring ring, on the step at the nearest angle; there is nothing past
 * the innermost and the outermost lane, so a move there returns `cell`.
 */
export function neighborCell(
  layout: RingLayout,
  cell: Cell,
  move: CellMove,
): Cell {
  const { steps } = layout.rings[cell.ringIndex];
  switch (move) {
    case "clockwise":
      return { ...cell, step: (cell.step + 1) % steps };
    case "anticlockwise":
      return { ...cell, step: (cell.step + steps - 1) % steps };
    case "outward":
      return cell.lane + 1 < layout.lanes
        ? { ...cell, lane: cell.lane + 1 }
        : crossedCell(layout, cell, cell.ringIndex + 1, 0);
    case "inward":
      return cell.lane > 0
        ? { ...cell, lane: cell.lane - 1 }
        : crossedCell(layout, cell, cell.ringIndex - 1, layout.lanes - 1);
  }
}

/**
 * Returns the cell under the point (`x`, `y`), or `undefined` where the point
 * lies in the hub, in a gap between rings, or outside the outermost ring. The
 * point is measured from the center with `y` growing downward, in units of the
 * outermost ring's radius.
 */
export function cellAt(
  layout: RingLayout,
  x: number,
  y: number,
): Cell | undefined {
  const radius = Math.hypot(x, y);
  const bands = ringBands(layout.rings.length);
  const ringIndex = bands.findIndex((band) =>
    radius >= band.inner && radius < band.outer
  );
  if (ringIndex < 0) return undefined;

  const band = bands[ringIndex];
  const { steps } = layout.rings[ringIndex];
  // `atan2()` is handed the axes swapped, which measures the angle clockwise
  // from the top rather than counterclockwise from the right.
  const turn = (Math.atan2(x, -y) / TAU + 1) % 1;
  const depth = (radius - band.inner) / (band.outer - band.inner);
  return {
    ringIndex,
    step: Math.min(steps - 1, Math.floor(turn * steps)),
    lane: Math.min(layout.lanes - 1, Math.floor(depth * layout.lanes)),
  };
}

/** Returns the annular sector that `cell` occupies. */
export function cellShape(layout: RingLayout, cell: Cell): CellShape {
  const band = ringBands(layout.rings.length)[cell.ringIndex];
  const { steps } = layout.rings[cell.ringIndex];
  const laneWidth = (band.outer - band.inner) / layout.lanes;
  return {
    inner: band.inner + cell.lane * laneWidth,
    outer: band.inner + (cell.lane + 1) * laneWidth,
    startTurn: cell.step / steps,
    endTurn: (cell.step + 1) / steps,
  };
}

/** Returns the key a cell's note is stored under in the shared notes. */
export function cellKey(ringId: string, step: number, lane: number): string {
  return `${ringId}:${step}:${lane}`;
}

/**
 * Returns the notes of `notes` that the layout can draw and play: those whose
 * ring exists, whose step and lane fall inside it, and that sit under the key
 * of their own cell. A removed note, a value that is not a note, and a note
 * left over from a layout with other rings are not among them. The values are
 * read as anyone with write access to the space may have stored them, so an
 * `authorName` is bounded as `noteAuthorName()` bounds it, and dropped where it
 * is not a string.
 */
export function liveNotes(
  layout: RingLayout,
  notes: Readonly<Record<string, unknown>>,
): LiveNote[] {
  const ringIndexById = new Map(
    layout.rings.map((ring, index) => [ring.id, index]),
  );
  const live: LiveNote[] = [];
  for (const [key, value] of Object.entries(notes)) {
    const note = readNote(value);
    if (!note) continue;
    const ringIndex = ringIndexById.get(note.ringId);
    if (ringIndex === undefined) continue;
    const { steps } = layout.rings[ringIndex];
    if (!isIndexBelow(note.step, steps)) continue;
    if (!isIndexBelow(note.lane, layout.lanes)) continue;
    if (key !== cellKey(note.ringId, note.step, note.lane)) continue;
    live.push({ ringIndex, note });
  }
  return live;
}

/** Returns the note `author` places in `cell`. */
export function noteFor(
  layout: RingLayout,
  cell: Cell,
  author: NoteAuthor,
): PlacedNote {
  return {
    ringId: layout.rings[cell.ringIndex].id,
    step: cell.step,
    lane: cell.lane,
    authorId: author.id,
    color: author.color,
    ...(author.name !== "" && { authorName: author.name }),
  };
}

/**
 * Returns the write that toggles `cell`: removing the note that is there, or
 * placing one by `author` where the cell is empty.
 */
export function toggleEdit(
  layout: RingLayout,
  notes: Readonly<Record<string, PlacedNote | null | undefined>>,
  cell: Cell,
  author: NoteAuthor,
): CellEdit {
  const ringId = layout.rings[cell.ringIndex].id;
  const key = cellKey(ringId, cell.step, cell.lane);
  const occupied = liveNotes(layout, { [key]: notes[key] }).length > 0;
  return { key, value: occupied ? null : noteFor(layout, cell, author) };
}

/**
 * Returns the cell that `spec` names.
 *
 * @throws {RangeError} When no ring has the identifier, or the step or the
 *   lane is not a whole number inside the ring. The message states the valid
 *   values.
 */
export function cellOf(layout: RingLayout, spec: NoteSpec): Cell {
  const ringIndex = layout.rings.findIndex((ring) => ring.id === spec.ring);
  if (ringIndex < 0) {
    throw new RangeError(
      `No ring has that id. The rings are: ${
        layout.rings.map((ring) => ring.id).join(", ")
      }.`,
    );
  }
  const ring = layout.rings[ringIndex];
  if (!isIndexBelow(spec.step, ring.steps)) {
    throw new RangeError(
      `A step on ring \`${ring.id}\` is a whole number from 0 to ${
        ring.steps - 1
      }.`,
    );
  }
  if (!isIndexBelow(spec.lane, layout.lanes)) {
    throw new RangeError(
      `A lane is a whole number from 0 to ${layout.lanes - 1}.`,
    );
  }
  return { ringIndex, step: spec.step, lane: spec.lane };
}

/** Returns `cells` with each cell kept once, in the order first named. */
export function uniqueCells(
  layout: RingLayout,
  cells: readonly Cell[],
): Cell[] {
  const seen = new Set<string>();
  return cells.filter((cell) => {
    const key = cellKey(layout.rings[cell.ringIndex].id, cell.step, cell.lane);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Returns the name a note records for its author: the agent's where one is
 * given, else the viewer's. Every note a caller places carries a copy, so the
 * name takes the bounded form a presence name takes (see
 * `normalizePresenceParticipantName()`), and is the empty string where neither
 * leaves anything.
 */
export function noteAuthorName(
  agentName: string | undefined,
  viewerName: string,
): string {
  return normalizePresenceParticipantName(agentName ?? "") ||
    normalizePresenceParticipantName(viewerName);
}

/** Returns the name to show for whoever placed `note`. */
export function authorNameOf(note: PlacedNote): string {
  return note.authorName?.trim() || "Someone";
}

/**
 * Returns every ring with what its lanes play and the notes on it, each ring's
 * notes ordered by step and then by lane.
 */
export function ringViews(
  layout: RingLayout,
  live: readonly LiveNote[],
): RingView[] {
  return layout.rings.map((ring, ringIndex) => ({
    id: ring.id,
    label: ring.label,
    voice: ring.voice,
    steps: ring.steps,
    lanes: Array.from(
      { length: layout.lanes },
      (_, lane) => laneLabel(layout, ring, lane),
    ),
    notes: live.filter((entry) => entry.ringIndex === ringIndex)
      .map(({ note }) => ({
        step: note.step,
        lane: note.lane,
        plays: laneLabel(layout, ring, note.lane),
        by: authorNameOf(note),
      }))
      .sort((a, b) => a.step - b.step || a.lane - b.lane),
  }));
}

/**
 * Returns one tally for each name the notes carry, the author with the most
 * notes first and equal counts in name order.
 */
export function authorTallies(live: readonly LiveNote[]): AuthorTally[] {
  const byName = new Map<string, Map<string, number>>();
  for (const { note } of live) {
    const colors = byName.get(authorNameOf(note)) ?? new Map<string, number>();
    colors.set(note.color, (colors.get(note.color) ?? 0) + 1);
    byName.set(authorNameOf(note), colors);
  }
  return [...byName].map(([name, colors]) => {
    const ranked = [...colors].sort((a, b) => b[1] - a[1]);
    return {
      name,
      color: ranked[0][0],
      count: ranked.reduce((total, [, count]) => total + count, 0),
    };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Returns the notes that sound when the step clock reaches `step`, a whole
 * number counted from the start of playback. Each ring wraps the count at its
 * own length, which is what lets rings of different lengths drift apart.
 */
export function notesAtStep(
  layout: RingLayout,
  live: readonly LiveNote[],
  step: number,
): LiveNote[] {
  return live.filter(({ ringIndex, note }) =>
    step % layout.rings[ringIndex].steps === note.step
  );
}

/**
 * Returns the tempo to play for a stored `tempoBpm`, within the offered range.
 */
export function normalizeTempo(tempoBpm: number): number {
  if (!Number.isFinite(tempoBpm)) return FALLBACK_TEMPO_BPM;
  return Math.min(MAX_TEMPO_BPM, Math.max(MIN_TEMPO_BPM, tempoBpm));
}

/**
 * Returns `tempoBpm` where it is a tempo the shared control offers.
 *
 * @throws {RangeError} When it is not a number from `MIN_TEMPO_BPM` to
 *   `MAX_TEMPO_BPM`.
 */
export function checkedTempo(tempoBpm: number): number {
  if (
    !Number.isFinite(tempoBpm) || tempoBpm < MIN_TEMPO_BPM ||
    tempoBpm > MAX_TEMPO_BPM
  ) {
    throw new RangeError(
      `A tempo is a number from ${MIN_TEMPO_BPM} to ${MAX_TEMPO_BPM}.`,
    );
  }
  return tempoBpm;
}

/**
 * Returns `volume` where it is a playback volume.
 *
 * @throws {RangeError} When it is not a number from 0 to 1.
 */
export function checkedVolume(volume: number): number {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    throw new RangeError("A volume is a number from 0 to 1.");
  }
  return volume;
}

/**
 * Returns `color` where it is one of `NOTE_COLORS`.
 *
 * @throws {RangeError} When it is any other string. The message lists the
 *   colors on offer.
 */
export function checkedColor(color: string): string {
  if (!NOTE_COLORS.includes(color)) {
    throw new RangeError(
      `A note color is one of: ${NOTE_COLORS.join(", ")}.`,
    );
  }
  return color;
}

/** Returns how long one step lasts at `tempoBpm`, in seconds. */
export function secondsPerStep(tempoBpm: number): number {
  return 60 / tempoBpm / STEPS_PER_BEAT;
}

/** Returns the step position `transport` holds at audio time `time`. */
export function positionAt(transport: Transport, time: number): number {
  return transport.anchorStep +
    (time - transport.anchorTime) / secondsPerStep(transport.tempoBpm);
}

/** Returns the audio time at which `transport` reaches `step`. */
export function timeOfStep(transport: Transport, step: number): number {
  return transport.anchorTime +
    (step - transport.anchorStep) * secondsPerStep(transport.tempoBpm);
}

/**
 * Returns a clock that holds the position `transport` has at `time` and
 * advances at `tempoBpm` from there, so a tempo change moves no hand.
 */
export function retimed(
  transport: Transport,
  time: number,
  tempoBpm: number,
): Transport {
  return {
    anchorStep: positionAt(transport, time),
    anchorTime: time,
    tempoBpm,
  };
}

/** Returns each whole step from `from` up to but not including `to`. */
export function stepsBetween(from: number, to: number): number[] {
  const steps: number[] = [];
  for (let step = Math.ceil(from); step < to; step++) steps.push(step);
  return steps;
}

/**
 * Returns how far around a ring of `steps` steps its hand is at `position`, as
 * a fraction of a turn clockwise from the top.
 */
export function handTurn(position: number, steps: number): number {
  return ((position % steps) + steps) % steps / steps;
}

/** Returns the MIDI note number `lane` of `ring` sounds at. */
export function laneMidi(layout: RingLayout, ring: Ring, lane: number): number {
  return layout.rootMidi + ring.transpose + layout.scale[lane];
}

/** Returns the frequency of MIDI note number `midi`, in hertz. */
export function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Returns the drum sound that `lane` of a drum ring plays. */
export function drumSound(lane: number): DrumSound {
  return DRUM_SOUNDS[lane % DRUM_SOUNDS.length];
}

/**
 * Returns what `lane` of `ring` plays, as a reader would name it: the drum
 * sound for a drum ring, and otherwise the note with its octave, such as `A3`.
 */
export function laneLabel(
  layout: RingLayout,
  ring: Ring,
  lane: number,
): string {
  if (ring.voice === "drums") return drumSound(lane);
  const midi = Math.round(laneMidi(layout, ring, lane));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  return `${name}${Math.floor(midi / 12) - 1}`;
}

/**
 * Returns the color a participant's notes take until they choose one. The same
 * `authorId` always maps to the same color, and two participants may share
 * one.
 */
export function defaultColor(authorId: string): string {
  // The 32-bit FNV-1a hash, which spreads similar identifiers across the list.
  let hash = 0x811c9dc5;
  for (let index = 0; index < authorId.length; index++) {
    hash ^= authorId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return NOTE_COLORS[hash % NOTE_COLORS.length];
}

/** Returns whether `value` is a whole number indexing one of `length` slots. */
function isIndexBelow(value: number, length: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < length;
}

/** Returns whether `value` is a record whose fields can be read by name. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Helper for `neighborCell()`, which returns the cell of `lane` in ring
 * `ringIndex` at the angle of the middle of `cell`, or `cell` where the layout
 * has no such ring.
 */
function crossedCell(
  layout: RingLayout,
  cell: Cell,
  ringIndex: number,
  lane: number,
): Cell {
  const target = layout.rings[ringIndex];
  if (!target) return cell;
  const turn = (cell.step + 0.5) / layout.rings[cell.ringIndex].steps;
  return { ringIndex, step: Math.floor(turn * target.steps), lane };
}

/**
 * Helper for `liveNotes()`, which reads a stored value as a note, or returns
 * `undefined` where a field of a note is missing or of the wrong type. The
 * `authorName` is read in the bounded form `noteAuthorName()` writes, and reads
 * as absent where it is not a string or nothing of it is left.
 */
function readNote(value: unknown): PlacedNote | undefined {
  if (!isRecord(value)) return undefined;
  const { ringId, step, lane, authorId, color } = value;
  if (
    typeof ringId !== "string" || typeof step !== "number" ||
    typeof lane !== "number" || typeof authorId !== "string" ||
    typeof color !== "string"
  ) {
    return undefined;
  }
  const authorName = typeof value.authorName === "string"
    ? normalizePresenceParticipantName(value.authorName)
    : "";
  return {
    ringId,
    step,
    lane,
    authorId,
    color,
    ...(authorName !== "" && { authorName }),
  };
}

//
// Presence
//
// What a participant publishes to the `jam` room, read back defensively: a
// facet is whatever another guest wrote, so every field is checked and a facet
// that does not fit is ignored.
//

/** Name of the presence room every participant on a piece shares. */
export const JAM_ROOM = "jam";

/** Facet holding the color a participant's notes and pointer are drawn in. */
export const LOOK_FACET = "look";

/** Facet holding where a participant's pointer is over the rings. */
export const POINTER_FACET = "pointer";

/** Facet holding where a participant's playback was at one wall-clock time. */
export const HAND_FACET = "hand";

/** Facet holding a participant's most recent jam-pad presses. */
export const PRESSES_FACET = "presses";

/** Most presses a participant's facet keeps, oldest first. */
export const MAX_PRESSES = 8;

/** Keys that play the jam pads, one row per ring from the innermost. */
export const PAD_KEY_ROWS: readonly string[] = [
  "12345678",
  "qwertyui",
  "asdfghjk",
  "zxcvbnm,",
];

/** Furthest from the center a published pointer is drawn, in ring radii. */
const MAX_POINTER_RADIUS = 1.2;

/**
 * Where a participant's playback was: the step position it held at wall-clock
 * time `at`, advancing at `bpm` from there.
 */
export interface PeerHand {
  /** Step position at `at`. */
  readonly step: number;

  /** Wall-clock time, in milliseconds since the epoch. */
  readonly at: number;

  /** Tempo the hand advances at, in beats per minute. */
  readonly bpm: number;
}

/** One press of a jam pad. */
export interface PadPress {
  /** Number of the press, increasing within one membership of the room. */
  readonly id: number;

  /** Identifier of the ring whose instrument and lane were played. */
  readonly ring: string;

  /** Lane of that ring, from 0. */
  readonly lane: number;
}

/** A point over the rings, measured from the center in ring radii. */
export interface RingPoint {
  /** Distance right of the center. */
  readonly x: number;

  /** Distance below the center. */
  readonly y: number;
}

/** One other participant, as this guest draws and plays them. */
export interface Peer {
  /** Membership the record belongs to. */
  readonly id: string;

  /** Name the participant published. */
  readonly name: string;

  /** Color to draw the participant in. */
  readonly color: string;

  /** Where the participant's pointer is, or `undefined` when off the rings. */
  readonly pointer?: RingPoint;

  /** Where the participant's playback is, or `undefined` when stopped. */
  readonly hand?: PeerHand;

  /** The participant's most recent presses, oldest first. */
  readonly presses: readonly PadPress[];
}

/** A presence record, as the room delivers it. */
export interface PeerRecord {
  /** Membership the record belongs to. */
  readonly participantId: string;

  /** Name the participant published. */
  readonly name: string;

  /** What the participant published, by facet name. */
  readonly facets: Readonly<Record<string, unknown>>;
}

/**
 * Returns `record` as a peer. A facet of the wrong shape reads as absent, and a
 * color that is not one of `NOTE_COLORS` reads as the membership's default.
 */
export function readPeer(record: PeerRecord): Peer {
  const { facets } = record;
  const look = facets[LOOK_FACET];
  const color = isRecord(look) && typeof look.color === "string" &&
      NOTE_COLORS.includes(look.color)
    ? look.color
    : defaultColor(record.participantId);
  const pointer = readRingPoint(facets[POINTER_FACET]);
  const hand = readHand(facets[HAND_FACET]);
  return {
    id: record.participantId,
    name: record.name.trim() || "Someone",
    color,
    ...(pointer && { pointer }),
    ...(hand && { hand }),
    presses: readPresses(facets[PRESSES_FACET]),
  };
}

/**
 * Returns the step position `hand` has reached at wall-clock time `nowMs`, or
 * 0 while that is still before the first step, as during the delay a clock
 * starts with. A time before the hand's own, as a sender's clock running
 * ahead produces, reads as the hand's own.
 */
export function peerHandPosition(hand: PeerHand, nowMs: number): number {
  const elapsedSeconds = Math.max(0, nowMs - hand.at) / 1000;
  return Math.max(0, hand.step + elapsedSeconds / secondsPerStep(hand.bpm));
}

/**
 * Returns a step clock that plays in step with `hand`: at audio time
 * `audioNow + delaySeconds` it holds the position `hand` reaches at wall-clock
 * time `nowMs` plus the same delay, and it advances at the hand's tempo. It is
 * only as close to the peer's as the two machines' wall clocks are to each
 * other.
 */
export function followingClock(
  hand: PeerHand,
  nowMs: number,
  audioNow: number,
  delaySeconds: number,
): Transport {
  return {
    anchorStep: peerHandPosition(hand, nowMs + delaySeconds * 1000),
    anchorTime: audioNow + delaySeconds,
    tempoBpm: hand.bpm,
  };
}

/**
 * Returns whether moving from `current` to `next` at audio time `audioNow`
 * shifts the playing position by `maxShiftSteps` or more, as a peer restarting
 * does. A smaller shift is clock jitter, under which the steps already queued
 * stand.
 */
export function isClockJump(
  current: Transport,
  next: Transport,
  audioNow: number,
  maxShiftSteps: number,
): boolean {
  return Math.abs(positionAt(next, audioNow) - positionAt(current, audioNow)) >=
    maxShiftSteps;
}

/**
 * Returns the largest shift, in steps, that counts as clock jitter at
 * `tempoBpm`: half a step, or less where half the lookahead is shorter than
 * that. A shift under half the lookahead can move the playing position past
 * no step the queue has not yet reached, so keeping the queue drops none.
 */
export function maxJitterSteps(
  tempoBpm: number,
  lookaheadSeconds: number,
): number {
  return Math.min(0.5, lookaheadSeconds / 2 / secondsPerStep(tempoBpm));
}

/** What following a peer's latest hand does to this browser's clock. */
export interface FollowStep {
  /** The clock to play by from now on. */
  readonly clock: Transport;

  /**
   * The step position to queue notes from, where the queue starts afresh, or
   * `undefined` where the notes already queued stand.
   */
  readonly restartQueueAt?: number;

  /**
   * Whether the room should hear this browser's hand: the clock started, its
   * tempo changed, or it jumped. A jitter-sized re-sync is not announced, so
   * two people following each other settle instead of answering each other.
   */
  readonly announce: boolean;
}

/**
 * Returns how to follow `hand` from `current`, this browser's running clock,
 * or from a stopped one when `current` is `undefined`. The times are as
 * `followingClock()` takes them.
 */
export function followStep(
  current: Transport | undefined,
  hand: PeerHand,
  nowMs: number,
  audioNow: number,
  delaySeconds: number,
  lookaheadSeconds: number,
): FollowStep {
  const clock = followingClock(hand, nowMs, audioNow, delaySeconds);
  const restartQueueAt = positionAt(clock, audioNow);
  if (!current) return { clock, restartQueueAt, announce: true };
  const jumped = isClockJump(
    current,
    clock,
    audioNow,
    maxJitterSteps(clock.tempoBpm, lookaheadSeconds),
  );
  return {
    clock,
    ...(jumped && { restartQueueAt }),
    announce: jumped || current.tempoBpm !== clock.tempoBpm,
  };
}

/** Returns the presses in `presses` numbered above `lastSeen`, oldest first. */
export function freshPresses(
  presses: readonly PadPress[],
  lastSeen: number,
): PadPress[] {
  return presses.filter((press) => press.id > lastSeen);
}

/**
 * Returns `name` as a presence record carries it, in the form the relay takes
 * (see `normalizePresenceParticipantName()`), or `Guest` where nothing of it
 * is left.
 */
export function presenceName(name: string): string {
  return normalizePresenceParticipantName(name) || "Guest";
}

/** Returns the highest press number in `presses`, or `undefined` for none. */
export function lastPressId(presses: readonly PadPress[]): number | undefined {
  return presses.length === 0
    ? undefined
    : presses.reduce((highest, press) => Math.max(highest, press.id), -1);
}

/** Returns `presses` with `press` appended, keeping the newest ones. */
export function withPress(
  presses: readonly PadPress[],
  press: PadPress,
): PadPress[] {
  return [...presses, press].slice(-MAX_PRESSES);
}

/**
 * Returns the pad `key` plays: the ring is the key's row in `PAD_KEY_ROWS`
 * and the lane its place in the row. Returns `undefined` for any other key,
 * and for a row or lane the layout does not have.
 */
export function padForKey(
  layout: RingLayout,
  key: string,
): { readonly ringIndex: number; readonly lane: number } | undefined {
  const lower = key.toLowerCase();
  const ringIndex = PAD_KEY_ROWS.findIndex((row) => row.includes(lower));
  if (ringIndex < 0 || ringIndex >= layout.rings.length) return undefined;
  const lane = PAD_KEY_ROWS[ringIndex].indexOf(lower);
  return lane < layout.lanes ? { ringIndex, lane } : undefined;
}

/** Returns the key that plays lane `lane` of ring `ringIndex`, if any. */
export function keyForPad(ringIndex: number, lane: number): string | undefined {
  return PAD_KEY_ROWS[ringIndex]?.[lane];
}

/** Helper for `readPeer()`, which reads a pointer facet. */
function readRingPoint(value: unknown): RingPoint | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y } = value;
  if (typeof x !== "number" || typeof y !== "number") return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return Math.hypot(x, y) > MAX_POINTER_RADIUS ? undefined : { x, y };
}

/** Helper for `readPeer()`, which reads a hand facet. */
function readHand(value: unknown): PeerHand | undefined {
  if (!isRecord(value)) return undefined;
  const { step, at, bpm } = value;
  if (
    typeof step !== "number" || typeof at !== "number" ||
    typeof bpm !== "number" || !Number.isFinite(step) || !Number.isFinite(at)
  ) {
    return undefined;
  }
  return { step, at, bpm: normalizeTempo(bpm) };
}

/** Helper for `readPeer()`, which reads a presses facet. */
function readPresses(value: unknown): PadPress[] {
  if (!isRecord(value) || !Array.isArray(value.list)) return [];
  return value.list.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    const { id, ring, lane } = entry;
    return typeof id === "number" && Number.isInteger(id) &&
        typeof ring === "string" && typeof lane === "number" &&
        Number.isInteger(lane)
      ? [{ id, ring, lane }]
      : [];
  }).slice(-MAX_PRESSES);
}
