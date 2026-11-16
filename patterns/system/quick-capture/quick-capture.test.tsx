/**
 * Test Pattern: Quick Capture
 *
 * The note and notebook tools the agent calls register what they create. The
 * pattern itself takes captured text, from its `capture` stream or from the
 * prompt input, into its transcript, which its summary counts and its view
 * shows, and the Clear button empties it again.
 *
 * The test environment has no language model, so the dialog answers each
 * message with its error reply, which counts in the transcript like any
 * other.
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElement,
  fireEvent,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import type { MentionablePiece } from "../backlinks-index/backlinks-index.tsx";
import QuickCapture, {
  createNotebookHandler,
  createNoteHandler,
} from "./quick-capture.tsx";

type Message = { role: string; content: unknown };

/** The transcript the view's chat shows, or none when it shows no chat. */
const transcriptOf = (ui: unknown): Message[] | undefined =>
  propValue(findElement(ui, "cf-chat"), "$messages") as Message[] | undefined;

/** The text of the user message at `index` of the transcript in `ui`. */
const userTextAt = (ui: unknown, index: number): string | undefined => {
  const message = transcriptOf(ui)?.[index];
  if (message?.role !== "user" || !Array.isArray(message.content)) {
    return undefined;
  }
  return (message.content[0] as { text?: string } | undefined)?.text;
};

export default pattern(() => {
  const pieceRegistry = new Writable<MentionablePiece[]>([]);
  const createNote = createNoteHandler({ pieceRegistry });
  const createNotebook = createNotebookHandler({ pieceRegistry });
  const capture = QuickCapture({
    pieceRegistry: new Writable<MentionablePiece[]>([]),
  });

  const action_create_note = action(() => {
    createNote.send({
      title: "Captured thought",
      content: "A useful detail",
    });
  });
  const action_create_notebook = action(() => {
    createNotebook.send({
      title: "Capture Log",
      notes: [{ title: "Transcript", content: "Raw input" }],
    });
  });
  const action_capture = action(() => {
    capture.capture.send({ text: "Call the plumber on Monday." });
  });
  const action_send_with_paste = action(() => {
    fireEvent(findElement(capture[UI], "cf-prompt-input"), "oncf-send", {
      detail: {
        text: "File this: [Pasted text](#att-1)",
        attachments: [
          {
            id: "att-1",
            name: "Pasted text",
            type: "clipboard",
            data: "buy more flour",
          },
        ],
      },
    }, "the prompt input");
  });
  const action_clear = action(() => {
    clickButton(capture[UI], "Clear");
  });

  const assert_note_is_registered = assert(() =>
    pieceRegistry.get().length === 1 && pieceRegistry.get()[0] !== undefined
  );
  const assert_notebook_is_registered = assert(() =>
    pieceRegistry.get().length === 2 && pieceRegistry.get()[1] !== undefined
  );
  const assert_starts_empty = assert(() =>
    capture[NAME] === "Quick Capture" &&
    capture.summary === "Quick capture — paste text to organize into notes" &&
    transcriptOf(capture[UI]) === undefined &&
    hasText(capture[UI], "Paste text, meeting notes, or ideas below.")
  );
  const assert_capture_in_transcript = assert(() =>
    capture.summary === "Quick Capture (2 messages)" &&
    userTextAt(capture[UI], 0) === "Call the plumber on Monday." &&
    transcriptOf(capture[UI])?.[1]?.role === "assistant" &&
    !hasText(capture[UI], "Paste text, meeting notes, or ideas below.")
  );
  // The pasted content is put inline (`cfc/prompt-injection/prompt.test.ts`
  // states the rule).
  const assert_paste_resolved_inline = assert(() =>
    capture.summary === "Quick Capture (4 messages)" &&
    userTextAt(capture[UI], 2) === "File this: buy more flour"
  );

  return {
    [TESTS]: [
      { action: action_create_note },
      { assertion: assert_note_is_registered },
      { action: action_create_notebook },
      { assertion: assert_notebook_is_registered },
      { assertion: assert_starts_empty },
      { action: action_capture },
      { settle: true },
      { assertion: assert_capture_in_transcript },
      { action: action_send_with_paste },
      { settle: true },
      { assertion: assert_paste_resolved_inline },
      { action: action_clear },
      { assertion: assert_starts_empty },
    ],
    // The dialog warns that it cannot reach the language model.
    allowConsoleWarnings: true,
  };
});
