/**
 * Test: the space home's view controls.
 *
 * Opening the Notes menu lays a backdrop over the page, and a click on the
 * backdrop closes the menu. A note dropped onto a notebook's row joins that
 * notebook and leaves the list of pieces. "Join this space" adds nobody while
 * the viewer has no profile.
 *
 * Run: deno task cf test patterns/system/default-app/default-app-view.test.tsx --root patterns
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  countElements,
  findElement,
  findElementByText,
  findNode,
  fireClick,
  fireEvent,
  styleOf,
} from "../../tools/test-support/vnode-helpers.ts";
import DefaultApp from "./default-app.tsx";
import Note from "../notes/note.tsx";
import Notebook from "../notes/notebook.tsx";

/** The full-screen layer the open menu lays over the page, if any. */
const backdropOf = (root: unknown) =>
  findNode(root, (node) => styleOf(node, "zIndex") === "999");

/** The display style of the Notes dropdown. */
const menuDisplayOf = (root: unknown) =>
  styleOf(
    findNode(root, (node) => styleOf(node, "zIndex") === "1000"),
    "display",
  );

export default pattern(() => {
  const subject = DefaultApp();
  const notebook = Notebook({ title: "Shelf" });
  const note = Note({ title: "Loose page", content: "" });

  const action_register = action(() => {
    subject.addPiece.send({ piece: notebook });
    subject.addPiece.send({ piece: note });
  });
  const action_open_menu = action(() => {
    fireClick(findElementByText(subject[UI], "cf-button", "Notes"));
  });
  const action_click_backdrop = action(() => {
    fireClick(backdropOf(subject[UI]), "the menu backdrop");
  });
  const action_drop_note = action(() => {
    fireEvent(findElement(subject[UI], "cf-drop-zone"), "oncf-drop", {
      detail: { sourceCell: note },
    }, "the notebook's drop zone");
  });
  const action_join_without_profile = action(() => {
    fireClick(findElementByText(subject[UI], "cf-button", "Join this space"));
  });

  return {
    [TESTS]: [
      { action: action_register },
      { assertion: assert(() => countElements(subject[UI], "tr") === 2) },
      { assertion: assert(() => menuDisplayOf(subject[UI]) === "none") },
      { assertion: assert(() => backdropOf(subject[UI]) === undefined) },

      { action: action_open_menu },
      { assertion: assert(() => menuDisplayOf(subject[UI]) === "flex") },
      { assertion: assert(() => backdropOf(subject[UI]) !== undefined) },
      { action: action_click_backdrop },
      { assertion: assert(() => menuDisplayOf(subject[UI]) === "none") },
      { assertion: assert(() => backdropOf(subject[UI]) === undefined) },

      // The dropped note joins the notebook and is hidden from the list.
      { action: action_drop_note },
      { assertion: assert(() => notebook.notes.length === 1) },
      { assertion: assert(() => note.isHidden === true) },
      { assertion: assert(() => countElements(subject[UI], "tr") === 1) },

      { action: action_join_without_profile },
      { assertion: assert(() => subject.participants.length === 0) },
    ],
    subject,
  };
});
