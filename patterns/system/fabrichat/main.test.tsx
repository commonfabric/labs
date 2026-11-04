/** Exercises reviewed starts against the Loom root's shared room registry. */

import {
  action,
  assert,
  NAME,
  pattern,
  type Stream,
  TESTS,
  UI,
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
import Main from "./main.tsx";
import { CHAT_START_ACTION, CHAT_START_SURFACE } from "./schemas.tsx";

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
  ) as { display?: unknown } | undefined;
  return readValue(style?.display);
}

export default pattern(() => {
  const first = Main({});
  const second = Main({});
  const loom = Loom({});
  const root = wish<
    Writable<{
      chatRoom?: unknown;
      ensureChatRoom?: unknown;
    }>
  >({ query: "#default" }).result!;
  const saved = Writable.of<{ start?: Stream<unknown> }>({});
  const held = Writable.of<{ room?: Writable<{ [NAME]?: string }> }>({});
  const install = action(() => {
    root.key("chatRoom").set(loom.chatRoom);
    root.key("ensureChatRoom").set(loom.ensureChatRoom);
  });
  const capture = action(() => saved.set({ start: startOf(second[UI]) }));
  const start = action(() => clickButton(first[UI], "Start conversation"));
  const repeat = action(() => saved.get().start!.send({}));
  const hold = action(() => {
    if (loom.chatRoom !== undefined) held.set({ room: loom.chatRoom });
  });
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
      { assertion: assert(() => setupDisplay(first[UI]) === "block") },
      {
        action: start,
        trustedUi: { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION },
      },
      { assertion: assert(() => loom.chatRoom?.get() === undefined) },
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
      {
        action: start,
        trustedUi: { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION },
      },
      { render: first[UI] },
      { render: second[UI] },
      { assertion: assert(() => loom.chatRoom?.get() !== undefined) },
      { assertion: assert(() => first.room?.equals(loom.chatRoom!) === true) },
      { assertion: assert(() => second.room?.equals(first.room!) === true) },
      { assertion: assert(() => !hasText(first[UI], "Start conversation")) },
      { assertion: assert(() => setupDisplay(first[UI]) === "none") },
      { assertion: assert(() => !hasText(second[UI], "Start conversation")) },
      { action: hold },
      {
        action: repeat,
        trustedUi: { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION },
      },
      { assertion: assert(() => first.room?.equals(loom.chatRoom!) === true) },
      { assertion: assert(() => second.room?.equals(first.room!) === true) },
      {
        assertion: assert(() =>
          loom.chatRoom?.equals(held.key("room")) === true
        ),
      },
      { assertion: assert(() => loom.panels.length === 0) },
      { assertion: assert(() => loom.pieceRegistry.length === 0) },
    ],
  };
});
