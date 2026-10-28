/**
 * Retitling a FabriChat room: any member who can write in it sets the title
 * every member shares, in a group room or a direct one, from a trusted gesture
 * on `ChatRetitleSurface`. The room's views and its name show the title a
 * member last set, ahead of the one it was created with, and each retitle's
 * outcome is recorded under its `requestId` in the sender's `titleRequests`: a
 * refused one with a reason and a code, which changes nothing else.
 * `retitle-members.test.tsx` covers retitles by members of each access level,
 * and `retitle-manager.test.tsx` the manager's list following one.
 */
import {
  type AddIntegrity,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  VIEWS,
  Writable,
} from "commonfabric";
import {
  findNodeById,
  propValue,
  readValue,
  textContent,
} from "../test/vnode-helpers.ts";
import { type MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_RETITLE_ACTION,
  CHAT_RETITLE_SURFACE,
  type ChatProfile,
  type SetTitleOutcome,
  type TitleRecord,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const retitleGesture = {
  surface: CHAT_RETITLE_SURFACE,
  action: CHAT_RETITLE_ACTION,
};

/** The outcome `outcomes` records under `id`, as `status` or `status/code`. */
const outcomeOf = (
  outcomes: Record<string, SetTitleOutcome> | undefined,
  id: string,
): string => {
  const outcome = outcomes?.[id];
  return outcome === undefined
    ? "none"
    : outcome.status === "refused"
    ? `refused/${outcome.code}`
    : outcome.status;
};

/** Why `outcomes` records the request `id` was refused, or `""`. */
const reasonOf = (
  outcomes: Record<string, SetTitleOutcome> | undefined,
  id: string,
): string => {
  const outcome = outcomes?.[id];
  return outcome?.status === "refused" ? outcome.reason : "";
};

// How the element `id` under `root` is displayed.
const displayOf = (root: unknown, id: string): unknown =>
  readValue(
    (propValue(findNodeById(root, id), "style") as { display?: unknown })
      ?.display,
  );

// What the room's retitle control shows of the session's latest refusal.
const shownRefusal = (root: unknown): string =>
  displayOf(root, "fabrichat-retitle-refusal") === "none"
    ? ""
    : textContent(findNodeById(root, "fabrichat-retitle-refusal")).trim();

/** A room's records, with none of them holding anything yet. */
const freshRecords = () => ({
  messages: Writable.of<MessagesValue>([] as MessagesValue),
  titles: Writable.of<TitleRecord[]>([]),
});

export default pattern(() => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
  const group = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const, title: "Team" },
    ...freshRecords(),
  } as RoomArg);
  const direct = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "direct" as const },
    ...freshRecords(),
  } as RoomArg);
  // A space's own chat, which has no `about`, and is shown by its space's
  // name.
  const shared = FabriChatRoomCore({
    myProfile: profile,
    ...freshRecords(),
  } as RoomArg);

  return {
    [TESTS]: [
      // Before any retitle, a group room shows the title it was created with,
      // and a direct room none. The viewer can write in each, so each offers
      // its retitle control, and a space's own chat doesn't.
      {
        assertion: assert(() =>
          group[VIEWS].room.about.title === "Team" &&
          group[NAME] === "Team" &&
          direct[VIEWS].room.about.title === undefined &&
          direct[NAME] === "Direct chat" &&
          displayOf(group[UI], "fabrichat-retitle") === "flex" &&
          displayOf(direct[UI], "fabrichat-retitle") === "flex" &&
          displayOf(shared[UI], "fabrichat-retitle") === "none"
        ),
      },
      // A member retitles a group room. The view, and the room's name, show
      // the new title, trimmed, and the outcome is recorded as done.
      {
        action: group[VIEWS].room.setTitle,
        event: { requestId: "t-1", title: "  Plans  " },
        trustedUi: retitleGesture,
      },
      {
        assertion: assert(() =>
          group[VIEWS].room.about.title === "Plans" &&
          group.about.title === "Plans" &&
          group[NAME] === "Plans" &&
          outcomeOf(group[VIEWS].room.titleRequests, "t-1") === "done"
        ),
      },
      // A member titles a direct room, which has none until then.
      {
        action: direct[VIEWS].room.setTitle,
        event: { requestId: "t-2", title: "Us two" },
        trustedUi: retitleGesture,
      },
      {
        assertion: assert(() =>
          direct[VIEWS].room.about.title === "Us two" &&
          direct[NAME] === "Us two" &&
          direct[VIEWS].room.about.kind === "direct" &&
          outcomeOf(direct[VIEWS].room.titleRequests, "t-2") === "done"
        ),
      },
      // The rendered control sends the text it holds, and no `requestId`.
      {
        action: group.setTitle,
        event: { type: "click", target: { value: "From the field" } },
        trustedUi: retitleGesture,
      },
      { assertion: assert(() => group[NAME] === "From the field") },
      // A title with no text in it is refused, with a reason and a code, and
      // the title stays as it was. The control shows the reason.
      {
        action: group[VIEWS].room.setTitle,
        event: { requestId: "t-blank", title: "   " },
        trustedUi: retitleGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(group[VIEWS].room.titleRequests, "t-blank") ===
            "refused/invalid-title" &&
          reasonOf(group[VIEWS].room.titleRequests, "t-blank") ===
            "A chat's title needs some text." &&
          shownRefusal(group[UI]) === "A chat's title needs some text." &&
          group[VIEWS].room.about.title === "From the field"
        ),
      },
      // A retitle that takes effect clears the shown refusal.
      {
        action: group[VIEWS].room.setTitle,
        event: { requestId: "t-3", title: "Plans" },
        trustedUi: retitleGesture,
      },
      {
        assertion: assert(() =>
          group[VIEWS].room.about.title === "Plans" &&
          shownRefusal(group[UI]) === ""
        ),
      },
      // A request already decided changes nothing when it arrives again, even
      // with another title.
      {
        action: group[VIEWS].room.setTitle,
        event: { requestId: "t-1", title: "Something else" },
        trustedUi: retitleGesture,
      },
      {
        assertion: assert(() =>
          group[VIEWS].room.about.title === "Plans" &&
          outcomeOf(group[VIEWS].room.titleRequests, "t-1") === "done"
        ),
      },
      // A space's own chat refuses a retitle, whatever reaches its stream.
      {
        action: shared[VIEWS].room.setTitle,
        event: { requestId: "t-shared", title: "Ours" },
        trustedUi: retitleGesture,
      },
      {
        assertion: assert(() =>
          outcomeOf(shared[VIEWS].room.titleRequests, "t-shared") ===
            "refused/fixed-title" &&
          reasonOf(shared[VIEWS].room.titleRequests, "t-shared") ===
            "This chat is named by its space." &&
          shared[VIEWS].room.about.title === undefined &&
          shared[NAME] === "Chat"
        ),
      },
    ],
  };
});
