import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  hasText,
  innermostNode,
  isElement,
} from "../../../patterns/tools/test-support/vnode-helpers.ts";
import type { AgentCommandValue } from "./main.tsx";
import { DebugViewFixture } from "./test/fixture.ts";

/** One more command than a page of the command history holds. */
const QUEUED_COMMANDS: AgentCommandValue[] = Array.from(
  { length: 26 },
  (_, index) => ({
    schema: "commonfabric.agent-connector.command",
    ownerDid: "did:key:test-owner",
    id: `cmd-${String(index + 1).padStart(2, "0")}`,
    createdAt: "2026-07-20T00:03:00.000Z",
    sourceId: "codex",
    nativeSessionId: "session-1",
    type: "cancel",
    payload: {},
  }),
);

/** The card that lists the command action values. */
function commandHistory(root: unknown): unknown {
  return innermostNode(
    root,
    (node) =>
      isElement(node, "cf-card") && hasText(node, "Command action values"),
  );
}

/** Whether the command history shows page `page` of two, listing only the
 * newest command on the first page and only the oldest on the second. */
function showsCommandPage(root: unknown, page: 1 | 2): boolean {
  const history = commandHistory(root);
  const [shown, hidden] = page === 1
    ? ["cmd-26", "cmd-01"]
    : ["cmd-01", "cmd-26"];
  return hasText(history, `Page ${page} of 2`) &&
    hasText(history, shown) && !hasText(history, hidden);
}

export default pattern(() => {
  const fixture = DebugViewFixture();
  const view = fixture.view;
  const commands = fixture.commands;

  // The command history pages from the newest command: "Older" moves to the
  // page holding the oldest command, "Newer" moves back, and neither moves
  // past the first or last page.
  const action_queue_commands = action(() => {
    commands.set(QUEUED_COMMANDS);
  });
  const assert_newest_page = assert(() =>
    view.commandCount === 26 && showsCommandPage(view[UI], 1)
  );
  const action_older = action(() => {
    clickButton(commandHistory(view[UI]), "Older");
  });
  const assert_oldest_page = assert(() => showsCommandPage(view[UI], 2));
  const action_newer = action(() => {
    clickButton(commandHistory(view[UI]), "Newer");
  });

  return {
    [TESTS]: [
      { action: action_queue_commands },
      { assertion: assert_newest_page },
      { action: action_older },
      { assertion: assert_oldest_page },
      { action: action_older },
      { assertion: assert_oldest_page },
      { action: action_newer },
      { assertion: assert_newest_page },
      { action: action_newer },
      { assertion: assert_newest_page },
    ],
    view,
  };
});
