import {
  action,
  assert,
  type Cell,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElementByExactText,
  findNodeById,
  findNodeByProp,
  hasText,
  propValue,
} from "../test/vnode-helpers.ts";
import Home from "./home.tsx";
import PrivateInbox, {
  type PrivateInboxPiece,
  TRUSTED_PRIVATE_INBOX_REFUSAL_SURFACE,
  TRUSTED_REPLACE_REFUSED_INBOX_ACTION,
} from "./private-inbox.tsx";

type SpaceEntry = { name: string; did?: string };

/** The entry for `did` in the Home space list `list`, if it holds one. */
function entryFor(
  list: readonly SpaceEntry[] | undefined,
  did: string,
): SpaceEntry | undefined {
  return (list ?? []).find((entry) => entry.did === did);
}

/** When the test's refusals were first recorded. */
const REFUSED_AT = Date.UTC(2026, 9, 9, 12, 0, 0);

/** Home's private-inbox refusal notice in the rendering `ui`, if it shows. */
function refusalNoticeIn(ui: unknown): unknown {
  return findNodeById(ui, "home-private-inbox-refusal");
}

/**
 * Whether the rendering `ui` shows the button that replaces the refused inbox,
 * marked as the action it is, inside the notice marked as its trusted surface.
 */
function offersReplacementIn(ui: unknown): boolean {
  const notice = refusalNoticeIn(ui);
  return propValue(notice, "data-ui-pattern") ===
      TRUSTED_PRIVATE_INBOX_REFUSAL_SURFACE &&
    propValue(notice, "data-ui-event-integrity") ===
      TRUSTED_PRIVATE_INBOX_REFUSAL_SURFACE &&
    propValue(
        findNodeById(notice, "home-private-inbox-replace"),
        "data-ui-action",
      ) === TRUSTED_REPLACE_REFUSED_INBOX_ACTION &&
    hasText(notice, "Use a new inbox");
}

/** An inbox's result, as the link a refusal record keeps. */
function linkOf(inbox: unknown): Cell<PrivateInboxPiece>;
function linkOf(inbox: unknown): unknown {
  return inbox;
}

