/**
 * What the board and a topic actually RENDER through whatever projection the
 * board declares for its topics: that a card carries its topic's text, that
 * the body editor's completion source reaches it populated, and that an entry
 * of that source carries the number its topic publishes — through the board's
 * derived universe, and through the raw topics list a topic not yet rewired to
 * that universe reads.
 *
 * The four assertions over the board's card and the two editors were validated
 * by mutation — remove the step that files a topic and each goes red — so none
 * of them is decoration.
 *
 * WHAT THIS CANNOT CATCH, stated because the gap is not obvious and I walked
 * into it: narrowing `mentionable` to a projection WITHOUT `[NAME]` leaves
 * every assertion here green. `cf-code-editor` declares its entries as
 * `Mentionable`, whose schema carries `required: [NAME]`
 * (`packages/ui/src/v2/core/mentionable.ts`), but that filtering happens at
 * the COMPONENT's read in the browser. A pattern test sees the cell, not the
 * component's schema-filtered view of it, so the entries still carry their
 * name here however narrowly the pattern declared them. Only a browser test
 * crosses that boundary; `packages/patterns/integration/topic-board-*` is
 * where that guard belongs.
 *
 * Deliberately separate from topics.test.tsx: it touches no verb through the
 * board's projection, so it keeps compiling while a demand-narrowing change is
 * in flight — which is exactly when the render contract needs guarding.
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import Topics from "./main.tsx";
import Topic from "./topic.tsx";

interface TestVNode {
  type: "vnode";
  name: string;
  // deno-lint-ignore no-explicit-any
  props: Record<string, any>;
  children: unknown[];
}

const isVNode = (node: unknown): node is TestVNode =>
  typeof node === "object" && node !== null &&
  (node as { type?: unknown }).type === "vnode";

function findAllByTag(
  node: unknown,
  tag: string,
  found: TestVNode[] = [],
): TestVNode[] {
  // Resolved BEFORE either test, and before the array check so that a
  // cell-backed list of children is stepped through rather than skipped. A
  // compiled reactive child arrives cell-backed, and asking `isVNode` of the
  // cell rather than its value stops the walk one level above whatever it was
  // looking for. That failure is not silent here — the assertions below treat
  // "no editor found" as false — but a guard that reports a real render as a
  // regression is no more use than one that misses it. `propValue` returns a
  // non-cell unchanged, so this costs nothing on the plain path.
  const resolved = propValue(node);
  if (Array.isArray(resolved)) {
    resolved.forEach((child) => findAllByTag(child, tag, found));
    return found;
  }
  if (!isVNode(resolved)) return found;
  if (resolved.name === tag) found.push(resolved);
  for (const child of resolved.children ?? []) findAllByTag(child, tag, found);
  return found;
}

/** Compiled JSX props can be cell-backed even where the source wrote a plain
 * value, so every prop read goes through this. */
// deno-lint-ignore no-explicit-any
const propValue = (value: any): unknown =>
  value && typeof value.get === "function" ? value.get() : value;

/** Every string anywhere in a rendered subtree, so an assertion can ask what
 * the reader would SEE rather than what the model holds. */
function renderedText(node: unknown, into: string[] = []): string[] {
  // Resolved before the array check, for the reason given on `findAllByTag`.
  const resolved = propValue(node);
  if (Array.isArray(resolved)) {
    resolved.forEach((child) => renderedText(child, into));
    return into;
  }
  if (typeof resolved === "string") {
    into.push(resolved);
    return into;
  }
  if (!isVNode(resolved)) return into;
  for (const child of resolved.children ?? []) renderedText(child, into);
  return into;
}

