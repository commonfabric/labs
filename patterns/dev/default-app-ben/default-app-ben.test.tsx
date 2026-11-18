/**
 * Test: Ben's space registers pieces, files notes into notebooks, and runs its
 * menu, keyboard shortcut, and pin stream.
 *
 * Pieces arrive through `addPiece` and show in the pieces table, which the
 * space's name counts. A note dropped onto a notebook's row moves into that
 * notebook and leaves the table. The "Notes" menu opens and closes, and each
 * of its entries closes it again as it navigates; "Daily Journal" creates and
 * registers one journal, then opens that one again. The keyboard shortcut and
 * an external pin both drive the FAB the space carries, and suggestions are
 * kept in its history.
 *
 * Menu entries navigate, so they are pressed as a person presses them rather
 * than fired from an action, where navigation is skipped with a warning.
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
  findElement,
  findElementByExactText,
  findNode,
  fireClick,
  fireEvent,
  propsOf,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import Note from "../../system/notes/note.tsx";
import Notebook from "../../system/notes/notebook.tsx";
import DefaultAppBen from "./default-app-ben.tsx";

/** Whether the "Notes" dropdown is showing, read from its display style. */
const menuShown = (root: unknown): boolean => {
  const menu = findNode(root, (node) => {
    const style = propValue(node, "style");
    return typeof style === "object" && style !== null &&
      "minWidth" in style && style.minWidth === "160px";
  });
  const style = propValue(menu, "style");
  return typeof style === "object" && style !== null && "display" in style &&
    style.display === "flex";
};

/** The full-screen layer that closes the menu when clicked outside it. */
const backdrop = (root: unknown) =>
  findNode(root, (node) => {
    const style = propValue(node, "style");
    return propsOf(node)?.onClick !== undefined && typeof style === "object" &&
      style !== null && "inset" in style;
  });

const fabExpanded = (fabUI: unknown): unknown =>
  propValue(findElement(fabUI, "cf-fab"), "expanded");

export default pattern(() => {
  const subject = DefaultAppBen();
  const note = Note({ title: "Registered Note", content: "" });
  const otherNote = Note({ title: "Other Note", content: "" });
  const notebook = Notebook({ title: "Ideas" });
  const suggestion = new Writable("Try the do list");

  const action_register_pieces = action(() => {
    subject.addPiece.send({ piece: note });
    subject.addPiece.send({ piece: otherNote });
    subject.addPiece.send({ piece: notebook });
    subject.addPiece.send({ piece: note });
  });
  const action_record_suggestion = action(() => {
    subject.recordSuggestion.send({
      result: suggestion,
      messages: [],
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  });
  const action_close_menu = action(() =>
    fireClick(backdrop(subject[UI]), "the menu backdrop")
  );
  const action_drop_note_on_notebook = action(() => {
    const dropZone = findElement(subject[UI], "cf-drop-zone");
    fireEvent(dropZone, "oncf-drop", { detail: { sourceCell: note } });
    fireEvent(dropZone, "oncf-drop", { detail: { sourceCell: note } });
  });
  const action_pin = action(() => {
    subject.pinToChat.send({
      path: "notes",
      name: "Registered Note",
      accumulate: false,
    });
  });
  const action_press_shortcut = action(() =>
    fireEvent(findElement(subject[UI], "cf-keybind"), "oncf-keybind", {})
  );
  const action_remove_piece = action(() => {
    fireClick(findElementByExactText(subject[UI], "cf-button", "🗑️"));
  });

  const assert_starts_empty = assert(() =>
    subject.pieceRegistry.length === 0 &&
    subject[NAME] === "Ben's Space (0)" &&
    subject.suggestionHistory.length === 0
  );
  // A piece registered twice is kept once.
  const assert_pieces_registered = assert(() =>
    subject.pieceRegistry.length === 3 && subject[NAME] === "Ben's Space (3)"
  );
  const assert_suggestion_recorded = assert(() =>
    subject.suggestionHistory.length === 1 &&
    subject.suggestionHistory[0]?.timestamp === "2026-01-01T00:00:00.000Z"
  );
  const assert_menu_closed = assert(() =>
    !menuShown(subject[UI]) && backdrop(subject[UI]) === undefined
  );
  const assert_menu_open = assert(() =>
    menuShown(subject[UI]) && backdrop(subject[UI]) !== undefined
  );
  // The first press creates the journal and registers it, and the second
  // opens that journal rather than creating another.
  const assert_journal_registered = assert(() =>
    subject.pieceRegistry.length === 4 &&
    subject.pieceRegistry.filter((piece) => piece[NAME] === "📅 Daily Journal")
        .length === 1
  );

  // The note moves into the notebook once, however often it is dropped, and
  // hides from the pieces table, which the name counts.
  const assert_note_filed = assert(() =>
    notebook.notes.length === 1 &&
    notebook.notes[0]?.title === "Registered Note" &&
    subject.pieceRegistry.length === 4 &&
    subject[NAME] === "Ben's Space (3)"
  );

  const assert_fab_closed = assert(() => fabExpanded(subject.fabUI) === false);
  const assert_fab_open = assert(() => fabExpanded(subject.fabUI) === true);

  const assert_remove_piece_updates_registry = assert(() =>
    subject.pieceRegistry.length === 3
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { action: action_register_pieces },
      { assertion: assert_pieces_registered },
      { action: action_record_suggestion },
      { assertion: assert_suggestion_recorded },

      { assertion: assert_menu_closed },
      { press: subject[UI], control: "Notes ▾" },
      { assertion: assert_menu_open },
      { action: action_close_menu },
      { assertion: assert_menu_closed },
      { press: subject[UI], control: "Notes ▾" },
      { press: subject[UI], control: "📝 New Note" },
      { assertion: assert_menu_closed },
      { press: subject[UI], control: "Notes ▾" },
      { press: subject[UI], control: "📓 New Notebook" },
      { assertion: assert_menu_closed },
      { press: subject[UI], control: "Notes ▾" },
      { press: subject[UI], control: "⚡ Quick Capture" },
      { assertion: assert_menu_closed },
      { press: subject[UI], control: "Notes ▾" },
      { press: subject[UI], control: "📅 Daily Journal" },
      { assertion: assert_menu_closed },
      { assertion: assert_journal_registered },
      { press: subject[UI], control: "Notes ▾" },
      { press: subject[UI], control: "📅 Daily Journal" },
      { assertion: assert_menu_closed },
      { assertion: assert_journal_registered },

      { action: action_drop_note_on_notebook },
      { assertion: assert_note_filed },

      { assertion: assert_fab_closed },
      { action: action_pin },
      { assertion: assert_fab_open },
      { action: action_press_shortcut },
      { assertion: assert_fab_closed },

      { action: action_remove_piece },
      { assertion: assert_remove_piece_updates_registry },
    ],
    subject,
  };
});
