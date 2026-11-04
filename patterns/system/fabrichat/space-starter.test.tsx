/** Exercises starts against the Loom root's shared room registry. */

import {
  action,
  assert,
  type Cell,
  handler,
  NAME,
  pattern,
  type Stream,
  TESTS,
  UI,
  VIEWS,
  wish,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElementByText,
  findNodeById,
  hasText,
  propsOf,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import Loom from "../loom/main.tsx";
import Starter from "./space-starter.tsx";

/** Retains a rendered Start control as a callable stream. */
function startOf(ui: unknown): Stream<unknown> | undefined;
function startOf(ui: unknown): unknown {
  return propsOf(findElementByText(ui, "cf-button", "Start conversation"))
    ?.onClick;
}

/** Reads the starter's profile-setup visibility through rendered props. */
function setupDisplay(ui: unknown): unknown {
  const style = propValue(
    findNodeById(ui, "fabrichat-starter-profile-setup"),
    "style",
  );
  return typeof style === "object" && style !== null && "display" in style
    ? readValue(style.display)
    : undefined;
}

/** Links the fixture root to the Loom registry without snapshotting its state. */
const installRegistry = handler<void, {
  root: Writable<{
    chatRoom?: unknown;
    hasChatRoom?: unknown;
    ensureChatRoom?: unknown;
  }>;
  loom: Cell<{
    chatRoom?: unknown;
    hasChatRoom: boolean;
    ensureChatRoom: Stream<void>;
  }>;
}>((_, { root, loom }) => {
  root.key("chatRoom").set(loom.key("chatRoom"));
  root.key("hasChatRoom").set(loom.key("hasChatRoom"));
  if (root.get().ensureChatRoom === undefined) {
    root.key("ensureChatRoom").set(loom.get().ensureChatRoom);
  }
});

export default pattern(() => {
  const first = Starter({});
  const second = Starter({});
  const loom = Loom({});
  const root = wish<
    Writable<{
      chatRoom?: unknown;
      hasChatRoom?: unknown;
      ensureChatRoom?: unknown;
    }>
  >({ query: "#default" }).result!;
  const saved = Writable.of<{ start?: Stream<unknown> }>({});
  const held = Writable.of<{ room?: Writable<{ [NAME]?: string }> }>({});
  const notRoom = new Writable({ [NAME]: "Other piece" });
  const uiOnly = new Writable({
    [NAME]: "UI-only piece",
    [UI]: {
      type: "vnode",
      name: "span",
      props: {},
      children: ["Unrelated piece UI"],
    },
  });
  const emptyRoom = new Writable<{ [NAME]?: string }>();
  const installOlderRegistry = action(() =>
    root.key("ensureChatRoom").set(loom.ensureChatRoom)
  );
  const install = installRegistry({ root, loom });
  const capture = action(() => saved.set({ start: startOf(second[UI]) }));
  const start = action(() => clickButton(first[UI], "Start conversation"));
  const repeat = action(() => saved.get().start!.send({}));
  const hold = action(() => {
    if (loom.chatRoom !== undefined) held.set({ room: loom.chatRoom });
  });
  const nameOtherPiece = action(() => loom.setChatRoom.send({ room: notRoom }));
  const nameUiOnly = action(() => loom.setChatRoom.send({ room: uiOnly }));
  const nameEmptyRoom = action(() =>
    loom.setChatRoom.send({ room: emptyRoom })
  );
  return {
    [TESTS]: [
      { render: first[UI] },
      { assertion: assert(() => hasText(first[UI], "Start conversation")) },
      {
        assertion: assert(() =>
          propValue(
            findElementByText(first[UI], "cf-button", "Start conversation"),
            "disabled",
          ) === true
        ),
      },
      { assertion: assert(() => first.room?.get() === undefined) },
      { assertion: assert(() => first[VIEWS].room === undefined) },
      { assertion: assert(() => setupDisplay(first[UI]) === "block") },
      { action: start },
      { assertion: assert(() => loom.chatRoom?.get() === undefined) },
      { assertion: assert(() => loom.hasChatRoom === false) },
      { action: installOlderRegistry },
      { render: first[UI] },
      {
        assertion: assert(() =>
          propValue(
            findElementByText(first[UI], "cf-button", "Start conversation"),
            "disabled",
          ) === true
        ),
      },
      { action: start },
      { assertion: assert(() => loom.hasChatRoom === false) },
      { action: install },
      { render: first[UI] },
      { render: second[UI] },
      { assertion: assert(() => loom.chatRoom?.get() === undefined) },
      {
        assertion: assert(() =>
          propValue(
            findElementByText(first[UI], "cf-button", "Start conversation"),
            "disabled",
          ) === false
        ),
      },
      { action: capture },
      { assertion: assert(() => saved.get().start !== undefined) },
      { action: start },
      { render: first[UI] },
      { render: second[UI] },
      { assertion: assert(() => loom.chatRoom?.get() !== undefined) },
      { assertion: assert(() => loom.hasChatRoom === true) },
      { assertion: assert(() => first[VIEWS].room !== undefined) },
      {
        assertion: assert(() =>
          first[VIEWS].room?.replyShape === "thread-quotes"
        ),
      },
      {
        assertion: assert(() =>
          first[VIEWS].room?.replyShape ===
            first.room?.get()?.[VIEWS]?.room?.replyShape
        ),
      },
      { assertion: assert(() => first.room?.equals(loom.chatRoom!) === true) },
      { assertion: assert(() => second.room?.equals(first.room!) === true) },
      { assertion: assert(() => !hasText(first[UI], "Start conversation")) },
      { assertion: assert(() => setupDisplay(first[UI]) === "none") },
      { assertion: assert(() => !hasText(second[UI], "Start conversation")) },
      { action: hold },
      { action: repeat },
      { assertion: assert(() => first.room?.equals(loom.chatRoom!) === true) },
      { assertion: assert(() => second.room?.equals(first.room!) === true) },
      {
        assertion: assert(() =>
          loom.chatRoom?.equals(held.key("room")) === true
        ),
      },
      { assertion: assert(() => loom.panels.length === 0) },
      { assertion: assert(() => loom.pieceRegistry.length === 0) },
      { action: nameOtherPiece },
      { assertion: assert(() => loom.hasChatRoom === true) },
      { render: first[UI] },
      {
        assertion: assert(() =>
          hasText(first[UI], "The space's conversation is unavailable.")
        ),
      },
      { assertion: assert(() => !hasText(first[UI], "Start conversation")) },
      { assertion: assert(() => first[VIEWS].room === undefined) },
      { action: repeat },
      { assertion: assert(() => loom.chatRoom?.equals(notRoom) === true) },
      { action: nameUiOnly },
      { assertion: assert(() => loom.hasChatRoom === true) },
      { render: first[UI] },
      {
        assertion: assert(() =>
          hasText(first[UI], "The space's conversation is unavailable.")
        ),
      },
      { assertion: assert(() => !hasText(first[UI], "Unrelated piece UI")) },
      { assertion: assert(() => !hasText(first[UI], "Start conversation")) },
      { assertion: assert(() => first[VIEWS].room === undefined) },
      { action: repeat },
      { assertion: assert(() => loom.chatRoom?.equals(uiOnly) === true) },
      { action: nameEmptyRoom },
      { assertion: assert(() => loom.hasChatRoom === true) },
      { render: first[UI] },
      {
        assertion: assert(() =>
          hasText(first[UI], "The space's conversation is unavailable.")
        ),
      },
      { assertion: assert(() => !hasText(first[UI], "Start conversation")) },
      { assertion: assert(() => first[VIEWS].room === undefined) },
      { action: repeat },
      { assertion: assert(() => loom.chatRoom?.equals(emptyRoom) === true) },
    ],
  };
});
