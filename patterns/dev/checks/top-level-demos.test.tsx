/**
 * Test Pattern: the demo and fixture patterns at the top of the package
 *
 * These are the standalone demos and rendering fixtures that sit directly in
 * `patterns` rather than in a directory of their own. Each one is a
 * whole small program, and none of them had a test, so nothing built them
 * outside a browser.
 *
 * This builds each one with real inputs and checks what it publishes: the name
 * it goes under, the collections it derives, and text its rendered tree
 * carries. Where a demo has one headline action — the text swapper's swap, the
 * chat lobby's join — the test drives it and checks the state it moved.
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

import AnnotationManager from "../../apps/annotation-manager/annotation-manager.tsx";
import Aside from "../../examples/aside/aside.tsx";
import Bookmarks from "../../apps/bookmarks/bookmarks.tsx";
import Chatbot from "../../system/chatbot/chatbot.tsx";
import Cheeseboard from "../../apps/cheeseboard/cheeseboard.tsx";
import FormDemo from "../../examples/form-demo/form-demo.tsx";
import GroupChatLobby from "../../examples/group-chat-lobby/group-chat-lobby.tsx";
import GroupChatRoom from "../../examples/group-chat-room/group-chat-room.tsx";
import ImageAnalysis from "../../apps/image-analysis/image-analysis.tsx";
import LinkPreview from "../../examples/link-preview/link-preview.tsx";
import MobileAppDemo from "../../examples/mobile-app-demo/mobile-app-demo.tsx";
import NestedMapIfElseTest from "../nested-map-ifelse-test/nested-map-ifelse-test.tsx";
import ProfileRosterLiveDemo from "../../examples/profile-roster-live-demo/profile-roster-live-demo.tsx";
import RenderTest from "../render-test/render-test.tsx";
import {
  hasText,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import TextSwapper from "../../examples/text-swapper/text-swapper.tsx";

export default pattern(() => {
  // ==========================================================================
  // The demos, each with the inputs it needs
  // ==========================================================================

  const leftText = new Writable("Hello");
  const rightText = new Writable("World");
  const swapper = TextSwapper({ leftText, rightText });

  const people = new Writable<
    { name: string; email: string; role: "user" | "admin" }[]
  >([
    { name: "Ada", email: "ada@example.com", role: "admin" },
    { name: "Bo", email: "bo@example.com", role: "user" },
  ]);
  const formDemo = FormDemo({ people });

  const renderTest = RenderTest({
    title: "Render Test",
    globalCounter: 0,
    items: [
      { name: "first", value: 1, subItems: [] },
      { name: "second", value: 2, subItems: [] },
    ],
  });

  const nestedMap = NestedMapIfElseTest({
    items: [
      { title: "Milk", done: false, category: "Dairy" },
      { title: "Bread", done: true, category: "Bakery" },
    ],
    log: [],
  });

  const linkPreview = LinkPreview({ url: "https://example.com" });

  const messages = new Writable<[]>([]);
  const users = new Writable<[]>([]);
  const sessionId = new Writable("");
  const lobby = GroupChatLobby({
    chatName: "Test Chat",
    messages,
    users,
    sessionId,
  });

  const roomMessages = new Writable<[]>([]);
  const roomUsers = new Writable<[]>([]);
  const currentSessionId = new Writable("session-1");
  const room = GroupChatRoom({
    messages: roomMessages,
    users: roomUsers,
    myName: "Ada",
    mySessionId: "session-1",
    currentSessionId,
  });

  const mobileApp = MobileAppDemo({});
  const bookmarks = Bookmarks({});
  const chatbot = Chatbot({});
  const cheeseboard = Cheeseboard({});
  const aside = Aside({});
  const imageAnalysis = ImageAnalysis({});
  const annotationManager = AnnotationManager({});
  const profileRoster = ProfileRosterLiveDemo({});

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_swap_texts = action(() => {
    const left = leftText.get();
    leftText.set(rightText.get());
    rightText.set(left);
  });

  const action_add_person = action(() => {
    people.push({ name: "Cy", email: "cy@example.com", role: "user" });
  });

  // ==========================================================================
  // Assertions
  // ==========================================================================

  const assert_swapper_starts = assert(() =>
    swapper.leftText === "Hello" && swapper.rightText === "World"
  );

  const assert_swapper_swapped = assert(() =>
    swapper.leftText === "World" && swapper.rightText === "Hello"
  );

  // The form demo titles itself with the number of people it holds and lists
  // each of them.
  const assert_form_demo_lists_people = assert(() =>
    formDemo[NAME] === "People Directory (2)" &&
    formDemo.people.length === 2 &&
    hasText(formDemo[UI], "Ada") &&
    hasText(formDemo[UI], "Bo")
  );

  const assert_form_demo_grew = assert(() =>
    formDemo[NAME] === "People Directory (3)" &&
    formDemo.people.length === 3 &&
    hasText(formDemo[UI], "Cy")
  );

  // The two rendering fixtures pass their items straight back out, and each
  // declares its output to be its input, so the items are what there is to
  // check. Building them is what runs their nested maps and conditionals.
  const assert_render_test_builds = assert(() =>
    renderTest.title === "Render Test" && renderTest.items.length === 2
  );

  const assert_nested_map_builds = assert(() =>
    nestedMap.items.length === 2 && nestedMap.items[0].title === "Milk"
  );

  const assert_link_preview_holds_url = assert(() =>
    linkPreview.url === "https://example.com"
  );

  // The lobby names itself for the chat it fronts, and starts with nobody in.
  const assert_lobby_empty = assert(() =>
    lobby[NAME] === "Test Chat - Lobby" &&
    lobby.users.get().length === 0 &&
    lobby.messages.get().length === 0
  );

  const assert_room_named_for_me = assert(() => room.myName === "Ada");

  // Every remaining demo builds a tree. Bookmarks is checked for a tree rather
  // than for text: it starts with an empty list and has no text of its own.
  const assert_demos_render = assert(() =>
    textContent(mobileApp[UI]).length > 0 &&
    textContent(chatbot[UI]).length > 0 &&
    textContent(cheeseboard[UI]).length > 0 &&
    textContent(aside[UI]).length > 0 &&
    textContent(imageAnalysis[UI]).length > 0 &&
    textContent(annotationManager[UI]).length > 0 &&
    textContent(profileRoster[UI]).length > 0 &&
    bookmarks[UI] != null
  );

  return {
    [TESTS]: [
      { assertion: assert_swapper_starts },
      { assertion: assert_form_demo_lists_people },
      { assertion: assert_render_test_builds },
      { assertion: assert_nested_map_builds },
      { assertion: assert_link_preview_holds_url },
      { assertion: assert_lobby_empty },
      { assertion: assert_room_named_for_me },
      { assertion: assert_demos_render },

      { action: action_swap_texts },
      { assertion: assert_swapper_swapped },

      { action: action_add_person },
      { assertion: assert_form_demo_grew },
    ],
    swapper,
    formDemo,
    lobby,
    room,
  };
});
