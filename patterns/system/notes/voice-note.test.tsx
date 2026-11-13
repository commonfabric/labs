/**
 * Test: a finished transcription is saved as a voice note, listed with its
 * text and duration, and removed by its delete button.
 *
 * Run: deno task cf test patterns/system/notes/voice-note.test.tsx --root patterns --verbose
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  findElement,
  fireEvent,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import VoiceNote from "./voice-note.tsx";

export default pattern(() => {
  const memo = VoiceNote({ title: "Memo" });

  const action_finish_transcription = action(() =>
    fireEvent(
      findElement(memo[UI], "cf-voice-input"),
      "oncf-transcription-complete",
      {
        detail: {
          transcription: {
            id: "t1",
            text: "Buy milk",
            duration: 2.5,
            timestamp: 1_700_000_000_000,
          },
        },
      },
      "the voice input",
    )
  );
  const assert_note_saved = assert(() =>
    memo.notes.length === 1 && hasText(memo[UI], "Saved Notes (1)") &&
    hasText(memo[UI], "Buy milk") && hasText(memo[UI], "2.5s")
  );

  const action_delete_note = action(() => clickButton(memo[UI], "×"));
  const assert_note_deleted = assert(() =>
    memo.notes.length === 0 && hasText(memo[UI], "No voice notes yet")
  );

  return {
    [TESTS]: [
      { action: action_finish_transcription },
      { assertion: assert_note_saved },
      { action: action_delete_note },
      { assertion: assert_note_deleted },
    ],
    memo,
  };
});
