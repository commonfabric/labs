/**
 * Whether `event` is aimed at somewhere the user is entering text: a
 * contenteditable element, an input, a textarea, or a select.
 *
 * Editors such as `cf-code-editor` and `cf-input` keep their editable element
 * in a shadow root, and an event that crosses a shadow boundary reports the
 * shadow host as its target, so the first entry of the composed path is what
 * names the element the event came from. That element alone decides: its
 * `isContentEditable` already follows the nearest `contenteditable` boundary,
 * so a `contenteditable="false"` island inside an editor, such as a piece
 * rendered in prose, is not text entry. The element is read structurally, so
 * one from another document or realm still matches.
 */
export function targetsTextEntry(event: Event): boolean {
  const element = event.composedPath()[0] as
    | { tagName?: unknown; isContentEditable?: unknown }
    | undefined;
  if (!element || typeof element.tagName !== "string") return false;
  if (element.isContentEditable === true) return true;
  switch (element.tagName.toLowerCase()) {
    case "input":
    case "textarea":
    case "select":
      return true;
  }
  return false;
}
