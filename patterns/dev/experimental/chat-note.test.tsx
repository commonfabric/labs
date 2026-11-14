/**
 * Test Pattern: the chat note
 *
 * A chat note is a markdown document read as a conversation: sections split by
 * `---`, an optional leading `## System` section, and `## AI` sections for the
 * assistant. Generate appends an `## AI` section and starts the model on the
 * conversation so far, and only while the last section is the user's.
 *
 * This checks the parse directly, then drives the note through its view: the
 * title editor, the model picker, Generate and Cancel, the keyboard shortcut,
 * and the editor's backlink events, which register the linked piece and, when
 * not navigating, make it mentionable. The model answers one conversation,
 * the one `llmMocks` below names, and a generation no mock answers stays open
 * until Cancel ends it.
 *
 * Run: deno task cf test patterns/dev/experimental/chat-note.test.tsx --root patterns
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
  clickButton,
  findElement,
  findElementByText,
  findNode,
  fireEvent,
  innermostNode,
  isButton,
  propsOf,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import ChatNote, { parseContentToMessages } from "./chat-note.tsx";

const linkedNote = {
  noteId: "linked-id",
  content: "Linked content",
  mentioned: [],
  backlinks: [],
};

/** The parsed conversation as "role: content" lines. */
const parsed = (content: string): string[] =>
  parseContentToMessages(content, [linkedNote]).messages.map((message) =>
    `${message.role}: ${message.content}`
  );

/** Fires the event bound under `prop` on the first node that binds one. */
const fire = (ui: unknown, prop: string, event: unknown): void =>
  fireEvent(
    findNode(ui, (node) => propsOf(node)?.[prop] !== undefined),
    prop,
    event,
    `the node binding ${prop}`,
  );

/** Whether a node is rendered and laid out, by its display style. */
const displayed = (node: unknown): boolean =>
  node !== undefined &&
  !JSON.stringify(propValue(node, "style") ?? {}).includes('"display":"none"');

/** Whether the innermost node that sets a display style around the first
 * `element` is laid out. */
const shownAround = (ui: unknown, element: string): boolean =>
  displayed(
    innermostNode(
      ui,
      (node) =>
        findElement(node, element) !== undefined &&
        JSON.stringify(propValue(node, "style") ?? {}).includes('"display"'),
    ),
  );

const titleShown = (ui: unknown): boolean =>
  displayed(findNode(ui, isButton("Subject")));

const titleEditorShown = (ui: unknown): boolean => shownAround(ui, "cf-input");

const generateDisabled = (ui: unknown): unknown =>
  propValue(findElementByText(ui, "cf-button", "Generate"), "disabled");

