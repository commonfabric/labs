/**
 * Test Pattern: OmniboxFAB
 *
 * The floating assistant: a button that opens a chat panel, takes cells
 * dropped on it or pinned from elsewhere as the chat's attachments, and shows
 * a peek at the latest reply while the history is folded away.
 *
 * The test environment has no language model, so a message the test sends is
 * answered by the dialog's error reply. That reply is still an assistant
 * message, which is what the peek is about.
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
  findNode,
  fireClick,
  fireEvent,
  propsOf,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import OmniboxFAB, { latestAssistantText, wishTool } from "./omnibox-fab.tsx";

type Pinned = { path: string; name: string };
type Message = { role: string; content: unknown };

const fabOf = (ui: unknown) => findElement(ui, "cf-fab");

const pinnedIn = (ui: unknown): Pinned[] =>
  (propValue(findElement(ui, "cf-attachments-bar"), "pinnedCells") ??
    []) as Pinned[];

const samePins = (ui: unknown, expected: Pinned[]): boolean => {
  const pinned = pinnedIn(ui);
  return pinned.length === expected.length &&
    pinned.every((pin, i) =>
      pin.path === expected[i].path && pin.name === expected[i].name
    ) &&
    propValue(fabOf(ui), "pinCount") === expected.length;
};

/** The peek's message, when the peek shows. */
const peekOf = (ui: unknown) => findElement(ui, "cf-chat-message");

/** The style of the panel's history wrapper, which folds the history. */
const historyStyleOf = (ui: unknown): string => {
  const node = findNode(ui, (n) => {
    const style = propValue(n, "style");
    return typeof style === "string" && style.includes("max-height:") &&
      style.includes("transition");
  });
  return String(propValue(node, "style") ?? "");
};

const dropEvent = (id: string, path: string[], name?: string) => ({
  detail: {
    sourceCellRef: { id, path },
    ...(name !== undefined && { sourceCell: { [NAME]: name } }),
  },
});

