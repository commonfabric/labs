import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  DEFAULT_SETUP,
  DEFAULT_STATE,
  type PlacedNote,
  type RingLoopsSetup,
} from "./contract.ts";
import {
  authorNameOf,
  authorTallies,
  cellAt,
  cellKey,
  cellOf,
  cellShape,
  checkedColor,
  checkedTempo,
  checkedVolume,
  defaultColor,
  FALLBACK_TEMPO_BPM,
  followingClock,
  followStep,
  freshPresses,
  HAND_FACET,
  handTurn,
  isClockJump,
  keyForPad,
  laneLabel,
  laneMidi,
  lastPressId,
  liveNotes,
  LOOK_FACET,
  MAX_PRESSES,
  MAX_TEMPO_BPM,
  maxJitterSteps,
  midiToFrequency,
  MIN_TEMPO_BPM,
  neighborCell,
  normalizeTempo,
  NOTE_COLORS,
  noteAuthorName,
  noteFor,
  notesAtStep,
  padForKey,
  peerHandPosition,
  POINTER_FACET,
  positionAt,
  presenceName,
  PRESSES_FACET,
  readPeer,
  retimed,
  ringBands,
  ringLayoutOf,
  ringViews,
  secondsPerStep,
  stepsBetween,
  timeOfStep,
  toggleEdit,
  type Transport,
  uniqueCells,
  validLayoutOf,
  withPress,
} from "./model.ts";

const layout = ringLayoutOf(DEFAULT_SETUP);

const TAU = 2 * Math.PI;

/** The point at `radius` from the center, `turn` clockwise from the top. */
function pointAt(radius: number, turn: number): [number, number] {
  return [radius * Math.sin(turn * TAU), -radius * Math.cos(turn * TAU)];
}

const ada = { id: "ada", name: "Ada", color: "#4dabf7" };

function noteAt(ringId: string, step: number, lane: number): PlacedNote {
  return {
    ringId,
    step,
    lane,
    authorId: "ada",
    color: "#4dabf7",
    authorName: "Ada",
  };
}

function setupWith(overrides: Partial<RingLoopsSetup>): RingLoopsSetup {
  return { ...DEFAULT_SETUP, ...overrides };
}

