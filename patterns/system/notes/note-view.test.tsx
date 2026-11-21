/**
 * Test: the note's controls, driven through its rendered view.
 *
 * Two shelves are listed among the space's mentionables under the name
 * "Notebook", which is a name the note's `#notebook` wish matches, and a piece
 * named "allNotes" stands for the All Notes view the `#allNotes` wish finds.
 * With them discoverable, this drives the Notebooks menu: the notebooks it
 * lists, the check on the one holding the note, and the entries that close it.
 * It also drives the title input's keydown, the setTitle stream, a summary of
 * long content, and an edited projection whose definition names no piece.
 *
 * A navigation is not observable from a pattern test: the runner records it
 * for its summary, and nothing the test can read changes. So a control whose
 * only effect is to navigate is pressed only where the test asserts the
 * target the control shows (the parent chip, a backlink), and the controls
 * whose target the view does not show (View, a mention's pill) are left out.
 *
 * Run: deno task cf test patterns/system/notes/note-view.test.tsx --root patterns --verbose
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import {
  findNode,
  findNodeByProp,
  fireEvent,
  isButton,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";
import Note from "./note.tsx";
import Notebook from "./notebook.tsx";
import { addBacklink, NamedPiece, Shelf } from "./note-test-fixtures.tsx";

// ===== View helpers (module scope: SES callbacks may not capture callables
// from enclosing function scopes) =====

const buttonOf = (root: unknown, text: string): unknown =>
  findNode(root, isButton(text));

const titleInput = (root: unknown): unknown =>
  findNodeByProp(root, "placeholder", "Note title...");

const parentChip = (root: unknown): unknown =>
  findNodeByProp(root, "label", "📓 Parent (0)");

const LONG_WORDS = "word ".repeat(50).trim();
const LONG_RUN = "x".repeat(250);

export default pattern(() => {
  const mentionable = wish<Writable<object[]>>({ query: "#mentionable" })
    .result!;

  const subject = Note({ title: "Subject", content: "", isHidden: false });
  const holding = Shelf({ notes: [subject] });
  const empty = Shelf({ notes: [] });
  // The piece an `#allNotes` wish finds.
  const allNotes = NamedPiece({ name: "allNotes" });

  const parent = Notebook({ title: "Parent", notes: [], isHidden: false });
  const child = Note({
    title: "Child",
    content: "",
    isHidden: true,
    parentNotebook: parent,
  });

  const longWords = Note({ title: "Words", content: LONG_WORDS });
  const longRun = Note({ title: "Run", content: LONG_RUN });

  const linker = Note({ title: "Linker", content: "", isHidden: false });
  const backlinkToSubject = addBacklink({ target: subject, source: linker });

  // ===== The Notebooks menu =====

  const action_list_pieces = action(() => {
    mentionable.pushAll([holding, empty, allNotes]);
  });
  const action_open_menu = action(() => {
    subject.toggleMenu.send();
  });

  // The shelf that holds the note is checked; the empty one is not.
  const assert_menu_marks_containing_notebook = assert(() =>
    buttonOf(subject[UI], "Notebook ✓") !== undefined &&
    buttonOf(subject[UI], "Notebook") !== undefined
  );
  const assert_all_notes_entry_shown = assert(() =>
    styleOf(buttonOf(subject[UI], "📁 All Notes"), "display") === "flex"
  );

  const assert_menu_closed = assert(() => subject.menuOpen === false);

  // ===== Title =====

  const action_start_editing = action(() => {
    subject.startEditingTitle.send();
  });
  const action_press_escape = action(() =>
    fireEvent(titleInput(subject[UI]), "oncf-keydown", { key: "Escape" })
  );
  const action_press_enter = action(() =>
    fireEvent(titleInput(subject[UI]), "oncf-keydown", { key: "Enter" })
  );
  const assert_editing = assert(() => subject.isEditingTitle === true);
  const assert_not_editing = assert(() => subject.isEditingTitle === false);

  const action_set_title = action(() => {
    subject.setTitle.send("Renamed");
  });
  const assert_title_set = assert(() =>
    subject.title === "Renamed" && subject[NAME] === "📝 Renamed"
  );

  // ===== Summary =====

  // Content past 200 characters is cut at the last space after the 150th, or
  // at 200 when there is none.
  const assert_summary_cut_at_word = assert(() =>
    longWords.summary === LONG_WORDS.slice(0, 199) + "..."
  );
  const assert_summary_cut_at_limit = assert(() =>
    longRun.summary === LONG_RUN.slice(0, 200) + "..."
  );

  // ===== An edited projection =====

  const action_edit_projection = action(() => {
    subject.editProjection.send({
      body: "See the spec.\n\n[spec01]: https://example.com/spec",
    });
  });
  // A definition that names no piece is not a mention, so it stays as text.
  const assert_definition_kept_as_text = assert(() =>
    subject.content === "See the spec.\n\n[spec01]: https://example.com/spec" &&
    Object.keys(subject.references ?? {}).length === 0
  );

  // ===== Controls that only navigate =====

  const assert_parent_chip_names_parent = assert(() =>
    parentChip(child[UI]) !== undefined
  );
  const action_go_to_parent = action(() =>
    fireEvent(parentChip(child[UI]), "oncf-click", {}, "the parent chip")
  );

  const action_add_backlink = action(() => backlinkToSubject.send());
  const assert_backlink_listed = assert(() =>
    buttonOf(subject[UI], "📝 Linker") !== undefined
  );

  return {
    [TESTS]: [
      { action: action_list_pieces },
      { action: action_open_menu },
      { assertion: assert_menu_marks_containing_notebook },
      { assertion: assert_all_notes_entry_shown },
      // A press, since the entry is bound per notebook the menu lists.
      { press: subject[UI], control: "Notebook ✓" },
      { assertion: assert_menu_closed },
      { action: action_open_menu },
      { press: subject[UI], control: "📁 All Notes" },
      { assertion: assert_menu_closed },

      { action: action_start_editing },
      { action: action_press_escape },
      { assertion: assert_editing },
      { action: action_press_enter },
      { assertion: assert_not_editing },
      { action: action_set_title },
      { assertion: assert_title_set },

      { assertion: assert_summary_cut_at_word },
      { assertion: assert_summary_cut_at_limit },

      { action: action_edit_projection },
      { assertion: assert_definition_kept_as_text },

      { assertion: assert_parent_chip_names_parent },
      { action: action_go_to_parent },
      { action: action_add_backlink },
      { assertion: assert_backlink_listed },
      { press: subject[UI], control: "📝 Linker" },
    ],
    subject,
    child,
    longWords,
    longRun,
    // With server execution on, a navigation an action's event makes is a
    // cascade hop, which the client does not enact ahead of the server, and
    // the runtime warns `optimistic-navigate-skipped`. A press makes a root
    // event, but it sends only a click, and the parent chip binds
    // `oncf-click`. The flag is a boolean, so it cannot be pinned to that
    // warning.
    allowConsoleWarnings: true,
  };
});