export default pattern(() => {
  const pieceRegistry = wish<Writable<Array<{ title?: string }>>>({
    query: "#pieceRegistry",
  }).result!;
  const mentionable = wish<Writable<Array<{ title?: string }>>>({
    query: "#mentionable",
  }).result!;
  const subject = ChatNote({ title: "Subject", content: "" });
  const linked = ChatNote({ title: "Linked", content: "Linked content" });
  const child = ChatNote({ title: "Child", parentNotebook: linked });
  const editResult = new Writable("");

  const action_open_title = action(() => clickButton(subject[UI], "Subject"));
  const action_type_in_title = action(() =>
    fire(subject[UI], "oncf-keydown", { key: "a" })
  );
  const action_press_enter = action(() =>
    fire(subject[UI], "oncf-keydown", { key: "Enter" })
  );
  const action_blur_title = action(() => fire(subject[UI], "oncf-blur", {}));
  const action_pick_haiku = action(() =>
    fire(subject[UI], "onChange", {
      target: { value: "anthropic:claude-haiku-4-5" },
    })
  );
  const action_edit_with_result = action(() =>
    subject.editContent.send({
      detail: { value: "Hello" },
      result: editResult,
    })
  );
  const action_edit_answered = action(() =>
    subject.editContent.send({ detail: { value: "Q\n---\n## AI\nA" } })
  );
  const action_edit_follow_up = action(() =>
    subject.editContent.send({
      detail: { value: "Q\n---\n## AI\nA\n---\nFollow up" },
    })
  );
  const action_edit_bare_separator = action(() =>
    subject.editContent.send({ detail: { value: "Q\n---" } })
  );
  const action_edit_empty = action(() =>
    subject.editContent.send({ detail: { value: "" } })
  );
  const action_edit_hello = action(() =>
    subject.editContent.send({ detail: { value: "Hello" } })
  );
  const action_edit_with_newline = action(() =>
    subject.editContent.send({ detail: { value: "Hi\n" } })
  );
  const action_generate = action(() => clickButton(subject[UI], "Generate"));
  const action_cancel = action(() => clickButton(subject[UI], "Cancel"));
  const action_shortcut = action(() =>
    fireEvent(
      findElement(subject[UI], "cf-keybind"),
      "oncf-keybind",
      {},
      "the keyboard shortcut",
    )
  );
  const action_link_without_navigating = action(() =>
    fire(subject[UI], "onbacklink-create", {
      detail: {
        text: "Linked",
        pieceId: "linked",
        piece: linked,
        navigate: false,
      },
    })
  );
  const action_link_and_navigate = action(() =>
    fire(subject[UI], "onbacklink-create", {
      detail: { text: "Child", pieceId: "child", piece: child, navigate: true },
    })
  );
  // One navigation per step, as a person clicks one link at a time.
  const action_follow_backlink = action(() =>
    fire(subject[UI], "onbacklink-click", { detail: { piece: linked } })
  );
  const action_follow_parent_chip = action(() =>
    fireEvent(
      findElement(child[UI], "cf-chip"),
      "oncf-click",
      {},
      "the parent notebook chip",
    )
  );

  // An empty document is no conversation, under the default system prompt.
  const assert_parses_empty_document = assert(() => {
    const result = parseContentToMessages("  ", []);
    return result.messages.length === 0 &&
      result.system.startsWith("You are Claude");
  });
  // A system section sets the prompt; adjacent sections of one role merge;
  // empty sections and empty AI sections are dropped.
  const assert_parses_conversation = assert(() => {
    const result = parseContentToMessages(
      "## System\nBe terse.\n---\nfirst\n---\nsecond\n---\n## AI\nanswer" +
        "\n---\n## Assistant\nmore\n---\n\n---\n## AI\n",
      [],
    );
    const lines = result.messages.map((message) =>
      `${message.role}: ${message.content}`
    );
    return result.system === "Be terse." && lines.length === 2 &&
      lines[0] === "user: first\n\nsecond" &&
      lines[1] === "assistant: answer\n\nmore";
  });
  const assert_empty_system_section_keeps_default = assert(() => {
    const result = parseContentToMessages("## System\n---\nhi", []);
    return result.system.startsWith("You are Claude") &&
      result.messages.length === 1;
  });
  // A wiki link to a known note expands to its content; an unknown one stays.
  const assert_expands_known_wiki_links = assert(() => {
    const lines = parsed("See [[Linked (linked-id)]] and [[Gone (missing)]]");
    return lines.length === 1 &&
      lines[0] ===
        "user: See ## Linked\nLinked content and [[Gone (missing)]]";
  });

  const assert_starts_blank = assert(() =>
    subject[NAME] === "💬 Subject" && subject.content === "" &&
    subject.isGenerating === false && generateDisabled(subject[UI]) === true &&
    titleShown(subject[UI]) && !titleEditorShown(subject[UI]) &&
    (pieceRegistry.get() ?? []).length === 0
  );
  // Only a note with a parent shows the chip, labeled with the parent's name.
  const assert_child_shows_parent_chip = assert(() =>
    propValue(findElement(child[UI], "cf-chip"), "label") === "💬 Linked" &&
    shownAround(child[UI], "cf-chip") && !shownAround(subject[UI], "cf-chip")
  );

  const assert_title_editing = assert(() =>
    titleEditorShown(subject[UI]) && !titleShown(subject[UI])
  );
  const assert_title_not_editing = assert(() =>
    titleShown(subject[UI]) && !titleEditorShown(subject[UI])
  );

  const assert_model_picked = assert(() =>
    propValue(findElement(subject[UI], "select"), "value") ===
      "anthropic:claude-haiku-4-5"
  );

  const assert_edit_sets_content_and_result = assert(() =>
    subject.content === "Hello" && editResult.get() === "updated" &&
    generateDisabled(subject[UI]) === false
  );
  const assert_answered_cannot_generate = assert(() =>
    subject.content === "Q\n---\n## AI\nA" &&
    generateDisabled(subject[UI]) === true
  );
  const assert_follow_up_can_generate = assert(() =>
    generateDisabled(subject[UI]) === false
  );
  const assert_bare_separator_cannot_generate = assert(() =>
    generateDisabled(subject[UI]) === true
  );
  const assert_empty_stays_empty = assert(() =>
    subject.content === "" && subject.isGenerating === false
  );

  // The mocked reply lands under the AI heading, closed by a separator, and
  // the note is ready for the next turn.
  const assert_generate_completes = assert(() =>
    subject.content === "Hello\n---\n## AI\nHi there\n---\n" &&
    subject.isGenerating === false && generateDisabled(subject[UI]) === true &&
    propValue(findElement(subject[UI], "cf-code-editor"), "readonly") === false
  );
  // No mock answers "Hi", so this generation never completes.
  const assert_shortcut_generates_after_newline = assert(() =>
    subject.content === "Hi\n---\n## AI\n" &&
    subject.isGenerating === true && generateDisabled(subject[UI]) === true &&
    propValue(findElement(subject[UI], "cf-code-editor"), "readonly") === true
  );
  const assert_cancel_stops = assert(() =>
    subject.isGenerating === false &&
    subject.content === "Hi\n---\n## AI\n"
  );

  const assert_link_registers_and_mentions = assert(() =>
    pieceRegistry.get().length === 1 &&
    pieceRegistry.get()[0]?.title === "Linked" &&
    mentionable.get().length === 1
  );
  // Navigating registers the piece without making it mentionable.
  const assert_navigating_link_only_registers = assert(() =>
    pieceRegistry.get().length === 2 &&
    pieceRegistry.get()[1]?.title === "Child" &&
    mentionable.get().length === 1
  );
  // Following a link or the parent chip leaves the registry, the mentionable
  // list, and the note as they were.
  const assert_following_links_changes_nothing = assert(() =>
    pieceRegistry.get().length === 2 && mentionable.get().length === 1 &&
    subject.content === "Hi\n---\n## AI\n"
  );

  return {
    [TESTS]: [
      { assertion: assert_parses_empty_document },
      { assertion: assert_parses_conversation },
      { assertion: assert_empty_system_section_keeps_default },
      { assertion: assert_expands_known_wiki_links },
      { assertion: assert_starts_blank },
      { assertion: assert_child_shows_parent_chip },

      { action: action_open_title },
      { assertion: assert_title_editing },
      { action: action_type_in_title },
      { assertion: assert_title_editing },
      { action: action_press_enter },
      { assertion: assert_title_not_editing },
      { action: action_open_title },
      { action: action_blur_title },
      { assertion: assert_title_not_editing },

      { action: action_pick_haiku },
      { assertion: assert_model_picked },

      { action: action_edit_with_result },
      { assertion: assert_edit_sets_content_and_result },
      { action: action_edit_answered },
      { action: action_generate },
      { assertion: assert_answered_cannot_generate },
      { action: action_edit_follow_up },
      { assertion: assert_follow_up_can_generate },
      { action: action_edit_bare_separator },
      { assertion: assert_bare_separator_cannot_generate },
      { action: action_edit_empty },
      { action: action_generate },
      { assertion: assert_empty_stays_empty },

      { action: action_edit_hello },
      { action: action_generate },
      { assertion: assert_generate_completes },
      { action: action_edit_with_newline },
      { action: action_shortcut },
      { assertion: assert_shortcut_generates_after_newline },
      { action: action_cancel },
      { assertion: assert_cancel_stops },

      { action: action_link_without_navigating },
      { assertion: assert_link_registers_and_mentions },
      { action: action_link_and_navigate },
      { assertion: assert_navigating_link_only_registers },
      { action: action_follow_backlink },
      { assertion: assert_following_links_changes_nothing },
      { action: action_follow_parent_chip },
      { assertion: assert_following_links_changes_nothing },
    ],
    // A request no mock answers fails with a warning.
    allowConsoleWarnings: true,
    subject,
  };
});

// The model's one reply: to the conversation whose last turn is "Hello".
export const llmMocks = [{ promptIncludes: "Hello", text: "Hi there" }];