export default pattern(() => {
  const fab = OmniboxFAB({
    mentionable: [],
    extraTools: {},
    extraSystemPrompt: "Extra rule.",
  });

  // A wish the assistant makes for a target the space answers navigates to
  // the cell the wish found. The assistant calls the tool while answering a
  // message, so the test makes the wish from an action: navigation is
  // reachable only from the consequences of a fired event.
  const wishes = new Writable<boolean[]>([]);
  const action_wish = action(() => {
    wishes.push(wishTool({ query: "#now", context: { reason: "test" } }));
  });

  const action_toggle_fab = action(() => {
    fireClick(fabOf(fab[UI]), "the fab");
  });
  const action_escape = action(() => {
    fireEvent(fabOf(fab[UI]), "oncf-fab-escape", {}, "the fab");
  });
  const action_click_backdrop = action(() => {
    fireEvent(fabOf(fab[UI]), "oncf-fab-backdrop-click", {}, "the fab");
  });
  const action_drop_nothing = action(() => {
    fireEvent(findElement(fab[UI], "cf-drop-zone"), "oncf-drop", {
      detail: {},
    }, "the drop zone");
  });
  const action_drop_unnamed_cell = action(() => {
    fireEvent(
      findElement(fab[UI], "cf-drop-zone"),
      "oncf-drop",
      dropEvent("of:baguette123456", []),
      "the drop zone",
    );
  });
  const action_drop_named_field = action(() => {
    fireEvent(
      findElement(fab[UI], "cf-drop-zone"),
      "oncf-drop",
      dropEvent("of:shopping", ["items", "0"], "Shopping"),
      "the drop zone",
    );
  });
  const action_pin_accumulating = action(() => {
    fab.pinToChat.send({ path: "/of:extra", name: "Extra", accumulate: true });
  });
  const action_pin_replacing = action(() => {
    fab.pinToChat.send({ path: "/of:only", name: "Only", accumulate: false });
  });
  const action_send_message = action(() => {
    fireEvent(findElement(fab[UI], "cf-prompt-input"), "oncf-send", {
      detail: { text: "hello", attachments: [], mentions: [], message: "" },
    }, "the prompt input");
  });
  const action_dismiss_peek = action(() => {
    fireClick(
      findNode(fab[UI], (n) => propValue(n, "title") === "Dismiss"),
      "the dismiss button",
    );
  });
  const action_open_history_from_peek = action(() => {
    const peekRow = findNode(
      fab[UI],
      (n) =>
        propsOf(n)?.onClick !== undefined &&
        findElement(n, "cf-chat-message") !== undefined &&
        findElement(n, "cf-fab") === undefined,
    );
    fireClick(peekRow, "the peek");
  });
  const action_toggle_history = action(() => {
    fireEvent(
      findElement(fab[UI], "cf-chevron-button"),
      "oncf-toggle",
      {},
      "the chevron",
    );
  });

  const assert_starts_collapsed = assert(() =>
    fab[NAME] === "OmniboxFAB" && fab.fabExpanded === false &&
    findElement(fab[UI], "cf-prompt-input") === undefined
  );
  const assert_open_with_panel = assert(() =>
    fab.fabExpanded === true &&
    findElement(fab[UI], "cf-prompt-input") !== undefined &&
    findElement(fab[UI], "cf-chevron-button") !== undefined
  );
  const assert_collapsed = assert(() =>
    fab.fabExpanded === false &&
    findElement(fab[UI], "cf-prompt-input") === undefined
  );
  const assert_nothing_pinned = assert(() =>
    fab.fabExpanded === false && samePins(fab[UI], [])
  );
  const assert_unnamed_cell_pinned = assert(() =>
    fab.fabExpanded === true &&
    samePins(fab[UI], [{ path: "/of:baguette123456", name: "Cell #123456" }])
  );
  const assert_named_field_replaces = assert(() =>
    fab.fabExpanded === true &&
    samePins(fab[UI], [{ path: "/of:shopping/items/0", name: "Shopping" }])
  );
  const assert_external_pin_accumulates = assert(() =>
    fab.fabExpanded === true &&
    samePins(fab[UI], [
      { path: "/of:shopping/items/0", name: "Shopping" },
      { path: "/of:extra", name: "Extra" },
    ])
  );
  const assert_external_pin_replaces = assert(() =>
    samePins(fab[UI], [{ path: "/of:only", name: "Only" }])
  );
  const assert_reply_peeks = assert(() => {
    const messages = (fab.messages ?? []) as Message[];
    const reply = messages[1];
    const sent = messages[0];
    const parts = Array.isArray(sent?.content) ? sent.content : [];
    return messages.length === 2 &&
      sent.role === "user" && parts.length === 1 &&
      parts[0]?.type === "text" && parts[0]?.text === "hello" &&
      reply?.role === "assistant" &&
      typeof reply.content === "string" &&
      propValue(peekOf(fab[UI]), "content") === reply.content &&
      propValue(fabOf(fab[UI]), "$previewMessage") === reply.content &&
      historyStyleOf(fab[UI]).includes("max-height: 0;");
  });
  const assert_peek_dismissed = assert(() =>
    ((fab.messages ?? []) as Message[]).length === 2 &&
    peekOf(fab[UI]) === undefined
  );
  const assert_history_open = assert(() =>
    historyStyleOf(fab[UI]).includes("max-height: 480px;") &&
    peekOf(fab[UI]) === undefined
  );
  const assert_history_folded_peek_back = assert(() =>
    historyStyleOf(fab[UI]).includes("max-height: 0;") &&
    peekOf(fab[UI]) !== undefined
  );
  // The peek shows the latest reply, joining the text of a reply made of
  // parts and leaving out its other parts.
  const assert_peek_text_is_latest_reply = assert(() =>
    latestAssistantText(undefined) === null &&
    latestAssistantText([
        { role: "user", content: "hi" },
      ]) === null &&
    latestAssistantText([
        { role: "assistant", content: "Earlier" },
        { role: "user", content: "and?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Part one, " },
            { type: "image", image: "https://example.test/x.png" },
            { type: "text", text: "part two." },
          ],
        },
        { role: "user", content: "thanks" },
      ]) === "Part one, part two."
  );
  const assert_wish_navigates = assert(() =>
    wishes.get().length === 1 && wishes.get()[0] === true
  );
  return {
    [TESTS]: [
      { assertion: assert_starts_collapsed },
      { action: action_toggle_fab },
      { assertion: assert_open_with_panel },
      { action: action_escape },
      { assertion: assert_collapsed },
      { action: action_toggle_fab },
      { assertion: assert_open_with_panel },
      { action: action_click_backdrop },
      { assertion: assert_collapsed },
      { action: action_drop_nothing },
      { assertion: assert_nothing_pinned },
      { action: action_drop_unnamed_cell },
      { assertion: assert_unnamed_cell_pinned },
      { action: action_escape },
      { action: action_drop_named_field },
      { assertion: assert_named_field_replaces },
      { action: action_escape },
      { action: action_pin_accumulating },
      { assertion: assert_external_pin_accumulates },
      { action: action_pin_replacing },
      { assertion: assert_external_pin_replaces },
      { action: action_send_message },
      { settle: true },
      { assertion: assert_reply_peeks },
      { action: action_open_history_from_peek },
      { assertion: assert_history_open },
      { action: action_toggle_history },
      { assertion: assert_history_folded_peek_back },
      { action: action_dismiss_peek },
      { assertion: assert_peek_dismissed },
      { assertion: assert_peek_text_is_latest_reply },
      { action: action_wish },
      { assertion: assert_wish_navigates },
    ],
    fab,
    // The dialog warns when it cannot reach the language model.
    allowConsoleWarnings: true,
  };
});
