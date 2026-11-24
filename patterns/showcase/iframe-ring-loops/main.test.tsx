/**
 * Drives every verb of Ring Loops and reads the result back through `rings`,
 * `state`, and `output`. No profile wish resolves in a pattern test, so every
 * note a verb places here is named by the `agentName` its event carries.
 */

import { action, assert, pattern, TESTS } from "commonfabric";
import RingLoops from "./main.tsx";

export default pattern(() => {
  const loops = RingLoops({});

  // A verb declares a result and a step takes a stream that declares none, so
  // each call is sent from an action of the test's own.
  const action_add_bass_note = action(() => {
    loops.addNote.send({
      ring: "bass",
      step: 5,
      lane: 1,
      agentName: "Test Agent",
      color: "#4dabf7",
    });
  });
  const action_remove_bass_note = action(() => {
    loops.removeNote.send({ ring: "bass", step: 5, lane: 1 });
  });
  // One of the three cells already holds a starter note, which the new note
  // replaces, so the ring gains two.
  const action_add_three_bells = action(() => {
    loops.addNotes.send({
      agentName: "Test Agent",
      notes: [
        { ring: "bells", step: 7, lane: 2 },
        { ring: "bells", step: 3, lane: 0 },
        { ring: "bells", step: 12, lane: 4 },
      ],
    });
  });
  const action_clear_drums = action(() => {
    loops.clearNotes.send({ ring: "drums" });
  });
  const action_clear_everything = action(() => {
    loops.clearNotes.send({});
  });
  // A caller's name is copied into every note it places, so it is stored in
  // the bounded form a presence name takes: no control characters, and at most
  // 80 code points.
  const action_add_note_by_long_name = action(() => {
    loops.addNote.send({
      ring: "pluck",
      step: 2,
      lane: 3,
      agentName: `Agent\u0007 ${"x".repeat(500)}`,
    });
  });
  const action_set_tempo = action(() => {
    loops.setTempo.send({ bpm: 132 });
  });
  const action_set_volume = action(() => {
    loops.setVolume.send({ volume: 0.25 });
  });

  const assert_lists_four_rings = assert(() => loops.rings.length === 4);
  const assert_drums_loop_sixteen_steps = assert(() =>
    loops.rings[0].id === "drums" && loops.rings[0].steps === 16
  );
  const assert_drums_hold_starter_notes = assert(() =>
    loops.rings[0].notes.length === 6
  );
  const assert_bass_holds_starter_notes = assert(() =>
    loops.rings[2].notes.length === 2
  );

  const assert_bass_gained_named_note = assert(() =>
    loops.rings[2].notes.some((note) =>
      note.step === 5 && note.lane === 1 && note.plays === "C2" &&
      note.by === "Test Agent"
    )
  );
  const assert_bass_holds_three_notes = assert(() =>
    loops.rings[2].notes.length === 3
  );
  const assert_stored_note_names_its_color = assert(() =>
    loops.state.notes["bass:5:1"]?.color === "#4dabf7"
  );

  const assert_bass_note_is_gone = assert(() =>
    loops.rings[2].notes.length === 2 &&
    loops.state.notes["bass:5:1"] === null
  );

  const assert_bells_gained_two_notes = assert(() =>
    loops.rings[1].notes.length === 4
  );
  const assert_bells_note_replaced_in_place = assert(() =>
    loops.rings[1].notes.some((note) =>
      note.step === 7 && note.lane === 2 && note.by === "Test Agent"
    )
  );

  const assert_drums_are_empty = assert(() =>
    loops.rings[0].notes.length === 0
  );
  const assert_bells_kept_their_notes = assert(() =>
    loops.rings[1].notes.length === 4
  );

  const assert_every_ring_is_empty = assert(() =>
    loops.rings.every((ring) => ring.notes.length === 0)
  );

  const assert_long_name_is_bounded = assert(() =>
    loops.state.notes["pluck:2:3"]?.authorName === `Agent ${"x".repeat(74)}`
  );

  const assert_tempo_starts_at_default = assert(() =>
    loops.state.tempoBpm === 96
  );
  const assert_tempo_is_set = assert(() => loops.state.tempoBpm === 132);
  const assert_volume_is_set = assert(() => loops.output.volume === 0.25);

  return {
    [TESTS]: [
      { assertion: assert_lists_four_rings },
      { assertion: assert_drums_loop_sixteen_steps },
      { assertion: assert_drums_hold_starter_notes },
      { assertion: assert_bass_holds_starter_notes },

      { action: action_add_bass_note },
      { assertion: assert_bass_gained_named_note },
      { assertion: assert_bass_holds_three_notes },
      { assertion: assert_stored_note_names_its_color },

      { action: action_remove_bass_note },
      { assertion: assert_bass_note_is_gone },

      { action: action_add_three_bells },
      { assertion: assert_bells_gained_two_notes },
      { assertion: assert_bells_note_replaced_in_place },

      { action: action_clear_drums },
      { assertion: assert_drums_are_empty },
      { assertion: assert_bells_kept_their_notes },

      { action: action_clear_everything },
      { assertion: assert_every_ring_is_empty },

      { action: action_add_note_by_long_name },
      { assertion: assert_long_name_is_bounded },

      { assertion: assert_tempo_starts_at_default },
      { action: action_set_tempo },
      { assertion: assert_tempo_is_set },

      { action: action_set_volume },
      { assertion: assert_volume_is_set },
    ],
    loops,
  };
});