describe("model", () => {
  describe("ringLayoutOf()", () => {
    it("counts each ring's loop in steps of a sixteenth note", () => {
      expect(layout.rings.map((ring) => ring.steps)).toEqual([16, 20, 24, 32]);
    });

    it("takes one lane from each step of the scale", () => {
      expect(layout.lanes).toBe(DEFAULT_SETUP.scale.length);
    });

    it("throws a `RangeError` for a setup with no rings", () => {
      expect(() => ringLayoutOf(setupWith({ rings: [] }))).toThrow(RangeError);
    });

    it("throws a `TypeError` when two rings share an id", () => {
      const [first] = DEFAULT_SETUP.rings;
      expect(() => ringLayoutOf(setupWith({ rings: [first, first] })))
        .toThrow(TypeError);
    });

    it("throws a `RangeError` for a ring with a fractional beat count", () => {
      const [first] = DEFAULT_SETUP.rings;
      expect(() =>
        ringLayoutOf(setupWith({ rings: [{ ...first, beats: 2.5 }] }))
      ).toThrow(RangeError);
    });

    it("throws a `RangeError` for an empty scale", () => {
      expect(() => ringLayoutOf(setupWith({ scale: [] }))).toThrow(RangeError);
    });

    it("throws a `RangeError` for a pitched ring that would play above MIDI 127", () => {
      expect(() => ringLayoutOf(setupWith({ rootMidi: 120 }))).toThrow(
        RangeError,
      );
    });

    it("throws a `RangeError` for a pitched ring that would play below MIDI 0", () => {
      const [drums, bells, bass, pluck] = DEFAULT_SETUP.rings;
      const sunk = { ...bass, transpose: -80 };
      expect(() =>
        ringLayoutOf(setupWith({ rings: [drums, bells, sunk, pluck] }))
      ).toThrow(RangeError);
    });

    it("returns a layout whatever the root, where every ring is drums", () => {
      const [drums] = DEFAULT_SETUP.rings;
      expect(ringLayoutOf(setupWith({ rings: [drums], rootMidi: 500 })).lanes)
        .toBe(5);
    });
  });

  describe("validLayoutOf()", () => {
    it("returns the layout of a setup `ringLayoutOf()` accepts", () => {
      expect(validLayoutOf(DEFAULT_SETUP)).toEqual(layout);
    });

    it("returns `undefined` for a setup with no rings", () => {
      expect(validLayoutOf(setupWith({ rings: [] }))).toBeUndefined();
    });
  });

  describe("ringBands()", () => {
    it("orders the bands outward without overlap, ending at the unit radius", () => {
      const bands = ringBands(4);
      expect(bands[0].inner).toBeGreaterThan(0);
      for (let index = 0; index < bands.length; index++) {
        expect(bands[index].outer).toBeGreaterThan(bands[index].inner);
        if (index > 0) {
          expect(bands[index].inner).toBeGreaterThan(bands[index - 1].outer);
        }
      }
      expect(bands[3].outer).toBeCloseTo(1, 12);
    });
  });

  describe("neighborCell()", () => {
    it("returns the next step clockwise, wrapping past the last", () => {
      expect(
        neighborCell(layout, { ringIndex: 0, step: 15, lane: 2 }, "clockwise"),
      ).toEqual({ ringIndex: 0, step: 0, lane: 2 });
    });

    it("returns the step before anticlockwise, wrapping past the first", () => {
      expect(
        neighborCell(
          layout,
          { ringIndex: 1, step: 0, lane: 1 },
          "anticlockwise",
        ),
      ).toEqual({ ringIndex: 1, step: 19, lane: 1 });
    });

    it("returns the next lane outward within the band", () => {
      expect(
        neighborCell(layout, { ringIndex: 2, step: 5, lane: 1 }, "outward"),
      ).toEqual({ ringIndex: 2, step: 5, lane: 2 });
    });

    it("returns the lane before inward within the band", () => {
      expect(
        neighborCell(layout, { ringIndex: 2, step: 5, lane: 1 }, "inward"),
      ).toEqual({ ringIndex: 2, step: 5, lane: 0 });
    });

    it("returns the first lane of the next ring, at the nearest angle, past the band's outer edge", () => {
      // Step 8 of 16 is centered at 0.53 of a turn, which falls in step 10 of
      // the next ring's 20.

      expect(
        neighborCell(layout, { ringIndex: 0, step: 8, lane: 4 }, "outward"),
      ).toEqual({ ringIndex: 1, step: 10, lane: 0 });
    });

    it("returns the last lane of the ring inside, at the nearest angle, past the band's inner edge", () => {
      // Step 10 of 20 is centered at 0.525 of a turn, which falls in step 8
      // of the inner ring's 16.

      expect(
        neighborCell(layout, { ringIndex: 1, step: 10, lane: 0 }, "inward"),
      ).toEqual({ ringIndex: 0, step: 8, lane: 4 });
    });

    it("returns the cell itself past the outermost and the innermost lane", () => {
      const outermost = { ringIndex: 3, step: 5, lane: 4 };
      const innermost = { ringIndex: 0, step: 3, lane: 0 };
      expect([
        neighborCell(layout, outermost, "outward"),
        neighborCell(layout, innermost, "inward"),
      ]).toEqual([outermost, innermost]);
    });
  });

  describe("cellAt()", () => {
    const [innermost] = ringBands(layout.rings.length);

    it("returns the first step just clockwise of the top", () => {
      const [x, y] = pointAt(innermost.inner + 0.001, 0.001);
      expect(cellAt(layout, x, y)).toEqual({ ringIndex: 0, step: 0, lane: 0 });
    });

    it("returns the last step just counterclockwise of the top", () => {
      const [x, y] = pointAt(innermost.inner + 0.001, 0.999);
      expect(cellAt(layout, x, y)).toEqual({ ringIndex: 0, step: 15, lane: 0 });
    });

    it("counts steps clockwise, so the right-hand side is a quarter turn in", () => {
      const [x, y] = pointAt(innermost.inner + 0.001, 0.2501);
      expect(cellAt(layout, x, y)?.step).toBe(4);
    });

    it("returns the outermost lane just inside a band's outer edge", () => {
      const [x, y] = pointAt(innermost.outer - 0.001, 0.001);
      expect(cellAt(layout, x, y)?.lane).toBe(layout.lanes - 1);
    });

    it("returns `undefined` in the hub", () => {
      expect(cellAt(layout, 0, 0)).toBeUndefined();
    });

    it("returns `undefined` in the gap between two rings", () => {
      const bands = ringBands(layout.rings.length);
      const [x, y] = pointAt((bands[0].outer + bands[1].inner) / 2, 0.3);
      expect(cellAt(layout, x, y)).toBeUndefined();
    });

    it("returns `undefined` outside the outermost ring", () => {
      expect(cellAt(layout, 0, -1.01)).toBeUndefined();
    });
  });

  describe("cellShape()", () => {
    it("encloses a center that `cellAt()` maps back to the same cell, for every cell", () => {
      for (const [ringIndex, ring] of layout.rings.entries()) {
        for (let step = 0; step < ring.steps; step++) {
          for (let lane = 0; lane < layout.lanes; lane++) {
            const cell = { ringIndex, step, lane };
            const shape = cellShape(layout, cell);
            const [x, y] = pointAt(
              (shape.inner + shape.outer) / 2,
              (shape.startTurn + shape.endTurn) / 2,
            );
            expect(cellAt(layout, x, y)).toEqual(cell);
          }
        }
      }
    });
  });

  describe("cellKey()", () => {
    it("returns the ring id, the step, and the lane joined by colons", () => {
      expect(cellKey("bass", 3, 1)).toBe("bass:3:1");
    });
  });

  describe("liveNotes()", () => {
    it("returns every starter note of the default state", () => {
      const live = liveNotes(layout, DEFAULT_STATE.notes);
      expect(live.length).toBe(Object.keys(DEFAULT_STATE.notes).length);
      expect(live.length).toBeGreaterThan(0);
    });

    it("returns a note with the index of its ring", () => {
      const note = noteAt("bass", 3, 1);
      expect(liveNotes(layout, { "bass:3:1": note })).toEqual([
        { ringIndex: 2, note },
      ]);
    });

    it("omits a removed note", () => {
      expect(liveNotes(layout, { "bass:3:1": null })).toEqual([]);
    });

    it("omits a note whose ring the layout lacks", () => {
      expect(liveNotes(layout, { "organ:3:1": noteAt("organ", 3, 1) }))
        .toEqual([]);
    });

    it("omits a note whose step lies past the end of its ring", () => {
      expect(liveNotes(layout, { "drums:16:0": noteAt("drums", 16, 0) }))
        .toEqual([]);
    });

    it("omits a note whose lane lies outside the band", () => {
      expect(liveNotes(layout, { "drums:0:5": noteAt("drums", 0, 5) }))
        .toEqual([]);
    });

    it("omits a note stored under another cell's key", () => {
      expect(liveNotes(layout, { "drums:1:0": noteAt("drums", 0, 0) }))
        .toEqual([]);
    });

    it("returns a stored note whose `authorName` is not a string without one", () => {
      // Anyone with write access to the space can store a note, so a name of
      // the wrong type must not reach the code that trims names.

      const stored = {
        ringId: "bass",
        step: 3,
        lane: 1,
        authorId: "someone",
        color: "#4dabf7",
        authorName: 42,
      };
      const live = liveNotes(layout, { "bass:3:1": stored });
      expect(live).toEqual([{
        ringIndex: 2,
        note: {
          ringId: "bass",
          step: 3,
          lane: 1,
          authorId: "someone",
          color: "#4dabf7",
        },
      }]);
      expect(authorNameOf(live[0].note)).toBe("Someone");
    });

    it("returns a stored note's `authorName` without control characters and cut to 80 code points", () => {
      const stored = {
        ...noteAt("bass", 3, 1),
        authorName: `Agent\u0007 ${"x".repeat(500)}`,
      };
      const [{ note }] = liveNotes(layout, { "bass:3:1": stored });
      expect(note.authorName).toBe(`Agent ${"x".repeat(74)}`);
    });

    it("returns a stored note whose `authorName` leaves nothing without one", () => {
      const stored = { ...noteAt("bass", 3, 1), authorName: "\u0007 " };
      const [{ note }] = liveNotes(layout, { "bass:3:1": stored });
      expect(Object.hasOwn(note, "authorName")).toBe(false);
    });

    it("omits a stored value that lacks a field of a note", () => {
      const stored = { ringId: "bass", step: 3, lane: 1, color: "#4dabf7" };
      expect(liveNotes(layout, { "bass:3:1": stored, "bass:4:1": "bass" }))
        .toEqual([]);
    });
  });

  describe("noteFor()", () => {
    const cell = { ringIndex: 1, step: 7, lane: 2 };

    it("returns a note in the cell that carries the author's id, name, and color", () => {
      expect(noteFor(layout, cell, ada)).toEqual(noteAt("bells", 7, 2));
    });

    it("returns a note with no `authorName` for an author with no name", () => {
      const note = noteFor(layout, cell, { ...ada, name: "" });
      expect(Object.hasOwn(note, "authorName")).toBe(false);
    });
  });

  describe("toggleEdit()", () => {
    const cell = { ringIndex: 1, step: 7, lane: 2 };

    it("places a note by the author in an empty cell", () => {
      expect(toggleEdit(layout, {}, cell, ada)).toEqual({
        key: "bells:7:2",
        value: noteAt("bells", 7, 2),
      });
    });

    it("removes the note from an occupied cell", () => {
      const notes = { "bells:7:2": noteAt("bells", 7, 2) };
      const grace = { id: "grace", name: "Grace", color: "#ff6b6b" };
      expect(toggleEdit(layout, notes, cell, grace)).toEqual({
        key: "bells:7:2",
        value: null,
      });
    });

    it("places a note in a cell whose note was removed", () => {
      const edit = toggleEdit(layout, { "bells:7:2": null }, cell, ada);
      expect(edit.value?.authorId).toBe("ada");
    });
  });

  describe("cellOf()", () => {
    it("returns the cell a ring id, a step, and a lane name", () => {
      expect(cellOf(layout, { ring: "bass", step: 23, lane: 4 })).toEqual({
        ringIndex: 2,
        step: 23,
        lane: 4,
      });
    });

    it("throws a `RangeError` listing the ring ids for an unknown ring", () => {
      expect(() => cellOf(layout, { ring: "organ", step: 0, lane: 0 }))
        .toThrow("The rings are: drums, bells, bass, pluck.");
    });

    it("throws a `RangeError` naming the last step for a step past the ring's end", () => {
      expect(() => cellOf(layout, { ring: "bass", step: 24, lane: 0 }))
        .toThrow("from 0 to 23");
    });

    it("throws a `RangeError` for a fractional step", () => {
      expect(() => cellOf(layout, { ring: "bass", step: 1.5, lane: 0 }))
        .toThrow(RangeError);
    });

    it("throws a `RangeError` naming the last lane for a lane outside the band", () => {
      expect(() => cellOf(layout, { ring: "bass", step: 0, lane: 5 }))
        .toThrow("from 0 to 4");
    });
  });

  describe("uniqueCells()", () => {
    it("returns each cell once, in the order first named", () => {
      const a = { ringIndex: 0, step: 1, lane: 0 };
      const b = { ringIndex: 2, step: 4, lane: 3 };
      expect(uniqueCells(layout, [a, b, { ...a }, b])).toEqual([a, b]);
    });
  });

  describe("noteAuthorName()", () => {
    it("returns the agent's name in preference to the viewer's", () => {
      expect(noteAuthorName("Test Agent", "Ada")).toBe("Test Agent");
    });

    it("returns the viewer's name where the agent gives none", () => {
      expect(noteAuthorName(undefined, " Ada ")).toBe("Ada");
    });

    it("returns at most 80 code points, with control characters removed", () => {
      expect(noteAuthorName(`Agent\u0007 ${"x".repeat(500)}`, "Ada"))
        .toBe(`Agent ${"x".repeat(74)}`);
    });

    it("returns the empty string where neither name leaves anything", () => {
      expect(noteAuthorName("\u0007", "  ")).toBe("");
    });
  });

  describe("authorNameOf()", () => {
    it("returns the name the note carries", () => {
      expect(authorNameOf(noteAt("bass", 0, 0))).toBe("Ada");
    });

    it("returns `Someone` for a note that carries no name", () => {
      const { authorName: _, ...unnamed } = noteAt("bass", 0, 0);
      expect(authorNameOf(unnamed)).toBe("Someone");
    });
  });

  describe("ringViews()", () => {
    const live = liveNotes(layout, {
      "drums:8:0": noteAt("drums", 8, 0),
      "drums:4:1": noteAt("drums", 4, 1),
      "drums:4:0": noteAt("drums", 4, 0),
    });
    const [drums, bells] = ringViews(layout, live);

    it("returns each ring's id and loop length in steps", () => {
      expect(ringViews(layout, live).map((ring) => [ring.id, ring.steps]))
        .toEqual([["drums", 16], ["bells", 20], ["bass", 24], ["pluck", 32]]);
    });

    it("lists what each lane of a drum ring plays", () => {
      expect(drums.lanes).toEqual(["kick", "snare", "hat", "clap", "tom"]);
    });

    it("lists the note each lane of a pitched ring plays", () => {
      expect(bells.lanes).toEqual(["A4", "C5", "D5", "E5", "G5"]);
    });

    it("orders a ring's notes by step and then by lane", () => {
      expect(drums.notes).toEqual([
        { step: 4, lane: 0, plays: "kick", by: "Ada" },
        { step: 4, lane: 1, plays: "snare", by: "Ada" },
        { step: 8, lane: 0, plays: "kick", by: "Ada" },
      ]);
    });

    it("lists no notes for a ring nothing is placed on", () => {
      expect(bells.notes).toEqual([]);
    });
  });

  describe("authorTallies()", () => {
    it("returns one tally for each name, the larger count first", () => {
      const grace = { ...noteAt("bass", 0, 0), authorName: "Grace" };
      const live = liveNotes(layout, {
        "bass:0:0": grace,
        "drums:0:0": noteAt("drums", 0, 0),
        "drums:4:0": noteAt("drums", 4, 0),
      });
      expect(authorTallies(live).map((tally) => [tally.name, tally.count]))
        .toEqual([["Ada", 2], ["Grace", 1]]);
    });

    it("returns the color most of an author's notes are drawn in", () => {
      const live = liveNotes(layout, {
        "bass:0:0": { ...noteAt("bass", 0, 0), color: "#ff6b6b" },
        "drums:0:0": noteAt("drums", 0, 0),
        "drums:4:0": noteAt("drums", 4, 0),
      });
      expect(authorTallies(live)).toEqual([
        { name: "Ada", color: "#4dabf7", count: 3 },
      ]);
    });

    it("returns no tally for rings with no notes", () => {
      expect(authorTallies([])).toEqual([]);
    });
  });

  describe("notesAtStep()", () => {
    const drum = { ringIndex: 0, note: noteAt("drums", 3, 0) };
    const bell = { ringIndex: 1, note: noteAt("bells", 3, 0) };
    const live = [drum, bell];

    it("returns the notes placed at the step", () => {
      expect(notesAtStep(layout, live, 3)).toEqual([drum, bell]);
    });

    it("returns no note at a step nothing is placed on", () => {
      expect(notesAtStep(layout, live, 4)).toEqual([]);
    });

    it("wraps each ring at its own length", () => {
      expect(notesAtStep(layout, live, 19)).toEqual([drum]);
      expect(notesAtStep(layout, live, 23)).toEqual([bell]);
    });
  });

  describe("normalizeTempo()", () => {
    it("returns a tempo inside the range unchanged", () => {
      expect(normalizeTempo(120)).toBe(120);
    });

    it("returns the nearest bound for a tempo outside the range", () => {
      expect(normalizeTempo(5)).toBe(MIN_TEMPO_BPM);
      expect(normalizeTempo(900)).toBe(MAX_TEMPO_BPM);
    });

    it("returns the fallback for a value that is not a number", () => {
      expect(normalizeTempo(NaN)).toBe(FALLBACK_TEMPO_BPM);
    });
  });

  describe("checkedTempo()", () => {
    it("returns a tempo at either bound unchanged", () => {
      expect(checkedTempo(MIN_TEMPO_BPM)).toBe(MIN_TEMPO_BPM);
      expect(checkedTempo(MAX_TEMPO_BPM)).toBe(MAX_TEMPO_BPM);
    });

    it("throws a `RangeError` for a tempo outside the range", () => {
      expect(() => checkedTempo(MAX_TEMPO_BPM + 1)).toThrow(RangeError);
      expect(() => checkedTempo(MIN_TEMPO_BPM - 1)).toThrow(RangeError);
    });

    it("throws a `RangeError` for a value that is not a number", () => {
      expect(() => checkedTempo(NaN)).toThrow(RangeError);
    });
  });

  describe("checkedVolume()", () => {
    it("returns a volume at either bound unchanged", () => {
      expect(checkedVolume(0)).toBe(0);
      expect(checkedVolume(1)).toBe(1);
    });

    it("throws a `RangeError` for a volume outside 0 to 1", () => {
      expect(() => checkedVolume(1.01)).toThrow(RangeError);
      expect(() => checkedVolume(-0.01)).toThrow(RangeError);
    });
  });

  describe("checkedColor()", () => {
    it("returns a color the palette offers unchanged", () => {
      expect(checkedColor(NOTE_COLORS[3])).toBe(NOTE_COLORS[3]);
    });

    it("throws a `RangeError` for any other string", () => {
      expect(() => checkedColor("red")).toThrow(RangeError);
    });
  });

  describe("step clock", () => {
    const transport: Transport = {
      anchorStep: 4,
      anchorTime: 10,
      tempoBpm: 120,
    };

    it("lasts an eighth of a second per step at 120 beats per minute", () => {
      expect(secondsPerStep(120)).toBe(0.125);
    });

    it("advances eight steps in one second at 120 beats per minute", () => {
      expect(positionAt(transport, 11)).toBe(12);
    });

    it("reaches a step at the time `positionAt()` reports that step", () => {
      expect(positionAt(transport, timeOfStep(transport, 30))).toBe(30);
    });

    describe("retimed()", () => {
      it("holds the position the clock had at the moment of the change", () => {
        expect(positionAt(retimed(transport, 11, 60), 11)).toBe(12);
      });

      it("advances at the new tempo from that moment", () => {
        expect(positionAt(retimed(transport, 11, 60), 12)).toBe(16);
      });
    });
  });

  describe("stepsBetween()", () => {
    it("includes a whole lower bound and excludes the upper bound", () => {
      expect(stepsBetween(2, 5)).toEqual([2, 3, 4]);
    });

    it("starts at the first whole step after a fractional lower bound", () => {
      expect(stepsBetween(2.1, 4.5)).toEqual([3, 4]);
    });

    it("returns no step for a window that holds none", () => {
      expect(stepsBetween(2.1, 2.9)).toEqual([]);
    });

    it("returns each step once across two windows that share a bound", () => {
      expect([...stepsBetween(0, 2.5), ...stepsBetween(2.5, 5)]).toEqual([
        0,
        1,
        2,
        3,
        4,
      ]);
    });
  });

  describe("handTurn()", () => {
    it("returns 0 at the start of every loop", () => {
      expect(handTurn(0, 16)).toBe(0);
      expect(handTurn(32, 16)).toBe(0);
    });

    it("returns the fraction of the loop already swept", () => {
      expect(handTurn(20, 16)).toBe(0.25);
    });
  });

  describe("laneMidi()", () => {
    it("adds the ring's transposition and the lane's scale step to the root", () => {
      expect(laneMidi(layout, layout.rings[1], 1)).toBe(57 + 12 + 3);
    });
  });

  describe("midiToFrequency()", () => {
    it("returns 440 hertz for note 69", () => {
      expect(midiToFrequency(69)).toBe(440);
    });

    it("halves the frequency an octave down", () => {
      expect(midiToFrequency(57)).toBe(220);
    });
  });

  describe("laneLabel()", () => {
    it("returns the drum sound for a lane of a drum ring", () => {
      expect(laneLabel(layout, layout.rings[0], 1)).toBe("snare");
    });

    it("returns the note name and octave for a lane of a pitched ring", () => {
      expect(laneLabel(layout, layout.rings[3], 0)).toBe("A3");
      expect(laneLabel(layout, layout.rings[1], 1)).toBe("C5");
    });
  });

  describe("defaultColor()", () => {
    const authors = Array.from({ length: 50 }, (_, index) => `user-${index}`);

    it("returns one of the offered colors", () => {
      for (const author of authors) {
        expect(NOTE_COLORS).toContain(defaultColor(author));
      }
    });

    it("returns the same color for the same author", () => {
      expect(defaultColor("user-7")).toBe(defaultColor("user-7"));
    });

    it("returns more than one color across fifty authors", () => {
      expect(new Set(authors.map(defaultColor)).size).toBeGreaterThan(1);
    });
  });

  describe("readPeer()", () => {
    const base = { participantId: "peer-1", name: "Grace", facets: {} };

    it("returns the name, and the color the look facet names", () => {
      const peer = readPeer({
        ...base,
        facets: { [LOOK_FACET]: { color: "#69db7c" } },
      });
      expect([peer.name, peer.color]).toEqual(["Grace", "#69db7c"]);
    });

    it("returns the membership's default color for a color not on offer", () => {
      const peer = readPeer({
        ...base,
        facets: { [LOOK_FACET]: { color: "url(evil)" } },
      });
      expect(peer.color).toBe(defaultColor("peer-1"));
    });

    it("returns `Someone` for a blank name", () => {
      expect(readPeer({ ...base, name: "  " }).name).toBe("Someone");
    });

    it("returns a pointer inside the rings", () => {
      const peer = readPeer({
        ...base,
        facets: { [POINTER_FACET]: { x: 0.5, y: -0.25 } },
      });
      expect(peer.pointer).toEqual({ x: 0.5, y: -0.25 });
    });

    it("returns no pointer for one far outside the rings, or one that is not a number", () => {
      const far = readPeer({
        ...base,
        facets: { [POINTER_FACET]: { x: 40, y: 0 } },
      });
      const text = readPeer({
        ...base,
        facets: { [POINTER_FACET]: { x: "1", y: 0 } },
      });
      expect([far.pointer, text.pointer]).toEqual([undefined, undefined]);
    });

    it("returns a hand, with its tempo inside the offered range", () => {
      const peer = readPeer({
        ...base,
        facets: { [HAND_FACET]: { step: 3, at: 1000, bpm: 900 } },
      });
      expect(peer.hand).toEqual({ step: 3, at: 1000, bpm: MAX_TEMPO_BPM });
    });

    it("returns no hand for a facet missing its time", () => {
      const peer = readPeer({
        ...base,
        facets: { [HAND_FACET]: { step: 3, bpm: 96 } },
      });
      expect(peer.hand).toBeUndefined();
    });

    it("returns the well-formed presses and drops the rest", () => {
      const peer = readPeer({
        ...base,
        facets: {
          [PRESSES_FACET]: {
            list: [
              { id: 1, ring: "bass", lane: 2 },
              { id: 1.5, ring: "bass", lane: 2 },
              { id: 2, ring: 7, lane: 2 },
              { id: 3, ring: "drums", lane: 0 },
            ],
          },
        },
      });
      expect(peer.presses).toEqual([
        { id: 1, ring: "bass", lane: 2 },
        { id: 3, ring: "drums", lane: 0 },
      ]);
    });
  });

  describe("peerHandPosition()", () => {
    const hand = { step: 10, at: 5_000, bpm: 120 };

    it("advances eight steps a second at 120 beats per minute", () => {
      expect(peerHandPosition(hand, 6_000)).toBe(18);
    });

    it("returns the hand's own step for a time before the hand's", () => {
      expect(peerHandPosition(hand, 4_000)).toBe(10);
    });

    it("returns 0 until a negative step, as during a start delay, has run out", () => {
      const starting = { ...hand, step: -0.4 };
      expect(peerHandPosition(starting, 5_000)).toBe(0);
      expect(peerHandPosition(starting, 5_050)).toBe(0);
    });

    it("counts on from the negative step once it has run out, without a lead", () => {
      expect(peerHandPosition({ ...hand, step: -0.4 }, 6_050)).toBe(8);
    });
  });

  describe("followingClock()", () => {
    const hand = { step: 10, at: 5_000, bpm: 120 };

    it("holds the hand's position at the delayed moment, on this audio clock", () => {
      const clock = followingClock(hand, 6_000, 40, 0.5);
      expect(positionAt(clock, 40.5)).toBe(22);
    });

    it("advances at the hand's tempo", () => {
      const clock = followingClock(hand, 6_000, 40, 0.5);
      expect(positionAt(clock, 41.5)).toBe(30);
    });
  });

  describe("isClockJump()", () => {
    const current = { anchorStep: 0, anchorTime: 10, tempoBpm: 120 };

    it("returns `false` for a shift under the jitter bound", () => {
      const next = { ...current, anchorStep: 0.3 };
      expect(isClockJump(current, next, 12, 0.5)).toBe(false);
    });

    it("returns `true` for a shift at or over the jitter bound", () => {
      const next = { ...current, anchorStep: 0.3 };
      expect(isClockJump(current, next, 12, 0.25)).toBe(true);
    });

    it("returns `true` for a peer restarting from the top", () => {
      const next = { anchorStep: 0, anchorTime: 12, tempoBpm: 120 };
      expect(isClockJump(current, next, 12, 0.5)).toBe(true);
    });
  });

  describe("maxJitterSteps()", () => {
    it("returns half a step where half the lookahead is longer", () => {
      expect(maxJitterSteps(200, 1)).toBe(0.5);
    });

    it("returns half the lookahead, in steps, where that is shorter", () => {
      expect(maxJitterSteps(40, 0.12)).toBeCloseTo(0.16, 12);
    });
  });

  describe("followStep()", () => {
    const hand = { step: 10, at: 5_000, bpm: 120 };
    const step = (current: Transport | undefined, peer = hand) =>
      followStep(current, peer, 6_000, 40, 0.06, 0.12);
    const following = step(undefined).clock;

    it("starts the queue afresh and tells the room when the clock starts", () => {
      const start = step(undefined);
      expect([start.announce, start.restartQueueAt]).toEqual([
        true,
        positionAt(start.clock, 40),
      ]);
    });

    it("keeps the queue and tells the room nothing for a jitter-sized shift", () => {
      const nudged = step(following, { ...hand, at: 5_010 });
      expect([nudged.announce, nudged.restartQueueAt]).toEqual([
        false,
        undefined,
      ]);
    });

    it("tells the room when the tempo changes", () => {
      expect(step(following, { ...hand, bpm: 100 }).announce).toBe(true);
    });

    it("starts the queue afresh and tells the room when the peer restarts", () => {
      const restart = step(following, { step: 0, at: 6_000, bpm: 120 });
      expect([restart.announce, restart.restartQueueAt !== undefined])
        .toEqual([true, true]);
    });
  });

  describe("freshPresses()", () => {
    const presses = [
      { id: 4, ring: "bass", lane: 0 },
      { id: 5, ring: "bass", lane: 1 },
      { id: 6, ring: "bass", lane: 2 },
    ];

    it("returns the presses numbered above the last one seen", () => {
      expect(freshPresses(presses, 4).map((press) => press.id)).toEqual([
        5,
        6,
      ]);
    });

    it("returns none when the last one seen is the newest", () => {
      expect(freshPresses(presses, 6)).toEqual([]);
    });
  });

  describe("presenceName()", () => {
    it("returns a short name trimmed", () => {
      expect(presenceName("  Ada  ")).toBe("Ada");
    });

    it("returns `Guest` for a blank name", () => {
      expect(presenceName(" ")).toBe("Guest");
    });

    it("drops the control characters and lone surrogates the relay refuses", () => {
      expect(presenceName("\u0007Ada\u0085 Lovelace\ud800")).toBe(
        "Ada Lovelace",
      );
    });

    it("returns `Guest` for a name of nothing but refused characters", () => {
      expect(presenceName("\u0001\udc00")).toBe("Guest");
    });

    it("cuts a long name to the relay's 80 code points", () => {
      expect(presenceName("a".repeat(100))).toBe("a".repeat(80));
    });

    it("cuts a wide name to the relay's 256 bytes, keeping a character whole", () => {
      expect(presenceName("🎵".repeat(100))).toBe("🎵".repeat(64));
    });
  });

  describe("lastPressId()", () => {
    it("returns the highest press number", () => {
      expect(lastPressId([
        { id: 2, ring: "bass", lane: 0 },
        { id: 7, ring: "bass", lane: 0 },
      ])).toBe(7);
    });

    it("returns `undefined` for no presses", () => {
      expect(lastPressId([])).toBeUndefined();
    });
  });

  describe("withPress()", () => {
    it("keeps the newest presses once the list is full", () => {
      const full = Array.from(
        { length: MAX_PRESSES },
        (_, id) => ({ id, ring: "bass", lane: 0 }),
      );
      const next = withPress(full, { id: MAX_PRESSES, ring: "bass", lane: 1 });
      expect([next.length, next[0].id, next.at(-1)?.id]).toEqual([
        MAX_PRESSES,
        1,
        MAX_PRESSES,
      ]);
    });
  });

  describe("padForKey()", () => {
    it("returns the ring of the key's row and the lane of its place", () => {
      expect(padForKey(layout, "w")).toEqual({ ringIndex: 1, lane: 1 });
    });

    it("reads an upper-case key as its lower-case one", () => {
      expect(padForKey(layout, "A")).toEqual({ ringIndex: 2, lane: 0 });
    });

    it("returns `undefined` for a lane the layout does not have", () => {
      expect(padForKey(layout, "y")).toBeUndefined();
    });

    it("returns `undefined` for a key on no row", () => {
      expect(padForKey(layout, "p")).toBeUndefined();
    });

    it("returns the pad `keyForPad()` gives the key of, for every pad of the layout", () => {
      for (const [ringIndex] of layout.rings.entries()) {
        for (let lane = 0; lane < layout.lanes; lane++) {
          expect(padForKey(layout, keyForPad(ringIndex, lane) ?? ""))
            .toEqual({ ringIndex, lane });
        }
      }
    });
  });
});
