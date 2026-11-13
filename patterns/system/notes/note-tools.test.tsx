/**
 * Test: the note's tools for callers other than its view.
 *
 * The grep and translate patterns the note hands out through `patternTool`,
 * and its `editContent` stream refusing an event of the wrong shape and
 * taking one of the right shape. A language model is not reachable from a
 * pattern test, so translate is checked for what it reports when the request
 * fails. The refusal logs an error, which
 * is why this file allows console output and holds nothing else.
 *
 * Run: deno task cf test patterns/system/notes/note-tools.test.tsx --root patterns --verbose
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import { fireEvent } from "../../tools/test-support/vnode-helpers.ts";
import Note, { grepPattern, translatePattern } from "./note.tsx";

/** Sends `event` to `stream` whatever the event type the stream declares. */
const sendUnchecked = (stream: unknown, event: unknown): void =>
  fireEvent({ props: { stream } }, "stream", event, "the stream");

export default pattern(() => {
  const content = "Line one\nLine two\nLine three";
  const grep = grepPattern({ query: "two", content });
  const translation = translatePattern({ language: "French", content });
  const note = Note({ title: "Tools", content: "Kept" });

  const assert_grep_finds_matching_lines = assert(() =>
    [...(grep ?? [])].join("|") === "Line two"
  );

  const assert_failed_translation_reported = assert(() =>
    translation === "Error occurred"
  );

  const action_send_malformed_edit = action(() =>
    sendUnchecked(note.editContent, { detail: { value: 42 } })
  );
  const assert_malformed_edit_ignored = assert(() => note.content === "Kept");
  const action_send_edit = action(() => {
    note.editContent.send({ detail: { value: "Edited" } });
  });
  const assert_edit_taken = assert(() => note.content === "Edited");

  return {
    [TESTS]: [
      { assertion: assert_grep_finds_matching_lines },
      { settle: true },
      { assertion: assert_failed_translation_reported },
      { action: action_send_malformed_edit },
      { assertion: assert_malformed_edit_ignored },
      { action: action_send_edit },
      { assertion: assert_edit_taken },
    ],
    note,
    allowConsoleErrors: true,
    allowConsoleWarnings: true,
  };
});