export default pattern(() => {
  const home = Home({});

  // A stable piece cell to favorite and unfavorite by identity.
  const piece = new Writable<{ [NAME]?: string }>({ [NAME]: "Fav Piece" });

  const assert_initial_profile_missing = assert(() =>
    ((home.profiles as unknown[])?.length ?? 0) === 0
  );

  // The agent queue is held in a field of its own and starts empty, with no
  // runner registered.
  const assert_agent_queue_starts_empty = assert(() =>
    home.agentQueue.entries.get().length === 0 &&
    home.agentQueue.agentRunner === undefined
  );
  const assert_agent_runs_tab = assert(() =>
    hasText(findNodeByProp(home[UI], "value", "agent-runs"), "Agent runs") &&
    hasText(
      findNodeByProp(home[UI], "id", "home-agent-runs"),
      "No runner is registered.",
    ) &&
    hasText(findNodeByProp(home[UI], "value", "self"), "Self")
  );
  // The chat manager is held in a field of its own, starts with no rooms, and
  // is shown in a tab of its own, whose panel renders the manager's heading.
  const assert_chat_manager_starts_empty = assert(() =>
    home.chatManager.rooms.length === 0 &&
    home.chatManager.outgoingNotices.length === 0 &&
    findElementByExactText(home[UI], "cf-tab", "Chats") !== undefined &&
    hasText(findNodeByProp(home[UI], "id", "home-chats"), "Chats")
  );
  const action_register_runner = action(() => {
    home.agentQueue.setAgentRunner.send({
      runner: {
        host: "https://local.example",
        tools: [],
        registrationId: "runner-1",
        registeredAt: "2026-09-18T00:00:00.000Z",
      },
    });
  });
  const assert_runner_registered = assert(() =>
    home.agentQueue.agentRunner?.host === "https://local.example"
  );

  // NOTE: untrusted-write protection (sending the exported `createProfile`
  // stream from outside the trusted ProfileCreate surface must NOT create a
  // profile) is enforced by CFC and verified in
  // packages/runner/test/profile-owner-cfc.test.ts under `enforce-explicit`.
  // It can't be asserted here: the pattern-test runner runs CFC in `observe`
  // mode (no enforcement), so an untrusted send is not blocked. The previous
  // version of this test only "passed" because the untrusted cross-space
  // `inSpace` write incidentally threw a write-isolation error — which the
  // multi-profile change legitimately allows via a multi-space commit.

  // Favorites are keyed by the piece's identity (the client-supplied id): the
  // handler sets the keyed entity and add-uniques it.
  const action_add_favorite = action(() => {
    home.addFavorite.send({
      piece,
      tags: ["demo"],
      spaceName: "space-a",
      id: "fav-1",
    });
  });

  // The first removal takes the keyed path (the entity exists) and clears it.
  const action_remove_favorite = action(() => {
    home.removeFavorite.send({ piece, id: "fav-1" });
  });

  // A second removal with the same id finds no entity (it was cleared), so it
  // takes the piece-cell fallback that keeps a pre-keyed favorite deletable.
  const action_remove_favorite_again = action(() => {
    home.removeFavorite.send({ piece, id: "fav-1" });
  });

  // The journal append is an exported mergeable push.
  const action_add_journal = action(() => {
    home.addJournalEntry.send({
      entry: {
        timestamp: 1,
        eventType: "piece:created",
        space: "space-a",
      },
    });
  });

  // Spaces are keyed by DID: the add sets the keyed entity and add-uniques it,
  // and the remove matches that identity via removeByValue. A label is only
  // what an entry is called, so two entries may share one.
  const SPACE_ONE = "did:key:z6MkSpaceOne";
  const SPACE_TWO = "did:key:z6MkSpaceTwo";
  const LEGACY_DID = "did:key:z6MkLegacySpace";
  const action_add_space = action(() => {
    home.addSpace.send({ did: SPACE_ONE, name: "Team" });
  });
  const action_add_second_space = action(() => {
    home.addSpace.send({ did: SPACE_TWO, name: "Team" });
  });
  const assert_two_entries_share_a_label = assert(() =>
    (home.spaces.get() ?? []).length === 2 &&
    entryFor(home.spaces.get(), SPACE_ONE)?.name === "Team" &&
    entryFor(home.spaces.get(), SPACE_TWO)?.name === "Team"
  );
  const action_add_space_again = action(() => {
    home.addSpace.send({ did: SPACE_ONE, name: "Team" });
  });
  const assert_re_adding_keeps_one_entry = assert(() =>
    (home.spaces.get() ?? []).length === 2
  );
  const action_rename_space = action(() => {
    home.renameSpace.send({ did: SPACE_ONE, name: "Lunch" });
  });
  const assert_rename_changes_only_the_label = assert(() =>
    (home.spaces.get() ?? []).length === 2 &&
    entryFor(home.spaces.get(), SPACE_ONE)?.name === "Lunch" &&
    entryFor(home.spaces.get(), SPACE_TWO)?.name === "Team"
  );
  // A repeated add that carries no label, or an empty one, keeps the label
  // the entry already has.
  const action_add_space_unlabeled = action(() => {
    home.addSpace.send({ did: SPACE_ONE });
  });
  const action_add_space_with_empty_label = action(() => {
    home.addSpace.send({ did: SPACE_ONE, name: "" });
  });
  const assert_unlabeled_add_keeps_the_label = assert(() =>
    (home.spaces.get() ?? []).length === 2 &&
    entryFor(home.spaces.get(), SPACE_ONE)?.name === "Lunch"
  );
  const action_remove_space = action(() => {
    home.removeSpace.send({ did: SPACE_ONE });
  });
  const action_remove_second_space = action(() => {
    home.removeSpace.send({ did: SPACE_TWO });
  });
  const assert_removal_leaves_the_other_entry = assert(() =>
    (home.spaces.get() ?? []).length === 1 &&
    entryFor(home.spaces.get(), SPACE_TWO)?.name === "Team"
  );

  // An event carrying only a typed name, as an older sender sends it, records
  // an entry keyed by that name, as every entry written before spaces had
  // random identities is. Adopting it replaces it with an entry keyed by the
  // DID the name resolves to, called by the same name.
  const action_add_legacy_space = action(() => {
    home.addSpace.send({ detail: { message: "Old Space" } });
  });
  const assert_legacy_entry_present = assert(() =>
    (home.spaces.get() ?? []).some((entry) =>
      entry.name === "Old Space" && entry.did === undefined
    )
  );
  const action_adopt_legacy_space = action(() => {
    home.adoptSpace.send({ name: "Old Space", did: LEGACY_DID });
  });
  const assert_legacy_entry_adopted = assert(() =>
    (home.spaces.get() ?? []).length === 1 &&
    entryFor(home.spaces.get(), LEGACY_DID)?.name === "Old Space" &&
    !(home.spaces.get() ?? []).some((entry) => entry.did === undefined)
  );
  const action_remove_adopted_space = action(() => {
    home.removeSpace.send({ did: LEGACY_DID });
  });
  const assert_empty_space_notice = assert(() =>
    hasText(home[UI], "No spaces yet. Create one below.")
  );
  const assert_space_notice_hidden = assert(() =>
    !hasText(home[UI], "No spaces yet. Create one below.")
  );

  // The refusal notice shows while Home records a refusal, with the host's code
  // as given, a sentence saying what a code Home knows means, when Home first
  // recorded it, and the button that replaces the refused inbox, marked as its
  // trusted surface's action; it is gone once the record is cleared.
  const refusedInbox = PrivateInbox({ offers: [] });
  const assert_no_refusal_notice = assert(() =>
    refusalNoticeIn(home[UI]) === undefined
  );
  const action_record_refusal = action(() => {
    home.privateInboxRefusal.set({
      refusal: {
        reason: "inbox-adoption-acl-mismatch",
        inbox: linkOf(refusedInbox),
        refusedAt: REFUSED_AT,
      },
    });
  });
  const assert_refusal_notice_shown = assert(() =>
    hasText(refusalNoticeIn(home[UI]), "Shares may not reach you") &&
    hasText(
      refusalNoticeIn(home[UI]),
      "Reason: inbox-adoption-acl-mismatch.",
    ) &&
    hasText(refusalNoticeIn(home[UI]), "does not make you its owner") &&
    hasText(
      refusalNoticeIn(home[UI]),
      new Date(REFUSED_AT).toLocaleString(),
    ) &&
    hasText(refusalNoticeIn(home[UI]), "stops receiving loom shares") &&
    offersReplacementIn(home[UI])
  );
  const action_record_unknown_refusal = action(() => {
    home.privateInboxRefusal.set({
      refusal: {
        reason: "inbox-from-a-newer-host",
        inbox: linkOf(refusedInbox),
        refusedAt: REFUSED_AT,
      },
    });
  });
  const assert_unknown_code_shown_as_given = assert(() =>
    hasText(refusalNoticeIn(home[UI]), "Reason: inbox-from-a-newer-host.") &&
    !hasText(refusalNoticeIn(home[UI]), "does not make you its owner")
  );
  const action_clear_refusal = action(() => {
    home.privateInboxRefusal.set({});
  });

  return {
    [TESTS]: [
      { assertion: assert_initial_profile_missing },
      { assertion: assert_agent_queue_starts_empty },
      { assertion: assert_chat_manager_starts_empty },
      { assertion: assert_agent_runs_tab },
      { action: action_register_runner },
      { assertion: assert_runner_registered },
      { action: action_add_favorite },
      { action: action_remove_favorite },
      { action: action_remove_favorite_again },
      { action: action_add_journal },
      { assertion: assert_empty_space_notice },
      { action: action_add_space },
      { assertion: assert_space_notice_hidden },
      { action: action_add_second_space },
      { assertion: assert_two_entries_share_a_label },
      { action: action_add_space_again },
      { assertion: assert_re_adding_keeps_one_entry },
      { action: action_rename_space },
      { assertion: assert_rename_changes_only_the_label },
      { action: action_add_space_unlabeled },
      { assertion: assert_unlabeled_add_keeps_the_label },
      { action: action_add_space_with_empty_label },
      { assertion: assert_unlabeled_add_keeps_the_label },
      { action: action_remove_space },
      { assertion: assert_removal_leaves_the_other_entry },
      { action: action_remove_second_space },
      { assertion: assert_empty_space_notice },
      { action: action_add_legacy_space },
      { assertion: assert_legacy_entry_present },
      { action: action_adopt_legacy_space },
      { assertion: assert_legacy_entry_adopted },
      { action: action_remove_adopted_space },
      { assertion: assert_empty_space_notice },
      { assertion: assert_initial_profile_missing },
      { assertion: assert_no_refusal_notice },
      { action: action_record_refusal },
      { assertion: assert_refusal_notice_shown },
      { action: action_record_unknown_refusal },
      { assertion: assert_unknown_code_shown_as_given },
      { action: action_clear_refusal },
      { assertion: assert_no_refusal_notice },
    ],
  };
});