export default pattern(() => {
  const board = Topics({});

  const action_file_a_topic = action(() => {
    board.addTopic.send({
      title: "Rendered topic",
      body: "the living document",
      agentName: "Fable",
    });
  });

  // Wired the way `addTopic` wires its own children, so the projection under
  // test is the one production uses rather than a fixture's.
  const detail = Topic({
    title: "Detail topic",
    mentionable: board.mentionable,
    boardCrossrefs: board.crossrefs,
  });

  const action_open_the_editor = action(() => {
    detail.startEditBody.send();
  });

  // A topic whose mention universe is the board's topics themselves, which is
  // what a topic filed before the board derived its universe reads until an
  // operator rewires it. Its editor completes over the topics rather than over
  // the board's copies, so what it could offer for `#1` is what each topic
  // publishes as its own name.
  const rawUniverseDetail = Topic({
    title: "Raw universe topic",
    mentionable: board.topics,
  });

  const action_open_the_raw_editor = action(() => {
    rawUniverseDetail.startEditBody.send();
  });

  // A comment, then the same comment revised. `editComment` is reached on the
  // instance rather than through the board, for the reason the board's own
  // demand gives: it carries no verbs.
  const action_comment_on_detail = action(() => {
    detail.addComment.send({ body: "as first written", agentName: "Fable" });
  });
  const action_revise_that_comment = action(() => {
    const comment = detail.comments[0];
    if (comment) {
      detail.editComment.send({
        comment,
        body: "as revised",
        agentName: "Fable",
      });
    }
  });

  // The board's card list renders through whatever the board demands of a
  // stored topic. If that projection stops carrying a field a card reads, the
  // card goes blank while every model-level assertion stays green.
  const assert_card_shows_its_topic = assert(() => {
    const text = renderedText(board[UI]).join(" ");
    return text.includes("Rendered topic") &&
      text.includes("the living document");
  });

  // The break this file exists for: the editor's completion source must reach
  // it non-empty, and each entry must carry the display name the component
  // declares as required.
  const assert_editor_receives_mentionables = assert(() => {
    const editors = findAllByTag(detail[UI], "cf-code-editor");
    if (editors.length !== 1) return false;
    const entries = propValue(editors[0].props["$mentionable"]);
    if (!Array.isArray(entries) || entries.length === 0) return false;
    return entries.every((entry) => {
      const name = propValue((entry as Record<string, unknown>)?.[NAME]);
      return typeof name === "string" && name.length > 0;
    });
  });

  // The board's table names the filed topic `1`, and the entry standing for it
  // in the editor's completion source carries that number, so a `#1` query
  // offers that topic and a mention of it shows the number.
  const assert_editor_entries_carry_the_number = assert(() => {
    const editors = findAllByTag(detail[UI], "cf-code-editor");
    if (editors.length !== 1) return false;
    const entries = propValue(editors[0].props["$mentionable"]);
    if (!Array.isArray(entries) || entries.length !== 1) return false;
    const entry = entries[0] as Record<string, unknown>;
    return board.namesTable?.[0]?.name === "1" &&
      propValue(entry?.[NAME]) === "Rendered topic" &&
      propValue(entry?.shortName) === "1";
  });

  // The same of the raw list, where an entry IS a topic rather than a copy of
  // one: the topic the table names `1` publishes that number, so the entry
  // carries it with none of the board's derivation in between.
  const assert_raw_entries_carry_the_number = assert(() => {
    const editors = findAllByTag(rawUniverseDetail[UI], "cf-code-editor");
    if (editors.length !== 1) return false;
    const entries = propValue(editors[0].props["$mentionable"]);
    if (!Array.isArray(entries) || entries.length !== 1) return false;
    const entry = entries[0] as Record<string, unknown>;
    return board.namesTable?.[0]?.name === "1" &&
      propValue(entry?.[NAME]) === "Rendered topic" &&
      propValue(entry?.shortName) === "1";
  });

  // An edit is only honest if a reader can see one happened, and `editedAt`
  // is written by the verb rather than shown by anything that reads it. These
  // two assertions are a pair on purpose: the first says the marker is absent
  // when nothing was revised, so the second cannot pass on a marker that is
  // simply always there.
  const assert_no_edited_marker_before = assert(() => {
    const text = renderedText(detail[UI]).join(" ");
    return text.includes("as first written") && !text.includes("edited");
  });
  const assert_edited_marker_after = assert(() => {
    const text = renderedText(detail[UI]).join(" ");
    return text.includes("as revised") && text.includes("edited");
  });

  return {
    [UI]: board[UI],
    [TESTS]: [
      { action: action_file_a_topic },
      { render: board[UI] },
      { assertion: assert_card_shows_its_topic },
      { action: action_open_the_editor },
      { render: detail[UI] },
      { assertion: assert_editor_receives_mentionables },
      { assertion: assert_editor_entries_carry_the_number },
      { action: action_open_the_raw_editor },
      { render: rawUniverseDetail[UI] },
      { assertion: assert_raw_entries_carry_the_number },
      { action: action_comment_on_detail },
      { render: detail[UI] },
      { assertion: assert_no_edited_marker_before },
      { action: action_revise_that_comment },
      { render: detail[UI] },
      { assertion: assert_edited_marker_after },
    ],
  };
});
