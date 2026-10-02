import {
  action,
  assert,
  type Cell,
  currentPrincipal,
  equals,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import ProfileHome from "./profile-home.tsx";
import PrivateInbox, {
  OFFER_TITLE_MAX_LENGTH,
  pointProfilesAtPrivateInbox,
  type PrivateInboxHolder,
  type PrivateInboxPiece,
} from "./private-inbox.tsx";

/** A well-formed space DID for an offer to name. */
const ROOM_SPACE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

/** An inbox's result, as the link a holder keeps. */
function linkOf(inbox: unknown): Cell<PrivateInboxPiece>;
function linkOf(inbox: unknown): unknown {
  return inbox;
}

/**
 * Creates an inbox and keeps it in `holder`, as `ensurePrivateInbox` does but
 * in the calling space, since a pattern test cannot create a space.
 */
const holdNewInbox = handler<void, { holder: Writable<PrivateInboxHolder> }>(
  (_event, { holder }) => {
    holder.set({ piece: linkOf(PrivateInbox({ offers: [] })) });
  },
);

/** Records the actor's principal in `me`. */
const introduce = handler<void, { me: Writable<string> }>((_event, { me }) => {
  me.set(currentPrincipal() ?? "");
});

export default pattern(() => {
  const inbox = PrivateInbox({ offers: [] });
  const me = new Writable("");
  const introduceMe = introduce({ me });
  const action_introduce = action(() => {
    introduceMe.send();
  });

  const action_receive_room = action(() => {
    inbox.receive.send({
      kind: "fabrichat-room",
      space: ROOM_SPACE,
      host: "https://example.com",
      title: "Lunch",
    });
  });
  const assert_room_received_from_the_actor = assert(() =>
    inbox.offers.length === 1 &&
    inbox.offers[0]?.kind === "fabrichat-room" &&
    inbox.offers[0]?.space === ROOM_SPACE &&
    inbox.offers[0]?.host === "https://example.com" &&
    inbox.offers[0]?.title === "Lunch" &&
    me.get() !== "" &&
    inbox.offers[0]?.from === me.get() &&
    typeof inbox.offers[0]?.receivedAt === "number"
  );

  const action_receive_malformed = action(() => {
    inbox.receive.send({ kind: "Fabri Chat", space: ROOM_SPACE });
    inbox.receive.send({ kind: "", space: ROOM_SPACE });
    inbox.receive.send({ kind: "x".repeat(65), space: ROOM_SPACE });
    inbox.receive.send({ kind: "fabrichat-room", space: "not-a-did" });
    inbox.receive.send({
      kind: "fabrichat-room",
      space: ROOM_SPACE,
      host: "ftp://example.com",
    });
    inbox.receive.send({
      kind: "fabrichat-room",
      space: ROOM_SPACE,
      host: "https://example.com/path",
    });
  });
  const assert_malformed_offers_dropped = assert(() =>
    inbox.offers.length === 1
  );

  const action_receive_long_title = action(() => {
    inbox.receive.send({
      kind: "fabrichat-room",
      space: ROOM_SPACE,
      title: "t".repeat(OFFER_TITLE_MAX_LENGTH * 2),
    });
  });
  const assert_long_title_cut = assert(() =>
    inbox.offers.length === 2 &&
    inbox.offers[1]?.title === "t".repeat(OFFER_TITLE_MAX_LENGTH) &&
    inbox.offers[1]?.host === undefined
  );

  // Pointing profiles at an inbox: one profile already points at another
  // inbox, and one points at nothing.
  const pointed = ProfileHome({ initialName: "Pointed" });
  const unpointed = ProfileHome({ initialName: "Unpointed" });
  const home = new Writable<PrivateInboxHolder>({});
  const elsewhere = new Writable<PrivateInboxHolder>({});
  const holdHomeInbox = holdNewInbox({ holder: home });
  const holdElsewhereInbox = holdNewInbox({ holder: elsewhere });
  const pointProfiles = pointProfilesAtPrivateInbox({
    privateInbox: home,
    // deno-lint-ignore no-explicit-any
    profiles: [pointed, unpointed] as any,
  });

  const action_create_inboxes = action(() => {
    holdHomeInbox.send();
    holdElsewhereInbox.send();
  });
  const action_point_one_elsewhere = action(() => {
    pointed.setInbox.send({ inbox: elsewhere.get().piece?.resolveAsCell() });
  });
  const action_point_profiles = action(() => {
    pointProfiles.send();
  });
  const assert_inboxes_created = assert(() =>
    home.get().piece !== undefined && elsewhere.get().piece !== undefined &&
    !equals(home.get().piece, elsewhere.get().piece)
  );
  const assert_only_the_unpointed_profile_points_at_home_inbox = assert(() =>
    equals(pointed.inbox?.piece, elsewhere.get().piece) &&
    equals(unpointed.inbox?.piece, home.get().piece)
  );

  return {
    [TESTS]: [
      { action: action_introduce },
      { action: action_receive_room },
      { assertion: assert_room_received_from_the_actor },
      { action: action_receive_malformed },
      { assertion: assert_malformed_offers_dropped },
      { action: action_receive_long_title },
      { assertion: assert_long_title_cut },
      { action: action_create_inboxes },
      { assertion: assert_inboxes_created },
      { action: action_point_one_elsewhere },
      { action: action_point_profiles },
      { assertion: assert_only_the_unpointed_profile_points_at_home_inbox },
      // Pointing again changes nothing.
      { action: action_point_profiles },
      { assertion: assert_only_the_unpointed_profile_points_at_home_inbox },
    ],
  };
});
